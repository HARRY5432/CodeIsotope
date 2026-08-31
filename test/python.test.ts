import assert from 'node:assert/strict';
import { test } from 'node:test';
import { maskPythonFile, maskPythonLine } from '../src/gaps/mask-python.ts';
import { analyzeFile } from '../src/scan/analyze.ts';
import { PYTHON_DETECTORS } from '../src/scan/detectors/python.ts';
import { DETECTORS, detectorById, detectorsForExt } from '../src/scan/detectors/index.ts';
import type { SourceFile } from '../src/scan/walk.ts';

/** Build a Python SourceFile from a snippet, the way the walker would. */
function py(source: string, rel = 'app/main.py'): SourceFile {
  const lines = source.split('\n');
  return { abs: `/tmp/${rel}`, rel, ext: '.py', bytes: source.length, lines };
}

const idsOf = (source: string) => analyzeFile(py(source)).map((c) => c.detectorId);

// --- Python masking --------------------------------------------------------------------------

test('a hash comment is never evidence', () => {
  const { code, masked } = maskPythonLine('x = 1  # pickle.loads(blob) would be unsafe');
  assert.doesNotMatch(code, /pickle/);
  assert.doesNotMatch(masked, /pickle/);
  assert.match(code, /x = 1/);
});

test('a docstring is prose, not code', () => {
  // Scanning a fixture cited `"""Create a session token."""` as the evidence for a token finding.
  const views = maskPythonFile([
    'def make_token(n=32):',
    '    """Create a session token."""',
    '    return secrets.token_urlsafe(n)',
  ]);
  assert.doesNotMatch(views[1]?.code ?? '', /session token/);
  assert.match(views[2]?.code ?? '', /token_urlsafe/);
});

test('a multi-line docstring stays masked across lines', () => {
  const views = maskPythonFile([
    'def f():',
    '    """',
    '    Uses random.choice to build an api_key.',
    '    """',
    '    return 1',
  ]);
  assert.doesNotMatch(views[2]?.code ?? '', /random\.choice/);
  assert.match(views[4]?.code ?? '', /return 1/);
});

test('a string body is blanked but its delimiters and length survive', () => {
  const line = 'name = "hashlib.sha256"';
  const { masked } = maskPythonLine(line);
  assert.doesNotMatch(masked, /sha256/);
  assert.equal(masked.length, line.length, 'column positions must stay meaningful');
});

test('an f-string keeps its expressions and blanks its literal text', () => {
  // This is the one place a string is partly code. Blanking all of it would hide the interpolation,
  // which is exactly the SQL-injection signal worth keeping.
  const { masked } = maskPythonLine('q = f"SELECT * FROM users WHERE id = {user_id}"');
  assert.match(masked, /user_id/, 'the interpolated expression is code');
  assert.doesNotMatch(masked, /SELECT/, 'the literal text is data');
});

test('escaped braces in an f-string are not expressions', () => {
  const { masked } = maskPythonLine('s = f"{{literal}} {value}"');
  assert.match(masked, /value/);
  assert.doesNotMatch(masked, /literal/);
});

test('a raw or byte string prefix does not break masking', () => {
  for (const line of ['p = r"C:\\\\temp\\\\sha256"', 'b = b"sha256"', 'rb = rb"sha256"']) {
    assert.doesNotMatch(maskPythonLine(line).masked, /sha256/, line);
  }
});

// --- registration ----------------------------------------------------------------------------

test('every Python detector is registered and self-consistent', () => {
  const ids = new Set<string>();
  for (const d of PYTHON_DETECTORS) {
    assert.ok(!ids.has(d.id), `duplicate detector id ${d.id}`);
    ids.add(d.id);
    assert.equal(detectorById(d.id), d, `${d.id} is not reachable from the registry`);
    assert.equal(d.ecosystem, 'pypi', `${d.id} must name its ecosystem so suppression is correct`);
    assert.ok(d.ext.includes('.py'), `${d.id} does not apply to .py files`);
    assert.ok(d.knownSolutions.length > 0, `${d.id} names no solution`);
    assert.ok(d.searchTerms.length > 0, `${d.id} gives the model nothing to vet`);
    const names = new Set(d.signals.map((s) => s.name));
    for (const r of [...(d.required ?? []), ...(d.decisive ?? [])]) {
      assert.ok(names.has(r), `${d.id} anchors on unknown signal "${r}"`);
    }
  }
});

