import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runInit } from '../src/commands/init.ts';
import { MARKER, TARGETS, renderFor } from '../src/commands/targets.ts';

const emptyProject = () => mkdtemp(join(tmpdir(), 'codeisotope-init-'));

test('every target renders a non-empty file carrying the marker', () => {
  for (const target of TARGETS) {
    const out = renderFor(target);
    assert.ok(out.length > 500, `${target.key} output looks truncated`);
    assert.ok(out.includes(MARKER), `${target.key} output is missing the regeneration marker`);
    assert.ok(out.includes('codeisotope scan --json'), `${target.key} output lost the scan instruction`);
    assert.ok(!out.includes('{{ARGS}}'), `${target.key} left the argument placeholder unsubstituted`);
    assert.ok(out.includes(target.argsToken), `${target.key} did not inject its own argument token`);
  }
});

test('the prompt drives every capability the binary exposes', () => {
  // A capability the binary has but the prompt never mentions is unreachable from the slash
  // command, which is how most people will use this. `gaps` shipped without this and was invisible.
  const out = renderFor(TARGETS[0] as (typeof TARGETS)[number]);
  for (const command of ['scan', 'audit', 'gaps', 'vet']) {
    assert.ok(out.includes(`codeisotope ${command} `), `the prompt never runs \`codeisotope ${command}\``);
  }
});

test('the Gemini TOML file is well formed', () => {
  const gemini = TARGETS.find((t) => t.key === 'gemini');
  assert.ok(gemini);
  const out = renderFor(gemini);
  assert.match(out, /^# codeisotope:generated/m);
  assert.match(out, /^description = "/m);
  assert.match(out, /^prompt = '''$/m);
  // A literal triple quote inside the body would terminate the string early.
  const body = out.slice(out.indexOf("prompt = '''") + 12, out.lastIndexOf("'''"));
  assert.ok(!body.includes("'''"), 'body must not contain an unescaped triple quote');
});

test('init detects an existing CLI directory and installs only there', async () => {
  const root = await emptyProject();
  await mkdir(join(root, '.cursor'), { recursive: true });
  const result = await runInit({ cwd: root });
  assert.deepEqual(result.detected, ['cursor']);
  assert.deepEqual(result.installed.map((i) => i.target), ['cursor']);
  assert.equal(result.installed[0]?.action, 'created');
  const written = await readFile(join(root, '.cursor/commands/codeisotope.md'), 'utf8');
  assert.ok(written.includes(MARKER));
});

test('with no CLI detected it falls back to Claude Code and opencode and says so', async () => {
  const root = await emptyProject();
  const result = await runInit({ cwd: root });
  assert.deepEqual(result.installed.map((i) => i.target), ['claude', 'opencode']);
  assert.match(result.report, /no AI CLI config directory found/);
});

test('a hand-written command file is never clobbered without --force', async () => {
  const root = await emptyProject();
  await mkdir(join(root, '.claude/commands'), { recursive: true });
  await writeFile(join(root, '.claude/commands/codeisotope.md'), 'my own prompt', 'utf8');

  const skipped = await runInit({ cwd: root, targets: ['claude'] });
  assert.equal(skipped.installed[0]?.action, 'skipped-exists');
  assert.equal(await readFile(join(root, '.claude/commands/codeisotope.md'), 'utf8'), 'my own prompt');

  const forced = await runInit({ cwd: root, targets: ['claude'], force: true });
  assert.equal(forced.installed[0]?.action, 'updated');
  assert.ok((await readFile(join(root, '.claude/commands/codeisotope.md'), 'utf8')).includes(MARKER));
});

test('a file we generated is updated in place without --force', async () => {
  const root = await emptyProject();
  await runInit({ cwd: root, targets: ['claude'] });
  const again = await runInit({ cwd: root, targets: ['claude'] });
  assert.equal(again.installed[0]?.action, 'updated');
});

test('--dry-run writes nothing', async () => {
  const root = await emptyProject();
  const result = await runInit({ cwd: root, targets: ['claude'], dryRun: true });
  assert.equal(result.installed[0]?.action, 'would-write');
  await assert.rejects(() => readFile(join(root, '.claude/commands/codeisotope.md'), 'utf8'));
});

test('an unknown target is reported rather than ignored', async () => {
  const root = await emptyProject();
  const result = await runInit({ cwd: root, targets: ['emacs'] });
  assert.deepEqual(result.installed, []);
  assert.match(result.report, /unknown target "emacs"/);
});

test('--all installs for every known CLI', async () => {
  const root = await emptyProject();
  const result = await runInit({ cwd: root, all: true });
  assert.equal(result.installed.length, TARGETS.length);
  assert.ok(result.installed.every((i) => i.action === 'created'));
});
