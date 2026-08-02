import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { USER_AGENT } from './version.ts';

/**
 * Deliberately dependency-free.
 *
 * Yes, this file hand-rolls retry/backoff and a concurrency gate -- exactly the kind of thing
 * RepoRadar tells you to stop hand-rolling. The trade is intentional: `npx reporadar` has to
 * install in under a second and carry zero supply-chain surface, so the runtime dep count is 0.
 * That constraint does not apply to the projects we scan, which is the whole point.
 */

const CACHE_DIR =
  process.env.REPORADAR_CACHE_DIR ??
  join(process.env.XDG_CACHE_HOME ?? join(homedir() || tmpdir(), '.cache'), 'reporadar');

const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000; // 6h -- repo health does not change by the minute.

export interface FetchOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  retries?: number;
  /** Cache TTL. 0 disables the cache for this call. */
  ttlMs?: number;
  /** Treat 404 as an empty result instead of an error. */
  allow404?: boolean;
}

let cacheEnabled = true;
export function setCacheEnabled(on: boolean): void {
  cacheEnabled = on;
}

function cachePath(url: string, headerFingerprint: string): string {
  const key = createHash('sha256').update(`${url}\n${headerFingerprint}`).digest('hex').slice(0, 32);
  return join(CACHE_DIR, `${key}.json`);
}

async function readCache<T>(file: string, ttlMs: number): Promise<T | undefined> {
  if (!cacheEnabled || ttlMs <= 0) return undefined;
  try {
    const raw = await readFile(file, 'utf8');
    const entry = JSON.parse(raw) as { at: number; body: T };
    if (Date.now() - entry.at > ttlMs) return undefined;
    return entry.body;
  } catch {
    return undefined;
  }
}

async function writeCache(file: string, body: unknown): Promise<void> {
  if (!cacheEnabled) return;
  try {
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(file, JSON.stringify({ at: Date.now(), body }), 'utf8');
  } catch {
    /* cache is best-effort; never fail a scan over it */
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Retryable: transport errors, 429, and 5xx. Everything else fails fast. */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 408 || (status >= 500 && status < 600);
}

export class HttpError extends Error {
  readonly status: number;
  readonly url: string;

  constructor(message: string, status: number, url: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
  }
}

/** GET a URL and parse JSON, with disk cache, timeout, and bounded retry. */
export async function getJson<T>(url: string, opts: FetchOptions = {}): Promise<T | undefined> {
  const { headers = {}, timeoutMs = 12_000, retries = 2, ttlMs = DEFAULT_TTL_MS, allow404 = true } = opts;
  const allHeaders: Record<string, string> = { accept: 'application/json', 'user-agent': USER_AGENT, ...headers };
  // Auth tokens must partition the cache, but must never be written into a filename.
  const fingerprint = createHash('sha256').update(JSON.stringify(allHeaders)).digest('hex').slice(0, 16);
  const file = cachePath(url, fingerprint);

  const cached = await readCache<T>(file, ttlMs);
  if (cached !== undefined) return cached;

  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      // Exponential backoff with full jitter, capped -- keeps us polite under GitHub's 30/min search cap.
      const base = Math.min(2 ** attempt * 400, 4_000);
      await sleep(Math.random() * base);
    }
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, { headers: allHeaders, signal: ac.signal, redirect: 'follow' });
      if (res.status === 404 || res.status === 204) {
        if (allow404) {
          await writeCache(file, undefined);
          return undefined;
        }
        throw new HttpError(`404 for ${url}`, 404, url);
      }
      if (!res.ok) {
        const err = new HttpError(`HTTP ${res.status} for ${url}`, res.status, url);
        if (isRetryableStatus(res.status) && attempt < retries) {
          lastErr = err;
          continue;
        }
        throw err;
      }
      const body = (await res.json()) as T;
      await writeCache(file, body);
      return body;
    } catch (err) {
      lastErr = err;
      const retryable = !(err instanceof HttpError) || isRetryableStatus(err.status);
      if (!retryable || attempt === retries) break;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`Request failed: ${url}`);
}

/** Like getJson but never throws -- returns undefined and lets the caller record a gap. */
export async function tryJson<T>(url: string, opts: FetchOptions = {}): Promise<T | undefined> {
  try {
    return await getJson<T>(url, opts);
  } catch {
    return undefined;
  }
}

/** Run tasks with bounded concurrency, preserving input order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i] as T, i);
    }
  });
  await Promise.all(workers);
  return out;
}