test('Python detectors do not apply to JavaScript files', () => {
  const jsDetectors = new Set(detectorsForExt('.js').map((d) => d.id));
  for (const d of PYTHON_DETECTORS) {
    assert.ok(!jsDetectors.has(d.id), `${d.id} must not run on .js`);
  }
});

test('security detectors are ordered before the rest', () => {
  // When several detectors fire on one file, the dangerous ones must surface first.
  const order = DETECTORS.map((d) => d.id);
  const sqlInjection = order.indexOf('py-sql-injection');
  const argparse = order.indexOf('py-argparse-manual');
  assert.ok(sqlInjection >= 0 && argparse > sqlInjection, 'SQL injection must outrank argv parsing');
});

// --- the three that matter most ---------------------------------------------------------------

test('SQL built by f-string interpolation is caught', () => {
  const ids = idsOf(`
cur = db.cursor()
cur.execute(f"INSERT INTO users (email) VALUES ('{email}')")
`);
  assert.ok(ids.includes('py-sql-injection'), ids.join(', '));
});

test('SQL built by percent-formatting and .format() is caught', () => {
  assert.ok(idsOf(`cur.execute("SELECT * FROM t WHERE id = %s" % (uid,))`).includes('py-sql-injection'));
  assert.ok(idsOf(`cur.execute("SELECT * FROM t WHERE id = {}".format(uid))`).includes('py-sql-injection'));
});

test('a parameterised query is not a finding', () => {
  // The whole point of the detector is the difference between these two lines.
  const ids = idsOf(`
cur.execute("INSERT INTO users (email) VALUES (%s)", (email,))
cur.execute("SELECT * FROM users WHERE id = ?", (uid,))
`);
  assert.ok(!ids.includes('py-sql-injection'), ids.join(', '));
});

test('pickle.loads on request data is caught, and cites the adjacent lines', () => {
  const source = `
import os
DEBUG = bool(os.environ.get("DEBUG"))


def restore():
    blob = request.get_data()
    state = pickle.loads(blob)
    return state
`;
  const found = analyzeFile(py(source)).find((c) => c.detectorId === 'py-unsafe-deserialize');
  assert.ok(found, 'pickle.loads on request data must be reported');
  // Anchoring on first-in-file cited os.environ 5 lines away, because `environ` also matches the
  // untrusted-source signal. The evidence must be the two lines that are the vulnerability.
  assert.ok(found.excerpts.some((e) => /pickle\.loads/.test(e)), found.excerpts.join(' | '));
  assert.ok(found.excerpts.some((e) => /request\.get_data/.test(e)), found.excerpts.join(' | '));
  assert.ok(!found.excerpts.some((e) => /DEBUG/.test(e)), 'module config is not the evidence');
});

test('yaml.load and eval on untrusted input are caught', () => {
  assert.ok(idsOf('cfg = yaml.load(request.data)').includes('py-unsafe-deserialize'));
  assert.ok(idsOf('result = eval(request.args["expr"])').includes('py-unsafe-deserialize'));
});

test('yaml.safe_load is not a finding', () => {
  assert.ok(!idsOf('cfg = yaml.safe_load(request.data)').includes('py-unsafe-deserialize'));
});

test('a token built from random is caught', () => {
  const ids = idsOf(`
def make_token(n=32):
    return "".join(random.choice(string.ascii_letters) for _ in range(n))
`);
  assert.ok(ids.includes('py-insecure-random'), ids.join(', '));
});

test('random used for something harmless is not a security finding', () => {
  // random.shuffle on a deck of cards is correct code. Only security-bearing vocabulary qualifies.
  const ids = idsOf(`
def deal():
    random.shuffle(deck)
    return deck.pop()
`);
  assert.ok(!ids.includes('py-insecure-random'), ids.join(', '));
});

