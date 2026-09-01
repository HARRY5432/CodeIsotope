import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { decideEcosystem, gradeableEcosystems, isAmbiguous } from '../src/vet/infer.ts';
import { readManifests } from '../src/scan/manifests.ts';
import { buildEvidence } from '../src/gaps/profile.ts';
import { findGaps } from '../src/gaps/gaps.ts';
import { PY_SOURCE_SIGNALS } from '../src/gaps/signals-python.ts';
import { maskPythonLine } from '../src/gaps/mask-python.ts';
import type { SourceFile } from '../src/scan/walk.ts';

async function project(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'codeisotope-infer-'));
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    await mkdir(join(abs, '..'), { recursive: true });
    await writeFile(abs, body, 'utf8');
  }
  return root;
}

function py(source: string, rel = 'tool.py'): SourceFile {
  const lines = source.split('\n');
  return { abs: `/tmp/${rel}`, rel, ext: '.py', bytes: source.length, lines };
}

// --- ecosystem inference ---------------------------------------------------------------------

test('an explicit ecosystem always wins', async () => {
  const root = await project({ 'requirements.txt': 'flask==3.0.0\n' });
  const decided = await decideEcosystem(root, 'npm');
  assert.ok(!isAmbiguous(decided));
  assert.equal(decided.ecosystem, 'npm');
  assert.equal(decided.source, 'explicit');
});

test('an unknown explicit ecosystem is rejected rather than silently defaulted', async () => {
  const root = await project({});
  const decided = await decideEcosystem(root, 'cpan');
  assert.ok(isAmbiguous(decided));
  assert.match(decided.message, /unknown ecosystem "cpan"/);
});

test('a single manifest infers its own ecosystem', async () => {
  // The bug this fixes: `vet --package tenacity` in a Python project returned the abandoned npm
  // styleguide generator of the same name, graded F 18/100, with nothing saying the registry was
  // wrong. A card with signals and a licence reads as authoritative.
  for (const [file, body, expected] of [
    ['requirements.txt', 'flask==3.0.0\n', 'pypi'],
    ['pyproject.toml', '[project]\nname = "x"\ndependencies = ["flask"]\n', 'pypi'],
    ['Cargo.toml', '[package]\nname = "x"\n\n[dependencies]\nserde = "1"\n', 'cargo'],
    ['go.mod', 'module x\n\nrequire github.com/gin-gonic/gin v1.12.0\n', 'go'],
    ['package.json', JSON.stringify({ dependencies: { express: '^4' } }), 'npm'],
  ] as const) {
    const root = await project({ [file]: body });
    const decided = await decideEcosystem(root);
    assert.ok(!isAmbiguous(decided), `${file} was ambiguous`);
    assert.equal(decided.ecosystem, expected, file);
    assert.equal(decided.source, 'inferred');
    assert.match(decided.reason, new RegExp(file.replace('.', '\\.')));
  }
});

test('two ecosystems with dependencies is ambiguous, and refuses instead of guessing', async () => {
  const root = await project({
    'requirements.txt': 'flask==3.0.0\n',
    'package.json': JSON.stringify({ dependencies: { react: '^18' } }),
  });
  const decided = await decideEcosystem(root);
  assert.ok(isAmbiguous(decided), 'a polyglot project must not be guessed at');
  assert.equal(decided.candidates.length, 2);
  assert.match(decided.message, /--ecosystem/);
  // The message must say why guessing is dangerous, not merely that it declined.
  assert.match(decided.message, /tenacity/);
});

test('an empty manifest beside a real one is not ambiguous', async () => {
  // A near-empty package.json beside a real requirements.txt is common. Calling that ambiguous
  // would be pedantic, and the reasoning has to be stated rather than silent.
  const root = await project({
    'requirements.txt': 'flask==3.0.0\nrequests==2.31.0\n',
    'package.json': JSON.stringify({ name: 'scripts', private: true }),
  });
  const decided = await decideEcosystem(root);
  assert.ok(!isAmbiguous(decided));
  assert.equal(decided.ecosystem, 'pypi');
  assert.match(decided.reason, /declare no dependencies/);
});

