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
  /** Feed these to `codeisotope vet` to gather evidence. */
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

/**
 * What an audited dependency is: 'healthy' needs no action, 'aging' is a watch item,
 * 'weak' should be reviewed, and 'replace' is a hard problem -- deprecated, archived,
 * or carrying a published advisory.
 */
export type DepVerdict = 'healthy' | 'aging' | 'weak' | 'replace';

/** How the project declares the dependency. Dev deps are graded more leniently. */
export type DepKind = 'direct' | 'dev';

export interface AuditedDep {
  name: string;
  kind: DepKind;
  /** The range as written in the manifest, e.g. "^4.17.21". */
  range: string;
  /** Manifest the range came from, relative to scan root. */
  manifest: string;
  verdict: DepVerdict;
  /** Ordered, human-readable reasons the verdict is what it is. */
  reasons: string[];
  evidence: PackageEvidence;
  /**
   * The replacement the maintainer named in the deprecation message, when there is one. This is a
   * fact quoted from package metadata, not a suggestion of ours -- still worth vetting before use.
   * `builtIn` means the answer is to delete the dependency, not swap it.
   */
  maintainerSuggestion?: { name: string; builtIn: boolean };
  /** Feed these to `codeisotope vet` to find and prove a replacement. Only set for weak/replace. */
  searchTerms?: string[];
}

/** Everything `codeisotope audit` reports about the dependencies already installed. */
export interface AuditReport {
  tool: { name: string; version: string };
  root: string;
  ecosystem: Ecosystem;
  generatedAt: string;
  /** Counts by verdict, so CI can act without walking the list. */
  totals: { audited: number; healthy: number; aging: number; weak: number; replace: number };
  deps: AuditedDep[];
  /** Dependencies we could not gather any evidence for, with the reason. */
  unresolved: Array<{ name: string; kind: DepKind; reason: string }>;
  notes: string[];
}

/** Infrastructure the project has no answer for at all. */
export interface MissingCapability {
  gapId: string;
  capability: string;
  severity: Confidence;
  /** Why this matters, in terms of the concrete failure it prevents. */
  why: string;
  /** The project traits that made this gap applicable -- why we think it applies to you. */
  becauseTraits: string[];
  /** Where we saw the evidence, so the claim is checkable. */
  citations: Array<{ file: string; line: number; text: string }>;
  knownSolutions: string[];
  /** Feed these to `codeisotope vet`. */
  searchTerms: string[];
}

export interface GapReport {
  tool: { name: string; version: string };
  root: string;
  generatedAt: string;
  /** What we established about the project, and therefore which gaps were even considered. */
  profile: {
    traits: string[];
    scanned: { files: number; durationMs: number };
  };
  missing: MissingCapability[];
  /** Gaps checked and found already handled, with what handles them. */
  satisfied: Array<{ gapId: string; capability: string; by: string }>;
  /** Gaps not checked because the project is not that kind of project. */
  notApplicable: Array<{ gapId: string; capability: string; needsTraits: string[] }>;
  notes: string[];
}

/** One file in a healthy repository, pinned to a commit so the link cannot rot. */
export interface ReferenceFile {
  /** Repo-relative path. */
  path: string;
  /** Permalink pinned to a commit SHA, not a branch name. */
  url: string;
  size: number;
  /** Why this file was picked, so the ranking is inspectable. */
  reasons: string[];
}

export interface ReferenceSource {
  /** Package the reference came from. */
  package: string;
  version?: string;
  slug: string;
  /** The commit every url below is pinned to. */
  commit: string;
  defaultBranch: string;
  /** Health of the source, so a reader knows whether this is worth imitating. */
  health: { score: number; grade: HealthVerdict['grade']; summary: string };
  license: string | null;
  files: ReferenceFile[];
  /** Set when the repo's file listing was incomplete or gave no usable signal. */
  note?: string;
}

export interface ReferenceReport {
  tool: { name: string; version: string };
  query: string;
  generatedAt: string;
  sources: ReferenceSource[];
  notes: string[];
}