test('secrets is the answer, and using it is not a finding', () => {
  const ids = idsOf('token = secrets.token_urlsafe(32)');
  assert.ok(!ids.includes('py-insecure-random'), ids.join(', '));
  const detector = detectorById('py-insecure-random');
  assert.match(detector?.knownSolutions[0] ?? '', /secrets/, 'a built-in must lead the solutions');
});

// --- the rest ----------------------------------------------------------------------------------

test('sha256 password hashing is caught', () => {
  const ids = idsOf(`
password = request.json["password"]
pwhash = hashlib.sha256(password.encode()).hexdigest()
`);
  assert.ok(ids.includes('py-password-hashing'), ids.join(', '));
});

test('hashing something that is not a password is not a finding', () => {
  const ids = idsOf(`
etag = hashlib.sha256(body).hexdigest()
`);
  assert.ok(!ids.includes('py-password-hashing'), ids.join(', '));
});

test('requests without a timeout is caught', () => {
  assert.ok(idsOf('r = requests.get("https://api.example.com/x")').includes('py-requests-no-timeout'));
});

test('requests with a timeout is not a finding', () => {
  assert.ok(!idsOf('r = requests.get("https://api.example.com/x", timeout=5)').includes('py-requests-no-timeout'));
});

test('a hand-rolled retry loop is caught', () => {
  const ids = idsOf(`
for attempt in range(max_retries):
    try:
        return call()
    except Error:
        time.sleep(2 ** attempt)
`);
  assert.ok(ids.includes('py-retry-backoff'), ids.join(', '));
});

test('a loop with a sleep but no retry vocabulary is not a retry finding', () => {
  // The required-signal mechanism: without it, any polling loop matches.
  const ids = idsOf(`
while running:
    time.sleep(1)
    poll()
`);
  assert.ok(!ids.includes('py-retry-backoff'), ids.join(', '));
});

test('CSV parsed by splitting on commas is caught', () => {
  const ids = idsOf(`
rows = [line.split(",") for line in body.splitlines()]
`);
  assert.ok(ids.includes('py-csv-parsing'), ids.join(', '));
});

test('the csv module is the answer, and using it is not a finding', () => {
  const ids = idsOf('reader = csv.DictReader(handle)');
  assert.ok(!ids.includes('py-csv-parsing'), ids.join(', '));
  assert.match(detectorById('py-csv-parsing')?.knownSolutions[0] ?? '', /built-in/);
});

test('hand-parsed environment configuration is caught', () => {
  const ids = idsOf(`
DEBUG = bool(os.environ.get("DEBUG"))
PORT = int(os.environ.get("PORT", "5000"))
`);
  assert.ok(ids.includes('py-manual-json-config'), ids.join(', '));
});

test('reading one environment variable without casting is not a finding', () => {
  const ids = idsOf('HOME = os.environ.get("HOME")');
  assert.ok(!ids.includes('py-manual-json-config'), ids.join(', '));
});

test('hand-parsed argv is caught', () => {
  const ids = idsOf(`
verbose = "--verbose" in sys.argv
name = sys.argv[1]
`);
  assert.ok(ids.includes('py-argparse-manual'), ids.join(', '));
});

test('a comment describing a vulnerability is not a vulnerability', () => {
  // The masking payoff: prose about pickle must never produce a pickle finding.
  const ids = idsOf(`
# never call pickle.loads on request data
# and never use random.choice for an api_key
value = json.loads(request.data)
`);
  assert.deepEqual(ids, []);
});

test('Python built-ins lead the solutions wherever one exists', () => {
  // Python's standard library is large enough that the answer is often to delete code, not add a
  // dependency. Where a built-in covers the case it must be named first.
  for (const id of ['py-insecure-random', 'py-csv-parsing', 'py-argparse-manual', 'py-datetime-format']) {
    const detector = detectorById(id);
    assert.ok(detector, id);
    assert.match(
      detector.knownSolutions[0] ?? '',
      /built-in/,
      `${id} should recommend the standard library before a package`,
    );
  }
});
