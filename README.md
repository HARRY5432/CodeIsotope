# CodeIsotope

**Find the battle-tested open-source libraries your AI-written codebase reinvented by hand.**

Isotopes are the same element in variants of differing stability — some stable, some decaying with a measurable half-life. Libraries are the same. `request` and `undici` are isotopes of "HTTP client"; one of them has not had a commit in 79 months. CodeIsotope measures which one you are holding.

AI coding assistants write code. They rarely go looking for the mature, widely-adopted repository that already solved the problem — so codebases built with AI quietly accumulate hand-rolled retry loops, `JSON.parse(JSON.stringify())` clones, `Math.random()` session tokens, and `split(',')` CSV parsers. Each one works in the happy path and fails in production.

CodeIsotope closes that gap from both ends. It installs into your project as a `/codeisotope` slash command for whichever AI coding CLI you already use, then:

- **`scan`** finds capabilities that look hand-implemented, and
- **`audit`** grades the dependencies you already have — the deprecated, archived and quietly-abandoned ones no advisory will ever be filed against.

Either way it gathers hard evidence on the libraries involved — maintenance, adoption, bus factor, published advisories, licence — so the recommendation is a fact, not a guess.

```
npx codeisotope init      # install the slash command into this project
/codeisotope              # run it from Claude Code, opencode, Cursor, Gemini CLI, Windsurf or Copilot
```

## Why it works this way

CodeIsotope is two halves with a hard line between them:

| | Does | Never does |
|---|---|---|
| **The binary** (`codeisotope`) | Fingerprints the code, grades your dependencies, queries npm / GitHub / deps.dev / OpenSSF, scores health | Judge whether a finding is real, or pick a replacement |
| **The host model** (your AI CLI) | Reads the flagged code, confirms or discards each lead, chooses and vets replacements, writes the report | Invent a package from memory |

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
codeisotope scan                      # fingerprint the current directory
codeisotope scan ./src --json         # machine-readable, scoped to a subtree
codeisotope scan --only csv-parsing,password-hashing
codeisotope scan --include-suppressed # report even capabilities you already have a library for

codeisotope audit                     # grade every direct dependency
codeisotope audit --dev               # include devDependencies
codeisotope audit --fail-on replace   # exit 3 in CI if anything is deprecated/archived/abandoned

codeisotope vet "csv parser quoted fields" --seed papaparse --seed csv-parse
codeisotope vet --package lru-cache --package quick-lru
codeisotope detectors                 # list every detector and what it matches
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

  replace  request@^2.88.2  F 25/100
            deprecated by its maintainers: request has been deprecated, see .../issues/3142
            1 known advisory/advisories on the current version: GHSA-p8p7-x288-28g6
            no commits in 79 months -- effectively unmaintained
            find a replacement: codeisotope vet "Simplified HTTP client"

  replace  left-pad@^1.3.0  F 25/100
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

## How the health score works

Six weighted signals, 0–100:

| Signal | Weight | Measures |
|---|---|---|
| Maintenance | 25 | Commits on the **default branch** in the last 90 days, then true last-commit age |
| Adoption | 20 | Weekly npm downloads, falling back to stars |
| Release cadence | 15 | Releases in the last 12 months, attributed per-package in monorepos |
| Bus factor | 15 | Share of commits held by the top 3 contributors |
| Security | 15 | Published advisories on the current version, then OpenSSF Scorecard |
| License | 10 | Permissive / copyleft / missing |

Two rules keep the number honest:

- **Unknown signals are dropped from the average, not counted as failures.** A package with no OpenSSF Scorecard is not penalised for it — the gap is reported in `gaps` instead. Tools that score missing data as zero systematically punish smaller, perfectly good libraries.
- **Hard problems cap the score outright.** Deprecated caps at 25, archived at 30, a known advisory at 40 — so no amount of popularity can bury them. `async-retry` has 31 million downloads a week and still lands at D, because its last commit was three years ago.

`pushed_at` is deliberately *not* treated as a commit date. It counts pushes to any branch, so a Dependabot push to a side branch makes an abandoned repo look fresh. CodeIsotope reports the real default-branch commit history and says "last push to any branch" when that is all it has.

## Data sources

All free, all keyless, no account required:

| Source | Supplies |
|---|---|
| [npm registry](https://registry.npmjs.org) | Search, versions, licences, deprecation |
| [npm downloads API](https://api.npmjs.org) | Weekly download counts |
| [deps.dev](https://deps.dev) (Google Open Source Insights) | Advisories, deprecation, licences, canonical source repo |
| [GitHub REST API](https://docs.github.com/rest) | Commits, releases, contributors, archived status |
| [OpenSSF Scorecard](https://securityscorecards.dev) | Supply-chain security posture |

GitHub is the only rate-limited one: 60 requests/hour unauthenticated, 5,000 with a token. CodeIsotope picks up `GITHUB_TOKEN`, `GH_TOKEN`, or your local `gh auth login` automatically, and tells you in the report when it is running without one. Responses are cached on disk for 6 hours (`--no-cache` to bypass).

> **Note on Google Search:** the Google Custom Search JSON API is closed to new customers and shuts down on 1 January 2027, so it is not usable here. It also is not needed — GitHub and npm are the authoritative indexes for this problem, and the semantic half of the search is done by the LLM that is already running.

## Detectors

22 detectors, ordered so security and correctness findings surface first. Run `codeisotope detectors` for the full list with match rules.

**Security** — insecure random IDs, fast-hash password hashing, hand-rolled JWTs, ad-hoc input validation
**Correctness** — CSV via `split(',')`, `JSON.parse(JSON.stringify())` clones, naive semver comparison, regex slugifiers, manual date formatting, query-string building
**Resilience** — retry/backoff, rate limiting, concurrency pools, TTL/LRU caches
**Utilities** — deep equal, deep merge (prototype pollution), debounce/throttle, event emitters
**Platform** — argv parsing, `.env` parsing, console-wrapper logging, recursive directory walks

Each detector is anchored on a **required** signal that names the capability, so a bare `for` loop or `setTimeout` cannot trigger a finding on its own. A detector is also **suppressed entirely** when the project already depends on something that solves it — recommending `p-retry` to a project that already imports `p-retry` is noise, and the suppression is reported so you know it was considered.

Recommendations prefer platform built-ins over dependencies. If `structuredClone`, `URLSearchParams`, `crypto.randomUUID`, `util.parseArgs` or `fs.glob` covers the case, that is the answer — zero dependencies beats a good dependency.

## Development

Zero runtime dependencies, so `npx codeisotope` installs in under a second and carries no supply-chain surface.

```bash
npm install
npm run dev -- scan      # runs src/ directly via Node's native TypeScript support
npm test                 # 48 tests, all offline
npm run typecheck
npm run build
```

Requires Node 20.11+ **to run**; Node 22+ to develop, since the test suite is TypeScript executed directly by `node --test`. CI verifies both: the suite runs on 22 and 24, and the 20.11 floor is checked against the compiled `dist/`, which is what a consumer actually installs.

`src/lib/http.ts` hand-rolls retry with backoff and a concurrency gate — precisely what this tool tells you not to do. That trade is deliberate and documented in the file: the zero-dependency constraint applies to a tool distributed by `npx`, not to the projects it scans. CodeIsotope flags itself for it, which is the honest outcome.

## Status

v0.2.0. Scanning is JavaScript/TypeScript, and both auditing and vetting are npm-first; other ecosystems are detected and reported but must be vetted by explicit `--package`. The roadmap, in order: reference implementations to learn from, then missing infrastructure the project lacks.

MIT.
