import type { AuditedDep, DepKind, DepVerdict, PackageEvidence } from '../lib/types.ts';
import { daysSince } from '../score/signals.ts';

/**
 * Turn gathered evidence into a verdict on a dependency you already have.
 *
 * This is a deliberately different question from the one `vet` answers. `vet` asks "is this worth
 * adopting", where thin adoption is a real strike against a candidate. Audit asks "is what you
 * already shipped going to hurt you", and by then adoption is sunk cost -- a 200-download package
 * that its author still maintains is not a problem, whereas a 30-million-download package whose
 * last commit was three years ago absolutely is.
 *
 * So the verdict is driven by maintenance, deprecation, advisories and licence -- not popularity.
 */

/** A dev dependency that has gone quiet is a smaller problem than a shipped one. */
const STALE_DAYS: Record<DepKind, { aging: number; weak: number; dead: number }> = {
  direct: { aging: 270, weak: 540, dead: 900 },
  dev: { aging: 400, weak: 730, dead: 1100 },
};

function rank(verdict: DepVerdict): number {
  return { healthy: 0, aging: 1, weak: 2, replace: 3 }[verdict];
}

const worst = (a: DepVerdict, b: DepVerdict): DepVerdict => (rank(b) > rank(a) ? b : a);

const truncate = (s: string, max = 160): string => (s.length <= max ? s : `${s.slice(0, max - 3)}...`);

/** Days since the last real commit on the default branch, falling back to any-branch push. */
function lastActivityDays(evidence: PackageEvidence): number | undefined {
  const repo = evidence.repo;
  if (!repo) return undefined;
  return daysSince(repo.commits.lastCommitAt) ?? daysSince(repo.pushedAt);
}

export interface ClassifyResult {
  verdict: DepVerdict;
  reasons: string[];
  /** True when the problem is bad enough that a replacement search is worth the requests. */
  needsAlternative: boolean;
}

export function classifyDep(evidence: PackageEvidence, kind: DepKind): ClassifyResult {
  const reasons: string[] = [];
  let verdict: DepVerdict = 'healthy';

  // --- Hard problems. Each one alone justifies replacing the dependency. ---

  if (evidence.deprecated?.is) {
    // Deprecation messages are frequently multi-line install instructions; flatten them so one
    // reason stays one line in the report.
    const why = evidence.deprecated.reason?.replace(/\s+/g, ' ').trim();
    reasons.push(why ? `deprecated by its maintainers: ${truncate(why)}` : 'deprecated by its maintainers');
    verdict = 'replace';
  }

  if (evidence.repo?.archived) {
    reasons.push('repository is archived -- it will receive no further fixes, including security fixes');
    verdict = 'replace';
  }

  const advisories = evidence.health.signals.find((s) => s.label === 'Security');
  if (advisories?.verdict === 'bad') {
    reasons.push(advisories.detail);
    verdict = 'replace';
  }

  // --- Maintenance. The signal that actually decides most audits. ---

  const days = lastActivityDays(evidence);
  const commits90 = evidence.repo?.commits.last90d;
  const limits = STALE_DAYS[kind];

  if (days === undefined) {
    if (!evidence.repo) {
      reasons.push('no source repository linked, so maintenance cannot be verified');
      verdict = worst(verdict, 'weak');
    }
  } else if (days >= limits.dead) {
    reasons.push(`no commits in ${Math.floor(days / 30)} months -- effectively unmaintained`);
    verdict = worst(verdict, 'replace');
  } else if (days >= limits.weak) {
    reasons.push(`last commit ${Math.floor(days / 30)} months ago -- maintenance has stopped`);
    verdict = worst(verdict, 'weak');
  } else if (days >= limits.aging) {
    reasons.push(`last commit ${Math.floor(days / 30)} months ago -- slowing down`);
    verdict = worst(verdict, 'aging');
  } else if (commits90 === 0 && days > 120) {
    reasons.push(`no commits on the default branch in 90 days, last commit ${days} days ago`);
    verdict = worst(verdict, 'aging');
  }

  // --- Bus factor. Not a problem by itself; it raises the cost if the dep does stall. ---

  if (evidence.repo?.contributors.total === 1 && verdict !== 'healthy') {
    reasons.push('a single contributor accounts for every commit, so recovery is unlikely');
  }

  // --- Licence. A missing licence is a legal problem regardless of code quality. ---

  const license = evidence.health.signals.find((s) => s.label === 'License');
  if (license?.verdict === 'bad') {
    reasons.push('no licence detected -- legally unsafe to ship');
    verdict = worst(verdict, 'weak');
  }

  if (reasons.length === 0) {
    const detail = evidence.health.signals.find((s) => s.label === 'Maintenance')?.detail;
    reasons.push(detail ? `actively maintained: ${detail}` : 'no maintenance or security concerns found');
  }

  return { verdict, reasons, needsAlternative: verdict === 'replace' || verdict === 'weak' };
}

