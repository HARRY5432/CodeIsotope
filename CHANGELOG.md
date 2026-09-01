# Changelog

All notable changes to CodeIsotope. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.1] - 2026-08-31

Answers to outside criticism. Two bugs where the tool was **confidently wrong**, one unenforceable
rule made enforceable, and the scoring judgement written down instead of hidden.

### Fixed

- **`vet` and `reference` defaulted to npm regardless of the project's language.** This was the worst
  bug the tool has had, because it produced a wrong answer wearing a health card:

  ```
  $ codeisotope vet "retry" --package tenacity     # in a Python project
    1. tenacity@1.0.4  F 18/100
       Living Styleguide Generator                 <- an abandoned npm package
  ```

  The Python `tenacity` is a healthy B 84/100 with 4,010 dependents. Nothing in the output suggested
  the registry might be wrong, and a graded card with signals and a licence reads as authoritative.

  The ecosystem is now inferred from the project's own manifests. A project declaring two gradeable
  ecosystems is an **error**, not a guess — merging results would have preserved the failure and hidden
  it behind convenience. A near-empty `package.json` beside a real `requirements.txt` is not treated
  as ambiguous, and the reasoning appears in the report's notes.

- **A Python CLI was not recognised as a CLI.** Trait detection read only `[project.scripts]` and
  `__main__.py`, so a tool with `argparse` in two files established no `cli` trait, and
  `py-no-dependency-lockfile` — which applies to `library`, `cli` and `http-server` — stayed silent on
  it. Most Python CLIs never declare packaging entry points; they parse argv and are run with
  `python tool.py`.

  `argparse`, `click` and `typer` now establish `cli` on their own. `sys.argv` and `input()` need two
  corroborating signals, because a test harness reads argv and a migration script prompts for
  confirmation.

- **Bus factor misfired on small teams.** `tenacity` has two active maintainers and is perfectly
  healthy, but "top 3 contributors are 83% of commits" scored it `weak`. With three contributors the
  top three are *by definition* 100% of commits — the metric was measuring sample size, not risk.
  Four or fewer contributors now reports the contributor count instead of a meaningless percentage.
  One contributor is still `bad`.

- **A missing OpenSSF Scorecard was counted twice.** It was excluded from the score average *and*
  listed in `gaps` as a shortcoming of the package. Most small libraries have no Scorecard, and the
  entire point of dropping unknown signals is to stop punishing them for a metric they never
  published. It is now handled in one place.

### Added

- **`codeisotope verify <name>...`** — confirms a package name exists in an ecosystem, exiting 4 when
  it does not. This turns the tool's central rule from an instruction into a contract. "Never
  recommend a package that did not come back from `vet`" was fair criticism as a prompt, because a
  prompt is not a check; existence is a fact the binary can settle in one request.

  It distinguishes **INVENTED** (exists nowhere) from **WRONG REGISTRY** (exists, but in a different
  ecosystem). Collapsing those would lose the information that explains the `tenacity` mistake.

- **`vet --strict`** — refuses to grade a name the registry has no record of. Without it, an invented
  name produced an F-graded card full of unknown signals, which reads as "a real but unhealthy
  package" rather than as fiction. Rejected names appear in `notes` prefixed `REJECTED`.

- **[docs/SCORING.md](docs/SCORING.md)** — the weights are judgement, not measurement, and this says
  so with the reasoning for each one, the two false positives found so far, the known tension in caps
  collapsing different problems to the same number, and the three studies that would replace opinion
  with calibration. Shipped in the package, not only in the repo.

### Changed

- The installed prompt now *uses* the enforcement rather than restating the rule: it passes
  `--strict`, knows `verify`, and handles a cross-registry name collision. A test asserts the prompt
  keeps doing so, since the enforcement is optional in practice if the prompt stops asking for it.

  27 new tests, 206 total, all offline.

## [0.5.0] - 2026-08-31

`scan` and `gaps` now understand Python, which is where most AI-written code lives.

### Added

- **11 Python detectors for `scan`.** Not a translation of the JavaScript set: the first three —
  SQL built by f-string interpolation, `pickle.loads` on request data, and tokens from `random` —
  are the ones that actually get Python services owned, and none has a JavaScript equivalent worth
  detecting. They are registered ahead of everything else because they are injection and
  remote-code-execution classes rather than hardening opportunities.

  Recommendations lead with the standard library wherever it covers the case. Python's is large
  enough that the right answer is frequently to *delete* code: `secrets`, `hashlib.scrypt`, `csv`,
  `argparse` and `datetime.fromisoformat` all ship with the interpreter.

