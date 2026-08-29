import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { declaredDeps, worstVerdict } from '../src/audit/audit.ts';
import { bareName, classifyDep, compareDeps, maintainerSuggestion, replacementSearchTerms } from '../src/audit/verdict.ts';
import { renderAuditReport } from '../src/lib/render.ts';
import { readManifests } from '../src/scan/manifests.ts';
import { scoreHealth } from '../src/score/health.ts';
import type { AuditReport, AuditedDep, DepKind, PackageEvidence, RepoEvidence } from '../src/lib/types.ts';

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

/** Build evidence with a real health verdict, so classification is tested against real scoring. */
function evidence(overrides: Partial<PackageEvidence> & { repo?: RepoEvidence } = {}): PackageEvidence {
  const r = 'repo' in overrides ? overrides.repo : repo();
  const health = scoreHealth({
    ...(r ? { repo: r } : {}),
    weeklyDownloads: overrides.downloads?.weekly ?? 2_000_000,
    ...(overrides.deprecated ? { deprecated: overrides.deprecated } : {}),
    advisories: [],
    license: overrides.license === undefined ? 'MIT' : overrides.license,
    scorecardScore: 8,
  });
  return {
    name: 'widget',
    ecosystem: 'npm',
    license: 'MIT',
    health,
    gaps: [],
    ...overrides,
    ...(r ? { repo: r } : {}),
  };
}

test('an actively maintained dependency is healthy and gets no search terms', () => {
  const { verdict, reasons } = classifyDep(evidence(), 'direct');
  assert.equal(verdict, 'healthy');
  assert.equal(reasons.length, 1);
  assert.match(reasons[0] ?? '', /actively maintained/);
});

test('deprecation alone forces a replace verdict', () => {
  const dep = evidence({ deprecated: { is: true, reason: 'request has been deprecated' } });
  const { verdict, reasons } = classifyDep(dep, 'direct');
  assert.equal(verdict, 'replace');
  assert.match(reasons[0] ?? '', /deprecated by its maintainers/);
});

test('an archived repo forces replace even while commits look recent', () => {
  const dep = evidence({ repo: repo({ archived: true }) });
  const { verdict, reasons } = classifyDep(dep, 'direct');
  assert.equal(verdict, 'replace');
  assert.ok(reasons.some((r) => /archived/.test(r)));
});

test('abandonment is graded on real commit age, not the last push to any branch', () => {
  // A bot pushing to a side branch yesterday must not rescue a repo dead for three years.
  const dep = evidence({ repo: repo({ commits: { last90d: 0, lastCommitAt: iso(1_100) }, pushedAt: iso(1) }) });
  const { verdict, reasons } = classifyDep(dep, 'direct');
  assert.equal(verdict, 'replace');
  assert.ok(reasons.some((r) => /effectively unmaintained/.test(r)), reasons.join(' | '));
});

test('dev dependencies are graded more leniently than runtime ones', () => {
  const stale = { repo: repo({ commits: { last90d: 0, lastCommitAt: iso(600) }, pushedAt: iso(600) }) };
  const asDirect = classifyDep(evidence(stale), 'direct');
  const asDev = classifyDep(evidence(stale), 'dev');
  assert.equal(asDirect.verdict, 'weak');
  assert.equal(asDev.verdict, 'aging');
});

test('a missing licence is a problem in its own right', () => {
  const dep = evidence({ license: null, repo: repo({ license: null }) });
  const { verdict, reasons } = classifyDep(dep, 'direct');
  assert.equal(verdict, 'weak');
  assert.ok(reasons.some((r) => /licence/.test(r)));
});

test('a package with no linked repository cannot be called healthy', () => {
  const dep = evidence({ repo: undefined });
  const { verdict, reasons } = classifyDep(dep, 'direct');
  assert.equal(verdict, 'weak');
  assert.ok(reasons.some((r) => /maintenance cannot be verified/.test(r)));
});

test('maintainer suggestions are parsed from the phrasings npm actually uses', () => {
  assert.deepEqual(
    maintainerSuggestion('This module is no longer maintained, try this instead: npm i nyc'),
    { name: 'nyc', builtIn: false },
  );
  assert.deepEqual(
    maintainerSuggestion('use String.prototype.padStart()'),
    { name: 'String.prototype.padStart()', builtIn: true },
  );
  assert.deepEqual(maintainerSuggestion('replaced by @scope/thing'), { name: '@scope/thing', builtIn: false });
  // A bare issue link names no replacement, and must not be mistaken for one.
  assert.equal(maintainerSuggestion('request has been deprecated, see https://github.com/request/request/issues/3142'), undefined);
  assert.equal(maintainerSuggestion(undefined), undefined);
});

