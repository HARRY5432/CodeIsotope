/** Shared shapes for the whole tool. Everything the CLI prints as JSON is defined here. */

export type Ecosystem = 'npm' | 'pypi' | 'cargo' | 'go' | 'maven' | 'nuget' | 'rubygems';

export type Confidence = 'low' | 'medium' | 'high';

export interface Manifest {
  ecosystem: Ecosystem;
  /** Path relative to scan root. */
  file: string;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
}

/** A place in the codebase that looks like a hand-rolled version of a solved problem. */
export interface ReinventionCandidate {
  detectorId: string;
  /** Human-readable capability, e.g. "retry with exponential backoff". */
  capability: string;
  /** Path relative to scan root. */
  file: string;
  /** 1-indexed line numbers that produced signals. */
  lines: number[];
  /** Trimmed, length-capped source lines so the agent can judge without re-reading the file. */
  excerpts: string[];
  /** Named signals that fired, for explainability. */
  signalsHit: string[];
  confidence: Confidence;
  /** Feed these to `reporadar vet` to gather evidence. */
  searchTerms: string[];
  /** Well-known packages that already solve this, seeded for vetting. */
  knownSolutions: string[];
  /** Why this matters / what to watch out for. */
  note?: string;
}

export interface Fingerprint {
  tool: { name: string; version: string };
  root: string;
  generatedAt: string;
  scanned: { files: number; bytes: number; durationMs: number; skippedDirs: number };
  languages: Array<{ name: string; files: number; share: number }>;
  manifests: Manifest[];
  deps: { direct: string[]; dev: string[] };
  candidates: ReinventionCandidate[];
  /** Detectors that fired but were dropped because the project already uses a real solution. */
  suppressed: Array<{ detectorId: string; capability: string; reason: string }>;
}

export type SignalVerdict = 'good' | 'ok' | 'weak' | 'bad' | 'unknown';

export interface HealthSignal {
  label: string;
  verdict: SignalVerdict;
  detail: string;
  /** Relative contribution to the score. */
  weight: number;
}

export interface HealthVerdict {
  /** 0-100. */
  score: number;
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  signals: HealthSignal[];
  /** Hard disqualifiers or loud warnings, e.g. "archived", "deprecated", "single-maintainer". */
  flags: string[];
  /** One-line human summary. */
  summary: string;
}

export interface RepoEvidence {
  slug: string;
  url: string;
  stars: number;
  forks: number;
  openIssues: number;
  archived: boolean;
  isFork: boolean;
  createdAt: string;
  pushedAt: string;
  license: string | null;
  topics: string[];
  releases: { latestTag?: string; latestAt?: string; countLast12mo?: number };
  commits: { last90d?: number; lastCommitAt?: string };
  contributors: { total?: number; busFactorTop3Share?: number };
}

export interface PackageEvidence {
  name: string;
  ecosystem: Ecosystem;
  description?: string;
  version?: string;
  license?: string | null;
  homepage?: string;
  deprecated?: { is: boolean; reason?: string };
  downloads?: { weekly?: number; monthly?: number };
  dependentsCount?: number;
  repo?: RepoEvidence;
  scorecard?: { score: number; date: string; weakChecks: Array<{ name: string; score: number }> };
  health: HealthVerdict;
  /** Anything we tried and failed to fetch, so the agent knows what is missing vs. absent. */
  gaps: string[];
}

export interface VetReport {
  tool: { name: string; version: string };
  query: string;
  ecosystem: Ecosystem;
  generatedAt: string;
  candidates: PackageEvidence[];
  notes: string[];
}