- **8 Python gaps.** Six are the Python answer to a problem JavaScript also has; two have no
  counterpart at all:

  - `py-debug-enabled` — `DEBUG = True` hardcoded. Flask then serves the Werkzeug debugger on any
    traceback, offering an interactive Python console to whoever triggered the error. That is remote
    code execution by design; Django's version leaks settings including credentials.
  - `py-no-production-server` — no gunicorn/uvicorn/waitress declared, so the app is presumably run
    with `app.run()`. This is also *why Python has no shutdown gap*: a real WSGI server owns SIGTERM,
    so the correct advice is "configure a production server", not "write a signal handler".

- **A Python masker** (`src/gaps/mask-python.ts`). Docstrings and `#` comments are never evidence —
  a token finding previously cited `"""Create a session token."""`, the docstring rather than the
  code. f-strings are handled specially: the literal text is blanked but `{...}` expressions survive,
  because blanking the whole string would hide `f"... {user_input}"` interpolation, which is exactly
  the SQL-injection signal most worth keeping.

- **`unless` and `clusterWindow` on the detector contract.** Both exist because the first version
  accused correct code. `requests.get(url)` is a defect *because* there is no `timeout=`, and with no
  way to express that the detector flagged calls that passed one; and since a timeout is an argument
  of its own call, `clusterWindow: 0` was needed so a single correct call could not excuse every
  incorrect one in the file.

### Fixed

- **Cross-language contamination.** A repo with a Flask API and a React frontend earned
  `http-server` from Python and `javascript` from `package.json`, and one global trait set combined
  those into Node server advice — telling a frontend with no server to add a SIGTERM handler and
  Helmet middleware. Traits are now attributed to the language that earned them, and a scoped gap
  sees only its own language's traits. That repo went from 12 gaps to 6, all Python.

- **Misleading citations.** Excerpts were chosen first-in-file, so a `pickle.loads(blob)` at line 44
  was evidenced by `os.environ.get("DEBUG")` at line 15 — the broad `untrusted-source` signal also
  matches `environ`. Excerpts now anchor on the most precise signal, decisive over required, then
  take the nearest hit for each other signal. That finding now cites lines 43 and 44, the two
  adjacent lines that are the vulnerability.

- **The SQL detector flagged parameterised queries** — the exact fix it recommends. `.execute(`
  was a counted signal, and it fires on safe and unsafe calls alike, so
  `cursor.execute("... VALUES (%s)", (email,))` reached the threshold. A finding now requires a SQL
  keyword *plus* an interpolation on the same line.

- **A satisfied gap was reported as not-applicable.** `py-debug-enabled`'s requirement and its
  defect are the same signal, so a project correctly reading DEBUG from the environment failed the
  requirement and its good practice went unreported. Satisfaction is now checked before
  `requiresSignals`.

- Detector suppression is per-ecosystem: a Python detector naming `backoff` must not be silenced by
  an npm package of the same name, and `attrs`, `redis`, `six` and `mock` all exist on both
  registries as unrelated packages.

- CodeIsotope reported `auth` as a trait of itself, from `password: ['hash', 'kdf', 'crypto']` in its
  own synonym table — an object key read as credential handling. Fifth instance of the same
  code-versus-data class.

### Changed

- `detectors` and `gap-list` name the language of each entry, now that one capability can have an
  entry per language and the ids alone do not say which files each reads.
- The installed prompt covers Python and carries the rule that matters most: never translate advice
  across languages. `helmet` is not a Python answer; `gunicorn` is not a Node one.

  53 new tests, 176 total, all offline.

## [0.4.0] - 2026-08-30

`audit`, `vet` and `reference` now work on Python, Rust and Go, not just JavaScript.

### Added

- **Multi-ecosystem support.** Dependencies are graded against their own registry: npm, PyPI,
  crates.io and the Go module proxy. `requirements.txt`, `pyproject.toml` (both PEP 621 and Poetry),
  `Cargo.toml` and `go.mod` are all read properly. Ruby and Maven manifests are parsed and reported
  but not yet graded — they appear in `unresolved` with the reason, never silently as "clean".

  Python was the priority because it is where most AI-written code lives. Before this, pointing
  `audit` at a Python project reported *"pypi packages cannot be vetted in this version"* for every
  dependency.

