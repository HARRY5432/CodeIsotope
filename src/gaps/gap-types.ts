import type { Confidence } from '../lib/types.ts';
import { JS } from '../scan/detector-types.ts';

/**
 * A source signal, plus how much of the line it is allowed to see.
 *
 * The distinction is load-bearing. A signal meaning "this code calls X" must not be satisfiable by
 * X appearing in a string, or any project containing a table of package names, a set of lint rules,
 * or a block of help text produces false evidence. But some signals need the string as well as the
 * call -- `process.on('SIGTERM')` is only meaningful if both halves are there.
 *
 * So a signal can require two things at once: `re` against the code (call structure), and
 * `literalRe` against the string literals on the same line (the argument). Requiring both is what
 * separates a real `process.on('SIGTERM', ...)` from a catalog entry that merely names it.
 *
 * Every view excludes comments and multi-line template bodies. Prose is never evidence.
 */
export interface SourceSignal {
  name: string;
  /** Matched against the line with string and regex bodies blanked when `codeOnly`, else as-is. */
  re: RegExp;
  /** Match `re` with literal bodies blanked, so a mention inside a string cannot satisfy it. */
  codeOnly?: boolean;
  /**
   * Additionally require this to match the line *with* its string literals intact. Used where the
   * call and its string argument are both necessary, and neither alone is evidence.
   */
  literalRe?: RegExp;
}

/**
 * Detecting what a project *lacks* is a fundamentally harder claim than detecting what it has.
 *
 * A scan detector fires on evidence. A gap fires on the absence of evidence, and absence is
 * cheap to allege and expensive to be wrong about: telling a CLI tool it needs rate limiting,
 * or a prototype it needs graceful shutdown, is noise that trains the reader to ignore the tool.
 *
 * So every gap is gated on a *trait* -- positive evidence that this project is the kind of thing
 * where the gap matters. No trait, no report. That is the whole precision mechanism, and it is
 * why the catalog is deliberately small.
 */

/** Something we established about the project by looking, not by assuming. */
export type Trait =
  | 'http-server'        // binds a port and serves requests
  | 'http-routes'        // declares routes reachable from outside
  | 'reads-user-input'   // request bodies, query strings, form data
  | 'database'           // talks to a database
  | 'auth'              // handles credentials, sessions or tokens
  | 'outbound-http'      // calls other services
  | 'background-work'    // queues, crons, workers
  | 'frontend'           // ships a browser bundle
  | 'cli'                // declares a bin entry
  | 'library'            // published for others to import
  | 'containerised'      // has a Dockerfile or compose file
  | 'reads-env'          // reads process.env
  | 'published';         // goes to a public registry

export interface GapEvidence {
  /** Traits established about the project. */
  traits: Set<Trait>;
  /** Lowercased direct + dev dependency names. */
  deps: Set<string>;
  /** Repo-relative paths that exist at the root, lowercased. */
  rootFiles: Set<string>;
  /** Repo-relative paths of every file found, lowercased, forward slashes. */
  allFiles: Set<string>;
  /** Named source signals that fired anywhere in the codebase. */
  sourceSignals: Set<string>;
  /** Where each source signal first fired, for citation. */
  signalSites: Map<string, { file: string; line: number; text: string }>;
}

export interface Gap {
  id: string;
  /** What is missing, phrased as the thing itself, not as a complaint. */
  capability: string;
  /** Report only if the project has at least one of these traits. */
  appliesWhen: Trait[];
  /** Already handled if any of these are dependencies. */
  satisfiedByDeps?: string[];
  /** Already handled if any of these paths exist (checked against allFiles). */
  satisfiedByFiles?: string[];
  /** Already handled if any of these source signals fired. */
  satisfiedBySignals?: string[];
  /**
   * A gap is only reported when at least one of these is *also* true, on top of the trait.
   * Used where the trait alone is too broad -- 'http-server' does not by itself mean a public
   * endpoint needs rate limiting, but an unauthenticated route handler does.
   */
  requiresSignals?: string[];
  /** 'high' reads as: fix this before shipping. */
  severity: Confidence;
  /** The concrete failure this prevents. Quoted verbatim into the report. */
  why: string;
  knownSolutions: string[];
  searchTerms: string[];
}

