#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { setCacheEnabled } from './lib/http.ts';
import { renderAuditReport, renderFingerprint, renderGapReport, renderReferenceReport, renderVetReport } from './lib/render.ts';
import { TOOL_VERSION } from './lib/version.ts';
import { runInit } from './commands/init.ts';
import { auditDependencies, worstVerdict } from './audit/audit.ts';
import { findGaps, worstSeverity } from './gaps/gaps.ts';
import { GAPS } from './gaps/catalog.ts';
import { findReferences } from './reference/reference.ts';
import { buildFingerprint } from './scan/fingerprint.ts';
import { DETECTORS } from './scan/detectors/index.ts';
import { vet } from './vet/evidence.ts';
import type { Confidence, DepVerdict, Ecosystem } from './lib/types.ts';

// Dogfooding: this is exactly the util.parseArgs that our own argv-parsing detector recommends.
const OPTIONS = {
  json: { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
  version: { type: 'boolean', short: 'v', default: false },
  only: { type: 'string' },
  limit: { type: 'string' },
  'max-files': { type: 'string' },
  'include-suppressed': { type: 'boolean', default: false },
  'no-cache': { type: 'boolean', default: false },
  package: { type: 'string', multiple: true },
  seed: { type: 'string', multiple: true },
  ecosystem: { type: 'string' },
  target: { type: 'string', multiple: true },
  all: { type: 'boolean', default: false },
  force: { type: 'boolean', default: false },
  'dry-run': { type: 'boolean', default: false },
  dev: { type: 'boolean', default: false },
  'fail-on': { type: 'string' },
  'include-not-applicable': { type: 'boolean', default: false },
  'files-per-source': { type: 'string' },
  'include-unhealthy': { type: 'boolean', default: false },
} as const;

const HELP = `codeisotope ${TOOL_VERSION} -- find the mature repos your codebase reinvented by hand.

USAGE
  codeisotope init [--target claude,opencode,cursor,gemini,windsurf,copilot] [--all] [--force] [--dry-run]
      Install the /codeisotope slash command into every AI coding CLI it finds in this project.

  codeisotope scan [path] [--json] [--only <ids>] [--limit N] [--max-files N] [--include-suppressed]
      Fingerprint the codebase and list capabilities that look hand-rolled.

  codeisotope audit [path] [--json] [--dev] [--only <names>] [--limit N] [--fail-on <verdict>]
      Grade the dependencies you already have: deprecated, archived, abandoned, or unlicensed.

  codeisotope gaps [path] [--json] [--only <ids>] [--include-not-applicable] [--fail-on <severity>]
      Report infrastructure the project has no answer for, gated on what kind of project it is.

  codeisotope vet <query> [--json] [--package <name>]... [--seed <name>]... [--ecosystem npm] [--limit N]
      Gather hard evidence on candidate packages: maintenance, adoption, bus factor, advisories, licence.

  codeisotope reference <query> [--json] [--package <name>]... [--seed <name>]... [--limit N]
      Point at how healthy libraries solve this, as commit-pinned permalinks to their real source.

  codeisotope detectors            List every detector and what it looks for.
  codeisotope gap-list             List every gap and the project traits it applies to.

GLOBAL
  --json          Machine-readable output. This is what the slash command consumes.
  --no-cache      Bypass the 6-hour on-disk response cache.
  -h, --help      Show this help.  -v, --version   Print the version.

AUDIT
  --dev                  Include devDependencies (graded more leniently than runtime deps).
  --fail-on <verdict>    Exit 3 if any dependency is this bad or worse: replace, weak, aging.
  Audit states the problem and gives you search terms; run \`codeisotope vet\` to prove a replacement.

GAPS
  --fail-on <severity>       Exit 3 if any gap is this severe or worse: high, medium, low.
  --include-not-applicable   Show the gaps that were skipped, and which traits they need.
  A gap is only ever reported when the project has a trait that makes it relevant, and every
  reported gap cites the source lines that justified it.

REFERENCE
  --files-per-source N   How many files to surface per repository (default 4).
  --include-unhealthy    Also reference sources that failed the health gate, saying why.
  Sources are health-gated: copying patterns from an abandoned project is worse than no reference.
  Links are pinned to a commit SHA, so they cannot drift. The binary points; you read.

NOTES
  No API keys are required. GitHub requests use GITHUB_TOKEN, GH_TOKEN, or your local \`gh\` login
  when available, purely to raise the rate limit from 60/hour to 5,000/hour.
`;

const VERDICT_ORDER: DepVerdict[] = ['healthy', 'aging', 'weak', 'replace'];
const SEVERITY_ORDER: Confidence[] = ['low', 'medium', 'high'];

function fail(message: string, code = 1): never {
  process.stderr.write(`codeisotope: ${message}\n`);
  process.exit(code);
}

function toInt(value: string | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) fail(`--${label} must be a positive integer, got "${value}"`, 2);
  return n;
}

