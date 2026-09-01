import type { SourceSignal } from './gap-types.ts';

/**
 * Python source signals for `gaps`.
 *
 * Kept separate from the JavaScript set rather than merged into it, because the *same gap* needs
 * different evidence in each language and mixing them would produce cross-language false positives:
 * a Node project must never be told about WSGI workers, and a Flask app must never be judged on
 * whether it calls `process.on('SIGTERM')`.
 *
 * Two Python-specific realities shape what is detectable here:
 *
 * Graceful shutdown is usually *not* the application's job. A Flask or Django app is run by
 * gunicorn or uvicorn, and those handle SIGTERM themselves -- so the gap is "no production server
 * is configured at all", which is a dependency question, not a source-code one.
 *
 * And `DEBUG = True` reaching production is a Python-specific catastrophe: Flask's debugger exposes
 * an interactive console on any traceback, and Django's leaks settings including secrets. Neither
 * has a JavaScript equivalent worth a gap entry.
 */
export const PY_SOURCE_SIGNALS: SourceSignal[] = [
  // --- serving ---
  // An import is structure plus a module name, for the same reason as the JS version: a fixture
  // containing the text "from flask import Flask" is not a Flask app.
  { name: 'py-flask-app', re: /^\s*(?:from\s+flask\b|import\s+flask\b)|\bFlask\s*\(/, codeOnly: true },
  { name: 'py-django', re: /^\s*(?:from\s+django|import\s+django)|\bDJANGO_SETTINGS_MODULE\b/, codeOnly: true },
  { name: 'py-fastapi-app', re: /^\s*(?:from\s+fastapi\b|import\s+fastapi\b)|\bFastAPI\s*\(/, codeOnly: true },
  { name: 'py-asgi-app', re: /^\s*(?:from\s+(?:starlette|quart|sanic|aiohttp)\b)|\bStarlette\s*\(|\bQuart\s*\(/, codeOnly: true },
  { name: 'py-run-server', re: /\bapp\s*\.\s*run\s*\(|\buvicorn\s*\.\s*run\s*\(|\brunserver\b/, codeOnly: true },

  // --- routes ---
  {
    // Flask/Quart decorator form. The path is the evidence, so it has to be in a literal.
    name: 'py-route-decorator',
    re: /^\s*@\s*\w+\s*\.\s*(?:route|get|post|put|patch|delete)\s*\(/,
    literalRe: /['"]\/[^'"]*['"]/,
  },
  { name: 'py-django-urlpatterns', re: /\burlpatterns\s*=|\b(?:path|re_path)\s*\(/, codeOnly: true },
  {
    name: 'py-auth-route',
    re: /^\s*@\s*\w+\s*\.\s*(?:route|get|post)\s*\(|\b(?:path|re_path)\s*\(/,
    literalRe: /['"][^'"]*\/?(login|signin|sign-in|signup|sign-up|register|auth|token|session|password|forgot|reset)\b/i,
  },

  // --- input ---
  { name: 'py-request-data', re: /\brequest\s*\.\s*(?:json|form|args|data|files|get_json|get_data|POST|GET|body)\b/, codeOnly: true },

  // --- data ---
  { name: 'py-db-client', re: /\b(?:sqlite3|psycopg2?|pymysql|asyncpg|pymongo)\s*\.\s*connect\s*\(|\bcreate_engine\s*\(|\bSession\s*\(|\bmodels\s*\.\s*Model\b/, codeOnly: true },
  { name: 'py-orm-import', re: /^\s*(?:from|import)\s+(?:sqlalchemy|django\.db|peewee|tortoise|sqlmodel)\b/, codeOnly: true },

  // --- auth ---
  { name: 'py-password-use', re: /\b(?:password|passwd|passphrase)\s*[=,)\]}]|\.\s*(?:password|passwd)\b|\b(?:check_password|set_password|hash_password|verify_password)\s*\(/i, codeOnly: true },

  // --- outbound ---
  { name: 'py-outbound-http', re: /\b(?:requests|httpx|aiohttp|urllib3)\s*\.\s*(?:get|post|put|patch|delete|request|ClientSession)\s*\(|\burlopen\s*\(/, codeOnly: true },
  { name: 'py-http-timeout', re: /\btimeout\s*=\s*[\w.(]/, codeOnly: true },

  // --- background ---
  { name: 'py-worker', re: /\b(?:celery|Celery|shared_task|apply_async|delay)\s*[({]|\bschedule\s*\.\s*every\s*\(|\bAsyncIOScheduler\s*\(|\bBackgroundTasks\b/, codeOnly: true },

  // --- env ---
  { name: 'py-env-read', re: /\bos\s*\.\s*(?:environ\s*(?:\.\s*get\s*\(|\[)|getenv\s*\()/, codeOnly: true },

  // --- command line ---
  // A CLI does not have to declare itself in packaging. Most scripts never do: they parse argv and
  // are run with `python tool.py`. Reading only [project.scripts] and __main__.py meant a Python
  // tool with argparse in two files established no `cli` trait at all, so the lockfile gap -- which
  // applies to library, cli and http-server -- stayed silent on a real CLI.
  { name: 'py-argparse', re: /\bargparse\s*\.\s*ArgumentParser\s*\(|\badd_argument\s*\(|\bparse_args\s*\(/, codeOnly: true },
  { name: 'py-cli-framework', re: /^\s*@\s*(?:click|typer|app)\s*\.\s*(?:command|group|argument|option|callback)\b|\bTyper\s*\(|\bclick\s*\.\s*(?:command|group)\s*\(/, codeOnly: true },
  { name: 'py-argv-use', re: /\bsys\s*\.\s*argv\b/, codeOnly: true },
  { name: 'py-stdin-prompt', re: /\binput\s*\(|\bsys\s*\.\s*stdin\b/, codeOnly: true },

  // --- things that SATISFY gaps ---
  {
    // Signal handling in Python is a call plus the signal name, same shape as process.on.
    name: 'py-shutdown-handler',
    re: /\bsignal\s*\.\s*signal\s*\(|\batexit\s*\.\s*register\s*\(|\badd_signal_handler\s*\(|\bon_event\s*\(|\blifespan\b/,
    codeOnly: true,
  },
  {
    name: 'py-health-route',
    re: /^\s*@\s*\w+\s*\.\s*(?:route|get)\s*\(|\b(?:path|re_path)\s*\(/,
    literalRe: /['"]\/?(health|healthz|_health|ready|readyz|livez|ping|status)['"]/,
  },
  {
    // Flask/FastAPI validation is usually a pydantic model or a schema decorator.
    name: 'py-schema-validation',
    re: /\b(?:BaseModel|TypeAdapter|model_validate|parse_obj_as|Schema\s*\(|validate\s*\(|@validator|@field_validator)\b/,
    codeOnly: true,
  },
  { name: 'py-rate-limit-impl', re: /\b(?:Limiter|limiter|RateLimiter|rate_limit|throttle_classes)\b/, codeOnly: true },
  { name: 'py-structured-log', re: /\b(?:logger|log|logging)\s*\.\s*(?:info|warning|warn|error|debug|exception|critical)\s*\(|\bgetLogger\s*\(/, codeOnly: true },
  { name: 'py-print-call', re: /^\s*print\s*\(|[^.\w]print\s*\(/, codeOnly: true },
  {
    // DEBUG left enabled is a Python-specific catastrophe: Flask's debugger gives an interactive
    // console on any traceback, and Django's error page leaks settings including secrets.
    name: 'py-debug-true',
    re: /\bdebug\s*=\s*True\b|\bDEBUG\s*=\s*True\b/i,
    codeOnly: true,
  },
  {
    // Reading DEBUG from the environment is the fix, so it has to be distinguishable.
    name: 'py-debug-from-env',
    re: /\b(?:debug|DEBUG)\s*=\s*(?:bool\s*\()?\s*os\s*\.\s*(?:environ|getenv)/,
    codeOnly: true,
  },
];

/** Python source extensions the gap scanner reads. */
export const PY_GAP_EXT = ['.py', '.pyw'];
