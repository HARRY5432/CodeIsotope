# Changelog

All notable changes to CodeIsotope. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.4.0]: https://github.com/HARRY5432/CodeIsotope/releases/tag/v0.4.0
[0.3.0]: https://github.com/HARRY5432/CodeIsotope/releases/tag/v0.3.0
[0.2.0]: https://github.com/HARRY5432/CodeIsotope/releases/tag/v0.2.0
[0.1.0]: https://github.com/HARRY5432/CodeIsotope/releases/tag/v0.1.0
