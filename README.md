# CodeIsotope

**Find the battle-tested open-source libraries your AI-written codebase reinvented by hand.**

Isotopes are the same element in variants of differing stability — some stable, some decaying with a measurable half-life. Libraries are the same. `request` and `undici` are isotopes of "HTTP client"; one of them has not had a commit in 79 months. CodeIsotope measures which one you are holding.

AI coding assistants write code. They rarely go looking for the mature, widely-adopted repository that already solved the problem — so codebases built with AI quietly accumulate hand-rolled retry loops, `JSON.parse(JSON.stringify())` clones, `Math.random()` session tokens, and `split(',')` CSV parsers. Each one works in the happy path and fails in production.

CodeIsotope closes that gap from four directions. It installs into your project as a `/codeisotope` slash command for whichever AI coding CLI you already use, then:

- **`scan`** finds capabilities that look hand-implemented,
- **`audit`** grades the dependencies you already have — the deprecated, archived and quietly-abandoned ones no advisory will ever be filed against,
- **`gaps`** reports the infrastructure you have no answer for at all, and
- **`reference`** points at how healthy libraries solve it, as commit-pinned links to their real source.

`audit`, `vet` and `reference` work across **JavaScript, Python, Rust and Go**; `scan` and `gaps` cover JavaScript and Python. All of them gather hard evidence — maintenance, adoption, bus factor, published advisories, licence — so the recommendation is a fact, not a guess.

```
npx codeisotope init      # install the slash command into this project
/codeisotope              # run it from Claude Code, opencode, Cursor, Gemini CLI, Windsurf or Copilot
```

## Why it works this way

CodeIsotope is two halves with a hard line between them:

| | Does | Never does |
|---|---|---|
| **The binary** (`codeisotope`) | Fingerprints the code, grades your dependencies, reports what is missing, queries npm / GitHub / deps.dev / OpenSSF, scores health, pins permalinks to a commit | Judge whether a finding is real, pick a replacement, or explain a pattern |
| **The host model** (your AI CLI) | Reads the flagged code, confirms or discards each lead, chooses and vets replacements, reads the referenced source, writes the report | Invent a package or a code snippet from memory |

That split is the whole design. The model supplies judgement — it can tell a real retry loop from an incidental `for` loop with a `setTimeout` in it. The binary supplies facts that cannot be hallucinated — every recommended package is verified to exist, with real download counts and a real last-commit date. The slash command tells the model, in as many words, never to recommend anything that did not come back from `codeisotope vet`.

It also means **no API keys and no per-scan cost.** The intelligence is the LLM you are already paying for; every data source CodeIsotope queries is free and unauthenticated.

## Install

```bash
npx codeisotope init            # detects the AI CLIs configured in this project
npx codeisotope init --all      # install for every supported CLI
npx codeisotope init --dry-run  # show what would be written
```

Supported targets, each in its own native format:

| CLI | File |
|---|---|
| Claude Code | `.claude/commands/codeisotope.md` |
| opencode | `.opencode/commands/codeisotope.md` |
| Cursor | `.cursor/commands/codeisotope.md` |
| Gemini CLI | `.gemini/commands/codeisotope.toml` |
| Windsurf | `.windsurf/workflows/codeisotope.md` |
| GitHub Copilot | `.github/prompts/codeisotope.prompt.md` |

With no CLI detected it installs for Claude Code and opencode and tells you it did. A command file you wrote yourself is never overwritten without `--force`.

## Use it directly

The binary is useful on its own, and `--json` is what the slash command consumes.

