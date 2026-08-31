import type { Confidence, ReinventionCandidate } from '../lib/types.ts';
import { maskFileLines } from '../gaps/mask.ts';
import { maskPythonFile } from '../gaps/mask-python.ts';
import type { Detector } from './detector-types.ts';
import { detectorsForExt } from './detectors/index.ts';
import type { SourceFile } from './walk.ts';

/** Signals further apart than this are treated as unrelated code, not one implementation. */
const CLUSTER_WINDOW = 60;
const MAX_EXCERPTS = 4;
const EXCERPT_MAX_CHARS = 180;
const MAX_CLUSTERS_PER_DETECTOR_PER_FILE = 2;

const IMPORT_LINE = /^\s*(import|export)\s[^;]*\bfrom\b|^\s*(const|let|var)\s+[^=]+=\s*require\s*\(|^\s*import\s*\(/;

/**
 * A Python import line. Excluded for the same reason as JS imports: naming a module is not using
 * it, and the `from flask import request` line was being cited as the evidence for a `pickle.loads`
 * finding 34 lines further down, purely because it contains the word `request`.
 */
const PY_IMPORT_LINE = /^\s*(?:from\s+[\w.]+\s+)?import\s+/;

interface Hit {
  signal: string;
  line: number; // 1-indexed
}

interface Cluster {
  hits: Hit[];
  signals: Set<string>;
}

/** Group hits into clusters of nearby lines. Input must be sorted by line. */
function cluster(hits: Hit[], window = CLUSTER_WINDOW): Cluster[] {
  const clusters: Cluster[] = [];
  for (const hit of hits) {
    const last = clusters[clusters.length - 1];
    const lastLine = last?.hits[last.hits.length - 1]?.line;
    if (last && lastLine !== undefined && hit.line - lastLine <= window) {
      last.hits.push(hit);
      last.signals.add(hit.signal);
    } else {
      clusters.push({ hits: [hit], signals: new Set([hit.signal]) });
    }
  }
  return clusters;
}

function gradeConfidence(detector: Detector, signals: Set<string>): Confidence {
  const hasDecisive = detector.decisive?.some((s) => signals.has(s)) ?? false;
  if (hasDecisive) return 'high';
  if (signals.size >= detector.signals.length) return 'high';
  if (signals.size > detector.minSignals) return detector.baseConfidence === 'low' ? 'medium' : 'high';
  return detector.baseConfidence;
}

function excerpt(line: string): string {
  const trimmed = line.trim();
  return trimmed.length > EXCERPT_MAX_CHARS ? `${trimmed.slice(0, EXCERPT_MAX_CHARS)}...` : trimmed;
}

/**
 * A cluster qualifies when a decisive signal fired, or when every required signal is present
 * AND the distinct-signal count clears minSignals. The required check is what keeps generic
 * signals (a for-loop, a setTimeout) from matching unrelated code.
 *
 * `unless` is checked first, because a disqualifier settles the question: `requests.get(url,
 * timeout=5)` is correct code, and no amount of other evidence makes it a finding.
 */
function qualifies(detector: Detector, signals: Set<string>): boolean {
  if (detector.unless?.some((s) => signals.has(s))) return false;
  if (detector.decisive?.some((s) => signals.has(s))) return true;
  if (detector.required?.some((s) => !signals.has(s))) return false;
  return signals.size >= detector.minSignals;
}

/** Python source, which needs docstring- and comment-aware masking rather than JS rules. */
const PY_EXT = new Set(['.py', '.pyw']);

/**
 * Run every applicable detector over one file.
 *
 * Comments and docstrings are masked out before matching, because prose describing a feature is not
 * the feature. Scanning a Python fixture produced a finding whose cited line was
 * `"""Create a session token."""` -- the docstring, not the code beneath it.
 */
export function analyzeFile(file: SourceFile, enabled?: Set<string>): ReinventionCandidate[] {
  const detectors = detectorsForExt(file.ext).filter((d) => !enabled || enabled.has(d.id));
  if (detectors.length === 0) return [];

  const isPython = PY_EXT.has(file.ext);
  const views = isPython ? maskPythonFile(file.lines) : maskFileLines(file.lines);
  const hitsByDetector = new Map<string, Hit[]>();

  for (let i = 0; i < file.lines.length; i++) {
    const raw = file.lines[i];
    const view = views[i];
    if (raw === undefined || view === undefined || raw.length === 0) continue;
    // `code` keeps string literals, which several detectors genuinely need: a SQL statement and a
    // route path are both written as strings. Only comments and docstrings are removed.
    const subject = view.code;
    if (subject.trim().length === 0) continue;
    if (IMPORT_LINE.test(subject) || PY_IMPORT_LINE.test(subject)) continue;
    for (const detector of detectors) {
      for (const signal of detector.signals) {
        if (signal.re.test(subject)) {
          const list = hitsByDetector.get(detector.id) ?? [];
          list.push({ signal: signal.name, line: i + 1 });
          hitsByDetector.set(detector.id, list);
        }
      }
    }
  }

  const candidates: ReinventionCandidate[] = [];
  for (const detector of detectors) {
    const hits = hitsByDetector.get(detector.id);
    if (!hits || hits.length === 0) continue;

    const clusters = cluster(hits, detector.clusterWindow ?? CLUSTER_WINDOW)
      .filter((c) => qualifies(detector, c.signals))
      .slice(0, MAX_CLUSTERS_PER_DETECTOR_PER_FILE);

    for (const c of clusters) {
      // Anchor the excerpts on the signal that most precisely names the capability, then pick the
      // *nearest* hit for every other signal.
      //
      // Decisive signals outrank required ones. Both are anchors, but a decisive signal identifies
      // the capability on its own while a required one is often broad vocabulary: for
      // `pickle.loads(blob)` at line 44, the required `untrusted-source` signal also matched
      // `os.environ.get("DEBUG")` at line 15, and anchoring there cited module-level config as the
      // evidence for a deserialisation finding 29 lines away.
      const anchorHit =
        c.hits.find((h) => detector.decisive?.includes(h.signal)) ??
        c.hits.find((h) => detector.required?.includes(h.signal)) ??
        c.hits[0];
      const anchorLine = anchorHit?.line ?? 0;

      const byDistance = [...c.hits].sort(
        (a, b) => Math.abs(a.line - anchorLine) - Math.abs(b.line - anchorLine) || a.line - b.line,
      );

      const seenSignals = new Set<string>();
      const seenLines = new Set<number>();
      const representative: Hit[] = [];
      for (const hit of byDistance) {
        if (seenSignals.has(hit.signal) || seenLines.has(hit.line)) continue;
        seenSignals.add(hit.signal);
        seenLines.add(hit.line);
        representative.push(hit);
      }
      // Read in source order, even though they were selected by proximity.
      const chosen = representative.slice(0, MAX_EXCERPTS).sort((a, b) => a.line - b.line);
      candidates.push({
        detectorId: detector.id,
        capability: detector.capability,
        file: file.rel,
        lines: chosen.map((h) => h.line),
        excerpts: chosen.map((h) => `${h.line}: ${excerpt(file.lines[h.line - 1] ?? '')}`),
        signalsHit: [...c.signals],
        confidence: gradeConfidence(detector, c.signals),
        searchTerms: detector.searchTerms,
        knownSolutions: detector.knownSolutions,
        ...(detector.note ? { note: detector.note } : {}),
      });
    }
  }

  return candidates;
}

const CONFIDENCE_RANK: Record<Confidence, number> = { high: 0, medium: 1, low: 2 };

/**
 * Rank candidates so the most actionable land first: confidence, then detector priority
 * (security detectors are registered first), then file path for stable output.
 */
export function rankCandidates(candidates: ReinventionCandidate[], detectorOrder: string[]): ReinventionCandidate[] {
  const order = new Map(detectorOrder.map((id, i) => [id, i]));
  return [...candidates].sort((a, b) => {
    const byConfidence = CONFIDENCE_RANK[a.confidence] - CONFIDENCE_RANK[b.confidence];
    if (byConfidence !== 0) return byConfidence;
    const byDetector = (order.get(a.detectorId) ?? 999) - (order.get(b.detectorId) ?? 999);
    if (byDetector !== 0) return byDetector;
    return a.file.localeCompare(b.file);
  });
}