/** The bare package name, without the npm scope. */
export function bareName(name: string): string {
  return name.replace(/^@[^/]+\//, '');
}

/**
 * Pull the replacement the maintainer named out of an npm deprecation message.
 *
 * This is the one replacement suggestion that is a *fact* rather than a guess: the person who
 * deprecated the package said what to use instead. Messages are free text, but the phrasings are
 * conventional enough to match reliably, and anything we cannot parse is simply not reported.
 *
 * `builtIn` matters because it changes the advice completely. "use String.prototype.padStart()"
 * means delete the dependency, not swap it -- and it is not a package name, so passing it to
 * `vet` would search npm for something that does not exist there.
 */
export function maintainerSuggestion(reason: string | undefined): { name: string; builtIn: boolean } | undefined {
  if (!reason) return undefined;
  const text = reason.replace(/\s+/g, ' ').trim();

  // "use String.prototype.padStart()", "use the built-in structuredClone()", "use globalThis.fetch"
  const builtIn = /\buse\s+(?:the\s+)?(?:built-?in\s+)?((?:[A-Z]\w*\.)*(?:prototype\.)?\w+\(\)|globalThis\.\w+|Object\.\w+)/.exec(text);
  if (builtIn?.[1] && /[A-Z]|globalThis/.test(builtIn[1])) return { name: builtIn[1], builtIn: true };

  // "npm i nyc", "npm install --save foo"
  const install = /npm\s+(?:i|install|add)\s+(?:--save(?:-dev)?\s+|-[DS]\s+)?((?:@[\w.-]+\/)?[\w.-]+)/i.exec(text);
  if (install?.[1]) return { name: install[1], builtIn: false };

  // "use foo instead", "replaced by @scope/foo", "superseded by foo"
  const named = /\b(?:use|try|switch to|migrate to|replaced by|superseded by)\s+((?:@[\w.-]+\/)?[a-z][\w.-]*)\b(?![^ ]*\.(?:com|org|io|dev))/i.exec(text);
  if (named?.[1] && !/^(this|it|the|instead|https?|module|package)$/i.test(named[1])) {
    return { name: named[1], builtIn: false };
  }

  return undefined;
}

/**
 * Search terms describing the capability, for the host model to pass to `reporadar vet`.
 *
 * Deliberately *not* used to auto-select a replacement. Finding a functional equivalent is semantic
 * judgement: npm search ranks on text relevance, so querying a package's own description reliably
 * returns forks of it, its `@types` stub, and unrelated packages that share vocabulary -- searching
 * "retrying made simple easy async" surfaces a JSDoc parser. The model reads the code that uses the
 * dependency, decides what it actually needs, and vets that. The binary supplies the facts.
 */
export function replacementSearchTerms(evidence: PackageEvidence): string[] {
  const terms: string[] = [];
  const bare = bareName(evidence.name);

  // A named package the maintainer pointed at is the strongest lead; a built-in is advice to
  // delete the dependency, so there is nothing to search for.
  const suggestion = maintainerSuggestion(evidence.deprecated?.reason);
  if (suggestion && !suggestion.builtIn) terms.push(suggestion.name);

  const description = evidence.description?.replace(/\s+/g, ' ').trim();
  if (description) {
    const cleaned = description
      .replace(new RegExp(bare.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), ' ')
      .replace(/[^\w\s-]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2)
      .slice(0, 8)
      .join(' ')
      .trim();
    if (cleaned) terms.push(cleaned);
  }

  if (terms.length === 0) terms.push(bare.replace(/[-_.]/g, ' '));
  return terms;
}

/** Order the report so the dependency that most needs attention is read first. */
export function compareDeps(a: AuditedDep, b: AuditedDep): number {
  const byVerdict = rank(b.verdict) - rank(a.verdict);
  if (byVerdict !== 0) return byVerdict;
  const byHealth = a.evidence.health.score - b.evidence.health.score;
  if (byHealth !== 0) return byHealth;
  return a.name.localeCompare(b.name);
}
