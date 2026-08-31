import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { GAPS, gapById } from '../src/gaps/catalog.ts';
import { evaluateGap, findGaps } from '../src/gaps/gaps.ts';
import type { GapEvidence, Language, Trait } from '../src/gaps/gap-types.ts';
import { readPythonShape } from '../src/gaps/profile.ts';
import { PY_SOURCE_SIGNALS } from '../src/gaps/signals-python.ts';
import { maskPythonLine } from '../src/gaps/mask-python.ts';
import type { SourceFile } from '../src/scan/walk.ts';

/** Evidence with traits attributed to one language only, which is what scoping is tested on. */
function evidenceFor(language: Language, traits: Trait[], over: Partial<GapEvidence> = {}): GapEvidence {
  const own = new Set<Trait>([...traits, language]);
  const other: Language = language === 'python' ? 'javascript' : 'python';
  return {
    traits: new Set(own),
    traitsByLanguage: new Map<Language, Set<Trait>>([
      [language, own],
      [other, new Set<Trait>()],
    ]),
    deps: new Set(),
    rootFiles: new Set(),
    allFiles: new Set(),
    sourceSignals: new Set(),
    signalSites: new Map(),
    ...over,
  };
}

async function project(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'codeisotope-pygaps-'));
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    await mkdir(join(abs, '..'), { recursive: true });
    await writeFile(abs, body, 'utf8');
  }
  return root;
}

const FLASK_APP = [
  'from flask import Flask, request',
  '',
  'app = Flask(__name__)',
  '',
  '@app.post("/login")',
  'def login():',
  '    email = request.json["email"]',
  '    return {"email": email}',
  '',
  'app.run(debug=True)',
].join('\n');

// --- language scoping ------------------------------------------------------------------------

test('a Python service is never told to write a Node SIGTERM handler', async () => {
  const root = await project({ 'requirements.txt': 'flask==3.0.0\n', 'app.py': FLASK_APP });
  const report = await findGaps(root);
  const ids = report.missing.map((m) => m.gapId);

  assert.ok(report.profile.traits.includes('python'));
  assert.ok(!ids.includes('no-graceful-shutdown'), 'that gap prescribes process.on, which Python has not got');
  assert.ok(!ids.includes('unhandled-rejection'));
  assert.ok(!ids.includes('no-security-headers'), 'helmet is an npm package');
  // Every reported gap must belong to Python.
  for (const id of ids) {
    assert.equal(gapById(id)?.language, 'python', `${id} is not a Python gap`);
  }
});

test('a JavaScript service is never told to configure gunicorn', async () => {
  const root = await project({
    'package.json': JSON.stringify({ name: 'api', private: true, dependencies: { express: '^4' } }),
    'server.js': ["import express from 'express';", 'const app = express();', 'app.listen(3000);'].join('\n'),
  });
  const ids = (await findGaps(root)).missing.map((m) => m.gapId);
  assert.ok(!ids.includes('py-no-production-server'));
  assert.ok(!ids.includes('py-debug-enabled'));
  for (const id of ids) {
    assert.equal(gapById(id)?.language, 'javascript', `${id} is not a JavaScript gap`);
  }
});

test('a Flask API beside a React frontend gets Python advice only', async () => {
  // The contamination bug: `http-server` was earned by Python and `javascript` by package.json, and
  // one global trait set combined them into Node server advice for a frontend with no server at all.
  const root = await project({
    'requirements.txt': 'flask==3.0.0\nrequests==2.31.0\n',
    'package.json': JSON.stringify({ name: 'web', private: true, dependencies: { react: '^18.3.1' } }),
    'api/app.py': FLASK_APP,
    'web/index.js': "import React from 'react';\nexport default function App() { return null; }\n",
  });

  const report = await findGaps(root);
  const ids = report.missing.map((m) => m.gapId);

  assert.ok(report.profile.traits.includes('python'));
  assert.ok(report.profile.traits.includes('javascript'));
  assert.ok(report.profile.traits.includes('frontend'));
  assert.ok(ids.some((id) => id.startsWith('py-')), 'the Flask side must still be judged');
  assert.ok(
    !ids.includes('no-graceful-shutdown'),
    'the JavaScript side is a React frontend, so it has no server to shut down',
  );
  assert.ok(!ids.includes('no-request-timeout'), 'requests is a Python dependency, not a fetch call');
});

