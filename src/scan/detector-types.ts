import type { Confidence, Ecosystem } from '../lib/types.ts';

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
  /**
   * Which registry `suppressIfDeps` and `knownSolutions` refer to. A Python detector naming
   * `tenacity` must not be suppressed by an npm dependency that happens to share a name, and the
   * packages it suggests have to be vetted against PyPI rather than npm.
   */
  ecosystem?: Ecosystem;
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
  /**
   * Signals whose presence *disqualifies* the cluster.
   *
   * The absence of something is sometimes the finding. `requests.get(url)` is a defect precisely
   * because there is no `timeout=`, and with no way to express that, the detector fired on correct
   * code that passed one. Checked before `decisive`, because a satisfied case is not a finding no
   * matter how strong the other evidence looks.
   */
  unless?: string[];
  /**
   * Override the clustering window, in lines. `0` means each line is judged alone.
   *
   * Needed where the disqualifying evidence has to be on the *same line* as the problem: a
   * timeout is an argument of the call it applies to, so a correct call 20 lines away must not
   * excuse an incorrect one.
   */
  clusterWindow?: number;
  /** Queries handed to `codeisotope vet`. */
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

/** Python source extensions. `.pyi` is a stub file with no implementation, so it is excluded. */
export const PY = ['.py', '.pyw'];
