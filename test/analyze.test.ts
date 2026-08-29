import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyzeFile, rankCandidates } from '../src/scan/analyze.ts';
import { DETECTORS } from '../src/scan/detectors/index.ts';
import type { SourceFile } from '../src/scan/walk.ts';

function file(rel: string, source: string): SourceFile {
  const lines = source.split('\n');
  return { abs: `/tmp/${rel}`, rel, ext: rel.slice(rel.lastIndexOf('.')), bytes: source.length, lines };
}

const HAND_ROLLED_RETRY = `
export async function callApi(url) {
  const maxRetries = 3;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fetch(url);
    } catch (err) {
      const backoff = Math.pow(2, attempt) * 100;
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
}
`;

test('detects hand-rolled retry with backoff', () => {
  const found = analyzeFile(file('src/api.ts', HAND_ROLLED_RETRY));
  const retry = found.find((c) => c.detectorId === 'retry-backoff');
  assert.ok(retry, 'expected retry-backoff to fire');
  assert.equal(retry.capability, 'retry with exponential backoff');
  assert.ok(retry.signalsHit.includes('retry-vocab'));
  assert.ok(retry.signalsHit.includes('backoff-math'));
  assert.ok(retry.lines.length > 0);
  assert.ok(retry.excerpts.every((e) => /^\d+: /.test(e)), 'excerpts should be line-numbered');
});

test('required signals suppress generic matches', () => {
  // A loop, a setTimeout and the word "attempt" -- but no backoff maths, which is required.
  const noBackoff = file('src/poll.ts', `
    let attempt = 0;
    while (attempt < 5) {
      attempt++;
      setTimeout(tick, 1000);
    }
  `);
  const found = analyzeFile(noBackoff).filter((c) => c.detectorId === 'retry-backoff');
  assert.equal(found.length, 0, 'retry-backoff must not fire without backoff maths');
});

test('a decisive signal fires on its own', () => {
  const found = analyzeFile(file('src/clone.ts', 'const copy = JSON.parse(JSON.stringify(input));'));
  const clone = found.find((c) => c.detectorId === 'deep-clone');
  assert.ok(clone, 'expected deep-clone to fire on the JSON round-trip alone');
  assert.equal(clone.confidence, 'high');
  assert.match(clone.note ?? '', /^CORRECTNESS/);
});

test('import lines and comments are ignored', () => {
  const imported = file('src/x.ts', `
    import debounce from 'lodash.debounce';
    // const timer = setTimeout(() => debounce(fn), 10);
    export const handler = debounce;
  `);
  const found = analyzeFile(imported).filter((c) => c.detectorId === 'debounce-throttle');
  assert.equal(found.length, 0, 'matches inside imports and comments must not count');
});

test('signals far apart are not treated as one implementation', () => {
  const filler = Array.from({ length: 120 }, (_, i) => `const filler${i} = ${i};`).join('\n');
  const split = file('src/split.ts', `const slug = 'x';\n${filler}\nname.toLowerCase().replace(/a/, 'b');`);
  const found = analyzeFile(split).filter((c) => c.detectorId === 'slugify');
  assert.equal(found.length, 0, 'signals 120 lines apart belong to different code');
});

test('non-matching extensions are skipped', () => {
  const found = analyzeFile(file('README.md', 'const copy = JSON.parse(JSON.stringify(x));'));
  assert.equal(found.length, 0);
});

test('ranking puts high confidence and security detectors first', () => {
  const mixed = analyzeFile(file('src/mixed.ts', `
    const id = Math.random().toString(36).slice(2);
    const copy = JSON.parse(JSON.stringify(input));
  `));
  const ranked = rankCandidates(mixed, DETECTORS.map((d) => d.id));
  assert.ok(ranked.length >= 2);
  assert.equal(ranked[0]?.detectorId, 'insecure-random-id', 'security findings rank above correctness ones');
});
