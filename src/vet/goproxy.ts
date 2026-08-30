import { tryJson } from '../lib/http.ts';
import { type RegistryClient, type RegistryFacts } from './registry.ts';

const PROXY = 'https://proxy.golang.org';

interface LatestResponse {
  Version?: string;
  Time?: string;
}

/**
 * Go module paths are case-sensitive, but the proxy protocol serves them over a case-insensitive
 * filesystem. The spec resolves this by escaping every uppercase letter as `!` + lowercase, so
 * `github.com/BurntSushi/toml` is requested as `github.com/!burnt!sushi/toml`. Getting this wrong
 * silently 404s on a large fraction of real modules.
 */
export function escapeGoModulePath(path: string): string {
  return path.replace(/[A-Z]/g, (c) => `!${c.toLowerCase()}`);
}

/**
 * A Go module path usually *is* its repository URL, which is the one place Go is easier than every
 * other ecosystem: `github.com/gin-gonic/gin` needs no metadata lookup to find the source.
 */
function repoUrlFromModulePath(path: string): string | undefined {
  if (/^(github|gitlab|bitbucket)\.com\/[^/]+\/[^/]+/.test(path)) {
    const parts = path.split('/');
    return `https://${parts.slice(0, 3).join('/')}`;
  }
  return undefined;
}

async function fetchGoModule(name: string): Promise<RegistryFacts | undefined> {
  const escaped = escapeGoModulePath(name);
  const latest = await tryJson<LatestResponse>(`${PROXY}/${escaped}/@latest`);
  if (!latest?.Version) return undefined;

  const facts: RegistryFacts = {
    name,
    version: latest.Version,
    // The proxy exposes no licence, no description and no deprecation flag; deps.dev fills the
    // licence and advisories in, and the rest stays honestly unknown.
    license: null,
    deprecated: { is: false },
  };
  if (latest.Time) facts.publishedAt = latest.Time;
  const repoUrl = repoUrlFromModulePath(name);
  if (repoUrl) facts.repoUrl = repoUrl;
  return facts;
}

/**
 * pkg.go.dev has no public search API, and the module proxy is a resolver rather than an index.
 * So Go modules must be named explicitly -- declaring no search is more useful than scraping a
 * page whose markup will change.
 */
export const GO_CLIENT: RegistryClient = {
  ecosystem: 'go',
  label: 'Go module proxy',
  fetchPackage: fetchGoModule,
};
