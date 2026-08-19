import { TOOL_NAME, TOOL_VERSION } from '../lib/version.ts';
import type { Fingerprint, ReinventionCandidate } from '../lib/types.ts';
import { analyzeFile, rankCandidates } from './analyze.ts';
import { DETECTORS } from './detectors/index.ts';
import { collectDependencyNames, readManifests } from './manifests.ts';
import { walkSource } from './walk.ts';

const EXT_LANGUAGE: Record<string, string> = {
  '.ts': 'TypeScript', '.tsx': 'TypeScript', '.mts': 'TypeScript', '.cts': 'TypeScript',
  '.js': 'JavaScript', '.jsx': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript',
  '.py': 'Python', '.rb': 'Ruby', '.go': 'Go', '.rs': 'Rust', '.java': 'Java',
  '.kt': 'Kotlin', '.swift': 'Swift', '.cs': 'C#', '.php': 'PHP', '.vue': 'Vue', '.svelte': 'Svelte',
};

export interface ScanOptions {
  /** Restrict to these detector ids. */
  only?: string[];
  /** Cap the number of candidates reported. */
  limit?: number;
  maxFiles?: number;
  /** Report candidates even when the project already depends on a known solution. */
  includeSuppressed?: boolean;
}

/** All extensions any detector cares about, plus the ones we count for the language breakdown. */
function scanExtensions(): Set<string> {
  const set = new Set<string>(Object.keys(EXT_LANGUAGE));
  for (const d of DETECTORS) for (const e of d.ext) set.add(e);
  return set;
}

export async function buildFingerprint(root: string, opts: ScanOptions = {}): Promise<Fingerprint> {
  const started = Date.now();
  const { only, limit = 40, maxFiles = 4_000, includeSuppressed = false } = opts;

  const manifests = await readManifests(root);
  const deps = collectDependencyNames(manifests);

  // A detector is suppressed when the project already depends on something that solves it --
  // recommending p-retry to a project that already imports p-retry is noise, not insight.
  const suppressed: Fingerprint['suppressed'] = [];
  const activeIds = new Set<string>();
  for (const detector of DETECTORS) {
    if (only && !only.includes(detector.id)) continue;
    const hit = detector.suppressIfDeps.find((name) => deps.all.has(name.toLowerCase()));
    if (hit && !includeSuppressed) {
      suppressed.push({ detectorId: detector.id, capability: detector.capability, reason: `already depends on ${hit}` });
      continue;
    }
    activeIds.add(detector.id);
  }

  const { files, stats } = await walkSource(root, { maxFiles, extensions: scanExtensions() });

  const languageCounts = new Map<string, number>();
  let candidates: ReinventionCandidate[] = [];
  for (const file of files) {
    const language = EXT_LANGUAGE[file.ext];
    if (language) languageCounts.set(language, (languageCounts.get(language) ?? 0) + 1);
    candidates.push(...analyzeFile(file, activeIds));
  }

  candidates = rankCandidates(candidates, DETECTORS.map((d) => d.id)).slice(0, limit);

  const totalLangFiles = [...languageCounts.values()].reduce((a, b) => a + b, 0) || 1;
  const languages = [...languageCounts.entries()]
    .map(([name, count]) => ({ name, files: count, share: Math.round((count / totalLangFiles) * 1000) / 10 }))
    .sort((a, b) => b.files - a.files);

  return {
    tool: { name: TOOL_NAME, version: TOOL_VERSION },
    root,
    generatedAt: new Date().toISOString(),
    scanned: { files: stats.files, bytes: stats.bytes, durationMs: Date.now() - started, skippedDirs: stats.skippedDirs },
    languages,
    manifests,
    deps: { direct: deps.direct, dev: deps.dev },
    candidates,
    suppressed,
  };
}
