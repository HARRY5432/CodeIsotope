import { tryJson } from '../lib/http.ts';
import { type RegistryClient, type RegistryFacts } from './registry.ts';

const CRATES = 'https://crates.io/api/v1';

interface CratesResponse {
  crate?: {
    name?: string;
    newest_version?: string;
    max_stable_version?: string;
    description?: string;
    repository?: string;
    homepage?: string;
    documentation?: string;
    downloads?: number;
    /** crates.io publishes a rolling 90-day count, not a weekly one. */
    recent_downloads?: number;
    updated_at?: string;
  };
  versions?: Array<{
    num?: string;
    license?: string;
    yanked?: boolean;
    created_at?: string;
  }>;
}

interface CratesSearchResponse {
  crates?: Array<{ name?: string }>;
}

/** 90 days to a nominal week, so the number means the same thing as every other ecosystem's. */
function weeklyFromRecent(recent: number | undefined): number | undefined {
  if (recent === undefined || !Number.isFinite(recent)) return undefined;
  return Math.round(recent / 13);
}

async function fetchCrate(name: string): Promise<RegistryFacts | undefined> {
  const res = await tryJson<CratesResponse>(`${CRATES}/crates/${encodeURIComponent(name)}`);
  const crate = res?.crate;
  if (!crate?.name) return undefined;

  // Prefer the newest *stable* release: a crate whose newest version is a prerelease should be
  // judged on what a consumer would actually install.
  const version = crate.max_stable_version ?? crate.newest_version;
  const entry = res?.versions?.find((v) => v.num === version) ?? res?.versions?.[0];

  const facts: RegistryFacts = {
    name: crate.name,
    license: entry?.license ?? null,
    // crates.io permanently deletes nothing and has no deprecation flag; a yanked newest version is
    // the only in-band signal that the maintainer pulled it.
    deprecated: entry?.yanked ? { is: true, reason: 'newest release is yanked from crates.io' } : { is: false },
  };
  if (version) facts.version = version;
  if (crate.description) facts.description = crate.description.replace(/\s+/g, ' ').trim();
  if (crate.repository) facts.repoUrl = crate.repository;
  if (crate.homepage ?? crate.documentation) facts.homepage = crate.homepage ?? crate.documentation;

  const weekly = weeklyFromRecent(crate.recent_downloads);
  if (weekly !== undefined) facts.downloads = { weekly };
  const published = entry?.created_at ?? crate.updated_at;
  if (published) facts.publishedAt = published;

  return facts;
}

async function searchCrates(query: string, size: number): Promise<string[]> {
  const url = `${CRATES}/crates?q=${encodeURIComponent(query)}&per_page=${Math.min(size, 100)}`;
  const res = await tryJson<CratesSearchResponse>(url, { ttlMs: 60 * 60 * 1000 });
  return (res?.crates ?? []).flatMap((c) => (c.name ? [c.name] : []));
}

/**
 * crates.io asks for a descriptive user-agent and rate-limits anonymous traffic politely rather
 * than harshly. Our client sends one by default, and every call goes through the shared cache.
 */
export const CRATES_CLIENT: RegistryClient = {
  ecosystem: 'cargo',
  label: 'crates.io',
  fetchPackage: fetchCrate,
  search: searchCrates,
};