- **Dependent counts as the adoption signal.** How many published packages depend on this one, from
  deps.dev. Unlike downloads this is comparable across ecosystems, which is what makes a single
  health score meaningful for a polyglot project.

- **A section-aware manifest parser** (`src/scan/parse-manifests.ts`) replacing the line-at-a-time
  matcher. Understands Cargo's four dependency-table forms, PEP 508 extras and environment markers,
  Go's `// indirect` marks and `exclude` blocks, Gemfile group blocks, and Maven test scope.

### Fixed

- **Polyglot projects were graded against a single registry.** `audit` picked one ecosystem for the
  whole project, so a repo with both a `pyproject.toml` and a `go.mod` looked up
  `github.com/gin-gonic/gin` on PyPI, found nothing, and reported three healthy Go modules as
  `F 0/100` with *"no licence detected — legally unsafe to ship"*. Dependencies now carry the
  ecosystem of the manifest they came from, and are keyed by ecosystem **and** name — `redis` exists
  on both npm and PyPI as unrelated packages.

- **Packages were graded on prereleases.** deps.dev reports `isDefault` for httpx's `1.0.0.dev5`,
  which has 34 dependents against 38,576 for the stable `0.28.1` people actually install. That
  scored one of Python's most-used HTTP clients at `F 33/100` with "modest adoption". The newest
  stable release is now preferred, in both PEP 440 and SemVer conventions.

- **Packages with no linked repository scored as if unjudged.** The maintenance signal went
  `unknown` and dropped out of the average — correct behaviour on missing data, wrong input, since
  the registry's publish date was already fetched. `nose` scored `B 70/100` despite its last release
  being 2015; it now reads *"newest release published 11.3 years ago — effectively unmaintained"*.

- `Cargo.toml` parsing reported `name`, `version`, `edition`, `license` and `path` as dependencies,
  and filed `[dev-dependencies]` as runtime ones.

### Changed

- Download thresholds are **per-ecosystem**. `requests` records ~297M PyPI downloads a week against
  ~1M for a thriving npm package, because PyPI counts every CI mirror pull. One global threshold
  either flattered every Python package or condemned every healthy Rust crate.

- Audit reports name every ecosystem present rather than just the first manifest's, and tag each
  dependency with its own. The old single-ecosystem header is exactly what let the PyPI/Go mixup hide
  in plain sight.

- **pypistats.org was tried and rejected** as the Python download source: it returns
  `429 RATE LIMIT EXCEEDED` on the second consecutive request, so it cannot support an audit that
  checks 40 packages. deps.dev dependent counts replaced it and are a better signal anyway.

  33 new tests, 122 total, all offline.

## [0.3.0] - 2026-08-30

Completes the four capabilities the tool was planned around.

### Added

- **`codeisotope gaps`** — reports infrastructure the project has no answer for: graceful shutdown,
  a handler for unhandled rejections, request validation, security headers, rate limiting on auth
  routes, outbound timeouts, structured logging, a health check, env validation, a lockfile.

  Detecting absence is a far weaker claim than detecting presence, so every gap is gated on a
  **trait** — positive evidence that this project is the kind of thing where the gap matters. A CLI
  is never told it needs security headers. Traits are earned from a `listen()` call, a `/login`
  route, a Dockerfile, a `bin` entry; never assumed. Every reported gap cites the source line that
  justified it. `--fail-on high|medium|low` exits 3.

- **`codeisotope reference`** — points at how healthy libraries solve a problem, as permalinks into
  their real source pinned to a commit SHA. Ask any model how `p-retry` implements jitter and it
  will produce a confident, plausible, invented snippet; a pinned URL is checkable and does not
  drift. Sources are health-gated at 55/100 and deprecated or archived repos are refused, because
  imitating an abandoned project is worse than having no reference.

  89 tests, all offline.

- **`codeisotope gap-list`** — every gap with the traits it applies to.

- CI: matrix on Node 22 and 24, a separate `engine-floor` job that verifies the declared 20.11
  floor against the compiled `dist/`, a self-audit gate, a self-gaps gate, and a step that fetches
  every permalink the binary emits and fails on a non-200.

### Fixed

