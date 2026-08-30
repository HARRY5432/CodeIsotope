import type { Ecosystem } from '../lib/types.ts';

/**
 * What any package registry can tell us, normalised so the rest of the tool never has to know
 * which ecosystem it is looking at.
 *
 * Every registry answers a different subset of this, and the missing fields matter as much as the
 * present ones -- a field left undefined becomes an "unknown" signal, which the health score drops
 * from the average rather than counting as a failure.
 */
export interface RegistryFacts {
  name: string;
  version?: string;
  description?: string;
  license?: string | null;
  homepage?: string;
  /** Anything that might contain a source repository URL. */
  repoUrl?: string;
  deprecated?: { is: boolean; reason?: string };
  /**
   * Downloads, where the registry publishes them. Deliberately NOT comparable across ecosystems:
   * `requests` gets 297M PyPI downloads a week and a thriving npm package gets 1M, because PyPI
   * counts every CI mirror. Thresholds are per-ecosystem for exactly this reason.
   */
  downloads?: { weekly?: number; monthly?: number };
  /**
   * How many published packages depend on this one. This IS portable across ecosystems, and is the
   * better adoption signal: it measures what the ecosystem actually builds on rather than how
   * often a mirror pulled a tarball.
   */
  dependents?: { direct?: number; total?: number };
  /** When the newest version was published. */
  publishedAt?: string;
}

/** One package registry. Search is optional -- not every registry has a usable search API. */
export interface RegistryClient {
  ecosystem: Ecosystem;
  /** Human name, for notes and error messages. */
  label: string;
  fetchPackage(name: string): Promise<RegistryFacts | undefined>;
  /** Free-text search. Absent when the registry has no search we can rely on. */
  search?(query: string, size: number): Promise<string[]>;
}

/** Extract "owner/name" from any of the many shapes a repository URL takes. */
export function githubSlugFrom(...urls: Array<string | undefined>): string | undefined {
  for (const url of urls) {
    if (!url) continue;
    const m = /github\.com[/:]([^/\s#]+)\/([^/\s#?]+)/i.exec(url);
    if (!m?.[1] || !m[2]) continue;
    const name = m[2].replace(/\.git$/i, '');
    if (!name || name === '.' || name === '..') continue;
    return `${m[1]}/${name}`;
  }
  return undefined;
}

/**
 * Pick the likeliest source-repository URL out of a bag of project links.
 *
 * Ordered by how reliably each key names the actual source. PyPI in particular lets a maintainer
 * put anything in `project_urls`, and "Documentation" pointing at a docs site is common -- so the
 * explicit source keys are tried first and the homepage last.
 */
const REPO_URL_KEYS = ['source', 'source code', 'repository', 'code', 'github', 'homepage', 'home'];

export function pickRepoUrl(links: Record<string, string | undefined> | undefined): string | undefined {
  if (!links) return undefined;
  const lower = new Map<string, string>();
  for (const [key, value] of Object.entries(links)) {
    if (value) lower.set(key.toLowerCase(), value);
  }
  // A key that explicitly names the source wins, but only if it actually points at a forge.
  for (const key of REPO_URL_KEYS) {
    const value = lower.get(key);
    if (value && githubSlugFrom(value)) return value;
  }
  // Otherwise any value that looks like a GitHub URL is better than nothing.
  for (const value of lower.values()) {
    if (githubSlugFrom(value)) return value;
  }
  return undefined;
}
