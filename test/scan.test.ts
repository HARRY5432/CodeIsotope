import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { collectDependencyNames, primaryEcosystem, readManifests } from '../src/scan/manifests.ts';
import { buildFingerprint } from '../src/scan/fingerprint.ts';
import { walkSource } from '../src/scan/walk.ts';
import { githubSlug } from '../src/vet/npm.ts';

async function fixture(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'codeisotope-test-'));
  for (const [rel, content] of Object.entries(files)) {
    const path = join(root, rel);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, content, 'utf8');
  }
  return root;
}

const RETRY_SOURCE = `
export async function get(url) {
  const retries = 3;
  for (let attempt = 0; attempt < retries; attempt++) {
    try { return await fetch(url); }
    catch { await new Promise((r) => setTimeout(r, Math.pow(2, attempt) * 50)); }
  }
}
`;

test('reads package.json dependencies across all dependency kinds', async () => {
  const root = await fixture({
    'package.json': JSON.stringify({
      dependencies: { zod: '^3.0.0' },
      devDependencies: { typescript: '^5.0.0' },
      peerDependencies: { react: '^19.0.0' },
    }),
  });
  const manifests = await readManifests(root);
  assert.equal(manifests.length, 1);
  assert.equal(primaryEcosystem(manifests), 'npm');
  const deps = collectDependencyNames(manifests);
  assert.deepEqual(deps.direct, ['react', 'zod']);
  assert.deepEqual(deps.dev, ['typescript']);
  assert.ok(deps.all.has('typescript'));
});

test('a malformed package.json degrades instead of throwing', async () => {
  const root = await fixture({ 'package.json': '{ this is not json' });
  const manifests = await readManifests(root);
  assert.equal(manifests.length, 1);
  assert.deepEqual(collectDependencyNames(manifests).direct, []);
});

test('walk skips ignored directories, lockfiles and minified bundles', async () => {
  const root = await fixture({
    'src/app.ts': 'export const a = 1;',
    'node_modules/pkg/index.js': 'module.exports = 1;',
    'dist/app.js': 'export const a = 1;',
    'package-lock.json': '{}',
    'src/vendor.min.js': 'var a=1;',
    'src/huge.js': `var x="${'y'.repeat(2_000)}";`,
  });
  const { files } = await walkSource(root, { extensions: new Set(['.ts', '.js', '.json']) });
  const seen = files.map((f) => f.rel).sort();
  assert.deepEqual(seen, ['src/app.ts']);
});

test('an existing dependency suppresses its detector', async () => {
  const withDep = await fixture({
    'package.json': JSON.stringify({ dependencies: { 'p-retry': '^8.0.0' } }),
    'src/api.ts': RETRY_SOURCE,
  });
  const fp = await buildFingerprint(withDep);
  assert.equal(fp.candidates.filter((c) => c.detectorId === 'retry-backoff').length, 0);
  const note = fp.suppressed.find((s) => s.detectorId === 'retry-backoff');
  assert.ok(note, 'suppression should be reported, not silent');
  assert.match(note.reason, /p-retry/);
});

test('--include-suppressed reports the finding anyway', async () => {
  const withDep = await fixture({
    'package.json': JSON.stringify({ dependencies: { 'p-retry': '^8.0.0' } }),
    'src/api.ts': RETRY_SOURCE,
  });
  const fp = await buildFingerprint(withDep, { includeSuppressed: true });
  assert.ok(fp.candidates.some((c) => c.detectorId === 'retry-backoff'));
});

test('fingerprint reports language mix and scan stats', async () => {
  const root = await fixture({ 'package.json': '{}', 'src/api.ts': RETRY_SOURCE, 'src/util.js': 'export const b = 2;' });
  const fp = await buildFingerprint(root);
  // package.json is read as a manifest, not walked as source, so only the two code files count.
  assert.equal(fp.scanned.files, 2);
  assert.ok(fp.scanned.durationMs >= 0);
  const names = fp.languages.map((l) => l.name);
  assert.ok(names.includes('TypeScript') && names.includes('JavaScript'));
  assert.ok(fp.candidates.some((c) => c.detectorId === 'retry-backoff'));
});

test('githubSlug handles the shapes npm repository fields actually take', () => {
  assert.equal(githubSlug('git+https://github.com/sindresorhus/p-retry.git'), 'sindresorhus/p-retry');
  assert.equal(githubSlug('https://github.com/acme/widget#readme'), 'acme/widget');
  assert.equal(githubSlug('git@github.com:acme/widget.git'), 'acme/widget');
  assert.equal(githubSlug('https://gitlab.com/acme/widget'), undefined);
  assert.equal(githubSlug(undefined), undefined);
});