```bash
codeisotope scan                      # fingerprint the current directory (JS/TS and Python)
codeisotope scan ./src --json         # machine-readable, scoped to a subtree
codeisotope scan --only csv-parsing,password-hashing
codeisotope scan --only py-sql-injection,py-insecure-random
codeisotope scan --include-suppressed # report even capabilities you already have a library for

codeisotope audit                     # grade every direct dependency
codeisotope audit --dev               # include devDependencies
codeisotope audit --fail-on replace   # exit 3 in CI if anything is deprecated/archived/abandoned

codeisotope gaps                      # report infrastructure the project has no answer for
codeisotope gaps --include-not-applicable  # show what was skipped, and why
codeisotope gaps --fail-on high       # exit 3 in CI on any high-severity gap

codeisotope vet "csv parser quoted fields" --seed papaparse --seed csv-parse
codeisotope vet --package lru-cache --package quick-lru
codeisotope vet --package httpx --ecosystem pypi        # Python, Rust and Go too
codeisotope vet "async runtime" --ecosystem cargo

codeisotope reference "retry exponential backoff jitter" --package p-retry
codeisotope reference "csv parser quoted fields" --limit 2
codeisotope reference "task scheduling" --package tokio --ecosystem cargo

codeisotope verify undici p-retry            # does this name exist? exits 4 if not
codeisotope vet "retry" --strict           # refuse to grade an invented name

codeisotope detectors                 # list every detector and what it matches
codeisotope gap-list                  # list every gap and the traits it applies to
```

### What a scan looks like

```
high    password hashing
        src/auth.js:3  [password-hashing] signals: password-vocab, fast-hash, digest
          3: export function hashPassword(password) {
          5: const digest = createHash('sha256').update(salt + password).digest('hex');
        SECURITY: general-purpose hashes are far too fast for passwords -- a GPU tries billions
        of guesses per second against them. Use a memory-hard KDF (argon2id, scrypt, bcrypt).
        known solutions: @node-rs/argon2, argon2, bcrypt, node:crypto scrypt (built-in)
```

The same command on a Python project. This is a real run against a 22-line Flask app — 8 findings, 5 of them high-severity security:

```
high    building SQL by string formatting
        app/main.py:30  [py-sql-injection] signals: fstring-sql, sql-keyword
          30: cur.execute(f"INSERT INTO users (email, pw) VALUES ('{email}', '{pwhash}')")
        SECURITY: interpolating a value into SQL is injection. A parameterised query --
        cursor.execute("... WHERE id = %s", (id,)) -- costs nothing and closes it entirely.

high    deserialising untrusted data
        app/main.py:43  [py-unsafe-deserialize] signals: untrusted-source, pickle-load
          43: blob = request.get_data()
          44: state = pickle.loads(blob)
        SECURITY: pickle.loads, yaml.load and eval all execute arbitrary code by design. Given
        attacker-controlled bytes this is remote code execution, not a hardening issue.
```

Note the citation on that second finding: lines 43 and 44, the two adjacent lines that *are* the vulnerability. An earlier version cited `os.environ.get("DEBUG")` 29 lines away, because the broad `untrusted-source` signal also matched `environ` and happened to appear first in the file. Excerpts now anchor on the most precise signal — decisive over required — then take the nearest hit for each other signal.

### What vetting looks like

```
1. @node-rs/argon2@2.1.0  A 87/100
   Actively maintained, widely adopted, safe to adopt.
     + Maintenance     49 commits in the last 90 days, last commit 0 days ago
     ~ Release cadence 1 release(s) in the last 12 months, latest @node-rs/argon2@2.1.0 16 days ago
     + Adoption        1,131,459 downloads/week -- de facto standard
     ~ Bus factor      top 3 contributors are 82% of commits (top 10 contributors sampled)
     ~ Security        OpenSSF Scorecard 5.5/10, no known advisories
     + License         MIT (permissive)
```

## Auditing what you already installed

`scan` asks what you should have installed. `audit` asks whether what you already installed is rotting.

```
CodeIsotope audit
6 direct dependencies | ecosystem: npm
4 replace | 2 healthy

  replace  request@^2.88.2 [npm]  F 25/100
            deprecated by its maintainers: request has been deprecated, see .../issues/3142
            1 known advisory/advisories on the current version: GHSA-p8p7-x288-28g6
            no commits in 79 months -- effectively unmaintained
            find a replacement: codeisotope vet "Simplified HTTP client"

  replace  left-pad@^1.3.0 [npm]  F 25/100
            deprecated by its maintainers: use String.prototype.padStart()
            repository is archived -- it will receive no further fixes, including security fixes
            maintainer says use String.prototype.padStart() -- drop the dependency

Healthy: lru-cache, papaparse
```

