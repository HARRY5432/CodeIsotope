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
 * Several gaps exist twice, once per language, because the *same problem* has a different answer in
 * each: a Node service closes its own server on SIGTERM, whereas a Flask app delegates that to
 * gunicorn, so telling a Python developer to call `process.on` would be wrong rather than merely
 * unhelpful. Those pairs are scoped with `requiresAllTraits`.
 *
 * Ordered by severity: a service that loses data on deploy outranks a missing README badge.
 */
export const GAPS: Gap[] = [
  // ---------------------------------------------------------------- JavaScript / TypeScript ----
  {
    id: 'no-graceful-shutdown',
    capability: 'graceful shutdown on SIGTERM',
    appliesWhen: ['http-server'],
    language: 'javascript',
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
    language: 'javascript',
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
    language: 'javascript',
    requiresSignals: ['request-body'],
    satisfiedByDeps: ['zod', 'valibot', 'arktype', 'ajv', 'yup', 'joi', 'superstruct', '@sinclair/typebox', 'class-validator', 'io-ts', '@effect/schema', 'effect'],
    severity: 'high',
    why: 'Request bodies are read and used without a schema, so the type annotations on your handlers are a claim rather than a guarantee -- at runtime the body is whatever the caller sent. This is how a missing field becomes a 500 instead of a 400, and how an unexpected type reaches a database query.',
    knownSolutions: ['zod', 'valibot', 'arktype', 'ajv'],
    searchTerms: ['typescript request body validation', 'zod vs valibot'],
  },
  {
    id: 'no-request-timeout',
    capability: 'timeouts on outbound HTTP calls',
    appliesWhen: ['outbound-http'],
    language: 'javascript',
    satisfiedBySignals: ['fetch-timeout'],
    satisfiedByDeps: ['undici', 'got', 'ky', 'axios-retry', 'p-timeout'],
    severity: 'high',
    why: 'fetch() has no default timeout. A dependency that accepts your connection and then never responds will hold the request open indefinitely, and under load those sockets accumulate until the process stops serving anything -- the classic cascading failure, where a slow dependency takes you down rather than an outage.',
    knownSolutions: ['AbortSignal.timeout (built-in)', 'undici', 'got', 'ky'],
    searchTerms: ['fetch timeout abortsignal node', 'http client timeout retry node'],
  },
  {
    id: 'no-security-headers',
    capability: 'HTTP security headers',
    appliesWhen: ['http-routes'],
    language: 'javascript',
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
    language: 'javascript',
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
    id: 'no-structured-logging',
    capability: 'structured logging',
    appliesWhen: ['http-server', 'background-work'],
    language: 'javascript',
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
    language: 'javascript',
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
    language: 'javascript',
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
    language: 'javascript',
    satisfiedByFiles: ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb', 'npm-shrinkwrap.json'],
    severity: 'high',
    why: 'With no lockfile, every install resolves transitive dependencies afresh, so CI and production can receive different code than you tested -- and a compromised patch release of a dependency-of-a-dependency reaches you automatically. This is the single cheapest supply-chain control available.',
    knownSolutions: ['npm install (writes package-lock.json)', 'pnpm install', 'yarn install'],
    searchTerms: ['why commit lockfile', 'npm ci reproducible install'],
  },

  // ------------------------------------------------------------------------------- Python ----
  {
    id: 'py-debug-enabled',
    capability: 'DEBUG disabled outside development',
    appliesWhen: ['http-server'],
    language: 'python',
    // The finding IS the hardcoded True, so the signal is required rather than satisfying.
    requiresSignals: ['py-debug-true'],
    satisfiedBySignals: ['py-debug-from-env'],
    severity: 'high',
    why: 'DEBUG is hardcoded to True. In Flask this serves the Werkzeug debugger on any traceback, which offers an interactive Python console to whoever triggered the error -- remote code execution by design. In Django it renders a page containing settings, environment variables and often database credentials. Read it from the environment so production cannot inherit it.',
    knownSolutions: ['os.environ.get("DEBUG") (built-in)', 'pydantic-settings', 'environs', 'django-environ'],
    searchTerms: ['flask debug mode production risk', 'django DEBUG setting environment'],
  },
  {
    id: 'py-no-production-server',
    capability: 'a production WSGI/ASGI server',
    appliesWhen: ['http-server'],
    language: 'python',
    satisfiedByDeps: ['gunicorn', 'uvicorn', 'uvicorn-worker', 'hypercorn', 'waitress', 'daphne', 'granian', 'mod_wsgi', 'gevent', 'meinheld'],
    satisfiedByFiles: ['procfile', 'gunicorn.conf.py', 'gunicorn_config.py'],
    severity: 'high',
    why: "No production server is declared, so the app is presumably started with app.run() or runserver. Both are single-threaded development servers that Flask and Django explicitly warn against deploying: they serve one request at a time, never reload workers, and -- the reason this is high severity -- do not handle SIGTERM, so every deploy severs in-flight requests. A real WSGI/ASGI server handles graceful shutdown for you, which is why Python has no separate shutdown gap.",
    knownSolutions: ['gunicorn', 'uvicorn', 'hypercorn', 'waitress'],
    searchTerms: ['gunicorn vs uvicorn production', 'deploy flask production wsgi server'],
  },
  {
    id: 'py-no-input-validation',
    capability: 'schema validation at the request boundary',
    appliesWhen: ['http-routes'],
    language: 'python',
    requiresSignals: ['py-request-data'],
    satisfiedBySignals: ['py-schema-validation'],
    satisfiedByDeps: ['pydantic', 'marshmallow', 'msgspec', 'cerberus', 'voluptuous', 'jsonschema', 'attrs', 'cattrs', 'schema', 'djangorestframework', 'flask-pydantic', 'webargs'],
    severity: 'high',
    why: 'request.json and request.form are read straight into use, and both return whatever the caller sent -- a dict with missing keys, a string where an int was expected, or a nested structure of any depth. Every access is a potential KeyError or TypeError surfacing as a 500, and unvalidated values reach database queries and template rendering.',
    knownSolutions: ['pydantic', 'marshmallow', 'msgspec'],
    searchTerms: ['pydantic request validation fastapi', 'marshmallow schema flask'],
  },
  {
    id: 'py-no-request-timeout',
    capability: 'timeouts on outbound HTTP calls',
    appliesWhen: ['outbound-http'],
    language: 'python',
    satisfiedBySignals: ['py-http-timeout'],
    severity: 'high',
    why: 'requests has no default timeout -- none, not a long one -- so a dependency that accepts the connection and then stalls blocks the calling thread forever. With a thread-per-request server those threads accumulate until nothing is served, meaning a slow dependency takes you down rather than an outage. httpx defaults to five seconds, which is the reason to prefer it.',
    knownSolutions: ['requests with timeout=', 'httpx (5s default)', 'urllib3 Retry with timeout'],
    searchTerms: ['python requests timeout best practice', 'httpx default timeout'],
  },
  {
    id: 'py-no-dependency-lockfile',
    capability: 'pinned or locked dependencies',
    appliesWhen: ['library', 'cli', 'http-server'],
    language: 'python',
    satisfiedByFiles: ['poetry.lock', 'uv.lock', 'pdm.lock', 'pipfile.lock', 'requirements.lock', 'requirements-lock.txt', 'constraints.txt'],
    severity: 'high',
    why: 'No lockfile is committed, so every install resolves the dependency graph afresh and CI can receive different code than you tested. A pinned requirements.txt covers the direct dependencies but not their dependencies, which is where a compromised patch release actually arrives.',
    knownSolutions: ['uv lock', 'poetry lock', 'pip-compile (pip-tools)', 'pdm lock'],
    searchTerms: ['python lockfile uv poetry pip-tools', 'pip-compile reproducible install'],
  },
  {
    id: 'py-no-structured-logging',
    capability: 'structured logging',
    appliesWhen: ['http-server', 'background-work'],
    language: 'python',
    requiresSignals: ['py-print-call'],
    satisfiedBySignals: ['py-structured-log'],
    satisfiedByDeps: ['structlog', 'loguru', 'python-json-logger', 'opentelemetry-api', 'sentry-sdk'],
    severity: 'medium',
    why: 'Diagnostics go through print(), which writes to stdout with no level, no timestamp and no request correlation. logging is in the standard library and gives you all three; the cost of not having them lands during an incident, when you cannot filter by severity or follow one request through the system.',
    knownSolutions: ['logging (built-in)', 'structlog', 'loguru'],
    searchTerms: ['python structlog json logging', 'logging vs print production'],
  },
  {
    id: 'py-no-healthcheck',
    capability: 'a health check endpoint',
    appliesWhen: ['http-routes', 'containerised'],
    language: 'python',
    satisfiedBySignals: ['py-health-route'],
    severity: 'medium',
    why: 'No /health or /ready route, so a load balancer or orchestrator can only ask whether the port is open -- which stays true while the process is deadlocked, out of database connections, or stuck in a GIL-bound loop. Broken instances keep receiving traffic.',
    knownSolutions: ['a plain route returning 200 (built-in)', 'flask-healthz', 'fastapi-health'],
    searchTerms: ['kubernetes readiness probe flask', 'fastapi health check endpoint'],
  },
  {
    id: 'py-no-env-validation',
    capability: 'validation of environment variables at startup',
    appliesWhen: ['reads-env'],
    language: 'python',
    requiresSignals: ['py-env-read'],
    satisfiedByDeps: ['pydantic-settings', 'environs', 'dynaconf', 'python-decouple', 'confuse', 'django-environ', 'everett'],
    severity: 'medium',
    why: 'os.environ is read directly, and every value in it is a string. A missing variable becomes None deep inside a request rather than a clear failure at boot, and int(os.environ["PORT"]) raises ValueError at the moment of use rather than at startup -- so a misconfigured deploy starts successfully and fails later, on a code path nobody watched.',
    knownSolutions: ['pydantic-settings', 'environs', 'dynaconf'],
    searchTerms: ['pydantic-settings environment validation', 'python config validation startup'],
  },
];

export function gapById(id: string): Gap | undefined {
  return GAPS.find((g) => g.id === id);
}
