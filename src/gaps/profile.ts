import type { Manifest } from '../lib/types.ts';
import type { SourceFile } from '../scan/walk.ts';
import { SOURCE_SIGNALS, type GapEvidence, type Language, type Trait } from './gap-types.ts';
import { maskFileLines } from './mask.ts';
import { maskPythonFile } from './mask-python.ts';
import { PY_GAP_EXT, PY_SOURCE_SIGNALS } from './signals-python.ts';

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

  // --- Python. Names are matched case-insensitively, since PyPI treats `Flask` and `flask` alike.
  { deps: ['flask', 'django', 'fastapi', 'starlette', 'quart', 'sanic', 'aiohttp', 'bottle', 'pyramid', 'tornado', 'litestar'], trait: 'http-server' },
  { deps: ['flask', 'django', 'fastapi', 'starlette', 'quart', 'sanic', 'bottle', 'pyramid', 'litestar', 'djangorestframework'], trait: 'http-routes' },
  { deps: ['sqlalchemy', 'psycopg', 'psycopg2', 'psycopg2-binary', 'pymysql', 'asyncpg', 'pymongo', 'motor', 'peewee', 'tortoise-orm', 'sqlmodel', 'django', 'redis', 'alembic'], trait: 'database' },
  { deps: ['passlib', 'bcrypt', 'argon2-cffi', 'python-jose', 'pyjwt', 'authlib', 'flask-login', 'django-allauth', 'fastapi-users'], trait: 'auth' },
  { deps: ['requests', 'httpx', 'aiohttp', 'urllib3', 'niquests'], trait: 'outbound-http' },
  { deps: ['celery', 'rq', 'dramatiq', 'apscheduler', 'huey', 'arq', 'schedule', 'prefect', 'airflow', 'apache-airflow'], trait: 'background-work' },
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

  // --- Python equivalents.
  { signals: ['py-flask-app', 'py-django', 'py-fastapi-app', 'py-asgi-app', 'py-run-server'], trait: 'http-server' },
  { signals: ['py-route-decorator', 'py-django-urlpatterns'], trait: 'http-routes' },
  { signals: ['py-request-data'], trait: 'reads-user-input' },
  { signals: ['py-db-client', 'py-orm-import'], trait: 'database' },
  { signals: ['py-password-use', 'py-auth-route'], trait: 'auth' },
  { signals: ['py-outbound-http'], trait: 'outbound-http' },
  { signals: ['py-worker'], trait: 'background-work' },
  { signals: ['py-env-read'], trait: 'reads-env' },
  // A tool that parses arguments is a CLI whether or not packaging says so.
  { signals: ['py-argparse', 'py-cli-framework'], trait: 'cli' },
];

/**
 * Traits that need corroboration from a second signal before they count.
 *
 * `sys.argv` and `input()` are suggestive of a CLI but appear in plenty of things that are not one:
 * a test harness reads argv, a migration script prompts for confirmation. Requiring a second
 * independent signal keeps the trait honest without demanding a packaging declaration.
 */
const CORROBORATED_TRAITS: Array<{ signals: string[]; trait: Trait; language: Language; minimum: number }> = [
  { signals: ['py-argv-use', 'py-stdin-prompt'], trait: 'cli', language: 'python', minimum: 2 },
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
  pythonShape?: PythonShape;
}