Four verdicts: `replace` (deprecated, archived, live advisory, or dead for years), `weak` (maintenance has stopped, no licence, or no repo to verify), `aging` (slowing down — a watch item), `healthy`.

Three things make the verdict different from a health score:

- **Adoption is ignored.** Popularity is sunk cost once a package is in your `package.json`. A 200-download package its author still maintains is fine; `async-retry` at 31M downloads a week and five years without a commit is not.
- **Dev dependencies are graded more leniently.** A stale test runner is a smaller problem than a stale runtime dependency, so the staleness thresholds are looser for `devDependencies`.
- **Abandonment is measured on real commits.** Same rule as the health score: `pushed_at` counts any branch, so it never decides the verdict.

**Audit does not choose the replacement**, and that is deliberate. npm search ranks on text relevance, so querying a package's own description returns its `@types` stub, forks that inherit the same abandoned code, and packages that merely share vocabulary — searching `async-retry`'s description surfaces a JSDoc parser at grade A. Picking a functional equivalent requires knowing which of the dependency's features your code actually uses, which is the model's job. The binary reports the problem, quotes the maintainer's own suggested successor when the deprecation message names one, and hands over search terms.

Direct dependencies only. Transitive advisories are `npm audit`'s job and it does them well; the gap nobody covers is the dependency *you chose* that has been abandoned for three years, because no advisory will ever be filed against it.

`--fail-on replace|weak|aging` exits 3, so it works as a CI gate.

### Four languages, one command

`audit` grades **JavaScript/TypeScript, Python, Rust and Go**, each against its own registry:

| Ecosystem | Manifests read | Registry |
|---|---|---|
| npm | `package.json` | registry.npmjs.org |
| PyPI | `requirements.txt`, `pyproject.toml` (PEP 621 and Poetry) | pypi.org |
| crates.io | `Cargo.toml` | crates.io |
| Go | `go.mod` | proxy.golang.org |

Ruby and Maven manifests are parsed and reported, but their packages cannot be graded yet — they appear in `unresolved` with the reason, never silently as "clean".

Every dependency carries the ecosystem of the manifest it came from, which matters more than it sounds:

```
7 direct dependencies | ecosystems: go, pypi
  note Polyglot project: 3 go, 4 pypi. Each dependency is graded against its own registry.

  weak   uvicorn@* [pypi]      B 83/100
  aging  httpx@>=0.27 [pypi]   F 33/100
```

An earlier version picked one ecosystem for the whole project. A repo with both a `pyproject.toml` and a `go.mod` therefore looked up `github.com/gin-gonic/gin` on PyPI, found nothing, and reported three healthy Go modules as `F 0/100` with *"no licence detected — legally unsafe to ship"*. Polyglot repositories are the normal case, so dependencies are keyed by ecosystem **and** name — `redis` exists on both npm and PyPI as unrelated packages.

Three more things the multi-language work had to get right:

- **Download counts are not comparable across registries.** `requests` records ~297M PyPI downloads a week against ~1M for a thriving npm package, because PyPI counts every CI mirror pull. Thresholds are per-ecosystem, and **dependent counts** — how many published packages depend on this one — are preferred wherever available, because that number means the same thing everywhere.
- **A prerelease is not what a package gets graded on.** deps.dev reports `isDefault` for httpx's `1.0.0.dev5`, which has 34 dependents against 38,576 for the stable `0.28.1` people actually install. Grading the prerelease scored one of Python's most-used HTTP clients at F 33/100 with "modest adoption".
- **Older PyPI packages often link no repository at all.** Without a fallback the maintenance signal went `unknown` and dropped out of the average, which scored `nose` at B 70/100 despite its last release being 2015. The registry's own publish date now stands in: *"newest release published 11.3 years ago — effectively unmaintained"*.

## Finding what is missing entirely

`scan` and `audit` examine code that exists. `gaps` looks for code that does not.

