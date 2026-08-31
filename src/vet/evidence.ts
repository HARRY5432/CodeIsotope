import { mapLimit } from '../lib/http.ts';
import type { Ecosystem, PackageEvidence, VetReport } from '../lib/types.ts';
import { TOOL_NAME, TOOL_VERSION } from '../lib/version.ts';
import { scoreHealth } from '../score/health.ts';
import { fetchDepsDev } from './depsdev.ts';
import { fetchRepoEvidence, isAuthenticated } from './github.ts';
import { registryFor } from './registries.ts';
import { githubSlugFrom, type RegistryFacts } from './registry.ts';
import { fetchScorecard } from './scorecard.ts';
import { verifyPackages } from './verify.ts';

/** Seeds written as "structuredClone (Node built-in)" are advice, not packages to vet. */
const BUILT_IN = /\(([^)]*built-in[^)]*)\)/i;

export interface VetOptions {
  ecosystem?: Ecosystem;
  /** Extra package names to vet alongside the search results. */
  seeds?: string[];
  /** Skip search entirely and vet exactly these names. */
  exact?: string[];
  /** Max packages to gather evidence for. */
  limit?: number;
  /**
   * Refuse to report on a name the registry has no record of, instead of grading it on absent data.
   *
   * Without this a hallucinated package name produces a card with an F grade and a list of unknown
   * signals, which reads as "a real but unhealthy package" rather than "this does not exist".
   */
  strict?: boolean;
}

function splitSeeds(seeds: readonly string[]): { packages: string[]; builtIns: string[] } {
  const packages: string[] = [];
  const builtIns: string[] = [];
  for (const seed of seeds) {
    const match = BUILT_IN.exec(seed);
    if (match) builtIns.push(seed);
    else packages.push(seed.trim());
  }
  return { packages, builtIns };
}

/**
 * Gather every fact we can about one package, from whichever registry owns it.
 *
 * The shape of what is knowable differs sharply by ecosystem, and the gaps are reported rather
 * than papered over: npm states deprecation outright, PyPI has no such field at all, and the Go
 * proxy publishes neither a licence nor a description. An unknown signal is dropped from the health
 * average instead of scored as a failure, so a Go module is never punished for what the proxy
 * declines to say.
 */
async function gatherOne(name: string, ecosystem: Ecosystem, facts: RegistryFacts | undefined): Promise<PackageEvidence> {
  const gaps: string[] = [];
  const registry = registryFor(ecosystem);

  if (!facts) gaps.push(`${registry?.label ?? ecosystem} has no record of a package called "${name}"`);

  // deps.dev is the cross-ecosystem source for advisories, licences and the canonical source repo,
  // and it is the only place several of those exist for Python and Go. The registry's own current
  // version is passed in so deps.dev does not grade the package on a prerelease.
  const depsDev = await fetchDepsDev(ecosystem, name, facts?.version);
  if (!depsDev) gaps.push('deps.dev has no record for this package');

  const slug = depsDev?.githubSlug ?? githubSlugFrom(facts?.repoUrl, facts?.homepage);
  const repo = slug ? await fetchRepoEvidence(slug, name) : undefined;
  if (!slug) gaps.push('no source repository linked from package metadata');
  else if (!repo) gaps.push(`GitHub repo ${slug} could not be read (renamed, private, or deleted)`);

  const scorecard = slug ? await fetchScorecard(slug) : undefined;
  // A missing Scorecard is deliberately NOT recorded as a gap. It is already handled by the scoring
  // rule that drops unknown signals from the average, and reporting it here too counted the same
  // absence twice: once in `gaps` as a shortcoming of the package, and once in the reader's mind as
  // a security concern. Most small libraries have no Scorecard, and the whole point of dropping
  // unknowns is to stop punishing them for a metric they never published.

  const license = facts?.license ?? depsDev?.licenses?.[0] ?? repo?.license ?? null;
  // Either source claiming deprecation is enough: npm carries the maintainer's own message, while
  // for PyPI a yank or an Inactive classifier is the closest equivalent that exists.
  const deprecated = facts?.deprecated?.is ? facts.deprecated : depsDev?.deprecated?.is ? depsDev.deprecated : (facts?.deprecated ?? depsDev?.deprecated);
  const advisories = depsDev?.advisories ?? [];
  const dependents = depsDev?.dependents;
  const lastPublishedAt = facts?.publishedAt ?? depsDev?.publishedAt;

  const health = scoreHealth({
    ecosystem,
    ...(repo ? { repo } : {}),
    ...(facts?.downloads?.weekly !== undefined ? { weeklyDownloads: facts.downloads.weekly } : {}),
    ...(dependents ? { dependents } : {}),
    ...(deprecated ? { deprecated } : {}),
    ...(lastPublishedAt ? { lastPublishedAt } : {}),
    advisories,
    license,
    ...(scorecard ? { scorecardScore: scorecard.score } : {}),
  });

  const evidence: PackageEvidence = { name, ecosystem, license, health, gaps };
  if (facts?.description) evidence.description = facts.description;
  const version = facts?.version ?? depsDev?.defaultVersion;
  if (version) evidence.version = version;
  if (facts?.homepage) evidence.homepage = facts.homepage;
  if (deprecated) evidence.deprecated = deprecated;
  if (facts?.downloads) evidence.downloads = facts.downloads;
  if (dependents?.direct !== undefined) evidence.dependentsCount = dependents.direct;
  if (repo) evidence.repo = repo;
  if (scorecard) evidence.scorecard = scorecard;
  return evidence;
}

