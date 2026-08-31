import assert from 'node:assert/strict';
import { test } from 'node:test';
import { queryTerms, rankFiles, type RankableFile } from '../src/reference/rank.ts';

const f = (path: string, size = 4_000): RankableFile => ({ path, size });

// --- query parsing -------------------------------------------------------------------------

test('query terms drop stopwords and noise words', () => {
  const terms = queryTerms('how does the retry with exponential backoff work in node javascript');
  assert.ok(terms.includes('retry'));
  assert.ok(terms.includes('exponential'));
  assert.ok(terms.includes('backoff'));
  for (const noise of ['how', 'does', 'the', 'with', 'node', 'javascript']) {
    assert.ok(!terms.includes(noise), `"${noise}" should not be a search term`);
  }
});

test('an unusable query ranks nothing rather than guessing', () => {
  // No terms means no signal. Returning src/index.js anyway would look like an answer.
  assert.deepEqual(rankFiles([f('src/retry.ts')], 'the and for'), []);
  assert.deepEqual(rankFiles([f('src/retry.ts')], ''), []);
});

// --- what must never be offered as a reference ---------------------------------------------

test('tests, fixtures, samples and benchmarks are never references', () => {
  const files = [
    f('test/retry.test.js'),
    f('src/__tests__/retry.js'),
    f('spec/retry.spec.ts'),
    f('fixtures/retry.js'),
    f('examples/retry.js'),
    f('packages/csv-stringify/samples/option.quoted_string.js'),
    f('bench/retry.js'),
    f('docs/retry.md'),
  ];
  assert.deepEqual(rankFiles(files, 'retry'), []);
});

test('build output and type stubs are never references', () => {
  const files = [
    f('dist/retry.js'),
    f('build/retry.js'),
    f('umd/retry.js'),
    f('retry.min.js'),
    f('src/retry.d.ts'),
    f('coverage/retry.js'),
  ];
  assert.deepEqual(rankFiles(files, 'retry'), []);
});

test('build tooling is not an implementation', () => {
  // This was a real result: rollup.config.js outranked the actual parser for `csv-parse`.
  const files = [f('packages/csv-parse/rollup.config.js'), f('vite.config.ts'), f('jest.config.js')];
  assert.deepEqual(rankFiles(files, 'csv parser'), []);
});

// --- Python conventions ----------------------------------------------------------------------

test('a pytest test file is never offered as a reference implementation', () => {
  // The real result before this: a query for "retry" against tenacity ranked test_retry.py first --
  // a test file as the reference, teaching the reader the opposite of what they asked for. Every
  // exclusion rule had been written for JavaScript, and pytest names tests `test_*.py` or
  // `*_test.py`, never `*.test.py`.
  const files = [
    f('test_retry.py'),
    f('tests/test_retry.py'),
    f('retry_test.py'),
    f('conftest.py'),
  ];
  assert.deepEqual(rankFiles(files, 'retry'), []);
});

test('Python packaging and task-runner files are not implementations', () => {
  // The Python equivalent of a rollup config.
  const files = [f('setup.py'), f('manage.py'), f('noxfile.py'), f('tasks.py'), f('wsgi.py'), f('conf.py')];
  assert.deepEqual(rankFiles(files, 'setup manage config'), []);
});

test('a database migration is never a pattern to imitate', () => {
  // Generated schema history. It matches a capability query by accident of naming.
  const files = [f('pkg/migrations/0001_retry.py'), f('alembic/versions/abc_add_retry.py')];
  assert.deepEqual(rankFiles(files, 'retry'), []);
});

test('a virtualenv or build artefact is not the library source', () => {
  // `.venv` was already excluded by the dotfile rule; plain `venv` and the rest were not.
  const files = [
    f('venv/lib/python3.12/site-packages/urllib3/retry.py'),
    f('env/lib/retry.py'),
    f('__pycache__/retry.py'),
    f('mypkg.egg-info/retry.py'),
    f('src/retry.pyi'),
  ];
  assert.deepEqual(rankFiles(files, 'retry'), []);
});

test('the real Python implementation survives all of those exclusions', () => {
  // The rules must not be so broad that they take the answer with them.
  const ranked = rankFiles(
    [f('tests/test_retry.py'), f('conftest.py'), f('setup.py'), f('tenacity/retry.py', 9_000)],
    'retry',
  );
  assert.deepEqual(ranked.map((r) => r.path), ['tenacity/retry.py']);
});

test('__init__.py counts as a Python entry point', () => {
  // In a single-purpose package it often *is* the implementation, and it is where a reader orients.
  const ranked = rankFiles([f('pkg/__init__.py'), f('pkg/helpers.py')], 'retry backoff');
  assert.deepEqual(ranked.map((r) => r.path), ['pkg/__init__.py']);
  assert.ok(ranked[0]?.reasons.some((x) => /entry point/.test(x)));
});

// --- lib/ vs src/ --------------------------------------------------------------------------

test('lib/ is skipped only when a src/ sits beside it', () => {
  // Typical TypeScript project: lib/ is compiled output of src/.
  const compiled = rankFiles([f('src/retry.ts'), f('lib/retry.js')], 'retry');
  assert.deepEqual(compiled.map((r) => r.path), ['src/retry.ts']);

  // csv-parse ships its real source in lib/ and has no src/ at all.
  const authored = rankFiles([f('lib/retry.js')], 'retry');
  assert.deepEqual(authored.map((r) => r.path), ['lib/retry.js']);
});