```
CodeIsotope gaps
1 files, 29 ms
project profile: containerised, database, http-routes, http-server, outbound-http, reads-env

10 missing capabilities (6 to fix before shipping):

  high    graceful shutdown on SIGTERM  [no-graceful-shutdown]
            Every container orchestrator and PaaS stops a process by sending SIGTERM and waiting.
            With no handler, Node exits immediately: in-flight requests are severed mid-response,
            database transactions are abandoned, and queue jobs are lost. This fires on every
            single deploy, not just on failures.
            applies because: http-server
            known solutions: process.on("SIGTERM") + server.close (built-in), close-with-grace

  high    schema validation at the request boundary  [no-input-validation]
            ...
            src/server.js:9  const { email, password } = req.body;
```

Detecting absence is a far weaker claim than detecting presence, and cheap to get wrong: tell a CLI tool it needs rate limiting and you have taught the reader to ignore the tool. So the mechanism is inverted — **every gap is gated on a trait**, meaning positive evidence that this project is the kind of thing where the gap matters. No trait, no report.

Traits are earned, never assumed: `http-server` from a `listen()` call or an Express import, `auth` from a route whose path is `/login`, `containerised` from a Dockerfile, `cli` from a `bin` entry. Some gaps need a second, narrower signal on top — a route alone does not justify raising rate limiting, but an auth endpoint does, because that is the credential-stuffing target.

Every reported gap carries the traits that made it applicable and the source line that justified it, so the claim is checkable rather than asserted. `--include-not-applicable` shows what was skipped and which traits it would need. Ten gaps, `gap-list` prints them all.

### Code is not data

The interesting failure mode showed up when CodeIsotope was pointed at itself, five separate times:

| What matched | Why it was wrong |
|---|---|
| `'AbortSignal.timeout (built-in)'` in the gap catalog | The tool read its own catalog as proof it handled timeouts |
| A JSDoc line mentioning "the local `gh` CLI login" | A keyless tool looked like it handles credentials |
| "rate limit" inside the 30-line `HELP` template literal | Satisfied the rate-limiting signal from inside a string |
| `"import express from 'express'"` in a test fixture | The tool declared itself an HTTP server |
| `password: ['hash', 'kdf', 'crypto']` in a synonym table | An object key, read as credential handling |

None of these is really about self-reference. Any project holding a table of package names, a set of lint rules, or a fixture of example payloads produces exactly the same false evidence.

The fix is `src/gaps/mask.ts`, which splits each line into two views. Comments and multi-line template bodies are never evidence — prose describing a feature is not the feature. On top of that, signals meaning "this code calls X" match with string and regex bodies blanked, so a mention cannot pose as an implementation. Where both halves matter — `process.on('SIGTERM')` is only meaningful with the call *and* the argument — a signal declares one pattern against the code and another against the literals. Line lengths are preserved so column positions stay valid.

Python needs its own masker (`src/gaps/mask-python.ts`) rather than a flag on that one, because three of its constructs have no JavaScript analogue:

- **Docstrings.** A triple-quoted string is Python's documentation. Before this, a token finding cited `"""Create a session token."""` — the docstring, not the code beneath it.
- **`#` comments**, which the JavaScript masker treats as live code.
- **f-strings**, where the literal text is data but `{...}` holds real expressions. Blanking the whole string would hide `f"... {user_input}"` interpolation — which is exactly the SQL-injection signal most worth keeping. So the literal is blanked and the braces survive.

`--fail-on high|medium|low` exits 3.

## Citing real code

Sometimes the answer is not "install this" but "your version is missing something". `reference` points at how a healthy library actually does it:

```
$ codeisotope reference "retry exponential backoff jitter" --package cockatiel

  cockatiel@4.0.0  C 55/100  MIT
     cockatiel @ f475a690ee (master)

     src/backoff/ExponentialBackoff.ts  2 KB
       filename matches exponential, backoff; directory matches backoff
       https://github.com/connor4312/cockatiel/blob/f475a690eedbb9dc.../src/backoff/ExponentialBackoff.ts
```

Ask any model how `p-retry` implements jitter and it will produce a confident, plausible, invented snippet. That is the problem this solves: the binary contributes **permalinks verified to exist, pinned to a commit SHA**. Not a branch — `blob/main/src/index.js` silently means something different next week, and a line number means something different the moment anyone edits above it. Resolving HEAD once and pinning every path to that commit produces citations that stay correct.

