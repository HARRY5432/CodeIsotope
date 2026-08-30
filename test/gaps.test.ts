import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { GAPS, gapById } from '../src/gaps/catalog.ts';
import { evaluateGap, findGaps, worstSeverity } from '../src/gaps/gaps.ts';
import { SOURCE_SIGNALS, type GapEvidence } from '../src/gaps/gap-types.ts';
import { maskFileLines, maskLiterals } from '../src/gaps/mask.ts';
import { buildEvidence, readPackageShape } from '../src/gaps/profile.ts';

function evidence(over: Partial<GapEvidence> = {}): GapEvidence {
  return {
    traits: new Set(),
    deps: new Set(),
    rootFiles: new Set(),
    allFiles: new Set(),
    sourceSignals: new Set(),
    signalSites: new Map(),
    ...over,
  };
}

/** Write a project tree and return its root. */
async function project(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'codeisotope-gaps-'));
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    await mkdir(join(abs, '..'), { recursive: true });
    await writeFile(abs, body, 'utf8');
  }
  return root;
}

// --- masking -------------------------------------------------------------------------------

test('a string literal cannot satisfy a code-only signal', () => {
  // The bug this prevents: our own catalog lists 'AbortSignal.timeout (built-in)' as a solution,
  // and the timeout signal matched it, so the tool reported its own catalog as an implementation.
  const line = `knownSolutions: ['AbortSignal.timeout (built-in)', 'undici'],`;
  assert.doesNotMatch(maskLiterals(line), /AbortSignal\.timeout/);
  assert.match(line, /AbortSignal\.timeout/, 'the raw line does contain it, which is the point');
});

test('masking preserves line length so columns stay meaningful', () => {
  for (const line of [`const a = 'hello';`, 'const re = /ab+c/gi;', `x("a", 'b', \`c\`)`]) {
    assert.equal(maskLiterals(line).length, line.length, line);
  }
});

test('a regex literal is masked, and division is not mistaken for one', () => {
  assert.doesNotMatch(maskLiterals(`{ re: /password|secret/i }`), /password/);
  // If `/` after a value were treated as a regex, everything after it would be blanked.
  assert.match(maskLiterals('const half = total / count; const name = ident;'), /ident/);
});

test('comments are never evidence, on any view', () => {
  const views = maskFileLines([
    '// process.on("SIGTERM") would go here',
    '/* app.listen(3000) */',
    'const real = 1;',
  ]);
  assert.doesNotMatch(views[0]?.code ?? '', /SIGTERM/);
  assert.doesNotMatch(views[1]?.code ?? '', /listen/);
  assert.match(views[2]?.code ?? '', /real/);
});

test('a multi-line block comment stays masked across lines', () => {
  const views = maskFileLines(['/*', ' * app.listen(3000)', ' */', 'const after = 2;']);
  assert.doesNotMatch(views[1]?.code ?? '', /listen/);
  assert.match(views[3]?.code ?? '', /after/);
});

test('a multi-line template body stays masked across lines', () => {
  // The real case: cli.ts holds its HELP text in a template literal spanning 30 lines, and the
  // words "rate limit" inside it satisfied the rate-limiting signal.
  const views = maskFileLines(['const HELP = `', '  raise the rate limit from 60/hour', '`;', 'const x = 1;']);
  assert.doesNotMatch(views[1]?.code ?? '', /rate limit/);
  assert.match(views[3]?.code ?? '', /x = 1/);
});

test('a test fixture containing server code does not make the project a server', () => {
  // This file is the case in point: it contains the literal line `"import express from 'express'"`
  // inside a fixture, and CodeIsotope reported itself as an http-server on the strength of it.
  const views = maskFileLines([`'src/server.js': "import express from 'express';",`]);
  const express = SOURCE_SIGNALS.find((s) => s.name === 'express-app');
  assert.ok(express);
  const subject = express.codeOnly ? (views[0]?.masked ?? '') : (views[0]?.code ?? '');
  const fires = express.re.test(subject) && (!express.literalRe || express.literalRe.test(views[0]?.code ?? ''));
  assert.equal(fires, false, 'a module name quoted inside a fixture string is not an import');
});

test('a real import still registers after the fixture fix', () => {
  const views = maskFileLines([`import express from 'express';`]);
  const express = SOURCE_SIGNALS.find((s) => s.name === 'express-app');
  assert.ok(express);
  const subject = express.codeOnly ? (views[0]?.masked ?? '') : (views[0]?.code ?? '');
  assert.ok(express.re.test(subject) && (express.literalRe?.test(views[0]?.code ?? '') ?? true));
});

