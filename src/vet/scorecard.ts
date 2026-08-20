import { tryJson } from '../lib/http.ts';

const API = 'https://api.securityscorecards.dev';

interface ScorecardResponse {
  date?: string;
  score?: number;
  checks?: Array<{ name?: string; score?: number; reason?: string }>;
}

export interface ScorecardFacts {
  score: number;
  date: string;
  weakChecks: Array<{ name: string; score: number }>;
}

/** Checks whose failure says something about whether the project is safe to depend on. */
const CHECKS_WE_REPORT = new Set([
  'Maintained', 'Code-Review', 'Vulnerabilities', 'Dependency-Update-Tool',
  'Branch-Protection', 'Signed-Releases', 'Binary-Artifacts', 'Dangerous-Workflow', 'Token-Permissions',
]);

/**
 * OpenSSF Scorecard: free, no key, precomputed for most notable repos.
 * A miss is normal (the repo is simply not in their corpus) and is reported as a gap, not a failure.
 */
export async function fetchScorecard(slug: string): Promise<ScorecardFacts | undefined> {
  const res = await tryJson<ScorecardResponse>(`${API}/projects/github.com/${slug}`, { ttlMs: 24 * 60 * 60 * 1000 });
  if (res?.score === undefined) return undefined;
  const weakChecks = (res.checks ?? [])
    .flatMap((c) => (c.name && CHECKS_WE_REPORT.has(c.name) && typeof c.score === 'number' && c.score >= 0 && c.score < 5
      ? [{ name: c.name, score: c.score }]
      : []))
    .sort((a, b) => a.score - b.score);
  return { score: res.score, date: res.date ?? '', weakChecks };
}