Sources are health-gated at 55/100, and deprecated or archived repos are refused outright. A reference implementation is advice to imitate someone's code, so pointing at an abandoned project is actively harmful — the reader copies patterns from a codebase that lost its maintainers years ago. Asked for a retry reference from `async-retry` and `request`, the answer is no sources and an explanation:

```
note No healthy reference found. Rejected: async-retry (health 46/100, below the 55 needed
     to be worth imitating); request (deprecated by its maintainers). Copying patterns from
     an unmaintained project is worse than having no reference.
```

The binary ranks **paths only** — never contents. Deciding what a file does requires reading it, which is the model's job; narrowing a 622-file monorepo to the four files worth opening is the binary's. Every ranked file states why it was picked, and when nothing scores above zero the answer is "the tree could not be narrowed" rather than an arbitrary `src/index.js`.

Two path-ranking rules earned their place by being wrong first:

- **`lib/` is ambiguous.** For a TypeScript project it is compiled output of `src/`; for `csv-parse` it is the authored source. The test has to be *sibling-scoped* — is there a `src/` next to *this* `lib/` — not repo-global. A first cut asked "does the repo contain any `src/` anywhere", and node-csv's `demo/webpack/src/` suppressed the real parser, leaving a `rollup.config.js` as the top result.
- **Monorepo members are not interchangeable.** node-csv publishes `csv-parse`, `csv-stringify` and `csv-generate` from one repo. Asked for a parser reference, the first version returned four files from the stringifier's samples directory. Files outside the package being referenced are now rejected rather than merely down-ranked.

## How the health score works

Six weighted signals, 0–100:

| Signal | Weight | Measures |
|---|---|---|
| Maintenance | 25 | Commits on the **default branch** in the last 90 days, then true last-commit age, then the registry's publish date |
| Adoption | 20 | Dependent count, then downloads at per-ecosystem thresholds, then stars |
| Release cadence | 15 | Releases in the last 12 months, attributed per-package in monorepos |
| Bus factor | 15 | Share of commits held by the top 3 contributors |
| Security | 15 | Published advisories on the current version, then OpenSSF Scorecard |
| License | 10 | Permissive / copyleft / missing |

Two rules keep the number honest:

- **Unknown signals are dropped from the average, not counted as failures.** A package with no OpenSSF Scorecard has not failed a security check — it has an unpublished one. Tools that score missing data as zero systematically punish smaller, perfectly good libraries. The corollary: a missing signal is never *also* reported as a shortcoming, which an earlier version did — listing `no Scorecard published` as a gap while already excluding it from the maths counted the same absence twice.
- **Hard problems cap the score outright.** Deprecated caps at 25, archived at 30, a known advisory at 40 — so no amount of popularity can bury them. `async-retry` has 31 million downloads a week and still lands at D, because its last commit was three years ago.

**The weights are judgement, not measurement, and [docs/SCORING.md](docs/SCORING.md) says so in detail** — including which false positives have been found, the known tension in how caps collapse different problems to the same number, and what data would be needed to replace opinion with calibration. Two are fixed so far:

- **Bus factor on a small team.** `tenacity` has two active maintainers and is healthy, but "top 3 contributors are 83% of commits" scored it `weak`. With three contributors the top three are *by definition* 100% of commits — the metric was measuring sample size, not risk. Four or fewer contributors now reports the count instead of a meaningless percentage.
- **Grading a prerelease.** deps.dev flags httpx's `1.0.0.dev5` as default; it has 34 dependents against 38,576 for the stable `0.28.1`. That scored one of Python's most-used HTTP clients at F 33/100 with "modest adoption".

`pushed_at` is deliberately *not* treated as a commit date. It counts pushes to any branch, so a Dependabot push to a side branch makes an abandoned repo look fresh. CodeIsotope reports the real default-branch commit history and says "last push to any branch" when that is all it has.

## Data sources

All free, all keyless, no account required:

| Source | Supplies |
|---|---|
| [npm registry](https://registry.npmjs.org) | Search, versions, licences, deprecation |
| [npm downloads API](https://api.npmjs.org) | Weekly download counts |
| [PyPI JSON API](https://pypi.org) | Versions, licences, yanked releases, project links |
| [crates.io API](https://crates.io) | Search, versions, licences, 90-day downloads |
| [Go module proxy](https://proxy.golang.org) | Latest version and its publish date |
| [deps.dev](https://deps.dev) (Google Open Source Insights) | Advisories, deprecation, licences, canonical source repo, dependent counts — across every ecosystem |
| [GitHub REST API](https://docs.github.com/rest) | Commits, releases, contributors, archived status, commit-pinned trees |
| [OpenSSF Scorecard](https://securityscorecards.dev) | Supply-chain security posture |

GitHub is the only rate-limited one that matters: 60 requests/hour unauthenticated, 5,000 with a token. CodeIsotope picks up `GITHUB_TOKEN`, `GH_TOKEN`, or your local `gh auth login` automatically, and tells you in the report when it is running without one. Responses are cached on disk for 6 hours (`--no-cache` to bypass).

Two sources were tried and rejected. **pypistats.org** returns `429 RATE LIMIT EXCEEDED` on the second consecutive request, so it cannot be a dependency of an audit that checks 40 packages — deps.dev dependent counts replaced it, and are a better signal anyway. **Google Custom Search** is closed to new customers and shuts down on 1 January 2027; it is also unnecessary, since the registries are the authoritative indexes and the semantic half of the search is done by the LLM already running.

## Detectors

33 detectors, ordered so security and correctness findings surface first. Run `codeisotope detectors` for the full list with match rules and languages.

**JavaScript / TypeScript — 22**

**Security** — insecure random IDs, fast-hash password hashing, hand-rolled JWTs, ad-hoc input validation
**Correctness** — CSV via `split(',')`, `JSON.parse(JSON.stringify())` clones, naive semver comparison, regex slugifiers, manual date formatting, query-string building
**Resilience** — retry/backoff, rate limiting, concurrency pools, TTL/LRU caches
**Utilities** — deep equal, deep merge (prototype pollution), debounce/throttle, event emitters
**Platform** — argv parsing, `.env` parsing, console-wrapper logging, recursive directory walks

**Python — 11**

**Security** — SQL built by string formatting, tokens from `random`, sha256 password hashing, `pickle`/`yaml.load`/`eval` on untrusted data
**Correctness** — `requests` without a timeout, CSV via `split(',')`, hand-parsed dates
**Resilience** — retry with exponential backoff
**Platform** — hand-parsed `argv`, hand-cast environment config, isinstance validation chains

The Python set is **not a translation** of the JavaScript one. Its first three security detectors — SQL by f-string, `pickle.loads` on request data, tokens from `random` — are the ones that actually get Python services owned, and none has a JavaScript equivalent worth detecting. They are also registered first, ahead of everything else, because they are injection and remote-code-execution classes rather than hardening opportunities.

Each detector is anchored on a **required** signal that names the capability, so a bare `for` loop or `setTimeout` cannot trigger a finding on its own. A detector is also **suppressed entirely** when the project already depends on something that solves it — recommending `p-retry` to a project that already imports `p-retry` is noise, and the suppression is reported so you know it was considered. Suppression is per-ecosystem: a Python detector naming `backoff` must not be silenced by an npm package of the same name, and `attrs`, `redis`, `six` and `mock` all exist on both registries as unrelated packages.

Recommendations prefer platform built-ins over dependencies, and this matters more in Python than in JavaScript because the standard library is so much larger. Where `secrets`, `hashlib.scrypt`, `csv`, `argparse` or `datetime.fromisoformat` covers the case, the answer is to **delete code**, not add a dependency.

### Two mechanisms the Python detectors needed

Both were added because the first version accused correct code:

- **`unless`** — signals that disqualify a finding. `requests.get(url)` is a defect *because* there is no `timeout=`, and with no way to express that, the detector flagged calls that passed one.
- **`clusterWindow: 0`** — judge each line alone. A timeout is an argument of its own call, so with the default 60-line window a single correct call excused every incorrect one in the file.

The same lesson appeared in the SQL detector: an early version counted `.execute(` as a signal, which fires on safe and unsafe calls alike, so `cursor.execute("... VALUES (%s)", (email,))` reached the threshold — flagging the exact parameterised form the detector exists to recommend. It now requires a SQL keyword *plus* an interpolation on the same line.

## Gaps

18 gaps, ordered by severity. Run `codeisotope gap-list` for each one's traits, language and match rules.

**JavaScript — 10**

**Reliability** — graceful shutdown on SIGTERM, a handler for unhandled rejections, a health check endpoint
**Security** — schema validation at the request boundary, HTTP security headers, rate limiting on auth routes
**Resilience** — timeouts on outbound HTTP calls
**Operability** — structured logging, environment-variable validation
**Supply chain** — a committed lockfile

**Python — 8**

**Security** — `DEBUG` disabled outside development, schema validation at the request boundary
**Reliability** — a production WSGI/ASGI server, a health check endpoint
**Resilience** — timeouts on outbound HTTP calls
**Operability** — structured logging, environment-variable validation
**Supply chain** — pinned or locked dependencies

The catalog is deliberately short. Every entry had to clear one bar: a competent reviewer, shown this against a project with the stated traits, would agree it is a real omission rather than a matter of taste. Anything that failed — "you have no tests", "you should use TypeScript", "add a CONTRIBUTING.md" — is absent on purpose. Those are opinions, and the whole claim of this tool is that it reports facts.

### The same problem, a different answer per language

Gaps are **scoped to one language**, because translating the advice would often make it wrong rather than merely unhelpful:

- A Node service closes its own server on SIGTERM. A Flask app delegates that to gunicorn — so Python has a `py-no-production-server` gap and **no shutdown gap at all**, and the production-server entry explains why.
- `helmet` is not a Python answer. `uv lock` is not a Node one.

Two Python gaps have no JavaScript counterpart:

- **`py-debug-enabled`** — `DEBUG = True` hardcoded. Flask then serves the Werkzeug debugger on any traceback, offering an interactive Python console to whoever triggered the error. That is remote code execution by design; Django's version leaks settings including credentials.
- **`py-no-production-server`** — no gunicorn/uvicorn/waitress declared, so the app is presumably started with `app.run()`. A development server serves one request at a time and ignores SIGTERM.

**Traits are attributed to the language that earned them**, which took a second attempt to get right. A repo with a Flask API and a React frontend earns `http-server` from Python and `javascript` from `package.json`; with one global trait set those combined into Node server advice, and a frontend with no server was told to add a SIGTERM handler and Helmet middleware:

```
before:  12 gaps — including no-graceful-shutdown, unhandled-rejection, no-security-headers
after:    6 gaps — all Python
```

## Development

Zero runtime dependencies, so `npx codeisotope` installs in under a second and carries no supply-chain surface.

```bash
npm install
npm run dev -- scan      # runs src/ directly via Node's native TypeScript support
npm test                 # 206 tests, all offline
npm run typecheck
npm run build
```

Requires Node 20.11+ **to run**; Node 22+ to develop, since the test suite is TypeScript executed directly by `node --test`. CI verifies both: the suite runs on 22 and 24, and the 20.11 floor is checked against the compiled `dist/`, which is what a consumer actually installs.

`src/lib/http.ts` hand-rolls retry with backoff and a concurrency gate — precisely what this tool tells you not to do. That trade is deliberate and documented in the file: the zero-dependency constraint applies to a tool distributed by `npx`, not to the projects it scans. CodeIsotope flags itself for it, which is the honest outcome.

## Status

v0.5.1. Coverage by capability:

| | JavaScript / TypeScript | Python | Rust | Go |
|---|---|---|---|---|
| `scan` | 22 detectors | 11 detectors | — | — |
| `gaps` | 10 gaps | 8 gaps | — | — |
| `audit` / `vet` / `reference` | ✅ | ✅ | ✅ | ✅ |

Ruby and Maven manifests are parsed and reported but not yet graded — they appear in `unresolved` with a reason, never silently as "clean".

All four capabilities from the original plan are in: replace hand-rolled code, flag weak dependencies, report missing infrastructure, and point at reference implementations. Next: nobody has run this on a real codebase yet, and that matters more than the next feature — five of the last nine fixes came from pointing it at live registries rather than trusting the code.

MIT.