test('a built-in suggestion is not offered as something to search npm for', () => {
  const dep = evidence({
    name: 'left-pad',
    description: 'String left pad',
    deprecated: { is: true, reason: 'use String.prototype.padStart()' },
  });
  const terms = replacementSearchTerms(dep);
  assert.ok(!terms.some((t) => t.includes('padStart')), `built-in leaked into search terms: ${terms.join(' | ')}`);
});

test('search terms drop the package own name so search does not anchor on it', () => {
  const dep = evidence({ name: 'async-retry', description: 'Retrying made simple, easy and async' });
  const terms = replacementSearchTerms(dep);
  assert.ok(terms.length > 0);
  assert.ok(!(terms[0] ?? '').includes('async-retry'));
});

test('bareName strips the npm scope', () => {
  assert.equal(bareName('@node-rs/argon2'), 'argon2');
  assert.equal(bareName('papaparse'), 'papaparse');
});

function auditedDep(name: string, verdict: AuditedDep['verdict'], score: number, kind: DepKind = 'direct'): AuditedDep {
  const dep = evidence({ name });
  return { name, kind, range: '^1.0.0', manifest: 'package.json', verdict, reasons: ['because'], evidence: { ...dep, health: { ...dep.health, score } } };
}

test('the report is ordered worst-first, then by health score', () => {
  const deps = [
    auditedDep('healthy-one', 'healthy', 90),
    auditedDep('aging-one', 'aging', 60),
    auditedDep('replace-better', 'replace', 40),
    auditedDep('replace-worse', 'replace', 10),
    auditedDep('weak-one', 'weak', 50),
  ].sort(compareDeps);
  assert.deepEqual(deps.map((d) => d.name), ['replace-worse', 'replace-better', 'weak-one', 'aging-one', 'healthy-one']);
});

test('worstVerdict reports the single worst verdict present', () => {
  const base: Omit<AuditReport, 'deps'> = {
    tool: { name: 'reporadar', version: '0.2.0' },
    root: '/tmp/x',
    ecosystem: 'npm',
    generatedAt: iso(0),
    totals: { audited: 0, healthy: 0, aging: 0, weak: 0, replace: 0 },
    unresolved: [],
    notes: [],
  };
  assert.equal(worstVerdict({ ...base, deps: [] }), undefined);
  assert.equal(worstVerdict({ ...base, deps: [auditedDep('a', 'healthy', 90)] }), 'healthy');
  assert.equal(
    worstVerdict({ ...base, deps: [auditedDep('a', 'healthy', 90), auditedDep('b', 'aging', 60), auditedDep('c', 'weak', 40)] }),
    'weak',
  );
});

test('declaredDeps prefers the runtime declaration when a package is in both lists', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'reporadar-audit-'));
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({ dependencies: { alpha: '^1.0.0' }, devDependencies: { alpha: '^2.0.0', beta: '^3.0.0' } }),
    'utf8',
  );
  const deps = declaredDeps(await readManifests(dir));
  assert.deepEqual(
    deps.map((d) => `${d.name}:${d.kind}:${d.range}`),
    ['alpha:direct:^1.0.0', 'beta:dev:^3.0.0'],
  );
});

test('a UTF-8 BOM does not make a project look dependency-free', async () => {
  // Windows editors write a BOM routinely, and JSON.parse throws on it.
  const dir = await mkdtemp(join(tmpdir(), 'reporadar-bom-'));
  await writeFile(join(dir, 'package.json'), `\uFEFF${JSON.stringify({ dependencies: { alpha: '^1.0.0' } })}`, 'utf8');
  const deps = declaredDeps(await readManifests(dir));
  assert.deepEqual(deps.map((d) => d.name), ['alpha']);
});

test('the rendered report leads with problems and lists healthy deps compactly', () => {
  const report: AuditReport = {
    tool: { name: 'reporadar', version: '0.2.0' },
    root: '/tmp/x',
    ecosystem: 'npm',
    generatedAt: iso(0),
    totals: { audited: 3, healthy: 2, aging: 0, weak: 0, replace: 1 },
    deps: [
      {
        ...auditedDep('request', 'replace', 25),
        reasons: ['deprecated by its maintainers'],
        maintainerSuggestion: { name: 'undici', builtIn: false },
        searchTerms: ['http client'],
      },
      auditedDep('lru-cache', 'healthy', 92),
      auditedDep('papaparse', 'healthy', 88),
    ],
    unresolved: [{ name: 'private-thing', kind: 'direct', reason: 'package not found on the registry' }],
    notes: ['a note'],
  };
  const text = renderAuditReport(report);
  assert.match(text, /replace/);
  assert.match(text, /maintainer says use: undici/);
  assert.match(text, /reporadar vet "http client"/);
  assert.match(text, /Healthy: lru-cache, papaparse/);
  assert.match(text, /Could not verify: private-thing/);
  assert.match(text, /a note/);
  // The healthy ones must not get a full block each.
  assert.doesNotMatch(text, /healthy {2}lru-cache/);
});
