import type { Manifest } from '../lib/types.ts';
import type { SourceFile } from '../scan/walk.ts';
import { SOURCE_SIGNALS, type GapEvidence, type Trait } from './gap-types.ts';
import { maskFileLines } from './mask.ts';

/**
 * Establish what kind of project this is, from evidence rather than assumption.
 *
 * Every trait must be earned by something concrete -- a bin entry, a listen() call, a route
 * literal. This is what stops the gap report from telling a CLI tool it needs security headers.
 */

/** Files that identify a project shape by their mere presence. */
const ROOT_MARKERS: Array<{ file: string; trait: Trait }> = [
  { file: 'dockerfile', trait: 'containerised' },
  { file: 'docker-compose.yml', trait: 'containerised' },
  { file: 'docker-compose.yaml', trait: 'containerised' },
  { file: 'compose.yml', trait: 'containerised' },
  { file: 'compose.yaml', trait: 'containerised' },
  { file: 'procfile', trait: 'http-server' },
  { file: 'fly.toml', trait: 'http-server' },
  { file: 'vercel.json', trait: 'http-server' },
  { file: 'railway.json', trait: 'http-server' },
  { file: 'render.yaml', trait: 'http-server' },
  { file: 'nixpacks.toml', trait: 'http-server' },
];

/** A dependency that is strong evidence of a project shape on its own. */
const DEP_TRAITS: Array<{ deps: string[]; trait: Trait }> = [
  { deps: ['express', 'fastify', 'koa', 'hapi', '@hapi/hapi', 'hono', 'h3', 'nestjs', '@nestjs/core', 'restify', 'polka', 'elysia'], trait: 'http-server' },
  { deps: ['express', 'fastify', 'koa', 'hono', 'h3', '@nestjs/core', 'next', 'nuxt', 'remix', '@remix-run/node', '@sveltejs/kit', 'astro'], trait: 'http-routes' },
  { deps: ['prisma', '@prisma/client', 'drizzle-orm', 'mongoose', 'sequelize', 'typeorm', 'knex', 'pg', 'mysql2', 'better-sqlite3', 'mongodb', '@libsql/client', 'kysely'], trait: 'database' },
  { deps: ['passport', 'next-auth', '@auth/core', 'lucia', 'jose', 'jsonwebtoken', '@clerk/nextjs', '@supabase/supabase-js', 'better-auth'], trait: 'auth' },
  { deps: ['axios', 'got', 'ky', 'undici', 'node-fetch', 'superagent'], trait: 'outbound-http' },
  { deps: ['bullmq', 'bull', 'agenda', 'node-cron', 'croner', 'bee-queue', 'graphile-worker', 'pg-boss', 'inngest'], trait: 'background-work' },
  { deps: ['react', 'vue', 'svelte', 'solid-js', 'preact', '@angular/core', 'lit'], trait: 'frontend' },
];

/** Source signals that establish a trait when they fire anywhere. */
const SIGNAL_TRAITS: Array<{ signals: string[]; trait: Trait }> = [
  { signals: ['listen-call', 'node-http-server', 'express-app', 'fastify-app'], trait: 'http-server' },
  { signals: ['route-handler', 'fetch-handler'], trait: 'http-routes' },
  { signals: ['request-body', 'search-params', 'form-data'], trait: 'reads-user-input' },
  { signals: ['sql-query', 'orm-client'], trait: 'database' },
  { signals: ['auth-vocab', 'password-handling', 'auth-route'], trait: 'auth' },
  { signals: ['outbound-fetch'], trait: 'outbound-http' },
  { signals: ['queue-worker'], trait: 'background-work' },
  { signals: ['react-component', 'dom-access'], trait: 'frontend' },
  { signals: ['env-read'], trait: 'reads-env' },
];

export interface PackageShape {
  hasBin: boolean;
  isPrivate: boolean;
  hasMainOrExports: boolean;
  hasStartScript: boolean;
}

export interface ProfileInput {
  manifests: Manifest[];
  files: SourceFile[];
  /** Every entry name at the scan root, as found on disk. */
  rootEntries: string[];
  packageShape?: PackageShape;
}

export function buildEvidence(input: ProfileInput): GapEvidence {
  const traits = new Set<Trait>();
  const deps = new Set<string>();
  const sourceSignals = new Set<string>();
  const signalSites = new Map<string, { file: string; line: number; text: string }>();

  for (const manifest of input.manifests) {
    for (const name of Object.keys(manifest.dependencies)) deps.add(name.toLowerCase());
    for (const name of Object.keys(manifest.devDependencies)) deps.add(name.toLowerCase());
  }

  const rootFiles = new Set(input.rootEntries.map((f) => f.toLowerCase()));
  const allFiles = new Set(input.files.map((f) => f.rel.toLowerCase()));
  // Lockfiles are filtered out of the walk, so root entries are the only place they show up.
  for (const f of rootFiles) allFiles.add(f);

  // --- source signals, with the first site recorded so the report can cite a line ---
  // Comments and multi-line template bodies never count as evidence: prose describing a feature is
  // not the feature. Beyond that, `codeOnly` signals also ignore single-line string and regex
  // bodies, so a catalog of package names cannot pose as an implementation.
  for (const file of input.files) {
    const views = maskFileLines(file.lines);
    for (let i = 0; i < file.lines.length; i++) {
      const raw = file.lines[i];
      const view = views[i];
      if (raw === undefined || view === undefined || raw.length === 0) continue;
      for (const signal of SOURCE_SIGNALS) {
        if (sourceSignals.has(signal.name)) continue;
        const subject = signal.codeOnly ? view.masked : view.code;
        if (subject.trim().length === 0) continue;
        if (!signal.re.test(subject)) continue;
        // Where the string argument is part of the evidence, require it on the same line.
        if (signal.literalRe && !signal.literalRe.test(view.code)) continue;
        sourceSignals.add(signal.name);
        signalSites.set(signal.name, { file: file.rel, line: i + 1, text: raw.trim().slice(0, 160) });
      }
    }
  }

  // --- traits ---
  for (const { file, trait } of ROOT_MARKERS) {
    if (rootFiles.has(file)) traits.add(trait);
  }
  for (const { deps: names, trait } of DEP_TRAITS) {
    if (names.some((n) => deps.has(n))) traits.add(trait);
  }
  for (const { signals, trait } of SIGNAL_TRAITS) {
    if (signals.some((s) => sourceSignals.has(s))) traits.add(trait);
  }

  const shape = input.packageShape;
  if (shape?.hasBin) traits.add('cli');
  if (shape?.hasStartScript) traits.add('http-server');
  // A package with an entry point and no `private: true` is meant to be installed by someone else.
  if (shape?.hasMainOrExports && !shape.isPrivate) {
    traits.add('library');
    traits.add('published');
  }

  return { traits, deps, rootFiles, allFiles, sourceSignals, signalSites };
}

/** Read the shape fields of package.json that identify what the project is for. */
export function readPackageShape(raw: string): PackageShape | undefined {
  try {
    const pkg = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw) as {
      bin?: unknown;
      private?: boolean;
      main?: string;
      exports?: unknown;
      scripts?: Record<string, string>;
    };
    const start = pkg.scripts?.start;
    return {
      hasBin: pkg.bin !== undefined,
      isPrivate: pkg.private === true,
      hasMainOrExports: pkg.main !== undefined || pkg.exports !== undefined,
      // `start` running a bundler dev server is not a service; running node on a file is.
      hasStartScript: start !== undefined && !/\b(vite|webpack|rollup|parcel|storybook)\b/.test(start),
    };
  } catch {
    return undefined;
  }
}
