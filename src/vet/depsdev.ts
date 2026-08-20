import { tryJson } from '../lib/http.ts';
import type { Ecosystem } from '../lib/types.ts';

const API = 'https://api.deps.dev/v3alpha';

/** deps.dev system names differ from ours. */
const SYSTEM: Record<Ecosystem, string | undefined> = {
  npm: 'npm', pypi: 'pypi', cargo: 'cargo', go: 'go', maven: 'maven', nuget: 'nuget', rubygems: undefined,
};

interface PackageResponse {
  versions?: Array<{ versionKey?: { version?: string }; isDefault?: boolean; isDeprecated?: boolean; deprecatedReason?: string; publishedAt?: string }>;
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
}

/**
 * Google's Open Source Insights. Free, no key, and the authoritative cross-ecosystem source for
 * deprecation, licences, known advisories, and the canonical source repository.
 */
export async function fetchDepsDev(ecosystem: Ecosystem, name: string): Promise<DepsDevFacts | undefined> {
  const system = SYSTEM[ecosystem];
  if (!system) return undefined;

  const pkgUrl = `${API}/systems/${system}/packages/${encodeURIComponent(name)}`;
  const pkg = await tryJson<PackageResponse>(pkgUrl);
  const versions = pkg?.versions ?? [];
  if (versions.length === 0) return undefined;

  const chosen = versions.find((v) => v.isDefault) ?? versions[versions.length - 1];
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
  return facts;
}