test('a language-scoped gap needs its own language present, not merely its traits', () => {
  const gap = gapById('py-no-healthcheck');
  assert.ok(gap);
  // Traits earned by JavaScript must not satisfy a Python gap.
  assert.equal(evaluateGap(gap, evidenceFor('javascript', ['http-routes'])).kind, 'not-applicable');
  assert.equal(evaluateGap(gap, evidenceFor('python', ['http-routes'])).kind, 'missing');
});

// --- the two Python-specific gaps -------------------------------------------------------------

test('DEBUG hardcoded to True is a high-severity finding', async () => {
  const root = await project({ 'requirements.txt': 'flask==3.0.0\n', 'app.py': FLASK_APP });
  const found = (await findGaps(root)).missing.find((m) => m.gapId === 'py-debug-enabled');
  assert.ok(found, 'DEBUG = True must be reported');
  assert.equal(found.severity, 'high');
  assert.match(found.why, /debugger|interactive/i, 'the reason must name the actual exposure');
});

test('DEBUG read from the environment is not a finding', async () => {
  const root = await project({
    'requirements.txt': 'flask==3.0.0\n',
    'app.py': [
      'import os',
      'from flask import Flask',
      'app = Flask(__name__)',
      'DEBUG = bool(os.environ.get("DEBUG"))',
      'app.run(debug=DEBUG)',
    ].join('\n'),
  });
  const report = await findGaps(root);
  assert.ok(!report.missing.some((m) => m.gapId === 'py-debug-enabled'), 'reading it from env is the fix');
  assert.ok(report.satisfied.some((s) => s.gapId === 'py-debug-enabled'));
});

test('a missing production server is reported, and gunicorn satisfies it', async () => {
  const withoutServer = await project({ 'requirements.txt': 'flask==3.0.0\n', 'app.py': FLASK_APP });
  assert.ok((await findGaps(withoutServer)).missing.some((m) => m.gapId === 'py-no-production-server'));

  const withServer = await project({ 'requirements.txt': 'flask==3.0.0\ngunicorn==22.0.0\n', 'app.py': FLASK_APP });
  const report = await findGaps(withServer);
  assert.ok(!report.missing.some((m) => m.gapId === 'py-no-production-server'));
  assert.ok(report.satisfied.some((s) => s.gapId === 'py-no-production-server'));
});

test('Python has no separate shutdown gap, because the WSGI server owns it', () => {
  // Documented reasoning, asserted so it cannot drift: the production-server gap says so explicitly.
  const shutdownGaps = GAPS.filter((g) => g.language === 'python' && /shutdown|sigterm/i.test(g.capability));
  assert.deepEqual(shutdownGaps, []);
  assert.match(gapById('py-no-production-server')?.why ?? '', /SIGTERM/);
});

// --- the translated gaps ----------------------------------------------------------------------

test('request.json used without a schema is reported', async () => {
  const root = await project({ 'requirements.txt': 'flask==3.0.0\n', 'app.py': FLASK_APP });
  const found = (await findGaps(root)).missing.find((m) => m.gapId === 'py-no-input-validation');
  assert.ok(found, 'reading request.json straight into use must be reported');
  assert.ok(found.citations.length > 0, 'a claim with no citation is unverifiable');
  assert.match(found.citations[0]?.text ?? '', /request\.json/);
});

test('pydantic satisfies Python request validation', async () => {
  const root = await project({
    'requirements.txt': 'fastapi==0.115.0\npydantic==2.9.0\n',
    'app.py': ['from fastapi import FastAPI', 'app = FastAPI()', 'x = request.json'].join('\n'),
  });
  const report = await findGaps(root);
  assert.ok(!report.missing.some((m) => m.gapId === 'py-no-input-validation'));
});

