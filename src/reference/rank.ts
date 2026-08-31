/**
 * Rank the files in a repository by how likely they are to be the implementation of a capability.
 *
 * This is the whole of the judgement the binary makes here, and it is deliberately shallow: it
 * ranks *paths*, never contents. Deciding what a file actually does requires reading it, which is
 * the model's job -- so the binary's contribution is to narrow a 400-file repo to the four files
 * worth opening, and to pin them to a commit so the reference cannot rot.
 */

/** Files that are never the implementation of anything. */
const EXCLUDED = [
  /(^|\/)(test|tests|__tests__|spec|specs|e2e|fixtures?|__mocks__|mocks?|examples?|samples?|demos?|playground|benchmark|benchmarks|bench|perf|docs?|website|site|scripts?|tools?|config)\//i,
  /\.(test|spec|bench|sample|example)\.[cm]?[jt]sx?$/i,
  /\.d\.ts$/,
  /\.(md|markdown|txt|json|yml|yaml|lock|snap|map|html|css)$/i,
  /(^|\/)(dist|build|esm|cjs|umd|out|coverage|node_modules|vendor|\.yarn)\//i,
  /\.min\.[cm]?js$/i,
  // Build tooling: rollup.config.js, vite.config.ts, jest.config.js, eslint.config.mjs.
  /(^|\/)[\w.-]*\.config\.[cm]?[jt]s$/i,
  /(^|\/)(rollup|webpack|vite|esbuild|babel|jest|vitest|karma|gulpfile|gruntfile|tsup|rspack)[\w.-]*\.[cm]?[jt]s$/i,
  /(^|\/)\./,

  // --- Python. Its conventions share almost nothing with JavaScript's, and the JS patterns above
  // catch none of them: pytest names tests `test_*.py` or `*_test.py`, not `*.test.py`. Without
  // these, a query for "retry" against tenacity ranked `test_retry.py` first -- a test file as the
  // reference implementation, which teaches the reader the opposite of what they asked for.
  /(^|\/)test_[\w.]+\.pyw?$/i,
  /(^|\/)[\w.]+_test\.pyw?$/i,
  /(^|\/)conftest\.pyw?$/i,
  // Packaging and task runners, the Python equivalent of a rollup config.
  /(^|\/)(setup|manage|noxfile|tasks|fabfile|wsgi|asgi|conf)\.pyw?$/i,
  // A migration is generated schema history, never a pattern to imitate.
  /(^|\/)(migrations|alembic|versions)\//i,
  // Virtualenvs and build artefacts. `.venv` is caught by the dotfile rule, `venv` is not.
  /(^|\/)(venv|env|site-packages|__pycache__|\.tox|\.nox|\.eggs|[\w.-]+\.egg-info)\//i,
  /\.pyi$/,
];

/**
 * `lib/` is ambiguous: for csv-parse it holds the real source, for a typical TypeScript project it
 * is compiled output of `src/`. The test has to be *sibling-scoped* -- does a `src/` exist next to
 * this particular `lib/` -- not repo-global. A first attempt asked "does the repo contain any src/
 * anywhere", and node-csv's `demo/webpack/src/` duly suppressed the real
 * `packages/csv-parse/lib/api/`, leaving a rollup config as the top reference.
 */
const LIB_SEGMENT = /(^|\/)lib\//i;
const SRC_SEGMENT = /(^|\/)src\//i;

/** Source extensions we are willing to point a reader at. */
const SOURCE_EXT = /\.([cm]?[jt]sx?|mjs|cjs|py|go|rs|rb|java|kt|swift|cs|php)$/i;

/**
 * An entry point is where a reader should usually start.
 *
 * `__init__.py` is Python's: it is the module a consumer imports, and in a single-purpose package it
 * often *is* the implementation. `__main__.py` is the CLI shim, which is a different thing, but
 * still a reasonable place to orient.
 */
const ENTRY_POINT = /(^|\/)(index|main|mod|lib)\.[cm]?[jt]sx?$|(^|\/)__(init|main)__\.pyw?$/i;

/** A workspace member directory in a monorepo: `packages/csv-parse/lib/index.js`. */
const MONOREPO_MEMBER = /^(?:packages|libs?|modules|apps?|workspaces)\/([^/]+)\//i;