test('no manifest falls back to npm, and says so', async () => {
  const root = await project({ 'notes.txt': 'nothing here' });
  const decided = await decideEcosystem(root);
  assert.ok(!isAmbiguous(decided));
  assert.equal(decided.ecosystem, 'npm');
  assert.equal(decided.source, 'default');
  assert.match(decided.reason, /no dependency manifest/);
});

test('an ungradeable manifest does not make a project ambiguous', async () => {
  // Ruby and Maven are parsed but not gradeable, so they must not compete for the decision.
  const root = await project({
    'requirements.txt': 'flask==3.0.0\n',
    'Gemfile': 'source "https://rubygems.org"\ngem "rails"\n',
  });
  const decided = await decideEcosystem(root);
  assert.ok(!isAmbiguous(decided));
  assert.equal(decided.ecosystem, 'pypi');
});

test('two manifests for one ecosystem keep the richer one', async () => {
  const root = await project({
    'requirements.txt': 'flask==3.0.0\n',
    'pyproject.toml': '[project]\nname = "x"\ndependencies = ["flask", "requests", "httpx"]\n',
  });
  const candidates = gradeableEcosystems(await readManifests(root));
  assert.equal(candidates.length, 1, 'one ecosystem, not two entries');
  assert.equal(candidates[0]?.manifest, 'pyproject.toml');
  assert.equal(candidates[0]?.directDeps, 3);
});

// --- the cli trait from source ---------------------------------------------------------------

test('argparse establishes cli without any packaging declaration', async () => {
  // Most Python CLIs never declare [project.scripts]; they parse argv and are run with
  // `python tool.py`. Reading only packaging meant a real CLI got no `cli` trait, so the lockfile
  // gap -- which applies to library, cli and http-server -- stayed silent on it.
  const root = await project({
    'requirements.txt': 'requests==2.31.0\n',
    'mytool/cli.py': [
      'import argparse',
      '',
      'def main():',
      '    parser = argparse.ArgumentParser()',
      '    parser.add_argument("--verbose", action="store_true")',
      '    return parser.parse_args()',
    ].join('\n'),
  });
  const report = await findGaps(root);
  assert.ok(report.profile.traits.includes('cli'), report.profile.traits.join(', '));
  assert.ok(
    report.missing.some((m) => m.gapId === 'py-no-dependency-lockfile'),
    'the lockfile gap must now fire on a CLI',
  );
});

test('click and typer also establish cli', () => {
  for (const line of ['@click.command()', '@app.command()', 'app = Typer()', 'cli = click.group()']) {
    const signal = PY_SOURCE_SIGNALS.find((s) => s.name === 'py-cli-framework');
    assert.ok(signal);
    assert.ok(signal.re.test(maskPythonLine(line).masked), line);
  }
});

test('sys.argv alone does not make something a CLI', () => {
  // argv appears in test harnesses and migration scripts. One weak signal is not a trait.
  const built = buildEvidence({
    manifests: [],
    files: [py('import sys\nprint(sys.argv)')],
    rootEntries: [],
  });
  assert.ok(!built.traits.has('cli'), 'one weak signal must not establish the trait');
});

test('sys.argv plus a stdin prompt corroborate each other into cli', () => {
  const built = buildEvidence({
    manifests: [],
    files: [py('import sys\nname = input("name? ")\nprint(name, sys.argv)')],
    rootEntries: [],
  });
  assert.ok(built.traits.has('cli'), 'two independent weak signals are enough');
  assert.ok(built.traitsByLanguage.get('python')?.has('cli'));
});

test('a Flask app is not turned into a CLI', async () => {
  const root = await project({
    'requirements.txt': 'flask==3.0.0\n',
    'app.py': ['from flask import Flask', 'app = Flask(__name__)', '', '@app.get("/x")', 'def x():', '    return {}'].join('\n'),
  });
  const report = await findGaps(root);
  assert.ok(!report.profile.traits.includes('cli'), report.profile.traits.join(', '));
  assert.ok(report.profile.traits.includes('http-server'));
});