test('the lib/ test is sibling-scoped, not repo-global', () => {
  // node-csv has demo/webpack/src/, which must not suppress packages/csv-parse/lib/.
  // A first cut asked "does the repo contain any src/ anywhere" and lost the real parser.
  const files = [
    f('demo/webpack/src/index.js'),
    f('packages/csv-parse/lib/api/index.js'),
  ];
  const ranked = rankFiles(files, 'csv parser', { packageName: 'csv-parse' });
  assert.deepEqual(ranked.map((r) => r.path), ['packages/csv-parse/lib/api/index.js']);
});

// --- monorepos -----------------------------------------------------------------------------

test('a monorepo reference stays inside the package being referenced', () => {
  // node-csv publishes csv-parse, csv-stringify and csv-generate from one repo. Files from the
  // stringifier are not a reference for the parser, at any score.
  const files = [
    f('packages/csv-stringify/lib/index.js'),
    f('packages/csv-generate/lib/index.js'),
    f('packages/csv-parse/lib/index.js'),
  ];
  const ranked = rankFiles(files, 'csv parser', { packageName: 'csv-parse' });
  assert.deepEqual(ranked.map((r) => r.path), ['packages/csv-parse/lib/index.js']);
});

test('a scoped package name resolves to its workspace directory', () => {
  const files = [f('packages/plainjs/src/JSON2CSVParser.js'), f('packages/node/src/index.js')];
  const ranked = rankFiles(files, 'csv', { packageName: '@json2csv/plainjs' });
  assert.ok(ranked.every((r) => r.path.startsWith('packages/plainjs/')), ranked.map((r) => r.path).join(', '));
});

test('a single-package repo is unaffected by the monorepo rule', () => {
  const ranked = rankFiles([f('src/retry.ts')], 'retry', { packageName: 'p-retry' });
  assert.deepEqual(ranked.map((r) => r.path), ['src/retry.ts']);
});

// --- ranking order -------------------------------------------------------------------------

test('a filename match outranks a directory match', () => {
  const ranked = rankFiles([f('src/backoff/helpers.ts'), f('src/util/backoff.ts')], 'backoff');
  assert.equal(ranked[0]?.path, 'src/util/backoff.ts');
});

test('related terms are matched, but score below a direct hit', () => {
  const ranked = rankFiles([f('src/jitter.ts'), f('src/backoff.ts')], 'backoff');
  assert.equal(ranked[0]?.path, 'src/backoff.ts');
  const jitter = ranked.find((r) => r.path === 'src/jitter.ts');
  assert.ok(jitter, 'jitter relates to backoff and should still appear');
  assert.ok((jitter.score ?? 0) < (ranked[0]?.score ?? 0));
});

test('an entry point surfaces even with no term match', () => {
  // In a single-purpose package the entry point often *is* the implementation.
  const ranked = rankFiles([f('index.js'), f('src/helpers.ts')], 'retry backoff');
  assert.deepEqual(ranked.map((r) => r.path), ['index.js']);
});

test('a shallower path wins a tie', () => {
  const ranked = rankFiles([f('src/a/b/c/retry.ts'), f('src/retry.ts')], 'retry');
  assert.equal(ranked[0]?.path, 'src/retry.ts');
});

test('a tiny re-export and a huge generated file are both penalised', () => {
  const ranked = rankFiles([f('src/retry.ts', 120), f('src/retry-impl.ts', 5_000)], 'retry');
  assert.equal(ranked[0]?.path, 'src/retry-impl.ts');
  const tiny = ranked.find((r) => r.path === 'src/retry.ts');
  assert.ok(tiny?.reasons.some((x) => /re-export/.test(x)));

  const huge = rankFiles([f('src/retry.ts', 400_000)], 'retry');
  assert.ok(huge[0]?.reasons.some((x) => /generated/.test(x)) ?? true);
});

test('every ranked file explains why it was chosen', () => {
  const ranked = rankFiles([f('src/backoff/ExponentialBackoff.ts')], 'exponential backoff');
  assert.ok(ranked.length > 0);
  for (const r of ranked) {
    assert.ok(r.reasons.length > 0, `${r.path} was ranked with no stated reason`);
    assert.ok(r.score > 0);
  }
});

test('relatedness is symmetric, so declaration order cannot hide a match', () => {
  // `jitter -> backoff` was declared without the reverse, so a query for "backoff" silently
  // missed a file named jitter.ts. The closure is now built both ways at load.
  const forward = rankFiles([f('src/jitter.ts')], 'backoff');
  const backward = rankFiles([f('src/backoff.ts')], 'jitter');
  assert.equal(forward.length, 1, 'a jitter file must be found by a backoff query');
  assert.equal(backward.length, 1, 'a backoff file must be found by a jitter query');
});

test('the limit is honoured', () => {
  const files = Array.from({ length: 20 }, (_, i) => f(`src/retry-${i}.ts`));
  assert.equal(rankFiles(files, 'retry', { limit: 3 }).length, 3);
});

test('a repo whose layout gives no signal yields nothing', () => {
  // Better to say "could not narrow this" than to point at an arbitrary file.
  const ranked = rankFiles([f('src/foo.ts'), f('src/bar.ts')], 'password hashing argon2');
  assert.deepEqual(ranked, []);
});