- `main: dist/index.js` in `package.json` pointed at a file that was never built —
  `import 'codeisotope'` failed with `ERR_MODULE_NOT_FOUND`. Removed rather than filled in: this is
  a CLI, not a library. Found by the tool's own gap detector, which reported `library` and
  `published` as traits inferred from that field.

- Manifest parsing threw on a UTF-8 BOM, so any `package.json` written by a Windows editor made the
  project look dependency-free.

- Pattern matching could not tell code from data, which produced four false positives against
  CodeIsotope itself: the gap catalog's own `'AbortSignal.timeout (built-in)'` string, a JSDoc line
  mentioning `gh` CLI login, the words "rate limit" inside a 30-line help template, and the fixture
  line `"import express from 'express'"` in a test file. Comments and multi-line template bodies are
  now never evidence, and signals meaning "this code calls X" match with string and regex bodies
  blanked.

### Changed

- The installed slash command now drives all four capabilities. `gaps` had shipped working but
  unmentioned in the prompt, making it unreachable from the slash command — the way most people use
  this. A test now asserts the prompt runs every command the binary exposes.

## [0.2.0] - 2026-08-29

### Added

- **`codeisotope audit`** — grades the dependencies you already have. Four verdicts: `replace`
  (deprecated, archived, live advisory, or dead for years), `weak`, `aging`, `healthy`.

  Adoption is deliberately ignored, which is the inverse of what `vet` does: popularity is sunk cost
  once a package is in your `package.json`. `async-retry` gets `replace` at 31M downloads a week
  because nothing has landed in five years. Dev dependencies are graded more leniently. Direct
  dependencies only — transitive advisories are `npm audit`'s job.

  Audit does not choose the replacement. An earlier cut did, and npm's text-relevance ranking
  returned `@types` stubs, forks carrying the same dead code, and a JSDoc parser at grade A for
  `async-retry`. It now quotes the successor the maintainer named in the deprecation message and
  hands over search terms.

### Changed

- **Renamed from RepoRadar to CodeIsotope.** The npm name `reporadar` was already taken, so it was
  never available to publish under. Isotopes are the same element in variants of differing
  stability, which is what the tool measures: `request` and `undici` are isotopes of "HTTP client",
  and one has not had a commit in 79 months.

  **Breaking:** the binary, the npm package and the installed command are all renamed, and the
  environment variables are now `CODEISOTOPE_CACHE_DIR` and `CODEISOTOPE_GITHUB_TOKEN`. Re-run
  `npx codeisotope init --force` to replace old command files.

- `vet` and `audit` share one evidence pipeline, so a dependency and its proposed replacement are
  always measured by identical code.

## [0.1.0] - 2026-08-29

Initial release.

### Added

- **`codeisotope scan`** — 22 detectors across security, correctness, resilience, utilities and
  platform. Each is anchored on a required signal naming the capability, so a bare `for` loop or
  `setTimeout` cannot trigger a finding, and each is suppressed entirely when the project already
  depends on something that solves it.

- **`codeisotope vet`** — evidence from npm, the npm downloads API, deps.dev, the GitHub REST API
  and OpenSSF Scorecard. All free, all keyless.

- **Health scoring** — six weighted signals, 0–100. Unknown signals are dropped from the average
  rather than counted as failures, so a package is never punished for a metric it does not publish.
  Hard problems cap the total outright: deprecated 25, archived 30, known advisory 40.

  `pushed_at` is deliberately not treated as a commit date. It counts pushes to any branch, so one
  Dependabot push to a side branch makes a three-year-dead repo look fresh.

- **`codeisotope init`** — installs the `/codeisotope` slash command for Claude Code, opencode,
  Cursor, Gemini CLI, Windsurf and GitHub Copilot, each in its native format. A file the developer
  wrote is never overwritten without `--force`.

- Zero runtime dependencies, so `npx` installs in under a second with no supply-chain surface.

[0.5.1]: https://github.com/HARRY5432/CodeIsotope/releases/tag/v0.5.1
[0.5.0]: https://github.com/HARRY5432/CodeIsotope/releases/tag/v0.5.0
[0.4.0]: https://github.com/HARRY5432/CodeIsotope/releases/tag/v0.4.0
[0.3.0]: https://github.com/HARRY5432/CodeIsotope/releases/tag/v0.3.0
[0.2.0]: https://github.com/HARRY5432/CodeIsotope/releases/tag/v0.2.0
[0.1.0]: https://github.com/HARRY5432/CodeIsotope/releases/tag/v0.1.0
