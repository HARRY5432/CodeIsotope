import type { HealthSignal, RepoEvidence, SignalVerdict } from '../lib/types.ts';

const DAY_MS = 86_400_000;

const PERMISSIVE = /^(MIT|Apache-2\.0|BSD-2-Clause|BSD-3-Clause|ISC|0BSD|Unlicense|MIT-0|BlueOak-1\.0\.0|Zlib|CC0-1\.0)$/i;
const COPYLEFT = /^(GPL|AGPL|LGPL|MPL|EPL|CDDL|OSL|SSPL|BUSL)/i;

export function daysSince(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.floor((Date.now() - t) / DAY_MS) : undefined;
}

function signal(label: string, weight: number, verdict: SignalVerdict, detail: string): HealthSignal {
  return { label, verdict, detail, weight };
}

/**
 * Commit volume on the default branch is the honest measure of "is anyone still working on this".
 * GitHub's pushed_at counts activity on any branch, so it is only ever a fallback -- reporting it as
 * "last commit" is how tools end up claiming a repo is fresh when nothing has landed in a year.
 */
export function maintenanceSignal(repo: RepoEvidence | undefined): HealthSignal {
  if (!repo) return signal('Maintenance', 25, 'unknown', 'no linked repository to check');
  if (repo.archived) return signal('Maintenance', 25, 'bad', 'repository is archived or disabled by its owner');

  const commits90 = repo.commits.last90d;
  const commitAge = daysSince(repo.commits.lastCommitAt);
  const pushAge = daysSince(repo.pushedAt);

  if (commits90 !== undefined) {
    const recency = commits90 > 0 && commitAge !== undefined ? `, last commit ${commitAge} days ago` : '';
    const volume = commits90 >= 100 ? "100+" : String(commits90);
    if (commits90 >= 25) return signal('Maintenance', 25, 'good', `${volume} commits in the last 90 days${recency}`);
    if (commits90 >= 5) return signal('Maintenance', 25, 'ok', `${volume} commits in the last 90 days${recency}`);
    if (commits90 >= 1) return signal('Maintenance', 25, 'weak', `only ${volume} commit(s) in the last 90 days${recency}`);
    // The 90-day window is empty, so grade on the real last-commit age when we have it and fall
    // back to push activity only when we do not. Grading on pushed_at here would let a stale repo
    // look fresh because a bot pushed to a side branch.
    const staleAge = commitAge ?? pushAge;
    const staleNote = commitAge !== undefined
      ? `, last commit ${commitAge} days ago`
      : pushAge === undefined ? '' : `; last push to any branch ${pushAge} days ago`;
    const head = `no commits on the default branch in 90 days${staleNote}`;
    if (staleAge !== undefined && staleAge <= 180) {
      return signal('Maintenance', 25, 'weak', head);
    }
    return signal('Maintenance', 25, 'bad', `${head} -- effectively unmaintained`);
  }
  const age = commitAge ?? pushAge;
  if (age === undefined) return signal('Maintenance', 25, 'unknown', 'no commit or push date available');
  if (age <= 30) return signal('Maintenance', 25, 'good', `last activity ${age} days ago`);
  if (age <= 120) return signal('Maintenance', 25, 'ok', `last activity ${age} days ago`);
  if (age <= 400) return signal('Maintenance', 25, 'weak', `last activity ${age} days ago -- slowing down`);
  return signal('Maintenance', 25, 'bad', `last activity ${age} days ago -- effectively unmaintained`);
}

export function releaseSignal(repo: RepoEvidence | undefined): HealthSignal {
  if (!repo) return signal('Release cadence', 15, 'unknown', 'no linked repository to check');
  const count = repo.releases.countLast12mo;
  const latest = repo.releases.latestAt;
  if (count === undefined && latest === undefined) {
    return signal('Release cadence', 15, 'unknown', 'project does not publish GitHub releases');
  }
  const days = daysSince(latest);
  const suffix = days === undefined ? '' : `, latest ${repo.releases.latestTag ?? 'release'} ${days} days ago`;
  if ((count ?? 0) >= 4) return signal('Release cadence', 15, 'good', `${count} releases in the last 12 months${suffix}`);
  if ((count ?? 0) >= 1) return signal('Release cadence', 15, 'ok', `${count} release(s) in the last 12 months${suffix}`);
  return signal('Release cadence', 15, 'weak', `no releases in the last 12 months${suffix}`);
}