/**
 * Gather evidence for a list of package names in one ecosystem.
 *
 * Shared by `vet`, `audit` and `reference` on purpose: an audited dependency and a suggested
 * replacement must be measured by the identical pipeline, or comparing their scores is meaningless.
 */
export async function gatherEvidence(
  names: readonly string[],
  ecosystem: Ecosystem = 'npm',
  concurrency = 3,
): Promise<PackageEvidence[]> {
  if (names.length === 0) return [];
  const registry = registryFor(ecosystem);

  // Registry metadata first, with its own concurrency: these are small, fast, cacheable requests,
  // while the per-package evidence gathering below fans out to three more services each.
  const facts = registry
    ? await mapLimit(names, 6, (name) => registry.fetchPackage(name).catch(() => undefined))
    : names.map(() => undefined);

  return mapLimit(names, concurrency, (name, i) => gatherOne(name, ecosystem, facts[i]));
}

/**
 * Turn a capability description (or an explicit package list) into ranked, evidence-backed candidates.
 * Every field comes from a public API -- nothing here is inferred or generated.
 */
export async function vet(query: string, opts: VetOptions = {}): Promise<VetReport> {
  const { ecosystem = 'npm', seeds = [], exact, limit = 6, strict = false } = opts;
  const notes: string[] = [];
  const registry = registryFor(ecosystem);

  if (!registry) {
    notes.push(`${ecosystem} packages cannot be graded in this version; supported ecosystems are npm, pypi, cargo and go.`);
  }

  const { packages: seedPackages, builtIns } = splitSeeds(seeds);
  for (const builtIn of builtIns) {
    notes.push(`Platform built-in available: ${builtIn} -- prefer this over any dependency if it covers the use case.`);
  }

  let names: string[];
  if (exact && exact.length > 0) {
    names = exact;
  } else {
    const searched = registry?.search ? await registry.search(query, Math.max(limit, 8)) : [];
    if (registry && !registry.search) {
      // PyPI withdrew its JSON search endpoint and pkg.go.dev has none, so naming packages
      // explicitly is the honest option. Scraping a web page would break on the next redesign.
      notes.push(`${registry.label} has no usable search API, so ${ecosystem} packages must be named with --package.`);
    }
    // Seeds first: they are curated answers, and search results fill the rest of the slate.
    names = [...seedPackages, ...searched];
  }

  const unique = [...new Set(names.map((n) => n.trim()).filter(Boolean))].slice(0, limit);
  if (unique.length === 0) {
    notes.push('No candidate packages found for this query.');
    return { tool: { name: TOOL_NAME, version: TOOL_VERSION }, query, ecosystem, generatedAt: new Date().toISOString(), candidates: [], notes };
  }

  // In strict mode, confirm existence before gathering evidence. A name the registry has never heard
  // of otherwise produces a graded card full of unknown signals, which reads as "a real but unhealthy
  // package" rather than "this was invented" -- the exact confusion the strict flag exists to remove.
  let vetting = unique;
  if (strict && registry) {
    const checked = await verifyPackages(unique, ecosystem);
    const real = checked.filter((c) => c.status === 'exists').map((c) => c.name);
    for (const bad of checked.filter((c) => c.status !== 'exists')) {
      notes.push(`REJECTED ${bad.name}: ${bad.detail}`);
    }
    if (real.length === 0) {
      notes.push('No requested package exists in this ecosystem, so nothing was graded.');
      return { tool: { name: TOOL_NAME, version: TOOL_VERSION }, query, ecosystem, generatedAt: new Date().toISOString(), candidates: [], notes };
    }
    vetting = real;
  }

  const candidates = await gatherEvidence(vetting, ecosystem);

  // Scores within a few points of each other are not meaningfully different, so adoption breaks
  // the tie: between two equally healthy libraries, the one the ecosystem already standardised on
  // has more StackOverflow answers, more transitive compatibility, and a cheaper migration.
  candidates.sort((a, b) => {
    const gap = b.health.score - a.health.score;
    if (Math.abs(gap) > 5) return gap;
    const byDependents = (b.dependentsCount ?? 0) - (a.dependentsCount ?? 0);
    if (byDependents !== 0) return byDependents;
    return (b.downloads?.weekly ?? 0) - (a.downloads?.weekly ?? 0);
  });

  if (!(await isAuthenticated())) {
    notes.push('Running unauthenticated against the GitHub API (60 requests/hour). Set GITHUB_TOKEN or run `gh auth login` for 5,000/hour and more complete evidence.');
  }

  return { tool: { name: TOOL_NAME, version: TOOL_VERSION }, query, ecosystem, generatedAt: new Date().toISOString(), candidates, notes };
}
