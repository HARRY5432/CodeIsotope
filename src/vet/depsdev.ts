import { tryJson } from '../lib/http.ts';
import type { Ecosystem } from '../lib/types.ts';

const API = 'https://api.deps.dev/v3alpha';

/** deps.dev system names differ from ours. */
const SYSTEM: Record<Ecosystem, string | undefined> = {
  npm: 'npm', pypi: 'pypi', cargo: 'cargo', go: 'go', maven: 'maven', nuget: 'nuget', rubygems: undefined,
};

interface PackageResponse {
  versions?: DepsDevVersion[];
}

interface DepsDevVersion {
  versionKey?: { version?: string };
  isDefault?: boolean;
  isDeprecated?: boolean;
  deprecatedReason?: string;
  publishedAt?: string;
}

interface VersionResponse {
  isDeprecated?: boolean;
  deprecatedReason?: string;
  licenses?: string[];
  advisoryKeys?: Array<{ id?: string }>;
  relatedProjects?: Array<{ projectKey?: { id?: string }; relationType?: string }>;
  publishedAt?: string;
}

export interface DepsDevFacts {
  defaultVersion?: string;
  publishedAt?: string;
  deprecated?: { is: boolean; reason?: string };
  licenses?: string[];
  /** GHSA / OSV advisory ids affecting the default version. Non-empty means do not recommend as-is. */
  advisories: string[];
  /** Canonical source repo, e.g. "github.com/sindresorhus/p-retry". */
  sourceRepo?: string;
  /** "owner/name" if the source repo is on GitHub. */
  githubSlug?: string;
  /** How many published packages depend on this version. */
  dependents?: { direct?: number; total?: number };
}

interface DependentsResponse {
  dependentCount?: number;
  directDependentCount?: number;
  indirectDependentCount?: number;
}

/**
 * A prerelease version, in either of the two conventions our ecosystems use.
 *
 * This matters more than it looks. deps.dev reports `isDefault: true` for httpx's `1.0.0.dev5`,
 * and asking for that version's dependents returns 34 -- against 38,576 for the stable `0.28.1`
 * that people actually install. Grading a package on a prerelease nobody uses made httpx, one of
 * Python's most-depended-on HTTP clients, score F 33/100 with "modest adoption".
 *
 * Two patterns are needed because PEP 440 makes the separator optional: `2.0b1` and `1.0a1` are
 * prereleases with no punctuation before the marker, which a separator-anchored pattern misses.
 */
const PEP440_ATTACHED = /\d(?:a|b|c|rc)\d*$/i;
const SEPARATED_MARKER = /[-._](?:a|b|c|rc|alpha|beta|dev|pre|preview|next|canary|nightly|snapshot)\.?\d*$/i;

export function isPrerelease(version: string): boolean {
  // SemVer puts everything after the first hyphen in the prerelease field.
  return version.includes('-') || PEP440_ATTACHED.test(version) || SEPARATED_MARKER.test(version);
}

/**
 * Pick the version to grade: the newest stable release, falling back to whatever deps.dev calls
 * default only when every version is a prerelease.
 */
export function chooseVersion(
  versions: readonly DepsDevVersion[],
  preferred?: string,
): DepsDevVersion | undefined {
  // The registry's own answer wins when we have it: PyPI and crates.io both distinguish a stable
  // release from a prerelease more reliably than deps.dev's default flag.
  if (preferred) {
    const match = versions.find((v) => v.versionKey?.version === preferred);
    if (match) return match;
  }

  const stable = versions.filter((v) => {
    const version = v.versionKey?.version;
    return version !== undefined && !isPrerelease(version);
  });

  const defaultStable = stable.find((v) => v.isDefault);
  if (defaultStable) return defaultStable;
  // deps.dev returns versions oldest-first, so the last stable entry is the newest one.
  if (stable.length > 0) return stable[stable.length - 1];

  return versions.find((v) => v.isDefault) ?? versions[versions.length - 1];
}

/**
 * How many published packages depend on this one.
 *
 * This is the adoption signal that actually ports across ecosystems. Download counts do not:
 * `requests` records ~297M PyPI downloads a week against ~1M/week for a thriving npm package,
 * because the two registries count entirely different things. Dependent counts measure what an
 * ecosystem chose to build on, and mean the same thing everywhere.
 */
async function fetchDependents(system: string, name: string, version: string): Promise<DepsDevFacts['dependents']> {
  const url = `${API}/systems/${system}/packages/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}:dependents`;
  const res = await tryJson<DependentsResponse>(url);
  if (!res) return undefined;
  const out: NonNullable<DepsDevFacts['dependents']> = {};
  if (Number.isFinite(res.directDependentCount)) out.direct = res.directDependentCount;
  if (Number.isFinite(res.dependentCount)) out.total = res.dependentCount;
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Google's Open Source Insights. Free, no key, and the authoritative cross-ecosystem source for
 * deprecation, licences, known advisories, and the canonical source repository.
 *
 * `preferVersion` is the version the package's own registry considers current. Passing it avoids
 * grading a package on a prerelease -- see `chooseVersion`.
 */
export async function fetchDepsDev(
  ecosystem: Ecosystem,
  name: string,
  preferVersion?: string,
): Promise<DepsDevFacts | undefined> {
  const system = SYSTEM[ecosystem];
  if (!system) return undefined;

  const pkgUrl = `${API}/systems/${system}/packages/${encodeURIComponent(name)}`;
  const pkg = await tryJson<PackageResponse>(pkgUrl);
  const versions = pkg?.versions ?? [];
  if (versions.length === 0) return undefined;

  const chosen = chooseVersion(versions, preferVersion);
  const version = chosen?.versionKey?.version;
  if (!version) return undefined;

  const detail = await tryJson<VersionResponse>(`${pkgUrl}/versions/${encodeURIComponent(version)}`);

  const sourceRepo = detail?.relatedProjects?.find((p) => p.relationType === 'SOURCE_REPO')?.projectKey?.id;
  const slugMatch = sourceRepo ? /^github\.com\/([^/]+\/[^/]+)$/.exec(sourceRepo) : null;

  const facts: DepsDevFacts = {
    defaultVersion: version,
    advisories: (detail?.advisoryKeys ?? []).flatMap((a) => (a.id ? [a.id] : [])),
  };
  const isDeprecated = detail?.isDeprecated ?? chosen?.isDeprecated;
  if (isDeprecated !== undefined) {
    facts.deprecated = { is: Boolean(isDeprecated) };
    const reason = detail?.deprecatedReason ?? chosen?.deprecatedReason;
    if (isDeprecated && reason) facts.deprecated.reason = reason;
  }
  if (detail?.licenses?.length) facts.licenses = detail.licenses;
  const publishedAt = detail?.publishedAt ?? chosen?.publishedAt;
  if (publishedAt) facts.publishedAt = publishedAt;
  if (sourceRepo) facts.sourceRepo = sourceRepo;
  if (slugMatch?.[1]) facts.githubSlug = slugMatch[1];

  const dependents = await fetchDependents(system, name, version);
  if (dependents) facts.dependents = dependents;

  return facts;
}
