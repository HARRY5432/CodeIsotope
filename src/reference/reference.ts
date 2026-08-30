import { mapLimit } from '../lib/http.ts';
import type { Ecosystem, PackageEvidence, ReferenceReport, ReferenceSource } from '../lib/types.ts';
import { TOOL_NAME, TOOL_VERSION } from '../lib/version.ts';
import { gatherEvidence } from '../vet/evidence.ts';
import { fetchRepoTree, isAuthenticated } from '../vet/github.ts';
import { searchNpm } from '../vet/npm.ts';
import { rankFiles } from './rank.ts';

/**
 * Point at how a healthy, widely-used library solves a problem.
 *
 * The binary contributes exactly one thing here that a language model cannot: **permalinks
 * verified to exist, pinned to a commit.** Ask any model how p-retry implements jitter and it will
 * produce a confident, plausible, invented snippet. A link to
 * `github.com/{slug}/blob/{sha}/{path}` is checkable, and because the SHA is resolved rather than
 * a branch name, it means the same thing in a year.
 *
 * What the binary deliberately does *not* do is read the code or explain it. Ranking file paths is
 * shallow work; understanding an implementation is judgement, and judgement belongs to the model.
 *
 * Sources are health-gated. A reference implementation is advice to imitate someone's code, so
 * pointing at an abandoned or deprecated repo would be actively harmful -- the reader would copy
 * patterns from a project that lost its maintainers years ago.
 */

/** Below this, a repo is not something to learn from. */
const MIN_HEALTH_SCORE = 55;

export interface ReferenceOptions {
  /** Vet and use exactly these packages, skipping search. */
  packages?: string[];
  /** Extra package names to consider alongside search results. */
  seeds?: string[];
  ecosystem?: Ecosystem;
  /** Max repositories to reference. */
  limit?: number;
  /** Max files to surface per repository. */
  filesPerSource?: number;
  /** Include sources that fail the health gate, saying why they failed. */
  includeUnhealthy?: boolean;
}

function isUsableSource(evidence: PackageEvidence): boolean {
  if (evidence.deprecated?.is) return false;
  if (evidence.repo?.archived) return false;
  if (evidence.health.flags.includes('known-vulnerability')) return false;
  return evidence.health.score >= MIN_HEALTH_SCORE;
}

/** Why a candidate was rejected, phrased for the report. */
function rejection(evidence: PackageEvidence): string {
  if (evidence.deprecated?.is) return 'deprecated by its maintainers';
  if (evidence.repo?.archived) return 'repository is archived';
  if (evidence.health.flags.includes('known-vulnerability')) return 'has a published advisory';
  return `health ${evidence.health.score}/100, below the ${MIN_HEALTH_SCORE} needed to be worth imitating`;
}

async function buildSource(
  evidence: PackageEvidence,
  query: string,
  filesPerSource: number,
): Promise<ReferenceSource | undefined> {
  const slug = evidence.repo?.slug;
  if (!slug) return undefined;

  const tree = await fetchRepoTree(slug);
  if (!tree) return undefined;

  const ranked = rankFiles(tree.entries, query, { limit: filesPerSource, packageName: evidence.name });

  const source: ReferenceSource = {
    package: evidence.name,
    slug: tree.slug,
    commit: tree.commit,
    defaultBranch: tree.defaultBranch,
    health: {
      score: evidence.health.score,
      grade: evidence.health.grade,
      summary: evidence.health.summary,
    },
    license: evidence.license ?? null,
    files: ranked.map((f) => ({
      path: f.path,
      // Pinned to the commit, never the branch: a blob/main link silently changes meaning.
      url: `https://github.com/${tree.slug}/blob/${tree.commit}/${f.path}`,
      size: f.size,
      reasons: f.reasons,
    })),
  };
  if (evidence.version) source.version = evidence.version;

  if (ranked.length === 0) {
    source.note = tree.truncated
      ? 'No file matched the query, and this repository is large enough that GitHub truncated its file listing.'
      : 'No file path matched the query, so nothing specific could be pointed at. Start from the entry point in package.json.';
  } else if (tree.truncated) {
    source.note = 'GitHub truncated this repository\'s file listing, so a better match may exist outside what was searched.';
  }

  return source;
}

export async function findReferences(query: string, opts: ReferenceOptions = {}): Promise<ReferenceReport> {
  const {
    packages,
    seeds = [],
    ecosystem = 'npm',
    limit = 3,
    filesPerSource = 4,
    includeUnhealthy = false,
  } = opts;
  const notes: string[] = [];

  let names: string[];
  if (packages && packages.length > 0) {
    names = packages;
  } else {
    if (ecosystem !== 'npm') {
      notes.push(`Search is npm-only in this version; pass ${ecosystem} packages explicitly with --package.`);
    }
    const searched = ecosystem === 'npm' ? await searchNpm(query, Math.max(limit * 3, 8)) : [];
    names = [...seeds, ...searched.map((s) => s.name)];
  }

  const unique = [...new Set(names.map((n) => n.trim()).filter(Boolean))];
  if (unique.length === 0) {
    notes.push('No candidate packages found for this query.');
    return { tool: { name: TOOL_NAME, version: TOOL_VERSION }, query, generatedAt: new Date().toISOString(), sources: [], notes };
  }

  // Gather evidence on more candidates than we need, because the health gate will reject some.
  const evidence = await gatherEvidence(unique.slice(0, Math.max(limit * 3, 6)), ecosystem);

  const healthy = evidence.filter(isUsableSource).sort((a, b) => b.health.score - a.health.score);
  const rejected = evidence.filter((e) => !isUsableSource(e));

  const chosen = includeUnhealthy
    ? [...healthy, ...rejected].slice(0, limit)
    : healthy.slice(0, limit);

  if (chosen.length === 0 && rejected.length > 0) {
    notes.push(
      `No healthy reference found. Rejected: ${rejected.map((r) => `${r.name} (${rejection(r)})`).join('; ')}. Copying patterns from an unmaintained project is worse than having no reference.`,
    );
  }
  if (!includeUnhealthy && chosen.length > 0 && rejected.length > 0) {
    notes.push(`Skipped as not worth imitating: ${rejected.map((r) => `${r.name} (${rejection(r)})`).join('; ')}.`);
  }

  const built = await mapLimit(chosen, 2, (e) => buildSource(e, query, filesPerSource));
  const sources = built.filter((s): s is ReferenceSource => s !== undefined);

  const missingRepo = chosen.length - sources.length;
  if (missingRepo > 0) {
    notes.push(`${missingRepo} candidate(s) had no readable GitHub repository, so no permalink could be produced for them.`);
  }
  if (sources.length > 0 && !(await isAuthenticated())) {
    notes.push('Running unauthenticated against the GitHub API (60 requests/hour). Set GITHUB_TOKEN or run `gh auth login` for 5,000/hour.');
  }

  return {
    tool: { name: TOOL_NAME, version: TOOL_VERSION },
    query,
    generatedAt: new Date().toISOString(),
    sources,
    notes,
  };
}
