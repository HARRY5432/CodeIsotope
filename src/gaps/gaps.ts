import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { GapReport, MissingCapability } from '../lib/types.ts';
import { TOOL_NAME, TOOL_VERSION } from '../lib/version.ts';
import { readManifests } from '../scan/manifests.ts';
import { walkSource } from '../scan/walk.ts';
import { GAPS } from './catalog.ts';
import { GAP_SOURCE_EXT, type Gap, type GapEvidence } from './gap-types.ts';
import { buildEvidence, readPackageShape } from './profile.ts';

/**
 * Report what the project has no answer for at all.
 *
 * The hard part is not finding gaps -- it is refusing to report the ones that do not apply. A
 * gap is only ever raised when the project has a trait that makes it relevant, and every raised
 * gap carries the traits and source lines that justified it, so the claim is checkable rather
 * than asserted. Anything unprovable is reported as not-applicable instead of guessed at.
 */

export interface GapOptions {
  /** Restrict to these gap ids. */
  only?: string[];
  maxFiles?: number;
  /** Include gaps that do not apply to this kind of project. Off by default -- that is the noise. */
  includeNotApplicable?: boolean;
}

type Outcome =
  | { kind: 'missing' }
  | { kind: 'satisfied'; by: string }
  | { kind: 'not-applicable' };

/** Decide one gap against the evidence. Order matters: applicability first, then satisfaction. */
export function evaluateGap(gap: Gap, evidence: GapEvidence): Outcome {
  const matchedTraits = gap.appliesWhen.filter((t) => evidence.traits.has(t));
  if (matchedTraits.length === 0) return { kind: 'not-applicable' };

  // Some gaps need a second, narrower piece of evidence on top of the trait -- a route alone does
  // not mean you need rate limiting, but an auth route does.
  if (gap.requiresSignals && !gap.requiresSignals.some((s) => evidence.sourceSignals.has(s))) {
    return { kind: 'not-applicable' };
  }

  const dep = gap.satisfiedByDeps?.find((d) => evidence.deps.has(d.toLowerCase()));
  if (dep) return { kind: 'satisfied', by: `depends on ${dep}` };

  const file = gap.satisfiedByFiles?.find((f) => evidence.allFiles.has(f.toLowerCase()));
  if (file) return { kind: 'satisfied', by: `${file} is present` };

  const signal = gap.satisfiedBySignals?.find((s) => evidence.sourceSignals.has(s));
  if (signal) {
    const site = evidence.signalSites.get(signal);
    return { kind: 'satisfied', by: site ? `handled at ${site.file}:${site.line}` : `handled in source (${signal})` };
  }

  return { kind: 'missing' };
}

/** The lines that justify raising this gap, so the reader can check the claim. */
function citationsFor(gap: Gap, evidence: GapEvidence): MissingCapability['citations'] {
  const names = [...(gap.requiresSignals ?? []), ...gap.appliesWhen];
  const out: MissingCapability['citations'] = [];
  const seen = new Set<string>();
  for (const name of names) {
    const site = evidence.signalSites.get(name);
    if (!site) continue;
    const key = `${site.file}:${site.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(site);
    if (out.length >= 2) break;
  }
  return out;
}

const SEVERITY_RANK = { high: 0, medium: 1, low: 2 } as const;

export async function findGaps(root: string, opts: GapOptions = {}): Promise<GapReport> {
  const started = Date.now();
  const { only, maxFiles = 4_000, includeNotApplicable = false } = opts;
  const notes: string[] = [];

  const manifests = await readManifests(root);
  const { files, stats } = await walkSource(root, { maxFiles, extensions: new Set(GAP_SOURCE_EXT) });

  let rootEntries: string[] = [];
  try {
    rootEntries = (await readdir(root, { withFileTypes: true })).map((e) => e.name);
  } catch {
    notes.push('Could not read the scan root, so file-presence checks were skipped.');
  }

  let packageShape;
  try {
    packageShape = readPackageShape(await readFile(join(root, 'package.json'), 'utf8'));
  } catch {
    packageShape = undefined;
  }

  const evidence = buildEvidence({ manifests, files, rootEntries, packageShape });

  if (evidence.traits.size === 0) {
    notes.push('Could not establish what kind of project this is, so no gaps were evaluated. Gaps are only reported when there is positive evidence they apply.');
  }
  if (stats.files === 0) {
    notes.push('No JavaScript or TypeScript source files were read; gap detection is JS/TS-only in this version.');
  }

  const missing: MissingCapability[] = [];
  const satisfied: GapReport['satisfied'] = [];
  const notApplicable: GapReport['notApplicable'] = [];

  for (const gap of GAPS) {
    if (only && only.length > 0 && !only.includes(gap.id)) continue;
    const outcome = evaluateGap(gap, evidence);

    if (outcome.kind === 'satisfied') {
      satisfied.push({ gapId: gap.id, capability: gap.capability, by: outcome.by });
      continue;
    }
    if (outcome.kind === 'not-applicable') {
      if (includeNotApplicable) {
        notApplicable.push({ gapId: gap.id, capability: gap.capability, needsTraits: gap.appliesWhen });
      }
      continue;
    }

    missing.push({
      gapId: gap.id,
      capability: gap.capability,
      severity: gap.severity,
      why: gap.why,
      becauseTraits: gap.appliesWhen.filter((t) => evidence.traits.has(t)),
      citations: citationsFor(gap, evidence),
      knownSolutions: gap.knownSolutions,
      searchTerms: gap.searchTerms,
    });
  }

  missing.sort((a, b) => {
    const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    return bySeverity !== 0 ? bySeverity : a.gapId.localeCompare(b.gapId);
  });

  return {
    tool: { name: TOOL_NAME, version: TOOL_VERSION },
    root,
    generatedAt: new Date().toISOString(),
    profile: {
      traits: [...evidence.traits].sort(),
      scanned: { files: stats.files, durationMs: Date.now() - started },
    },
    missing,
    satisfied,
    notApplicable,
    notes,
  };
}

/** Highest severity present, for `--fail-on`. */
export function worstSeverity(report: GapReport): 'high' | 'medium' | 'low' | undefined {
  for (const level of ['high', 'medium', 'low'] as const) {
    if (report.missing.some((m) => m.severity === level)) return level;
  }
  return undefined;
}