export interface RankableFile {
  path: string;
  size: number;
}

export interface RankedFile {
  path: string;
  size: number;
  /** Higher is a better place to start reading. */
  score: number;
  /** Why this file was chosen, so the ranking is inspectable rather than magic. */
  reasons: string[];
}

/** Split a query into lowercase terms worth matching on. */
export function queryTerms(query: string): string[] {
  const stop = new Set([
    'the', 'and', 'for', 'with', 'from', 'that', 'this', 'how', 'does', 'implement',
    'implementation', 'code', 'source', 'node', 'js', 'javascript', 'typescript', 'library',
  ]);
  return [
    ...new Set(
      query
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length >= 3 && !stop.has(t)),
    ),
  ];
}

/**
 * Terms that describe the same concept under a different name. Only where the mapping is
 * unambiguous in a software context -- guessing synonyms would produce confident wrong answers.
 *
 * Declared one way and closed symmetrically below, because relatedness is mutual and maintaining
 * both directions by hand goes wrong silently: `jitter -> backoff` was declared without
 * `backoff -> jitter`, so a query for "backoff" missed a file named `jitter.ts`.
 */
const DECLARED_RELATIONS: Record<string, string[]> = {
  retry: ['backoff', 'attempt'],
  backoff: ['delay'],
  jitter: ['random', 'backoff'],
  cache: ['lru', 'memo', 'store', 'ttl'],
  ttl: ['expire'],
  concurrency: ['limit', 'pool', 'queue', 'semaphore'],
  throttle: ['limit', 'debounce', 'rate'],
  debounce: ['delay'],
  ratelimit: ['throttle', 'limit', 'bucket'],
  validate: ['schema', 'parse', 'check'],
  schema: ['parse', 'type'],
  parse: ['parser', 'lexer', 'tokenize', 'decode'],
  serialize: ['stringify', 'encode'],
  hash: ['digest', 'crypto'],
  password: ['hash', 'kdf', 'crypto'],
  token: ['jwt', 'sign', 'verify'],
  jwt: ['sign', 'verify', 'jws'],
  timeout: ['abort', 'deadline'],
  abort: ['cancel'],
  shutdown: ['terminate', 'close', 'signal', 'drain'],
  logging: ['logger', 'log'],
  error: ['exception', 'failure'],
};

/** Symmetric closure of the declarations above, built once at load. */
const RELATED: Map<string, Set<string>> = (() => {
  const map = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    if (a === b) return;
    const set = map.get(a) ?? new Set<string>();
    set.add(b);
    map.set(a, set);
  };
  for (const [term, related] of Object.entries(DECLARED_RELATIONS)) {
    for (const other of related) {
      link(term, other);
      link(other, term);
    }
  }
  return map;
})();

function expand(terms: string[]): Set<string> {
  const out = new Set(terms);
  for (const term of terms) {
    for (const related of RELATED.get(term) ?? []) out.add(related);
  }
  return out;
}

export interface RankOptions {
  limit?: number;
  /**
   * The package being referenced. In a monorepo this is what tells us which workspace member is
   * the right one: node-csv publishes csv-parse, csv-stringify and csv-generate from one repo, so
   * without this a query for a parser happily returns files from the stringifier.
   */
  packageName?: string;
}

interface Context {
  direct: Set<string>;
  expanded: Set<string>;
  /** Directory prefixes that contain a `src/`, so a sibling `lib/` is build output. */
  srcPrefixes: Set<string>;
  /** Workspace member that matches the package being referenced, if any. */
  member?: string;
}

/** The prefix a `lib/` or `src/` segment sits under, e.g. `packages/csv-parse` or `` for root. */
function prefixBefore(path: string, segment: RegExp): string | undefined {
  const match = segment.exec(path);
  if (!match) return undefined;
  return path.slice(0, match.index + (match[1] === undefined ? 0 : match[1].length)).replace(/\/$/, '');
}

/**
 * Score one path. Filename matches outrank directory matches, because a file called `retry.ts` is
 * a far stronger signal than any file inside a directory called `src`.
 */
