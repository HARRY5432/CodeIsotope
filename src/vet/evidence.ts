import { mapLimit } from '../lib/http.ts';
import type { Ecosystem, PackageEvidence, VetReport } from '../lib/types.ts';
import { scoreHealth } from '../score/health.ts';
import { fetchDepsDev } from './depsdev.ts';
import { fetchRepoEvidence, isAuthenticated } from './github.ts';
import { enrichNpmCandidates, githubSlug, searchNpm, type NpmCandidate } from './npm.ts';
import { fetchScorecard } from './scorecard.ts';

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

async function gatherOne(candidate: NpmCandidate, ecosystem: Ecosystem): Promise<PackageEvidence> {
  const gaps: string[] = [];

  const depsDev = await fetchDepsDev(ecosystem, candidate.name);
  if (!depsDev) gaps.push('deps.dev has no record for this package');

  const slug = depsDev?.githubSlug ?? githubSlug(candidate.repoUrl);
  const repo = slug ? await fetchRepoEvidence(slug, candidate.name) : undefined;
  if (!slug) gaps.push('no GitHub repository linked from package metadata');
  else if (!repo) gaps.push(`GitHub repo ${slug} could not be read (renamed, private, or deleted)`);

  const scorecard = slug ? await fetchScorecard(slug) : undefined;
  if (slug && !scorecard) gaps.push('no OpenSSF Scorecard published for this repo');

  const license = candidate.license ?? depsDev?.licenses?.[0] ?? repo?.license ?? null;
  const deprecated = depsDev?.deprecated?.is ? depsDev.deprecated : (candidate.deprecated ?? depsDev?.deprecated);
  const advisories = depsDev?.advisories ?? [];

  const health = scoreHealth({
    ...(repo ? { repo } : {}),
    ...(candidate.downloads?.weekly !== undefined ? { weeklyDownloads: candidate.downloads.weekly } : {}),
    ...(deprecated ? { deprecated } : {}),
    advisories,
    license,
    ...(scorecard ? { scorecardScore: scorecard.score } : {}),
  });

  const evidence: PackageEvidence = { name: candidate.name, ecosystem, license, health, gaps };
  if (candidate.description) evidence.description = candidate.description;
  const version = depsDev?.defaultVersion ?? candidate.version;
  if (version) evidence.version = version;
  if (candidate.homepage) evidence.homepage = candidate.homepage;
  if (deprecated) evidence.deprecated = deprecated;
  if (candidate.downloads) evidence.downloads = candidate.downloads;
  if (candidate.dependentsCount !== undefined) evidence.dependentsCount = candidate.dependentsCount;
  if (repo) evidence.repo = repo;
  if (scorecard) evidence.scorecard = scorecard;
  return evidence;
}

/**
 * Turn a capability description (or an explicit package list) into ranked, evidence-backed candidates.
 * Every field comes from a public API -- nothing here is inferred or generated.
 */
export async function vet(query: string, opts: VetOptions = {}): Promise<VetReport> {
  const { ecosystem = 'npm', seeds = [], exact, limit = 6 } = opts;
  const notes: string[] = [];

  const { packages: seedPackages, builtIns } = splitSeeds(seeds);
  for (const builtIn of builtIns) {
    notes.push(`Platform built-in available: ${builtIn} -- prefer this over any dependency if it covers the use case.`);
  }

  let names: string[];
  if (exact && exact.length > 0) {
    names = exact;
  } else {
    const searched = ecosystem === 'npm' ? await searchNpm(query, Math.max(limit, 8)) : [];
    if (ecosystem !== 'npm') {
      notes.push(`Search is npm-only in this version; ${ecosystem} packages must be passed explicitly with --package.`);
    }
    // Seeds first: they are curated answers, and search results fill the rest of the slate.
    names = [...seedPackages, ...searched.map((s) => s.name)];
  }

  const unique = [...new Set(names.map((n) => n.trim()).filter(Boolean))].slice(0, limit);
  if (unique.length === 0) {
    notes.push('No candidate packages found for this query.');
    return { tool: { name: 'reporadar', version: '0.1.0' }, query, ecosystem, generatedAt: new Date().toISOString(), candidates: [], notes };
  }

  const enriched = await enrichNpmCandidates(unique.map((name) => ({ name })));
  const candidates = await mapLimit(enriched, 3, (c) => gatherOne(c, ecosystem));

  // Scores within a few points of each other are not meaningfully different, so adoption breaks
  // the tie: between two equally healthy libraries, the one the ecosystem already standardised on
  // has more StackOverflow answers, more transitive compatibility, and a cheaper migration.
  candidates.sort((a, b) => {
    const gap = b.health.score - a.health.score;
    if (Math.abs(gap) > 5) return gap;
    return (b.downloads?.weekly ?? 0) - (a.downloads?.weekly ?? 0);
  });

  if (!(await isAuthenticated())) {
    notes.push('Running unauthenticated against the GitHub API (60 requests/hour). Set GITHUB_TOKEN or run `gh auth login` for 5,000/hour and more complete evidence.');
  }

  return { tool: { name: 'reporadar', version: '0.1.0' }, query, ecosystem, generatedAt: new Date().toISOString(), candidates, notes };
}