/**
 * Source-level signals used both to establish traits and to satisfy gaps.
 *
 * `codeOnly` is set wherever the signal means "this code does X", so a string listing a package
 * name or a regex describing a pattern cannot masquerade as an implementation. It is deliberately
 * left off where the string literal is the real evidence -- a SQL statement, a route path, a
 * signal name passed to process.on.
 */
export const SOURCE_SIGNALS: SourceSignal[] = [
  // --- serving ---
  // An import is structure plus a string: the `import ... from` form has to survive masking, and
  // the module name has to appear in a literal. Requiring both is what stops a test fixture
  // containing the line `"import express from 'express'"` from making this project a web server --
  // which is exactly what CodeIsotope reported about itself before this was split.
  { name: 'express-app', re: /\b(import\b[^;]*\bfrom|require\s*\(|=\s*express\s*\()/, codeOnly: true, literalRe: /['"]express['"]|\bexpress\s*\(/ },
  { name: 'fastify-app', re: /\b(import\b[^;]*\bfrom|require\s*\()/, codeOnly: true, literalRe: /['"]fastify['"]/ },
  { name: 'node-http-server', re: /\b(createServer|createSecureServer)\s*\(/, codeOnly: true },
  { name: 'listen-call', re: /\.listen\s*\(\s*(\d{2,5}|process\.env|port|PORT)/i, codeOnly: true },
  {
    name: 'route-handler',
    re: /\b(app|router|server|fastify|api)\s*\.\s*(get|post|put|patch|delete|all)\s*\(/,
    codeOnly: true,
    literalRe: /['"`]\/[^'"`]*['"`]/,
  },
  { name: 'fetch-handler', re: /\bexport\s+(default\s+)?(async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE)\b|\bexport\s+const\s+(GET|POST|PUT|PATCH|DELETE)\s*=/, codeOnly: true },

  // --- input ---
  { name: 'request-body', re: /\breq(uest)?\s*\.\s*(body|query|params)\b|\bawait\s+req(uest)?\s*\.\s*json\(\)/, codeOnly: true },
  { name: 'search-params', re: /\bsearchParams\s*\.\s*get\(|\bnew\s+URLSearchParams\(/, codeOnly: true },
  { name: 'form-data', re: /\bnew\s+FormData\(|\bformData\s*\(\s*\)/, codeOnly: true },

  // --- data ---
  // SQL only counts inside a string: it is written as a literal, and matching bare words would
  // fire on any comment or identifier containing "select".
  { name: 'sql-query', re: /['"`]/, literalRe: /\b(SELECT\s+[\w*"`[]|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b/i },
  { name: 'orm-client', re: /\b(new\s+PrismaClient|drizzle|mongoose\s*\.|new\s+Sequelize|createPool|createConnection|new\s+Kysely)\s*[({]/, codeOnly: true },

  // --- auth ---
  // Requires a call or assignment, not a bare mention: a `login?: string` field on an API response
  // type is not evidence that this project authenticates anyone.
  { name: 'auth-vocab', re: /\b(signIn|signUp|logIn|logOut|authenticate|authorize|verifyToken|createSession|getSession|destroySession)\s*\(/, codeOnly: true },
  {
    // Requires the word to be *used as data*, not merely to appear as an object key.
    // `password: ['hash', 'kdf']` in a synonym table is a lookup key, not credential handling, and
    // that entry in src/reference/rank.ts made this tool report `auth` as a trait of itself.
    name: 'password-handling',
    re: /\b(password|passwd|passphrase)\s*[=,)}\]]|\.\s*(password|passwd|passphrase)\b|\b(hashPassword|verifyPassword|comparePassword|checkPassword)\s*\(/i,
    codeOnly: true,
  },
  {
    // A route whose *path* is an auth endpoint. This is the credential-stuffing target, and it is
    // far more reliable evidence than any function name -- the path is what an attacker POSTs to.
    name: 'auth-route',
    re: /\.\s*(get|post|put|all)\s*\(|\bexport\s+(default\s+)?(async\s+)?function\s+POST\b|\bexport\s+const\s+POST\s*=/,
    codeOnly: true,
    literalRe: /['"`][^'"`]*\/(login|signin|sign-in|signup|sign-up|register|auth|token|session|password|forgot|reset)\b/i,
  },

  // --- outbound ---
  { name: 'outbound-fetch', re: /\bawait\s+fetch\s*\(|\baxios\s*\.\s*(get|post|put|patch|delete)\s*\(|\bgot\s*\(/, codeOnly: true },
  // Abort-based only. An earlier version accepted any `timeout: <number>` and duly matched an
  // execFile call, then reported outbound HTTP timeouts as handled on the strength of it.
  // AbortSignal is the only mechanism that actually cancels a fetch.
  { name: 'fetch-timeout', re: /AbortSignal\.timeout\s*\(|\bsignal\s*:\s*[\w.]*\.signal\b|\bsignal\s*:\s*AbortSignal\b|\b\w*[Cc]ontroller\.abort\s*\(/, codeOnly: true },

  // --- background ---
  { name: 'queue-worker', re: /\bnew\s+Worker\(|\bBullMQ|\bQueue\(|\bcron\.schedule\(|\bsetInterval\(/, codeOnly: true },

  // --- frontend ---
  { name: 'react-component', re: /\b(import\b[^;]*\bfrom|require\s*\(|\buseState\s*\(|\buseEffect\s*\()/, codeOnly: true, literalRe: /['"]react['"]|\buse(State|Effect)\s*\(/ },
  { name: 'dom-access', re: /\bdocument\s*\.\s*(getElementById|querySelector)|\bwindow\s*\.\s*(location|localStorage)/, codeOnly: true },

  // --- env ---
  { name: 'env-read', re: /\bprocess\.env\s*[.[]/, codeOnly: true },
  // --- things that SATISFY gaps ---
  // These are the highest-risk signals in the file: getting one wrong tells a project a problem is
  // solved when it is not. So each requires the call structure in code AND the argument in a
  // string, which a catalog entry naming `process.on("SIGTERM")` cannot supply.
  {
    name: 'shutdown-handler',
    re: /\bprocess\s*\.\s*on\s*\(/,
    codeOnly: true,
    literalRe: /['"`]SIG(TERM|INT)['"`]/,
  },
  {
    name: 'error-boundary',
    re: /\bprocess\s*\.\s*on\s*\(/,
    codeOnly: true,
    literalRe: /['"`](uncaughtException|unhandledRejection)['"`]/,
  },
  {
    // A route path in a string, attached to a route registration or a file-based route export.
    name: 'health-route',
    re: /\.\s*(get|all|use)\s*\(|\bexport\s+(default\s+)?(async\s+)?function\s+GET\b|\bexport\s+const\s+GET\s*=/,
    codeOnly: true,
    literalRe: /['"`]\/?(health|healthz|_health|ready|readyz|livez|ping|status)['"`]/,
  },
  {
    // Either the middleware is invoked, or a header is actually being set.
    name: 'security-headers',
    re: /\bhelmet\s*\(|\b(setHeader|set|append)\s*\(/,
    codeOnly: true,
    literalRe: /['"`](Content-Security-Policy|Strict-Transport-Security|X-Content-Type-Options|X-Frame-Options|Referrer-Policy)['"`]/i,
  },
  { name: 'rate-limit-impl', re: /\b(rateLimit|rateLimiter|RateLimiter|createRateLimit\w*|Bottleneck|pThrottle)\s*[({]|\.\s*consume\s*\(/, codeOnly: true },
  { name: 'structured-log-call', re: /\b(logger|log)\s*\.\s*(info|warn|error|debug|trace|fatal)\s*\(/, codeOnly: true },
  { name: 'console-log', re: /\bconsole\s*\.\s*(log|info|warn|error)\s*\(/, codeOnly: true },
];

export const GAP_SOURCE_EXT = JS;