function scorePath(file: RankableFile, ctx: Context): RankedFile | undefined {
  const path = file.path;
  if (!SOURCE_EXT.test(path)) return undefined;
  if (EXCLUDED.some((re) => re.test(path))) return undefined;

  // Only treat lib/ as build output when a src/ sits beside it under the same prefix.
  const libPrefix = prefixBefore(path, LIB_SEGMENT);
  if (libPrefix !== undefined && ctx.srcPrefixes.has(libPrefix)) return undefined;

  const lower = path.toLowerCase();
  const slash = lower.lastIndexOf('/');
  const filename = slash === -1 ? lower : lower.slice(slash + 1);
  const dirs = slash === -1 ? '' : lower.slice(0, slash);

  let score = 0;
  const reasons: string[] = [];

  // In a monorepo, a file belonging to a different published package is not a reference for this
  // one. Reject rather than penalise: csv-stringify's samples are not a csv parser at any score.
  const memberMatch = MONOREPO_MEMBER.exec(path);
  if (memberMatch?.[1] && ctx.member) {
    if (memberMatch[1].toLowerCase() !== ctx.member) return undefined;
    score += 6;
    reasons.push(`in the ${memberMatch[1]} package`);
  }

  const nameHits = [...ctx.direct].filter((t) => filename.includes(t));
  if (nameHits.length > 0) {
    score += 10 * nameHits.length;
    reasons.push(`filename matches ${nameHits.join(', ')}`);
  }

  const relatedNameHits = [...ctx.expanded].filter((t) => !ctx.direct.has(t) && filename.includes(t));
  if (relatedNameHits.length > 0) {
    score += 4 * relatedNameHits.length;
    reasons.push(`filename relates to ${relatedNameHits.join(', ')}`);
  }

  const dirHits = [...ctx.expanded].filter((t) => dirs.includes(t));
  if (dirHits.length > 0) {
    score += 2 * dirHits.length;
    reasons.push(`directory matches ${dirHits.join(', ')}`);
  }

  if (ENTRY_POINT.test(path)) {
    // Worth surfacing on its own: in a single-purpose package the entry point often *is* the
    // implementation, and it is where a reader orients even when it is not.
    score += 5;
    reasons.push('package entry point');
  }

  // Depth is a weak tiebreak: src/retry.ts is likelier to be the thing than src/a/b/c/retry.ts.
  const depth = (lower.match(/\//g) ?? []).length;
  score -= Math.min(depth, 4);

  // A 40-byte re-export teaches nothing; a 300KB generated blob is unreadable.
  if (file.size > 0 && file.size < 200) {
    score -= 4;
    reasons.push('very small -- probably a re-export');
  }
  if (file.size > 120_000) {
    score -= 6;
    reasons.push('very large -- may be generated');
  }

  if (score <= 0) return undefined;
  return { path, size: file.size, score, reasons };
}

/**
 * Rank a repo's files against a capability query.
 *
 * Returns nothing when no path scores above zero. That is the honest outcome for a repo whose
 * layout gives no signal -- inventing a plausible-looking answer from `src/index.js` would be
 * worse than saying the tree could not be narrowed.
 */
export function rankFiles(files: readonly RankableFile[], query: string, opts: RankOptions = {}): RankedFile[] {
  const { limit = 5, packageName } = opts;
  const direct = new Set(queryTerms(query));
  if (direct.size === 0) return [];

  const bare = packageName?.replace(/^@[^/]+\//, '').toLowerCase();
  const srcPrefixes = new Set<string>();
  for (const f of files) {
    const prefix = prefixBefore(f.path, SRC_SEGMENT);
    if (prefix !== undefined) srcPrefixes.add(prefix);
  }

  const ctx: Context = {
    direct,
    expanded: expand([...direct]),
    srcPrefixes,
    ...(bare
      ? {
          member: files
            .map((f) => MONOREPO_MEMBER.exec(f.path)?.[1]?.toLowerCase())
            .find((m): m is string => m === bare),
        }
      : {}),
  };

  const ranked: RankedFile[] = [];
  for (const file of files) {
    const scored = scorePath(file, ctx);
    if (scored) ranked.push(scored);
  }

  ranked.sort((a, b) => (b.score - a.score) || a.path.localeCompare(b.path));
  return ranked.slice(0, limit);
}