async function main(): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs({ args: process.argv.slice(2), options: OPTIONS, allowPositionals: true, strict: true });
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err), 2);
  }
  const { values, positionals } = parsed;

  if (values.version) {
    process.stdout.write(`${TOOL_VERSION}\n`);
    return;
  }
  const command = positionals[0];
  if (values.help || command === undefined || command === 'help') {
    process.stdout.write(HELP);
    return;
  }
  if (values['no-cache']) setCacheEnabled(false);

  switch (command) {
    case 'scan': {
      const root = resolve(positionals[1] ?? process.cwd());
      const fingerprint = await buildFingerprint(root, {
        ...(values.only ? { only: values.only.split(',').map((s) => s.trim()).filter(Boolean) } : {}),
        ...(toInt(values.limit, 'limit') !== undefined ? { limit: toInt(values.limit, 'limit') } : {}),
        ...(toInt(values['max-files'], 'max-files') !== undefined ? { maxFiles: toInt(values['max-files'], 'max-files') } : {}),
        includeSuppressed: values['include-suppressed'],
      });
      process.stdout.write(values.json ? `${JSON.stringify(fingerprint, null, 2)}\n` : `${renderFingerprint(fingerprint)}\n`);
      return;
    }

    case 'audit': {
      const root = resolve(positionals[1] ?? process.cwd());
      const failOn = values['fail-on'];
      if (failOn !== undefined && !VERDICT_ORDER.includes(failOn as DepVerdict)) {
        fail(`--fail-on must be one of ${VERDICT_ORDER.join(', ')}, got "${failOn}"`, 2);
      }
      const report = await auditDependencies(root, {
        includeDev: values.dev,
        ...(values.only ? { only: values.only.split(',').map((s) => s.trim()).filter(Boolean) } : {}),
        ...(toInt(values.limit, 'limit') !== undefined ? { limit: toInt(values.limit, 'limit') } : {}),
      });
      process.stdout.write(values.json ? `${JSON.stringify(report, null, 2)}\n` : `${renderAuditReport(report)}\n`);

      if (failOn !== undefined) {
        const worst = worstVerdict(report);
        const threshold = VERDICT_ORDER.indexOf(failOn as DepVerdict);
        if (worst !== undefined && VERDICT_ORDER.indexOf(worst) >= threshold) {
          process.stderr.write(`codeisotope: worst dependency verdict is "${worst}", at or above --fail-on "${failOn}"\n`);
          process.exit(3);
        }
      }
      return;
    }

    case 'gaps': {
      const root = resolve(positionals[1] ?? process.cwd());
      const failOn = values['fail-on'];
      if (failOn !== undefined && !SEVERITY_ORDER.includes(failOn as Confidence)) {
        fail(`--fail-on must be one of ${[...SEVERITY_ORDER].reverse().join(', ')}, got "${failOn}"`, 2);
      }
      const report = await findGaps(root, {
        ...(values.only ? { only: values.only.split(',').map((s) => s.trim()).filter(Boolean) } : {}),
        ...(toInt(values['max-files'], 'max-files') !== undefined ? { maxFiles: toInt(values['max-files'], 'max-files') } : {}),
        includeNotApplicable: values['include-not-applicable'],
      });
      process.stdout.write(values.json ? `${JSON.stringify(report, null, 2)}\n` : `${renderGapReport(report)}\n`);

      if (failOn !== undefined) {
        const worst = worstSeverity(report);
        if (worst !== undefined && SEVERITY_ORDER.indexOf(worst) >= SEVERITY_ORDER.indexOf(failOn as Confidence)) {
          process.stderr.write(`codeisotope: most severe gap is "${worst}", at or above --fail-on "${failOn}"\n`);
          process.exit(3);
        }
      }
      return;
    }

    case 'gap-list': {
      if (values.json) {
        process.stdout.write(`${JSON.stringify(GAPS, null, 2)}\n`);
        return;
      }
      for (const gap of GAPS) {
        const language = gap.language ? ` [${gap.language}]` : '';
        process.stdout.write(`${gap.id.padEnd(26)} ${gap.severity.padEnd(7)} ${gap.capability}${language}\n`);
        process.stdout.write(`${''.padEnd(26)} applies when: ${gap.appliesWhen.join(', ')}\n`);
        if (gap.requiresSignals) {
          process.stdout.write(`${''.padEnd(26)} and also needs: ${gap.requiresSignals.join(' or ')}\n`);
        }
        process.stdout.write(`${''.padEnd(26)} solutions: ${gap.knownSolutions.join(', ')}\n\n`);
      }
      return;
    }

    case 'vet': {
      const query = positionals.slice(1).join(' ').trim();
      const exact = values.package ?? [];
      if (!query && exact.length === 0) fail('vet needs a query or at least one --package', 2);
      const report = await vet(query || exact.join(', '), {
        ecosystem: (values.ecosystem ?? 'npm') as Ecosystem,
        ...(values.seed ? { seeds: values.seed } : {}),
        ...(exact.length > 0 ? { exact } : {}),
        ...(toInt(values.limit, 'limit') !== undefined ? { limit: toInt(values.limit, 'limit') } : {}),
      });
      process.stdout.write(values.json ? `${JSON.stringify(report, null, 2)}\n` : `${renderVetReport(report)}\n`);
      return;
    }

    case 'init': {
      const result = await runInit({
        cwd: process.cwd(),
        ...(values.target ? { targets: values.target.flatMap((t) => t.split(',')).map((t) => t.trim()).filter(Boolean) } : {}),
        all: values.all,
        force: values.force,
        dryRun: values['dry-run'],
      });
      process.stdout.write(values.json ? `${JSON.stringify(result, null, 2)}\n` : `${result.report}\n`);
      return;
    }

    case 'reference': {
      const query = positionals.slice(1).join(' ').trim();
      const exact = values.package ?? [];
      if (!query && exact.length === 0) fail('reference needs a query or at least one --package', 2);
      const report = await findReferences(query || exact.join(', '), {
        ...(exact.length > 0 ? { packages: exact } : {}),
        ...(values.seed ? { seeds: values.seed } : {}),
        ecosystem: (values.ecosystem ?? 'npm') as Ecosystem,
        ...(toInt(values.limit, 'limit') !== undefined ? { limit: toInt(values.limit, 'limit') } : {}),
        ...(toInt(values['files-per-source'], 'files-per-source') !== undefined
          ? { filesPerSource: toInt(values['files-per-source'], 'files-per-source') }
          : {}),
        includeUnhealthy: values['include-unhealthy'],
      });
      process.stdout.write(values.json ? `${JSON.stringify(report, null, 2)}\n` : `${renderReferenceReport(report)}\n`);
      return;
    }

    case 'detectors': {
      if (values.json) {
        const list = DETECTORS.map((d) => ({
          id: d.id, capability: d.capability, ecosystem: d.ecosystem ?? 'npm',
          ext: d.ext, minSignals: d.minSignals,
          signals: d.signals.map((s) => s.name), knownSolutions: d.knownSolutions,
          suppressIfDeps: d.suppressIfDeps, note: d.note ?? null,
        }));
        process.stdout.write(`${JSON.stringify(list, null, 2)}\n`);
        return;
      }
      for (const d of DETECTORS) {
        // Naming the language matters now that one capability has a detector per language: `csv
        // parsing` appears twice, and the ids alone do not say which files each one reads.
        const language = d.ext.includes('.py') ? 'python' : 'javascript';
        process.stdout.write(`${d.id.padEnd(24)} ${d.capability} [${language}]\n`);
        process.stdout.write(`${''.padEnd(24)} signals: ${d.signals.map((s) => s.name).join(', ')} (need ${d.minSignals})\n`);
        process.stdout.write(`${''.padEnd(24)} solutions: ${d.knownSolutions.join(', ')}\n\n`);
      }
      return;
    }

    default:
      fail(`unknown command "${command}". Run \`codeisotope --help\`.`, 2);
  }
}

main().catch((err: unknown) => {
  fail(err instanceof Error ? (err.stack ?? err.message) : String(err));
});