export function buildEvidence(input: ProfileInput): GapEvidence {
  const traits = new Set<Trait>();
  const traitsByLanguage = new Map<Language, Set<Trait>>([
    ['javascript', new Set<Trait>()],
    ['python', new Set<Trait>()],
  ]);
  const deps = new Set<string>();
  const sourceSignals = new Set<string>();
  const signalSites = new Map<string, { file: string; line: number; text: string }>();

  /** Record a trait globally and against the language whose evidence produced it. */
  const add = (trait: Trait, language?: Language) => {
    traits.add(trait);
    if (language) traitsByLanguage.get(language)?.add(trait);
  };

  for (const manifest of input.manifests) {
    for (const name of Object.keys(manifest.dependencies)) deps.add(name.toLowerCase());
    for (const name of Object.keys(manifest.devDependencies)) deps.add(name.toLowerCase());
  }

  /** Which language a dependency name belongs to, by the manifest that declared it. */
  const depLanguage = new Map<string, Language>();
  for (const manifest of input.manifests) {
    const language: Language | undefined =
      manifest.ecosystem === 'npm' ? 'javascript' : manifest.ecosystem === 'pypi' ? 'python' : undefined;
    if (!language) continue;
    for (const name of [...Object.keys(manifest.dependencies), ...Object.keys(manifest.devDependencies)]) {
      depLanguage.set(name.toLowerCase(), language);
    }
  }

  const rootFiles = new Set(input.rootEntries.map((f) => f.toLowerCase()));
  const allFiles = new Set(input.files.map((f) => f.rel.toLowerCase()));
  // Lockfiles are filtered out of the walk, so root entries are the only place they show up.
  for (const f of rootFiles) allFiles.add(f);

  /** Which language each signal name belongs to, so a trait is attributed correctly. */
  const signalLanguage = new Map<string, Language>();
  for (const s of SOURCE_SIGNALS) signalLanguage.set(s.name, 'javascript');
  for (const s of PY_SOURCE_SIGNALS) signalLanguage.set(s.name, 'python');

  // --- source signals, with the first site recorded so the report can cite a line ---
  // Comments and multi-line template/docstring bodies never count as evidence: prose describing a
  // feature is not the feature. Beyond that, `codeOnly` signals also ignore single-line string and
  // regex bodies, so a catalog of package names cannot pose as an implementation.
  //
  // Each language gets its own signal set and its own masker. Merging them would let a Node project
  // match a Python signal, and the two languages need different advice for the same gap: a Node
  // service closes its own server on SIGTERM, a Flask app delegates that to gunicorn.
  for (const file of input.files) {
    const python = PY_GAP_EXT.includes(file.ext);
    const views = python ? maskPythonFile(file.lines) : maskFileLines(file.lines);
    const signals = python ? PY_SOURCE_SIGNALS : SOURCE_SIGNALS;
    const language: Language = python ? 'python' : 'javascript';
    if (file.lines.length > 0) add(language, language);

    for (let i = 0; i < file.lines.length; i++) {
      const raw = file.lines[i];
      const view = views[i];
      if (raw === undefined || view === undefined || raw.length === 0) continue;
      for (const signal of signals) {
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
  // A root marker names no language, so it counts for every language present. A Dockerfile in a
  // polyglot repo genuinely applies to whichever service it builds.
  for (const { file, trait } of ROOT_MARKERS) {
    if (!rootFiles.has(file)) continue;
    traits.add(trait);
    for (const [language, set] of traitsByLanguage) {
      if (traits.has(language)) set.add(trait);
    }
  }
  for (const { deps: names, trait } of DEP_TRAITS) {
    for (const name of names) {
      if (!deps.has(name)) continue;
      add(trait, depLanguage.get(name));
    }
  }
  for (const { signals, trait } of SIGNAL_TRAITS) {
    for (const s of signals) {
      if (!sourceSignals.has(s)) continue;
      add(trait, signalLanguage.get(s));
    }
  }
  for (const { signals, trait, language, minimum } of CORROBORATED_TRAITS) {
    const hits = signals.filter((s) => sourceSignals.has(s)).length;
    if (hits >= minimum) add(trait, language);
  }

  // A Python manifest is enough to establish the language even before any source is read: a project
  // whose only .py files were skipped by the walker is still a Python project.
  if (input.manifests.some((m) => m.ecosystem === 'pypi')) add('python', 'python');
  if (input.manifests.some((m) => m.ecosystem === 'npm')) add('javascript', 'javascript');

  const shape = input.packageShape;
  if (shape?.hasBin) add('cli', 'javascript');
  if (shape?.hasStartScript) add('http-server', 'javascript');
  // A package with an entry point and no `private: true` is meant to be installed by someone else.
  if (shape?.hasMainOrExports && !shape.isPrivate) {
    add('library', 'javascript');
    add('published', 'javascript');
  }
  // Python's equivalent of a bin entry: a console_scripts entry point, or a __main__ module.
  if (input.pythonShape?.hasConsoleScript) add('cli', 'python');
  if (input.pythonShape?.isPackaged) {
    add('library', 'python');
    add('published', 'python');
  }

  return { traits, traitsByLanguage, deps, rootFiles, allFiles, sourceSignals, signalSites };
}

/**
 * What a Python project's packaging says about its shape.
 *
 * `[project.scripts]` in pyproject.toml is the direct analogue of npm's `bin`, and a `__main__.py`
 * is the other way a Python package declares itself runnable.
 */
export interface PythonShape {
  hasConsoleScript: boolean;
  /** Declares a distribution name, so it is built for someone else to install. */
  isPackaged: boolean;
}

export function readPythonShape(pyproject: string | undefined, files: readonly SourceFile[]): PythonShape | undefined {
  const hasMainModule = files.some((f) => /(?:^|\/)__main__\.pyw?$/.test(f.rel));
  if (pyproject === undefined) {
    return hasMainModule ? { hasConsoleScript: true, isPackaged: false } : undefined;
  }
  const sections = pyproject.split(/\r?\n/);
  let inScripts = false;
  let hasConsoleScript = false;
  for (const raw of sections) {
    const line = raw.split('#')[0]?.trim() ?? '';
    if (/^\[/.test(line)) {
      inScripts = /^\[(?:project\.scripts|project\.gui-scripts|tool\.poetry\.scripts)\]$/.test(line);
      continue;
    }
    if (inScripts && /^[\w.-]+\s*=/.test(line)) hasConsoleScript = true;
  }
  return {
    hasConsoleScript: hasConsoleScript || hasMainModule,
    // A [project] table with a name is a distribution; without one it is just an app config.
    isPackaged: /^\s*name\s*=/m.test(pyproject) && /\[project\]|\[tool\.poetry\]/.test(pyproject),
  };
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