test('a BaseModel in source satisfies validation even without the dependency listed', async () => {
  const root = await project({
    'requirements.txt': 'flask==3.0.0\n',
    'app.py': [
      'from flask import Flask, request',
      'app = Flask(__name__)',
      '',
      'class LoginIn(BaseModel):',
      '    email: str',
      '',
      '@app.post("/login")',
      'def login():',
      '    data = LoginIn.model_validate(request.json)',
      '    return {"ok": True}',
    ].join('\n'),
  });
  const report = await findGaps(root);
  assert.ok(!report.missing.some((m) => m.gapId === 'py-no-input-validation'));
});

test('requests without a timeout is reported, and timeout= satisfies it', async () => {
  const without = await project({
    'requirements.txt': 'requests==2.31.0\n',
    'client.py': ['import requests', 'r = requests.get("https://api.example.com")'].join('\n'),
  });
  assert.ok((await findGaps(without)).missing.some((m) => m.gapId === 'py-no-request-timeout'));

  const with_ = await project({
    'requirements.txt': 'requests==2.31.0\n',
    'client.py': ['import requests', 'r = requests.get("https://api.example.com", timeout=5)'].join('\n'),
  });
  assert.ok(!(await findGaps(with_)).missing.some((m) => m.gapId === 'py-no-request-timeout'));
});

test('a Python lockfile satisfies the pinned-dependency gap', async () => {
  const without = await project({ 'requirements.txt': 'flask==3.0.0\n', 'app.py': FLASK_APP });
  const reported = (await findGaps(without)).missing.find((m) => m.gapId === 'py-no-dependency-lockfile');
  assert.ok(reported);
  // The advice must be Python tooling, not npm.
  assert.ok(reported.knownSolutions.some((s) => /uv|poetry|pip-compile|pdm/.test(s)), reported.knownSolutions.join(', '));
  assert.ok(!reported.knownSolutions.some((s) => /npm|yarn|pnpm/.test(s)));

  const withLock = await project({
    'requirements.txt': 'flask==3.0.0\n',
    'uv.lock': 'version = 1\n',
    'app.py': FLASK_APP,
  });
  assert.ok(!(await findGaps(withLock)).missing.some((m) => m.gapId === 'py-no-dependency-lockfile'));
});

test('print() for diagnostics is reported, and logging satisfies it', async () => {
  const withPrint = await project({
    'requirements.txt': 'flask==3.0.0\n',
    'app.py': [
      'from flask import Flask',
      'app = Flask(__name__)',
      '@app.get("/x")',
      'def x():',
      '    print("handled a request")',
      '    return {}',
    ].join('\n'),
  });
  assert.ok((await findGaps(withPrint)).missing.some((m) => m.gapId === 'py-no-structured-logging'));

  const withLogging = await project({
    'requirements.txt': 'flask==3.0.0\n',
    'app.py': [
      'import logging',
      'from flask import Flask',
      'logger = logging.getLogger(__name__)',
      'app = Flask(__name__)',
      '@app.get("/x")',
      'def x():',
      '    print("noisy")',
      '    logger.info("handled a request")',
      '    return {}',
    ].join('\n'),
  });
  assert.ok(!(await findGaps(withLogging)).missing.some((m) => m.gapId === 'py-no-structured-logging'));
});

test('a /health route satisfies the Python health check gap', async () => {
  const root = await project({
    'requirements.txt': 'flask==3.0.0\n',
    'app.py': [
      'from flask import Flask',
      'app = Flask(__name__)',
      '',
      '@app.get("/health")',
      'def health():',
      '    return {"ok": True}',
    ].join('\n'),
  });
  const report = await findGaps(root);
  assert.ok(!report.missing.some((m) => m.gapId === 'py-no-healthcheck'));
  assert.ok(report.satisfied.some((s) => s.gapId === 'py-no-healthcheck'));
});