export function adoptionSignal(weeklyDownloads: number | undefined, repo: RepoEvidence | undefined): HealthSignal {
  if (weeklyDownloads !== undefined) {
    const pretty = weeklyDownloads.toLocaleString('en-US');
    if (weeklyDownloads >= 1_000_000) return signal('Adoption', 20, 'good', `${pretty} downloads/week -- de facto standard`);
    if (weeklyDownloads >= 100_000) return signal('Adoption', 20, 'good', `${pretty} downloads/week`);
    if (weeklyDownloads >= 10_000) return signal('Adoption', 20, 'ok', `${pretty} downloads/week`);
    if (weeklyDownloads >= 1_000) return signal('Adoption', 20, 'weak', `${pretty} downloads/week -- modest adoption`);
    return signal('Adoption', 20, 'bad', `${pretty} downloads/week -- you would be an early adopter`);
  }
  if (!repo) return signal('Adoption', 20, 'unknown', 'no download or star data available');
  const stars = repo.stars.toLocaleString('en-US');
  if (repo.stars >= 5_000) return signal('Adoption', 20, 'good', `${stars} stars`);
  if (repo.stars >= 500) return signal('Adoption', 20, 'ok', `${stars} stars`);
  if (repo.stars >= 50) return signal('Adoption', 20, 'weak', `${stars} stars -- small user base`);
  return signal('Adoption', 20, 'bad', `${stars} stars -- essentially unproven`);
}

export function busFactorSignal(repo: RepoEvidence | undefined): HealthSignal {
  const share = repo?.contributors.busFactorTop3Share;
  const total = repo?.contributors.total;
  if (share === undefined) return signal('Bus factor', 15, 'unknown', 'contributor breakdown unavailable');
  const pct = Math.round(share * 100);
  const sample = total !== undefined ? ` (top ${total} contributors sampled)` : '';
  if (total === 1) return signal('Bus factor', 15, 'bad', `a single contributor accounts for every commit${sample}`);
  if (share <= 0.6) return signal('Bus factor', 15, 'good', `top 3 contributors are ${pct}% of commits${sample}`);
  if (share <= 0.85) return signal('Bus factor', 15, 'ok', `top 3 contributors are ${pct}% of commits${sample}`);
  return signal('Bus factor', 15, 'weak', `top 3 contributors are ${pct}% of commits -- concentrated ownership${sample}`);
}

export function securitySignal(advisories: string[] | undefined, scorecardScore: number | undefined): HealthSignal {
  if (advisories && advisories.length > 0) {
    return signal('Security', 15, 'bad', `${advisories.length} known advisory/advisories on the current version: ${advisories.join(', ')}`);
  }
  if (scorecardScore === undefined) return signal('Security', 15, 'unknown', 'no OpenSSF Scorecard published for this repo');
  if (scorecardScore >= 7) return signal('Security', 15, 'good', `OpenSSF Scorecard ${scorecardScore}/10, no known advisories`);
  if (scorecardScore >= 5) return signal('Security', 15, 'ok', `OpenSSF Scorecard ${scorecardScore}/10, no known advisories`);
  return signal('Security', 15, 'weak', `OpenSSF Scorecard ${scorecardScore}/10 -- weak supply-chain practices`);
}

export function licenseSignal(license: string | null | undefined): HealthSignal {
  if (!license) return signal('License', 10, 'bad', 'no license detected -- legally unsafe to depend on');
  if (PERMISSIVE.test(license)) return signal('License', 10, 'good', `${license} (permissive)`);
  if (COPYLEFT.test(license)) return signal('License', 10, 'ok', `${license} -- copyleft, check it against your distribution model`);
  return signal('License', 10, 'ok', `${license} -- non-standard, worth a read`);
}
