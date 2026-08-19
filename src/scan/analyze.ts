import type { Confidence, ReinventionCandidate } from '../lib/types.ts';
import type { Detector } from './detector-types.ts';
import { detectorsForExt } from './detectors/index.ts';
import type { SourceFile } from './walk.ts';

/** Signals further apart than this are treated as unrelated code, not one implementation. */
const CLUSTER_WINDOW = 60;
const MAX_EXCERPTS = 4;
const EXCERPT_MAX_CHARS = 180;
const MAX_CLUSTERS_PER_DETECTOR_PER_FILE = 2;

const COMMENT_ONLY = /^\s*(\/\/|\*|\/\*|#|<!--)/;
const IMPORT_LINE = /^\s*(import|export)\s[^;]*\bfrom\b|^\s*(const|let|var)\s+[^=]+=\s*require\s*\(|^\s*import\s*\(/;

interface Hit {
  signal: string;
  line: number; // 1-indexed
}

interface Cluster {
  hits: Hit[];
  signals: Set<string>;
}

/** Group hits into clusters of nearby lines. Input must be sorted by line. */
function cluster(hits: Hit[]): Cluster[] {
  const clusters: Cluster[] = [];
  for (const hit of hits) {
    const last = clusters[clusters.length - 1];
    const lastLine = last?.hits[last.hits.length - 1]?.line;
    if (last && lastLine !== undefined && hit.line - lastLine <= CLUSTER_WINDOW) {
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
 */
function qualifies(detector: Detector, signals: Set<string>): boolean {
  if (detector.decisive?.some((s) => signals.has(s))) return true;
  if (detector.required?.some((s) => !signals.has(s))) return false;
  return signals.size >= detector.minSignals;
}

/** Run every applicable detector over one file. */
export function analyzeFile(file: SourceFile, enabled?: Set<string>): ReinventionCandidate[] {
  const detectors = detectorsForExt(file.ext).filter((d) => !enabled || enabled.has(d.id));
  if (detectors.length === 0) return [];

  const hitsByDetector = new Map<string, Hit[]>();

  for (let i = 0; i < file.lines.length; i++) {
    const raw = file.lines[i];
    if (raw === undefined || raw.length === 0) continue;
    if (COMMENT_ONLY.test(raw) || IMPORT_LINE.test(raw)) continue;
    for (const detector of detectors) {
      for (const signal of detector.signals) {
        if (signal.re.test(raw)) {
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

    const clusters = cluster(hits)
      .filter((c) => qualifies(detector, c.signals))
      .slice(0, MAX_CLUSTERS_PER_DETECTOR_PER_FILE);

    for (const c of clusters) {
      // One representative line per distinct signal reads better than N hits of the same signal.
      // Dedupe by signal AND by line: two signals often match the same line, and printing that
      // line twice makes the excerpt list look padded.
      const seenSignals = new Set<string>();
      const seenLines = new Set<number>();
      const representative: Hit[] = [];
      for (const hit of c.hits) {
        if (seenSignals.has(hit.signal) || seenLines.has(hit.line)) continue;
        seenSignals.add(hit.signal);
        seenLines.add(hit.line);
        representative.push(hit);
      }
      const chosen = representative.slice(0, MAX_EXCERPTS);
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