test('pydantic-settings satisfies Python env validation', async () => {
  const root = await project({
    'requirements.txt': 'flask==3.0.0\npydantic-settings==2.5.0\n',
    'app.py': ['import os', 'from flask import Flask', 'PORT = os.environ.get("PORT")'].join('\n'),
  });
  assert.ok(!(await findGaps(root)).missing.some((m) => m.gapId === 'py-no-env-validation'));
});

// --- shapes that must NOT be judged as services -----------------------------------------------

test('a Python CLI is not told it needs a health check or a WSGI server', async () => {
  const root = await project({
    'pyproject.toml': [
      '[project]',
      'name = "mytool"',
      'version = "0.1.0"',
      '',
      '[project.scripts]',
      'mytool = "mytool.cli:main"',
    ].join('\n'),
    'uv.lock': 'version = 1\n',
    'mytool/cli.py': ['import sys', 'def main():', '    print(sys.argv)'].join('\n'),
  });

  const report = await findGaps(root);
  const ids = report.missing.map((m) => m.gapId);
  assert.ok(report.profile.traits.includes('cli'), report.profile.traits.join(', '));
  assert.ok(!ids.includes('py-no-healthcheck'), ids.join(', '));
  assert.ok(!ids.includes('py-no-production-server'), ids.join(', '));
  assert.ok(!ids.includes('py-no-input-validation'), ids.join(', '));
  assert.ok(!ids.includes('py-debug-enabled'), ids.join(', '));
});

test('a console script and a __main__ module both make a Python project a CLI', () => {
  const files = [{ rel: 'pkg/__main__.py' } as SourceFile];
  assert.equal(readPythonShape(undefined, files)?.hasConsoleScript, true);
  assert.equal(
    readPythonShape('[project]\nname = "x"\n\n[project.scripts]\nx = "x:main"\n', [])?.hasConsoleScript,
    true,
  );
  assert.equal(readPythonShape('[project]\nname = "x"\n', [])?.hasConsoleScript, false);
  assert.equal(readPythonShape('[project]\nname = "x"\n', [])?.isPackaged, true);
});

// --- Python gap signals -----------------------------------------------------------------------

test('a docstring mentioning DEBUG does not set DEBUG', () => {
  const signal = PY_SOURCE_SIGNALS.find((s) => s.name === 'py-debug-true');
  assert.ok(signal);
  assert.ok(signal.re.test(maskPythonLine('app.run(debug=True)').masked));
  // Prose describing the risk is not the risk.
  assert.ok(!signal.re.test(maskPythonLine('# never ship debug=True').masked));
  assert.ok(!signal.re.test(maskPythonLine('DEBUG_HELP = "set debug=True locally"').masked));
});

test('every Python gap signal is reachable from a plausible line of Python', () => {
  // Guards against a signal that can never match, which would silently disable its gap.
  const samples: Record<string, string> = {
    'py-flask-app': 'from flask import Flask',
    'py-fastapi-app': 'app = FastAPI()',
    'py-run-server': 'app.run(port=5000)',
    'py-request-data': 'email = request.json["email"]',
    'py-db-client': 'conn = sqlite3.connect("db.sqlite")',
    'py-password-use': 'user.check_password(password)',
    'py-outbound-http': 'r = requests.get(url)',
    'py-http-timeout': 'r = requests.get(url, timeout=5)',
    'py-worker': 'result = task.apply_async()',
    'py-env-read': 'port = os.environ.get("PORT")',
    'py-schema-validation': 'data = LoginIn.model_validate(payload)',
    'py-structured-log': 'logger.info("started")',
    'py-print-call': 'print("hello")',
    'py-debug-true': 'app.run(debug=True)',
    'py-debug-from-env': 'DEBUG = os.environ.get("DEBUG")',
  };
  for (const [name, line] of Object.entries(samples)) {
    const signal = PY_SOURCE_SIGNALS.find((s) => s.name === name);
    assert.ok(signal, `no signal named ${name}`);
    const view = maskPythonLine(line);
    const subject = signal.codeOnly ? view.masked : view.code;
    assert.ok(signal.re.test(subject), `${name} failed to match its own call site: ${line}`);
  }
});
