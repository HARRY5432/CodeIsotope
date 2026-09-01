import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scoreHealth } from '../src/score/health.ts';
import { busFactorSignal } from '../src/score/signals.ts';
import type { RepoEvidence } from '../src/lib/types.ts';

const DAY = 86_400_000;
const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * DAY).toISOString();

function repo(overrides: Partial<RepoEvidence> = {}): RepoEvidence {
  return {
    slug: 'acme/widget',
    url: 'https://github.com/acme/widget',
    stars: 9_000,
    forks: 400,
    openIssues: 20,
    archived: false,
    isFork: false,
    createdAt: iso(2_000),
    pushedAt: iso(3),
    license: 'MIT',
    topics: [],
    releases: { latestTag: 'v2.0.0', latestAt: iso(20), countLast12mo: 8 },
    commits: { last90d: 60, lastCommitAt: iso(3) },
    contributors: { total: 10, busFactorTop3Share: 0.4 },
    ...overrides,
  };
}

test('a healthy, popular package grades A', () => {
  const v = scoreHealth({ repo: repo(), weeklyDownloads: 5_000_000, license: 'MIT', scorecardScore: 8.2, advisories: [] });
  assert.equal(v.grade, 'A');
  assert.ok(v.score >= 85, `expected >=85, got ${v.score}`);
  assert.deepEqual(v.flags, []);
});

test('deprecation caps the score regardless of popularity', () => {
  const v = scoreHealth({
    repo: repo(), weeklyDownloads: 40_000_000, license: 'MIT', scorecardScore: 9,
    deprecated: { is: true, reason: 'use undici instead' },
  });
  assert.ok(v.score <= 25, `expected <=25, got ${v.score}`);
  assert.ok(v.flags.includes('deprecated'));
  assert.match(v.summary, /Deprecated/);
  assert.match(v.summary, /use undici instead/);
});

test('an archived repo is capped and flagged', () => {
  const v = scoreHealth({ repo: repo({ archived: true }), weeklyDownloads: 8_000_000, license: 'MIT' });
  assert.ok(v.score <= 30, `expected <=30, got ${v.score}`);
  assert.ok(v.flags.includes('archived'));
  assert.match(v.summary, /archived/);
});

test('a known advisory caps the score and is named', () => {
  const v = scoreHealth({ repo: repo(), weeklyDownloads: 9_000_000, license: 'MIT', advisories: ['GHSA-p8p7-x288-28g6'] });
  assert.ok(v.score <= 40, `expected <=40, got ${v.score}`);
  assert.ok(v.flags.includes('known-vulnerability'));
  const security = v.signals.find((s) => s.label === 'Security');
  assert.match(security?.detail ?? '', /GHSA-p8p7-x288-28g6/);
});

test('unknown signals are excluded rather than counted as failures', () => {
  // No repo and no scorecard: only adoption and licence are known, and both are good.
  const partial = scoreHealth({ weeklyDownloads: 3_000_000, license: 'MIT' });
  const full = scoreHealth({ repo: repo(), weeklyDownloads: 3_000_000, license: 'MIT', scorecardScore: 8.2, advisories: [] });
  assert.ok(partial.score >= 95, `missing data must not punish the score, got ${partial.score}`);
  assert.ok(partial.signals.some((s) => s.verdict === 'unknown'));
  assert.ok(full.score >= 85);
});

test('no evidence at all yields a zero score and a flag', () => {
  const v = scoreHealth({ license: undefined });
  assert.ok(v.flags.includes('no-license'));
  assert.equal(v.grade, 'F');
});

test('a single maintainer is flagged even when everything else is fine', () => {
  const v = scoreHealth({
    repo: repo({ contributors: { total: 1, busFactorTop3Share: 1 } }),
    weeklyDownloads: 2_000_000, license: 'MIT', scorecardScore: 8,
  });
  assert.ok(v.flags.includes('single-maintainer'));
});

test('a small team is not a concentration risk', () => {
  // Real false positive: tenacity has two active maintainers and is perfectly healthy, but
  // "top 3 contributors are 83% of commits" scored it weak. With three contributors the top three
  // are by definition 100% of commits -- the metric was measuring sample size, not risk.
  for (const total of [2, 3, 4]) {
    const signal = busFactorSignal(repo({ contributors: { total, busFactorTop3Share: 1 } }));
    assert.equal(signal.verdict, 'ok', `${total} contributors should not be weak`);
    assert.match(signal.detail, /not meaningful/);
  }
});

test('one contributor is still a genuine risk', () => {
  const signal = busFactorSignal(repo({ contributors: { total: 1, busFactorTop3Share: 1 } }));
  assert.equal(signal.verdict, 'bad');
});

test('concentration is judged once there are enough contributors for it to vary', () => {
  assert.equal(busFactorSignal(repo({ contributors: { total: 12, busFactorTop3Share: 0.95 } })).verdict, 'weak');
  assert.equal(busFactorSignal(repo({ contributors: { total: 12, busFactorTop3Share: 0.8 } })).verdict, 'ok');
  assert.equal(busFactorSignal(repo({ contributors: { total: 12, busFactorTop3Share: 0.5 } })).verdict, 'good');
});

test('a missing license is treated as a hard problem', () => {
  const v = scoreHealth({ repo: repo({ license: null }), weeklyDownloads: 2_000_000, license: null, scorecardScore: 8 });
  assert.ok(v.flags.includes('no-license'));
  const licence = v.signals.find((s) => s.label === 'License');
  assert.equal(licence?.verdict, 'bad');
});

test('a stale repo reports the true last-commit age, not the last push', () => {
  const v = scoreHealth({ repo: repo({ commits: { last90d: 0, lastCommitAt: iso(400) }, pushedAt: iso(5) }), weeklyDownloads: 1_000 });
  const maintenance = v.signals.find((s) => s.label === 'Maintenance');
  assert.equal(maintenance?.verdict, 'bad');
  assert.match(maintenance?.detail ?? '', /last commit 400 days ago/);
  assert.doesNotMatch(maintenance?.detail ?? '', /last push/);
});