test('every code-only signal survives masking of a real call site', () => {
  // Guards against a signal that can only ever match inside a string -- which would make it dead.
  const samples: Record<string, string> = {
    'node-http-server': 'const server = createServer(handler);',
    'listen-call': 'server.listen(3000);',
    'request-body': 'const body = req.body;',
    'env-read': 'const dir = process.env.HOME;',
    'console-log': 'console.log(x);',
    'outbound-fetch': 'const r = await fetch(url);',
  };
  for (const [name, line] of Object.entries(samples)) {
    const signal = SOURCE_SIGNALS.find((s) => s.name === name);
    assert.ok(signal, `no signal named ${name}`);
    assert.match(maskLiterals(line), signal.re, `${name} failed to match its own call site`);
  }
});

// --- gap evaluation ------------------------------------------------------------------------

test('a gap is not applicable when the project has none of its traits', () => {
  const gap = gapById('no-security-headers');
  assert.ok(gap);
  assert.deepEqual(evaluateGap(gap, evidence({ traits: new Set(['cli']) })), { kind: 'not-applicable' });
});

test('a dependency that solves the gap marks it satisfied, not missing', () => {
  const gap = gapById('no-security-headers');
  assert.ok(gap);
  const out = evaluateGap(gap, evidence({ traits: new Set(['http-routes']), deps: new Set(['helmet']) }));
  assert.equal(out.kind, 'satisfied');
});

test('a gap with requiresSignals stays quiet until the narrower evidence appears', () => {
  const gap = gapById('no-rate-limit');
  assert.ok(gap);
  // An internal service with routes but no auth endpoint does not need rate limiting reported.
  assert.equal(evaluateGap(gap, evidence({ traits: new Set(['http-routes']) })).kind, 'not-applicable');
  assert.equal(
    evaluateGap(gap, evidence({ traits: new Set(['http-routes']), sourceSignals: new Set(['auth-route']) })).kind,
    'missing',
  );
});

test('every gap in the catalog is reachable and self-consistent', () => {
  const signalNames = new Set(SOURCE_SIGNALS.map((s) => s.name));
  const ids = new Set<string>();
  for (const gap of GAPS) {
    assert.ok(!ids.has(gap.id), `duplicate gap id ${gap.id}`);
    ids.add(gap.id);
    assert.ok(gap.appliesWhen.length > 0, `${gap.id} applies to nothing, so it can never fire`);
    assert.ok(gap.knownSolutions.length > 0, `${gap.id} names no solution`);
    assert.ok(gap.why.length > 80, `${gap.id} does not explain the concrete failure`);
    for (const s of [...(gap.requiresSignals ?? []), ...(gap.satisfiedBySignals ?? [])]) {
      assert.ok(signalNames.has(s), `${gap.id} references unknown signal "${s}"`);
    }
  }
});

// --- profiling -----------------------------------------------------------------------------

test('package.json shape distinguishes a CLI, a library and a private app', () => {
  assert.equal(readPackageShape('{"bin":{"x":"cli.js"}}')?.hasBin, true);
  assert.equal(readPackageShape('{"main":"index.js"}')?.isPrivate, false);
  assert.equal(readPackageShape('{"private":true,"main":"i.js"}')?.isPrivate, true);
  // A start script running a bundler dev server is not a long-running service.
  assert.equal(readPackageShape('{"scripts":{"start":"vite"}}')?.hasStartScript, false);
  assert.equal(readPackageShape('{"scripts":{"start":"node server.js"}}')?.hasStartScript, true);
  assert.equal(readPackageShape('not json'), undefined);
});

test('traits are earned from evidence, not assumed', () => {
  const built = buildEvidence({
    manifests: [{ ecosystem: 'npm', file: 'package.json', dependencies: { express: '^4' }, devDependencies: {} }],
    files: [],
    rootEntries: ['Dockerfile', 'package.json'],
  });
  assert.ok(built.traits.has('http-server'), 'express implies a server');
  assert.ok(built.traits.has('containerised'), 'a Dockerfile implies a container');
  assert.ok(!built.traits.has('frontend'), 'nothing here implies a browser bundle');
});

// --- end to end ----------------------------------------------------------------------------

