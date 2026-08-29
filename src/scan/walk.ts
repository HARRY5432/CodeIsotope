import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, join, relative, sep } from 'node:path';

/** Directories that never contain code worth analysing. */
export const IGNORE_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', 'target',
  '.next', '.nuxt', '.svelte-kit', '.output', '.turbo', '.parcel-cache', '.cache',
  'coverage', '.nyc_output', 'vendor', 'venv', '.venv', '__pycache__', '.mypy_cache',
  '.pytest_cache', '.tox', '.gradle', '.idea', '.vscode', '.terraform',
  'bower_components', 'jspm_packages', '.yarn', '.pnpm-store', '.serverless',
  'Pods', 'DerivedData', '.dart_tool', 'bin', 'obj', 'tmp', 'temp', '.codeisotope-cache',
]);

/** Files whose contents are generated, vendored, or lockfiles -- noise for detectors. */
const IGNORE_FILE_PATTERNS = [
  /\.min\.(js|css|mjs)$/i,
  /\.bundle\.js$/i,
  /[-.](lock|generated|gen)\.[a-z]+$/i,
  /^(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|composer\.lock|Gemfile\.lock|poetry\.lock|Cargo\.lock)$/,
  /\.d\.ts$/,
  /\.(snap|map)$/,
];

const MAX_FILE_BYTES = 512 * 1024;

export interface SourceFile {
  /** Absolute path. */
  abs: string;
  /** Path relative to the scan root, always with forward slashes. */
  rel: string;
  ext: string;
  bytes: number;
  lines: string[];
}

export interface WalkStats {
  files: number;
  bytes: number;
  skippedDirs: number;
  skippedFiles: number;
}

export interface WalkOptions {
  /** Hard cap so a scan of a giant monorepo still finishes fast. */
  maxFiles?: number;
  /** Only read files with these extensions. */
  extensions?: Set<string>;
  maxDepth?: number;
}

function isIgnoredFile(name: string): boolean {
  return IGNORE_FILE_PATTERNS.some((re) => re.test(name));
}

/** Minified or single-line-bundle heuristic: cheap, and avoids thousands of bogus matches. */
function looksMinified(lines: string[], bytes: number): boolean {
  if (lines.length === 0) return false;
  if (lines.some((l) => l.length > 1_000)) return true;
  return bytes / lines.length > 250;
}

/**
 * Walk `root` breadth-first, reading only text source files that pass the filters.
 * Returns files plus the stats needed to tell the agent how much of the repo was actually seen.
 */
export async function walkSource(root: string, opts: WalkOptions = {}): Promise<{ files: SourceFile[]; stats: WalkStats }> {
  const { maxFiles = 4_000, extensions, maxDepth = 12 } = opts;
  const files: SourceFile[] = [];
  const stats: WalkStats = { files: 0, bytes: 0, skippedDirs: 0, skippedFiles: 0 };
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    if (current.depth > maxDepth) continue;

    let entries;
    try {
      entries = await readdir(current.dir, { withFileTypes: true });
    } catch {
      stats.skippedDirs++;
      continue;
    }

    for (const entry of entries) {
      const abs = join(current.dir, entry.name);
      if (entry.isDirectory()) {
        if (IGNORE_DIRS.has(entry.name) || entry.name.startsWith('.')) {
          stats.skippedDirs++;
          continue;
        }
        queue.push({ dir: abs, depth: current.depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;
      if (files.length >= maxFiles) continue;

      const ext = extname(entry.name);
      if (extensions && !extensions.has(ext)) continue;
      if (isIgnoredFile(entry.name)) {
        stats.skippedFiles++;
        continue;
      }

      let size: number;
      try {
        size = (await stat(abs)).size;
      } catch {
        stats.skippedFiles++;
        continue;
      }
      if (size > MAX_FILE_BYTES || size === 0) {
        stats.skippedFiles++;
        continue;
      }

      let text: string;
      try {
        text = await readFile(abs, 'utf8');
      } catch {
        stats.skippedFiles++;
        continue;
      }
      if (text.includes('\u0000')) {
        stats.skippedFiles++;
        continue;
      }

      const lines = text.split(/\r?\n/);
      if (looksMinified(lines, size)) {
        stats.skippedFiles++;
        continue;
      }

      files.push({ abs, rel: relative(root, abs).split(sep).join('/'), ext, bytes: size, lines });
      stats.files++;
      stats.bytes += size;
    }
  }

  return { files, stats };
}
