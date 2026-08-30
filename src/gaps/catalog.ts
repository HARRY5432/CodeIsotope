import type { Gap } from './gap-types.ts';

/**
 * The catalog of things a project can be missing.
 *
 * Kept deliberately short. Every entry had to clear one bar: a competent reviewer, seeing this
 * reported against a project with the stated traits, would agree it is a real omission rather
 * than a matter of taste. Anything that failed that bar -- "you have no tests", "you should use
 * TypeScript", "add a CONTRIBUTING.md" -- is absent on purpose. Those are opinions, and this
 * tool's whole claim is that it reports facts.
 *
 * Ordered by severity: a service that loses data on deploy outranks a missing README badge.
 */
export const GAPS: Gap[] = [
  {
    id: 'no-graceful-shutdown',
    capability: 'graceful shutdown on SIGTERM',
    appliesWhen: ['http-server'],
    satisfiedBySignals: ['shutdown-handler'],
    satisfiedByDeps: ['stoppable', 'http-terminator', 'lil-http-terminator', 'close-with-grace', '@godaddy/terminus', 'graceful-shutdown'],
    severity: 'high',
    why: 'Every container orchestrator and PaaS stops a process by sending SIGTERM and waiting. With no handler, Node exits immediately: in-flight requests are severed mid-response, database transactions are abandoned, and queue jobs are lost. This fires on every single deploy, not just on failures.',
    knownSolutions: ['process.on("SIGTERM") + server.close (built-in)', 'close-with-grace', 'http-terminator', '@godaddy/terminus'],
    searchTerms: ['graceful shutdown node sigterm', 'http terminator drain connections'],
  },
  {
    id: 'unhandled-rejection',
    capability: 'a top-level handler for unhandled rejections and uncaught exceptions',
    appliesWhen: ['http-server', 'background-work'],
    satisfiedBySignals: ['error-boundary'],
    satisfiedByDeps: ['@sentry/node', '@sentry/nextjs', '@sentry/bun', 'bugsnag', '@bugsnag/js', '@honeycombio/opentelemetry-node', 'rollbar'],
    severity: 'high',
    why: 'Since Node 15 an unhandled promise rejection terminates the process by default. Without a handler the crash is silent -- no log line, no stack trace, no report -- so the first sign of the bug is a restart loop in an orchestrator, with nothing recorded to explain it.',
    knownSolutions: ['process.on("unhandledRejection") (built-in)', '@sentry/node', 'rollbar', '@bugsnag/js'],
    searchTerms: ['node unhandledRejection handler', 'error tracking node service'],
  },
  {
    id: 'no-input-validation',
    capability: 'schema validation at the request boundary',
    appliesWhen: ['http-routes'],
    requiresSignals: ['request-body'],
    satisfiedByDeps: ['zod', 'valibot', 'arktype', 'ajv', 'yup', 'joi', 'superstruct', '@sinclair/typebox', 'class-validator', 'io-ts', '@effect/schema', 'effect'],
    severity: 'high',
    why: 'Request bodies are read and used without a schema, so the type annotations on your handlers are a claim rather than a guarantee -- at runtime the body is whatever the caller sent. This is how a missing field becomes a 500 instead of a 400, and how an unexpected type reaches a database query.',
    knownSolutions: ['zod', 'valibot', 'arktype', 'ajv'],
    searchTerms: ['typescript request body validation', 'zod vs valibot'],
  },
  {
    id: 'no-security-headers',
    capability: 'HTTP security headers',
    appliesWhen: ['http-routes'],
    satisfiedBySignals: ['security-headers'],
    satisfiedByDeps: ['helmet', '@fastify/helmet', 'koa-helmet', 'nosniff', 'hono'],
    severity: 'medium',
    why: 'No CSP, HSTS, X-Content-Type-Options or frame-ancestors policy is set. Each absent header re-enables a class of attack the browser would otherwise block for you: clickjacking, MIME-sniffing, and protocol downgrade. One middleware sets all of them.',
    knownSolutions: ['helmet', '@fastify/helmet'],
    searchTerms: ['http security headers node', 'helmet csp configuration'],
  },
  {
    id: 'no-rate-limit',
    capability: 'rate limiting on public endpoints',
    appliesWhen: ['http-routes'],
    // A route alone is not enough: an internal service behind a gateway does not need this. An
    // auth endpoint does, because it is the credential-stuffing target -- and the route *path* is
    // the reliable evidence, since that is what an attacker actually POSTs to.
    requiresSignals: ['auth-route', 'password-handling'],
    satisfiedBySignals: ['rate-limit-impl'],
    satisfiedByDeps: ['express-rate-limit', '@fastify/rate-limit', 'rate-limiter-flexible', 'bottleneck', 'p-throttle', 'limiter', '@upstash/ratelimit', 'hono-rate-limiter'],
    severity: 'high',
    why: 'Authentication endpoints with no rate limit are the standard credential-stuffing target: an attacker can try passwords as fast as your server answers. It is also the cheapest denial-of-service available against you.',
    knownSolutions: ['rate-limiter-flexible', 'express-rate-limit', '@fastify/rate-limit', '@upstash/ratelimit'],
    searchTerms: ['rate limiting node api', 'rate-limiter-flexible redis'],
  },
  {
    id: 'no-request-timeout',
    capability: 'timeouts on outbound HTTP calls',
    appliesWhen: ['outbound-http'],
    satisfiedBySignals: ['fetch-timeout'],
    satisfiedByDeps: ['undici', 'got', 'ky', 'axios-retry', 'p-timeout'],
    severity: 'high',
    why: 'fetch() has no default timeout. A dependency that accepts your connection and then never responds will hold the request open indefinitely, and under load those sockets accumulate until the process stops serving anything -- the classic cascading failure, where a slow dependency takes you down rather than an outage.',
    knownSolutions: ['AbortSignal.timeout (built-in)', 'undici', 'got', 'ky'],
    searchTerms: ['fetch timeout abortsignal node', 'http client timeout retry node'],
  },
  {
    id: 'no-structured-logging',
    capability: 'structured logging',
    appliesWhen: ['http-server', 'background-work'],
    requiresSignals: ['console-log'],
    satisfiedBySignals: ['structured-log-call'],
    satisfiedByDeps: ['pino', 'winston', 'bunyan', 'loglevel', 'consola', 'signale', 'tslog', '@opentelemetry/api', 'roarr'],
    severity: 'medium',
    why: 'Diagnostics go through console.log, which emits unstructured text with no level, no timestamp and no request correlation. The practical cost lands during an incident: you cannot filter by severity, follow one request across services, or query for a pattern -- exactly when you need all three.',
    knownSolutions: ['pino', 'winston', 'consola'],
    searchTerms: ['structured json logging node', 'pino vs winston'],
  },
  {
    id: 'no-healthcheck',
    capability: 'a health check endpoint',
    appliesWhen: ['http-routes', 'containerised'],
    satisfiedBySignals: ['health-route'],
    satisfiedByDeps: ['@godaddy/terminus', 'terminus'],
    severity: 'medium',
    why: 'No /health or /ready route, so a load balancer or orchestrator has no way to ask whether this instance can serve traffic. It falls back to "is the port open", which stays true while the process is deadlocked or has lost its database connection -- so broken instances keep receiving requests.',
    knownSolutions: ['a plain route returning 200 (built-in)', '@godaddy/terminus'],
    searchTerms: ['health check endpoint kubernetes readiness', 'liveness vs readiness probe'],
  },
  {
    id: 'no-env-validation',
    capability: 'validation of environment variables at startup',
    appliesWhen: ['reads-env'],
    satisfiedByDeps: ['envalid', 'znv', '@t3-oss/env-core', '@t3-oss/env-nextjs', 'env-var', 'convict', 'zod', 'valibot', 'arktype'],
    severity: 'medium',
    why: 'process.env is read directly, and every value in it is `string | undefined`. A missing variable therefore becomes `undefined` deep inside a request rather than a clear failure at boot -- so a misconfigured deploy starts successfully and fails later, on a code path nobody watched.',
    knownSolutions: ['envalid', 'znv', '@t3-oss/env-core', 'zod'],
    searchTerms: ['validate environment variables typescript', 'envalid vs t3-env'],
  },
  {
    id: 'no-dependency-lockfile',
    capability: 'a committed lockfile',
    appliesWhen: ['library', 'cli', 'http-server'],
    satisfiedByFiles: ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb', 'npm-shrinkwrap.json'],
    severity: 'high',
    why: 'With no lockfile, every install resolves transitive dependencies afresh, so CI and production can receive different code than you tested -- and a compromised patch release of a dependency-of-a-dependency reaches you automatically. This is the single cheapest supply-chain control available.',
    knownSolutions: ['npm install (writes package-lock.json)', 'pnpm install', 'yarn install'],
    searchTerms: ['why commit lockfile', 'npm ci reproducible install'],
  },
];

export function gapById(id: string): Gap | undefined {
  return GAPS.find((g) => g.id === id);
}
