import { mapLimit, tryJson } from '../lib/http.ts';
import type { RegistryClient, RegistryFacts } from './registry.ts';

const REGISTRY = 'https://registry.npmjs.org';
const DOWNLOADS = 'https://api.npmjs.org';

interface SearchResponse {
  objects?: Array<{
    package?: { name?: string; version?: string; description?: string; keywords?: string[]; links?: { repository?: string; homepage?: string } };
    downloads?: { weekly?: number; monthly?: number };
    dependents?: string | number;
    searchScore?: number;
  }>;
}

interface LatestManifest {
  name?: string;
  version?: string;
  description?: string;
  license?: string | { type?: string };
  homepage?: string;
  deprecated?: string;
  repository?: string | { url?: string; type?: string };
}

export interface NpmCandidate {
  name: string;
  version?: string;
  description?: string;
  license?: string | null;
  homepage?: string;
  repoUrl?: string;
  deprecated?: { is: boolean; reason?: string };
  downloads?: { weekly?: number; monthly?: number };
  dependentsCount?: number;
}

function normalizeLicense(license: LatestManifest['license']): string | null {
  if (!license) return null;
  return typeof license === 'string' ? license : (license.type ?? null);
}

function repoUrlOf(manifest: LatestManifest): string | undefined {
  const raw = typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url;
  return raw ?? manifest.homepage;
}

/** Extract "owner/name" from any of the many shapes npm repository fields take. */
export function githubSlug(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const m = /github\.com[/:]([^/\s#]+)\/([^/\s#?]+)/i.exec(url);
  if (!m?.[1] || !m[2]) return undefined;
  const name = m[2].replace(/\.git$/i, '');
  if (!name || name === '.' || name === '..') return undefined;
  return `${m[1]}/${name}`;
}

/** Free-text search of the npm registry. No key, no rate limit to speak of. */
export async function searchNpm(query: string, size = 8): Promise<NpmCandidate[]> {
  const url = `${REGISTRY}/-/v1/search?text=${encodeURIComponent(query)}&size=${size}`;
  const res = await tryJson<SearchResponse>(url, { ttlMs: 60 * 60 * 1000 });
  const objects = res?.objects ?? [];
  return objects.flatMap((o) => {
    const name = o.package?.name;
    if (!name) return [];
    const dependents = typeof o.dependents === 'string' ? Number.parseInt(o.dependents, 10) : o.dependents;
    const candidate: NpmCandidate = { name };
    if (o.package?.version) candidate.version = o.package.version;
    if (o.package?.description) candidate.description = o.package.description;
    if (o.package?.links?.repository ?? o.package?.links?.homepage) {
      candidate.repoUrl = o.package.links.repository ?? o.package.links.homepage;
    }
    if (o.downloads) candidate.downloads = o.downloads;
    if (Number.isFinite(dependents)) candidate.dependentsCount = dependents as number;
    return [candidate];
  });
}

/** Fetch the latest-version manifest for one package: license, deprecation, repo link. */
export async function fetchNpmPackage(name: string): Promise<NpmCandidate | undefined> {
  const manifest = await tryJson<LatestManifest>(`${REGISTRY}/${encodeURIComponent(name).replace('%40', '@')}/latest`);
  if (!manifest?.name) return undefined;
  const candidate: NpmCandidate = { name: manifest.name, license: normalizeLicense(manifest.license) };
  if (manifest.version) candidate.version = manifest.version;
  if (manifest.description) candidate.description = manifest.description;
  if (manifest.homepage) candidate.homepage = manifest.homepage;
  const repoUrl = repoUrlOf(manifest);
  if (repoUrl) candidate.repoUrl = repoUrl;
  candidate.deprecated = manifest.deprecated
    ? { is: true, reason: manifest.deprecated }
    : { is: false };
  return candidate;
}

/** Weekly download count -- the strongest single popularity signal in the npm ecosystem. */
export async function fetchWeeklyDownloads(name: string): Promise<number | undefined> {
  const res = await tryJson<{ downloads?: number }>(
    `${DOWNLOADS}/downloads/point/last-week/${encodeURIComponent(name).replace('%40', '@')}`,
    { ttlMs: 12 * 60 * 60 * 1000 },
  );
  return res?.downloads;
}

/** Merge search results with per-package manifest detail, in parallel but politely. */
export async function enrichNpmCandidates(candidates: NpmCandidate[]): Promise<NpmCandidate[]> {
  return mapLimit(candidates, 6, async (candidate) => {
    const [manifest, weekly] = await Promise.all([
      fetchNpmPackage(candidate.name),
      candidate.downloads?.weekly === undefined ? fetchWeeklyDownloads(candidate.name) : Promise.resolve(candidate.downloads.weekly),
    ]);
    const merged: NpmCandidate = { ...candidate, ...manifest, name: candidate.name };
    merged.repoUrl = manifest?.repoUrl ?? candidate.repoUrl;
    if (weekly !== undefined) merged.downloads = { ...candidate.downloads, weekly };
    return merged;
  });
}

/** The npm registry as a generic RegistryClient, so evidence gathering can dispatch by ecosystem. */
export const NPM_CLIENT: RegistryClient = {
  ecosystem: 'npm',
  label: 'npm',
  async fetchPackage(name) {
    const [manifest, weekly] = await Promise.all([fetchNpmPackage(name), fetchWeeklyDownloads(name)]);
    if (!manifest) return undefined;
    const facts: RegistryFacts = { name: manifest.name, license: manifest.license ?? null };
    if (manifest.version) facts.version = manifest.version;
    if (manifest.description) facts.description = manifest.description;
    if (manifest.homepage) facts.homepage = manifest.homepage;
    if (manifest.repoUrl) facts.repoUrl = manifest.repoUrl;
    if (manifest.deprecated) facts.deprecated = manifest.deprecated;
    if (weekly !== undefined) facts.downloads = { weekly };
    return facts;
  },
  async search(query, size) {
    return (await searchNpm(query, size)).map((c) => c.name);
  },
};
