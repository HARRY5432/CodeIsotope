import { PY, type Detector } from '../detector-types.ts';

/**
 * Python reinventions.
 *
 * Python is where most AI-written code lives, and its failure modes differ from JavaScript's in
 * ways that matter for detection. Two in particular shape this file:
 *
 * The standard library is far larger, so the right answer is more often "delete this code" than
 * "install a package" -- `secrets`, `hashlib.scrypt`, `csv`, `copy.deepcopy`, `argparse` and
 * `datetime.strftime` all ship with the interpreter. Those are listed first in `knownSolutions`.
 *
 * And the dangerous patterns are dangerous in a different way: `eval` on request data, `pickle` on
 * untrusted bytes, and string-formatted SQL are the three that actually get Python services owned,
 * and none of them has a JavaScript equivalent worth detecting.
 */
export const PYTHON_DETECTORS: Detector[] = [
  {
    id: 'py-sql-injection',
    capability: 'building SQL by string formatting',
    ext: PY,
    ecosystem: 'pypi',
    signals: [
      // An f-string containing an interpolation. `[^{]*` rather than `[^"']*`, because a SQL literal
      // routinely quotes values inside itself -- f"... VALUES ('{email}')" -- and stopping at the
      // inner apostrophe missed the brace entirely.
      { name: 'fstring-sql', re: /\bf["'][^{]*\{/ },
      { name: 'percent-format-sql', re: /["'][^"']*["']\s*%\s*[(\w]/ },
      { name: 'format-sql', re: /["'][^"']*["']\s*\.\s*format\s*\(/ },
      { name: 'concat-sql', re: /["'][^"']*["']\s*\+\s*\w/ },
      { name: 'sql-keyword', re: /\b(?:SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM|WHERE|VALUES)\b/i },
    ],
    minSignals: 2,
    // A SQL keyword and an interpolation, both on one line. `execute-call` was deliberately removed
    // from the signal list: it is present on safe and unsafe calls alike, so counting it let
    // `cursor.execute("... VALUES (%s)", (email,))` reach the signal threshold -- flagging the exact
    // parameterised form this detector exists to recommend.
    required: ['sql-keyword'],
    // Same line only. A safe execute() elsewhere in the file must neither excuse nor accuse.
    clusterWindow: 0,
    searchTerms: ['python parameterised sql query', 'sqlalchemy core select'],
    knownSolutions: ['parameterised queries: cursor.execute(sql, params) (built-in)', 'sqlalchemy', 'psycopg', 'asyncpg'],
    suppressIfDeps: [],
    note: 'SECURITY: interpolating a value into SQL is injection. A parameterised query -- cursor.execute("... WHERE id = %s", (id,)) -- costs nothing and closes it entirely. Escaping by hand does not: every escaping function has known bypasses per database and encoding.',
    baseConfidence: 'high',
  },
  {
    id: 'py-insecure-random',
    capability: 'generating tokens or IDs with random',
    ext: PY,
    ecosystem: 'pypi',
    signals: [
      { name: 'random-module', re: /\brandom\s*\.\s*(?:random|randint|choice|choices|sample|shuffle|randrange|getrandbits)\s*\(/ },
      { name: 'token-vocab', re: /\b(token|secret|api_?key|session_?id|password_?reset|nonce|salt|otp|csrf)\b/i },
      { name: 'ascii-pool', re: /string\s*\.\s*(?:ascii_letters|ascii_lowercase|ascii_uppercase|digits|hexdigits)/ },
    ],
    minSignals: 2,
    required: ['random-module'],
    searchTerms: ['python secrets token_urlsafe', 'cryptographically secure random python'],
    knownSolutions: ['secrets.token_urlsafe (built-in)', 'secrets.token_hex (built-in)', 'uuid.uuid4 (built-in)'],
    suppressIfDeps: [],
    note: 'SECURITY: the random module is a Mersenne Twister, seeded predictably and fully reconstructable from 624 observed outputs. Anything security-bearing must use secrets, which is in the standard library and needs no dependency.',
    baseConfidence: 'high',
  },
  {
    id: 'py-password-hashing',
    capability: 'password hashing',
    ext: PY,
    ecosystem: 'pypi',
    signals: [
      { name: 'fast-hash', re: /\bhashlib\s*\.\s*(?:md5|sha1|sha224|sha256|sha384|sha512)\s*\(/ },
      { name: 'password-vocab', re: /\b(password|passwd|passphrase)\b/i },
      { name: 'hexdigest', re: /\.\s*hexdigest\s*\(\s*\)|\.\s*digest\s*\(\s*\)/ },
    ],
    minSignals: 3,
    required: ['fast-hash', 'password-vocab'],
    searchTerms: ['argon2 python password hashing', 'passlib bcrypt vs argon2'],
    knownSolutions: ['hashlib.scrypt (built-in)', 'argon2-cffi', 'bcrypt', 'passlib'],
    suppressIfDeps: ['argon2-cffi', 'bcrypt', 'passlib', 'pwdlib', 'werkzeug'],
    note: 'SECURITY: sha256 is built for speed, which is exactly wrong for passwords -- a GPU tries billions of candidates per second. Use a memory-hard KDF: hashlib.scrypt ships with Python, and argon2-cffi is the stronger choice.',
    baseConfidence: 'high',
  },
  {
    id: 'py-unsafe-deserialize',
    capability: 'deserialising untrusted data',
    ext: PY,
    ecosystem: 'pypi',
    signals: [
      { name: 'pickle-load', re: /\b(?:pickle|cPickle|dill|shelve)\s*\.\s*loads?\s*\(/ },
      { name: 'yaml-unsafe', re: /\byaml\s*\.\s*(?:load|unsafe_load|full_load)\s*\(/ },
      { name: 'eval-exec', re: /\b(?:eval|exec)\s*\(/ },
      { name: 'untrusted-source', re: /\b(request|payload|body|user_?input|argv|environ|response|data)\b/i },
    ],
    minSignals: 2,
    required: ['untrusted-source'],
    decisive: ['pickle-load'],
    searchTerms: ['python safe deserialization json schema', 'pydantic parse untrusted input'],
    knownSolutions: ['json (built-in)', 'yaml.safe_load', 'pydantic', 'msgspec', 'ast.literal_eval (built-in)'],
    suppressIfDeps: [],
    note: 'SECURITY: pickle.loads, yaml.load and eval all execute arbitrary code by design. Given attacker-controlled bytes this is remote code execution, not a hardening issue. Use json, yaml.safe_load, or ast.literal_eval.',
    baseConfidence: 'high',
  },
  {
    id: 'py-requests-no-timeout',
    capability: 'HTTP calls without a timeout',
    ext: PY,
    ecosystem: 'pypi',
    signals: [
      { name: 'requests-call', re: /\brequests\s*\.\s*(?:get|post|put|patch|delete|head|request)\s*\(/ },
      { name: 'has-timeout', re: /\btimeout\s*=/ },
    ],
    minSignals: 1,
    required: ['requests-call'],
    // The absence of a timeout *is* the finding, so a call that passes one is not reported.
    unless: ['has-timeout'],
    // A timeout is an argument of the call it applies to, so the evidence has to be on the same
    // line. With the default 60-line window, one correct call excused every incorrect one in the
    // file -- which is how the first version passed its own fixture and failed its test.
    clusterWindow: 0,
    searchTerms: ['python requests timeout best practice', 'httpx timeout configuration'],
    knownSolutions: ['requests with timeout=', 'httpx', 'urllib3 Retry'],
    suppressIfDeps: [],
    note: 'CORRECTNESS: requests has no default timeout, so a hung dependency blocks the calling thread forever. Under load those threads accumulate until the process stops serving anything -- a slow dependency takes you down rather than an outage. Always pass timeout=.',
    baseConfidence: 'medium',
  },
  {
    id: 'py-retry-backoff',
    capability: 'retry with exponential backoff',
    ext: PY,
    ecosystem: 'pypi',
    signals: [
      { name: 'retry-vocab', re: /\b(max_retries|retry_count|retries|attempt|attempts|max_attempts)\b/ },
      { name: 'backoff-math', re: /\b2\s*\*\*\s*\w+|\bpow\s*\(\s*2|\bbackoff\b|\bjitter\b/i },
      { name: 'sleep', re: /\b(?:time\s*\.\s*sleep|asyncio\s*\.\s*sleep)\s*\(/ },
      { name: 'loop', re: /\b(?:for|while)\b/ },
    ],
    minSignals: 3,
    required: ['retry-vocab', 'backoff-math'],
    searchTerms: ['tenacity retry python', 'python exponential backoff library'],
    knownSolutions: ['tenacity', 'backoff', 'stamina', 'urllib3.util.Retry'],
    suppressIfDeps: ['tenacity', 'backoff', 'stamina', 'retrying', 'urllib3'],
    note: 'Hand-rolled retry usually misses jitter, per-exception retry decisions, a total time budget, and any way to give up cleanly on cancellation.',
    baseConfidence: 'medium',
  },
  {
    id: 'py-csv-parsing',
    capability: 'parsing CSV / delimited data',
    ext: PY,
    ecosystem: 'pypi',
    signals: [
      { name: 'comma-split', re: /\.\s*split\s*\(\s*["'],["']\s*\)/ },
      { name: 'line-split', re: /\.\s*split\s*\(\s*["']\\n["']\s*\)|\.\s*splitlines\s*\(/ },
      { name: 'csv-vocab', re: /\b(csv|tsv|header|headers|row|rows|delimiter|columns)\b/i },
    ],
    minSignals: 2,
    required: ['comma-split'],
    searchTerms: ['python csv reader quoted fields', 'pandas read_csv vs csv module'],
    knownSolutions: ['csv (built-in)', 'pandas', 'polars'],
    suppressIfDeps: ['pandas', 'polars', 'pyarrow'],
    note: 'CORRECTNESS: split(",") corrupts any row with a quoted comma, an escaped quote, or an embedded newline. The csv module is in the standard library and handles all three -- this is deleting code, not adding a dependency.',
    baseConfidence: 'medium',
  },
  {
    id: 'py-manual-json-config',
    capability: 'reading configuration from the environment',
    ext: PY,
    ecosystem: 'pypi',
    signals: [
      { name: 'env-read', re: /\bos\s*\.\s*(?:environ\s*(?:\.\s*get\s*\(|\[)|getenv\s*\()/ },
      { name: 'manual-cast', re: /\b(?:int|float|bool)\s*\(\s*os\s*\.\s*(?:environ|getenv)|==\s*["'](?:true|1|yes)["']/i },
      { name: 'default-fallback', re: /\bor\s+["'\d]|,\s*["'][^"']*["']\s*\)/ },
    ],
    minSignals: 2,
    required: ['env-read', 'manual-cast'],
    searchTerms: ['pydantic settings environment variables', 'python environment config validation'],
    knownSolutions: ['pydantic-settings', 'environs', 'dynaconf'],
    suppressIfDeps: ['pydantic-settings', 'environs', 'dynaconf', 'python-decouple', 'confuse'],
    note: 'Every value in os.environ is a string, so each int() and truthiness check is a hand-written parser with its own edge cases. A settings library validates the whole configuration once at startup, so a misconfigured deploy fails at boot rather than deep inside a request.',
    baseConfidence: 'low',
  },
  {
    id: 'py-manual-dataclass-validation',
    capability: 'runtime validation of input data',
    ext: PY,
    ecosystem: 'pypi',
    signals: [
      { name: 'isinstance-guard', re: /\bif\s+not\s+isinstance\s*\(/ },
      { name: 'raise-validation', re: /\braise\s+(?:ValueError|TypeError|AssertionError)\s*\(/ },
      { name: 'required-check', re: /\bif\s+(?:not\s+\w+|["']\w+["']\s+not\s+in\s+\w+)\s*:/ },
      { name: 'validate-fn', re: /\bdef\s+(?:validate|check|parse|clean)_?\w*\s*\(/ },
    ],
    minSignals: 3,
    required: ['validate-fn'],
    searchTerms: ['pydantic runtime validation', 'python dataclass validation library'],
    knownSolutions: ['pydantic', 'msgspec', 'attrs with validators', 'cattrs'],
    suppressIfDeps: ['pydantic', 'msgspec', 'attrs', 'cattrs', 'marshmallow', 'voluptuous', 'jsonschema'],
    note: 'Hand-written isinstance chains drift out of sync with your type annotations, and produce error messages that describe the check rather than the problem. A schema library derives the validator from the type declaration, so they cannot disagree.',
    baseConfidence: 'low',
  },
  {
    id: 'py-datetime-format',
    capability: 'parsing or formatting dates by hand',
    ext: PY,
    ecosystem: 'pypi',
    signals: [
      { name: 'manual-slice', re: /\[\s*0\s*:\s*(?:4|10|19)\s*\]|\[\s*:\s*(?:4|10|19)\s*\]/ },
      { name: 'date-vocab', re: /\b(date|datetime|timestamp|iso|utc|year|month|day)\b/i },
      { name: 'string-concat-date', re: /\bstr\s*\(\s*\w*(?:year|month|day)\w*\s*\)|\.\s*zfill\s*\(\s*2\s*\)/i },
      { name: 'strptime-guess', re: /\bstrptime\s*\(/ },
    ],
    minSignals: 3,
    required: ['date-vocab'],
    searchTerms: ['python parse iso8601 datetime', 'arrow pendulum datetime library'],
    knownSolutions: ['datetime.fromisoformat (built-in)', 'datetime.strftime (built-in)', 'python-dateutil', 'pendulum'],
    suppressIfDeps: ['python-dateutil', 'pendulum', 'arrow', 'whenever'],
    note: 'Slicing a timestamp string assumes one exact format. datetime.fromisoformat has handled full ISO 8601 since Python 3.11, including offsets and fractional seconds.',
    baseConfidence: 'low',
  },
  {
    id: 'py-argparse-manual',
    capability: 'parsing command-line arguments',
    ext: PY,
    ecosystem: 'pypi',
    signals: [
      { name: 'argv-index', re: /\bsys\s*\.\s*argv\s*\[/ },
      { name: 'argv-member', re: /\bin\s+sys\s*\.\s*argv\b/ },
      { name: 'flag-compare', re: /==\s*["']--?\w+["']|\bstartswith\s*\(\s*["']--?["']/ },
      { name: 'argv-loop', re: /\bfor\s+\w+\s+in\s+sys\s*\.\s*argv|\benumerate\s*\(\s*sys\s*\.\s*argv/ },
      { name: 'flag-literal', re: /["']--\w[\w-]*["']/ },
    ],
    minSignals: 2,
    // Any direct use of argv qualifies as the anchor. `argv-index` alone was too narrow: the most
    // common hand-rolled form is `"--verbose" in sys.argv`, which indexes nothing.
    required: [],
    searchTerms: ['python argparse vs click', 'typer cli library'],
    knownSolutions: ['argparse (built-in)', 'click', 'typer'],
    suppressIfDeps: ['click', 'typer', 'fire', 'docopt', 'rich-click'],
    note: 'argparse is in the standard library and gives you --help, type coercion, mutually exclusive groups and subcommands for free. Hand-parsed argv silently accepts nonsense and reports nothing useful when misused.',
    baseConfidence: 'low',
  },
];