test('a service with no infrastructure reports the high-severity gaps first', async () => {
  const root = await project({
    'package.json': JSON.stringify({ name: 'api', private: true, dependencies: { express: '^4.19.2' }, scripts: { start: 'node src/server.js' } }),
    'src/server.js': [
      "import express from 'express';",
      'const app = express();',
      "app.post('/login', async (req, res) => {",
      '  const { email } = req.body;',
      "  console.log('attempt', email);",
      '  res.json({ ok: true });',
      '});',
      'app.listen(3000);',
    ].join('\n'),
  });

  const report = await findGaps(root);
  const ids = report.missing.map((m) => m.gapId);

  assert.ok(report.profile.traits.includes('http-server'));
  assert.ok(ids.includes('no-graceful-shutdown'), ids.join(', '));
  assert.ok(ids.includes('no-input-validation'), ids.join(', '));
  assert.ok(ids.includes('no-rate-limit'), 'a /login route must trigger rate limiting');
  assert.ok(ids.includes('no-dependency-lockfile'), 'no lockfile was written');
  // Severity order, and every high-severity gap ahead of every medium one.
  const firstMedium = report.missing.findIndex((m) => m.severity === 'medium');
  const lastHigh = report.missing.map((m) => m.severity).lastIndexOf('high');
  if (firstMedium !== -1) assert.ok(lastHigh < firstMedium, 'high-severity gaps must sort first');
  assert.equal(worstSeverity(report), 'high');
});

test('a CLI tool is not told it needs security headers or a health check', async () => {
  const root = await project({
    'package.json': JSON.stringify({ name: 'tool', bin: { tool: 'cli.js' } }),
    'package-lock.json': '{"lockfileVersion":3}',
    'cli.js': "const args = process.argv.slice(2);\nconsole.log('hi', args);\n",
  });

  const report = await findGaps(root);
  const ids = report.missing.map((m) => m.gapId);
  assert.ok(report.profile.traits.includes('cli'));
  assert.ok(!ids.includes('no-security-headers'), ids.join(', '));
  assert.ok(!ids.includes('no-healthcheck'), ids.join(', '));
  assert.ok(!ids.includes('no-rate-limit'), ids.join(', '));
  assert.ok(!ids.includes('no-graceful-shutdown'), 'a CLI does not receive SIGTERM from an orchestrator');
  assert.ok(!ids.includes('no-dependency-lockfile'), 'the lockfile is present');
});

test('a project that already handles a gap has it reported as handled, with the site', async () => {
  const root = await project({
    'package.json': JSON.stringify({ name: 'api', private: true, dependencies: { express: '^4' }, scripts: { start: 'node s.js' } }),
    'package-lock.json': '{"lockfileVersion":3}',
    's.js': [
      "import express from 'express';",
      'const app = express();',
      'const server = app.listen(3000);',
      "process.on('SIGTERM', () => server.close());",
      "process.on('unhandledRejection', (e) => { throw e; });",
    ].join('\n'),
  });

  const report = await findGaps(root);
  const handled = report.satisfied.map((s) => s.gapId);
  assert.ok(handled.includes('no-graceful-shutdown'), report.satisfied.map((s) => s.gapId).join(', '));
  assert.ok(handled.includes('unhandled-rejection'));
  const shutdown = report.satisfied.find((s) => s.gapId === 'no-graceful-shutdown');
  assert.match(shutdown?.by ?? '', /s\.js:4/, 'the claim must cite where it is handled');
});

test('a project whose kind cannot be established reports nothing and says why', async () => {
  const root = await project({ 'notes.txt': 'just some notes' });
  const report = await findGaps(root);
  assert.deepEqual(report.missing, []);
  assert.deepEqual(report.profile.traits, []);
  assert.ok(report.notes.some((n) => /could not establish/i.test(n)), report.notes.join(' | '));
});

test('reported gaps cite the source line that justified them', async () => {
  const root = await project({
    'package.json': JSON.stringify({ name: 'api', private: true, dependencies: { express: '^4' } }),
    'package-lock.json': '{}',
    'r.js': ["import express from 'express';", "app.post('/items', (req, res) => res.json(req.body));"].join('\n'),
  });
  const report = await findGaps(root);
  const validation = report.missing.find((m) => m.gapId === 'no-input-validation');
  assert.ok(validation, report.missing.map((m) => m.gapId).join(', '));
  assert.ok(validation.citations.length > 0, 'a claim with no citation is unverifiable');
  assert.equal(validation.citations[0]?.file, 'r.js');
  assert.match(validation.citations[0]?.text ?? '', /req\.body/);
});

test('--include-not-applicable explains what was skipped and what it would need', async () => {
  const root = await project({
    'package.json': JSON.stringify({ name: 'tool', bin: { tool: 'c.js' } }),
    'c.js': 'console.log(1);',
  });
  const quiet = await findGaps(root);
  const verbose = await findGaps(root, { includeNotApplicable: true });
  assert.equal(quiet.notApplicable.length, 0);
  assert.ok(verbose.notApplicable.length > 0);
  assert.ok(verbose.notApplicable.every((n) => n.needsTraits.length > 0));
});
