import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mapLimit, tryJson } from '../lib/http.ts';
import type { RepoEvidence } from '../lib/types.ts';

const API = 'https://api.github.com';
const execFileAsync = promisify(execFile);

let tokenPromise: Promise<string | undefined> | undefined;

/**
 * Token resolution, in order: explicit env vars, then the local `gh` CLI login.
 * Unauthenticated still works -- 60 core requests/hour instead of 5,000 -- so this is a
 * throughput upgrade, never a requirement.
 */
async function resolveToken(): Promise<string | undefined> {
  const fromEnv = process.env.CODEISOTOPE_GITHUB_TOKEN ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (fromEnv) return fromEnv;
  try {
    // No shell: argv form, so a hostile PATH entry cannot inject.
    const { stdout } = await execFileAsync('gh', ['auth', 'token'], { timeout: 4_000, windowsHide: true });
    const token = stdout.trim();
    return token.length > 0 ? token : undefined;
  } catch {
    return undefined;
  }
}

function githubToken(): Promise<string | undefined> {
  tokenPromise ??= resolveToken();
  return tokenPromise;
}

async function ghHeaders(): Promise<Record<string, string>> {
  const token = await githubToken();
  return {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

interface RepoResponse {
  full_name?: string;
  html_url?: string;
  stargazers_count?: number;
  forks_count?: number;
  open_issues_count?: number;
  archived?: boolean;
  disabled?: boolean;
  fork?: boolean;
  created_at?: string;
  pushed_at?: string;
  license?: { spdx_id?: string | null } | null;
  topics?: string[];
}

interface ReleaseResponse {
  tag_name?: string;
  published_at?: string;
  draft?: boolean;
  prerelease?: boolean;
}

interface CommitResponse {
  commit?: { committer?: { date?: string }; author?: { date?: string } };
}

interface ContributorResponse {
  login?: string;
  contributions?: number;
}

const DAY_MS = 86_400_000;

/** Gather everything we can about one repo. Every sub-request is best-effort. */
/**
 * `packageName` is used only to pick the right releases out of a monorepo. napi-rs/node-rs, for
 * example, publishes dozens of packages from one repo, so its newest GitHub release is usually for
 * a sibling -- reporting that as this package's release date would be simply wrong.
 */
export async function fetchRepoEvidence(slug: string, packageName?: string): Promise<RepoEvidence | undefined> {
  const headers = await ghHeaders();
  const base = `${API}/repos/${slug}`;
  const since = new Date(Date.now() - 90 * DAY_MS).toISOString();

  const repo = await tryJson<RepoResponse>(base, { headers });
  if (!repo?.full_name) return undefined;

  const [releases, commits, contributors] = await Promise.all([
    tryJson<ReleaseResponse[]>(`${base}/releases?per_page=20`, { headers }),
    tryJson<CommitResponse[]>(`${base}/commits?since=${since}&per_page=100`, { headers }),
    tryJson<ContributorResponse[]>(`${base}/contributors?per_page=10&anon=0`, { headers }),
  ]);

  const allPublished = (releases ?? []).filter((r) => !r.draft && r.published_at);
  const bare = (packageName ?? '').split('/').pop() ?? '';
  const scoped = bare.length > 2 ? allPublished.filter((r) => r.tag_name?.toLowerCase().includes(bare.toLowerCase())) : [];
  const published = scoped.length > 0 ? scoped : allPublished;
  const yearAgo = Date.now() - 365 * DAY_MS;
  const releaseInfo: RepoEvidence['releases'] = {};
  const latest = published[0];
  if (latest?.tag_name) releaseInfo.latestTag = latest.tag_name;
  if (latest?.published_at) releaseInfo.latestAt = latest.published_at;
  if (published.length > 0) {
    releaseInfo.countLast12mo = published.filter((r) => Date.parse(r.published_at as string) >= yearAgo).length;
  }

  const commitInfo: RepoEvidence['commits'] = {};
  if (commits) {
    commitInfo.last90d = commits.length;
    const newest = commits[0]?.commit?.committer?.date ?? commits[0]?.commit?.author?.date;
    if (newest) commitInfo.lastCommitAt = newest;
    else {
      // The 90-day window is empty, so ask for the single most recent commit. "last commit 400 days
      // ago" is far more useful to a reader than "no commits in the last 90 days", and this extra
      // request only ever fires for repos that already look stale.
      const latest = await tryJson<CommitResponse[]>(`${base}/commits?per_page=1`, { headers });
      const date = latest?.[0]?.commit?.committer?.date ?? latest?.[0]?.commit?.author?.date;
      if (date) commitInfo.lastCommitAt = date;
    }
  }

  const contributorInfo: RepoEvidence['contributors'] = {};
  if (contributors && contributors.length > 0) {
    contributorInfo.total = contributors.length;
    const counts = contributors.map((c) => c.contributions ?? 0).sort((a, b) => b - a);
    const total = counts.reduce((a, b) => a + b, 0);
    if (total > 0) {
      const top3 = counts.slice(0, 3).reduce((a, b) => a + b, 0);
      contributorInfo.busFactorTop3Share = Math.round((top3 / total) * 100) / 100;
    }
  }

  return {
    slug: repo.full_name,
    url: repo.html_url ?? `https://github.com/${repo.full_name}`,
    stars: repo.stargazers_count ?? 0,
    forks: repo.forks_count ?? 0,
    openIssues: repo.open_issues_count ?? 0,
    archived: Boolean(repo.archived || repo.disabled),
    isFork: Boolean(repo.fork),
    createdAt: repo.created_at ?? '',
    pushedAt: repo.pushed_at ?? '',
    license: repo.license?.spdx_id && repo.license.spdx_id !== 'NOASSERTION' ? repo.license.spdx_id : null,
    topics: repo.topics ?? [],
    releases: releaseInfo,
    commits: commitInfo,
    contributors: contributorInfo,
  };
}

export async function fetchRepoEvidenceMany(slugs: readonly string[]): Promise<Map<string, RepoEvidence>> {
  const results = await mapLimit(slugs, 4, (slug) => fetchRepoEvidence(slug).catch(() => undefined));
  const map = new Map<string, RepoEvidence>();
  slugs.forEach((slug, i) => {
    const evidence = results[i];
    if (evidence) map.set(slug, evidence);
  });
  return map;
}

/** Whether we are running with a token, for the report's "how complete is this" note. */
export async function isAuthenticated(): Promise<boolean> {
  return (await githubToken()) !== undefined;
}
