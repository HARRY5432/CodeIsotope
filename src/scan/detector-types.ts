import type { Confidence } from '../lib/types.ts';

export interface Signal {
  name: string;
  re: RegExp;
}

export interface Detector {
  id: string;
  /** Human-readable capability, e.g. "retry with exponential backoff". */
  capability: string;
  /** File extensions this detector applies to. */
  ext: string[];
  signals: Signal[];
  /** How many distinct signals must fire inside one cluster of lines. */
  minSignals: number;
  /**
   * Signals that MUST be present, no matter how many others fire. This is the main precision
   * lever: without it, generic signals like a for-loop or a setTimeout match half a codebase.
   */
  required?: string[];
  /** Signals that are conclusive on their own, regardless of minSignals. */
  decisive?: string[];
  /** Queries handed to `reporadar vet`. */
  searchTerms: string[];
  /** Packages already known to solve this, seeded into vetting. */
  knownSolutions: string[];
  /** If the project already depends on any of these, the capability is solved -- do not report. */
  suppressIfDeps: string[];
  /** Why the hand-rolled version is risky. Surfaced verbatim to the agent. */
  note?: string;
  baseConfidence: Confidence;
}

/** JavaScript / TypeScript source extensions. */
export const JS = ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts'];
