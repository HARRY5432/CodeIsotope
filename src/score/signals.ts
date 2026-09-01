import type { Ecosystem, HealthSignal, RepoEvidence, SignalVerdict } from '../lib/types.ts';

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
 *
 * `lastPublishedAt` is the registry's own release date, used only when there is no readable
 * repository at all. Older PyPI packages frequently link nowhere, and without this the maintenance
 * signal went `unknown` and dropped out of the average -- which scored `nose` at B/70 despite its
 * last release being 2015. A release date is weaker evidence than commit history, but "published
 * eleven years ago" is emphatically not unknown.
 */
export function maintenanceSignal(repo: RepoEvidence | undefined, lastPublishedAt?: string): HealthSignal {
  if (!repo) {
    const publishedAge = daysSince(lastPublishedAt);
    if (publishedAge === undefined) return signal('Maintenance', 25, 'unknown', 'no linked repository to check');
    const years = (publishedAge / 365).toFixed(1);
    const months = Math.floor(publishedAge / 30);
    if (publishedAge <= 180) {
      return signal('Maintenance', 25, 'ok', `no linked repository; newest release published ${months} month(s) ago`);
    }
    if (publishedAge <= 540) {
      return signal('Maintenance', 25, 'weak', `no linked repository; newest release published ${months} months ago`);
    }
    return signal('Maintenance', 25, 'bad', `no linked repository; newest release published ${years} years ago -- effectively unmaintained`);
  }
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

export function releaseSignal(repo: RepoEvidence | undefined, lastPublishedAt?: string): HealthSignal {
  if (!repo) {
    // Same reasoning as maintenance: the registry's own publish date is real evidence about
    // cadence even when no repository is linked.
    const days = daysSince(lastPublishedAt);
    if (days === undefined) return signal('Release cadence', 15, 'unknown', 'no linked repository to check');
    const months = Math.floor(days / 30);
    if (days <= 365) return signal('Release cadence', 15, 'ok', `newest release published ${months} month(s) ago`);
    if (days <= 730) return signal('Release cadence', 15, 'weak', `no release in ${months} months`);
    return signal('Release cadence', 15, 'bad', `no release in ${(days / 365).toFixed(1)} years`);
  }
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

/**
 * Adoption thresholds, per ecosystem.
 *
 * Download counts are not comparable across registries and treating them as if they were produces
 * nonsense: `requests` records ~297M PyPI downloads a week, while a thriving npm package sits
 * around 1M, because PyPI counts every CI mirror pull and npm does not. One global threshold would
 * either flatter every Python package to "de facto standard" or condemn every healthy Rust crate.
 */
const ADOPTION_TIERS: Record<Ecosystem, { standard: number; strong: number; ok: number; weak: number }> = {
  // npm publishes true weekly installs and the ecosystem is enormous.
  npm: { standard: 1_000_000, strong: 100_000, ok: 10_000, weak: 1_000 },
  // PyPI counts mirrors and CI aggressively, so the same tiers sit roughly 20x higher.
  pypi: { standard: 20_000_000, strong: 2_000_000, ok: 200_000, weak: 20_000 },
  // crates.io reports a 90-day count, normalised to a nominal week before it reaches here.
  cargo: { standard: 2_000_000, strong: 200_000, ok: 20_000, weak: 2_000 },
  // The Go proxy publishes no download counts at all; these exist only so the type is total.
  go: { standard: 1_000_000, strong: 100_000, ok: 10_000, weak: 1_000 },
  maven: { standard: 1_000_000, strong: 100_000, ok: 10_000, weak: 1_000 },
  nuget: { standard: 1_000_000, strong: 100_000, ok: 10_000, weak: 1_000 },
  rubygems: { standard: 1_000_000, strong: 100_000, ok: 10_000, weak: 1_000 },
};

/**
 * How many published packages depend on this one. Unlike downloads this *is* portable, so the
 * thresholds are shared: it measures what an ecosystem chose to build on rather than how often a
 * mirror pulled a tarball.
 */
function dependentsVerdict(direct: number): { verdict: SignalVerdict; note: string } {
  if (direct >= 10_000) return { verdict: 'good', note: 'de facto standard' };
  if (direct >= 1_000) return { verdict: 'good', note: 'widely depended on' };
  if (direct >= 100) return { verdict: 'ok', note: '' };
  if (direct >= 10) return { verdict: 'weak', note: 'modest adoption' };
  return { verdict: 'bad', note: 'almost nothing depends on this' };
}

export function adoptionSignal(
  weeklyDownloads: number | undefined,
  repo: RepoEvidence | undefined,
  ecosystem: Ecosystem = 'npm',
  dependents?: { direct?: number; total?: number },
): HealthSignal {
  // Dependents first where we have them: it is the only adoption measure that means the same thing
  // in every ecosystem, so it keeps cross-ecosystem scores honest.
  const direct = dependents?.direct;
  if (direct !== undefined && direct > 0) {
    const { verdict, note } = dependentsVerdict(direct);
    const suffix = note ? ` -- ${note}` : '';
    const downloads = weeklyDownloads !== undefined ? `, ${weeklyDownloads.toLocaleString('en-US')} downloads/week` : '';
    return signal('Adoption', 20, verdict, `${direct.toLocaleString('en-US')} packages depend on this${downloads}${suffix}`);
  }

  const tiers = ADOPTION_TIERS[ecosystem];
  if (weeklyDownloads !== undefined) {
    const pretty = weeklyDownloads.toLocaleString('en-US');
    if (weeklyDownloads >= tiers.standard) return signal('Adoption', 20, 'good', `${pretty} downloads/week -- de facto standard`);
    if (weeklyDownloads >= tiers.strong) return signal('Adoption', 20, 'good', `${pretty} downloads/week`);
    if (weeklyDownloads >= tiers.ok) return signal('Adoption', 20, 'ok', `${pretty} downloads/week`);
    if (weeklyDownloads >= tiers.weak) return signal('Adoption', 20, 'weak', `${pretty} downloads/week -- modest adoption`);
    return signal('Adoption', 20, 'bad', `${pretty} downloads/week -- you would be an early adopter`);
  }
  if (!repo) return signal('Adoption', 20, 'unknown', 'no download, dependent or star data available');
  const stars = repo.stars.toLocaleString('en-US');
  if (repo.stars >= 5_000) return signal('Adoption', 20, 'good', `${stars} stars`);
  if (repo.stars >= 500) return signal('Adoption', 20, 'ok', `${stars} stars`);
  if (repo.stars >= 50) return signal('Adoption', 20, 'weak', `${stars} stars -- small user base`);
  return signal('Adoption', 20, 'bad', `${stars} stars -- essentially unproven`);
}

/**
 * Concentration of commits among the top contributors.
 *
 * The naive reading of a high share is wrong for small projects, and it produced a real false
 * positive: `tenacity` has two active maintainers and is perfectly healthy, but "top 3 are 83% of
 * commits" scored it `weak`. With three contributors the top three are *by definition* 100% of
 * commits -- the metric is measuring the sample size, not a risk.
 *
 * So concentration only means something once there are enough contributors for it to vary. Below
 * that, the honest signal is the contributor count itself: one person is a genuine risk, two or
 * three is a small team, and neither is inferable from a percentage.
 */
export function busFactorSignal(repo: RepoEvidence | undefined): HealthSignal {
  const share = repo?.contributors.busFactorTop3Share;
  const total = repo?.contributors.total;
  if (share === undefined) return signal('Bus factor', 15, 'unknown', 'contributor breakdown unavailable');
  const pct = Math.round(share * 100);
  const sample = total !== undefined ? ` (top ${total} contributors sampled)` : '';

  if (total === 1) {
    return signal('Bus factor', 15, 'bad', `a single contributor accounts for every commit${sample}`);
  }
  // With four or fewer contributors, the top-3 share is arithmetic rather than evidence.
  if (total !== undefined && total <= 4) {
    return signal(
      'Bus factor',
      15,
      'ok',
      `${total} contributors, so the top-3 share is not meaningful -- a small team, not a concentration risk`,
    );
  }

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
