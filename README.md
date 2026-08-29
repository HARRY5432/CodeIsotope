# RepoRadar

**Find the battle-tested open-source libraries your AI-written codebase reinvented by hand.**

AI coding assistants write code. They rarely go looking for the mature, widely-adopted repository that already solved the problem — so codebases built with AI quietly accumulate hand-rolled retry loops, `JSON.parse(JSON.stringify())` clones, `Math.random()` session tokens, and `split(',')` CSV parsers. Each one works in the happy path and fails in production.

RepoRadar closes that gap. It installs into your project as a `/reporadar` slash command for whichever AI coding CLI you already use, scans the codebase for capabilities that look hand-implemented, then gathers hard evidence on the libraries that already solve them — maintenance, adoption, bus factor, published advisories, licence — so the recommendation is a fact, not a guess.

```
npx reporadar init      # install the slash command into this project
/reporadar              # run it from Claude Code, opencode, Cursor, Gemini CLI, Windsurf or Copilot
```

## Why it works this way

RepoRadar is two halves with a hard line between them:

| | Does | Never does |
|---|---|---|
| **The binary** (`reporadar`) | Fingerprints the code, queries npm / GitHub / deps.dev / OpenSSF, scores health | Judge whether a finding is real |
| **The host model** (your AI CLI) | Reads the flagged code, confirms or discards each lead, writes the report | Invent a package from memory |

That split is the whole design. The model supplies judgement — it can tell a real retry loop from an incidental `for` loop with a `setTimeout` in it. The binary supplies facts that cannot be hallucinated — every recommended package is verified to exist, with real download counts and a real last-commit date. The slash command tells the model, in as many words, never to recommend anything that did not come back from `reporadar vet`.

It also means **no API keys and no per-scan cost.** The intelligence is the LLM you are already paying for; every data source RepoRadar queries is free and unauthenticated.

## Install

```bash
npx reporadar init            # detects the AI CLIs configured in this project
npx reporadar init --all      # install for every supported CLI
npx reporadar init --dry-run  # show what would be written
```

Supported targets, each in its own native format:

| CLI | File |
|---|---|
| Claude Code | `.claude/commands/reporadar.md` |
| opencode | `.opencode/commands/reporadar.md` |
| Cursor | `.cursor/commands/reporadar.md` |
| Gemini CLI | `.gemini/commands/reporadar.toml` |
| Windsurf | `.windsurf/workflows/reporadar.md` |
| GitHub Copilot | `.github/prompts/reporadar.prompt.md` |

With no CLI detected it installs for Claude Code and opencode and tells you it did. A command file you wrote yourself is never overwritten without `--force`.

## Use it directly

The binary is useful on its own, and `--json` is what the slash command consumes.

```bash
reporadar scan                      # fingerprint the current directory
reporadar scan ./src --json         # machine-readable, scoped to a subtree
reporadar scan --only csv-parsing,password-hashing
reporadar scan --include-suppressed # report even capabilities you already have a library for

reporadar vet "csv parser quoted fields" --seed papaparse --seed csv-parse
reporadar vet --package lru-cache --package quick-lru
reporadar detectors                 # list every detector and what it matches
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

`pushed_at` is deliberately *not* treated as a commit date. It counts pushes to any branch, so a Dependabot push to a side branch makes an abandoned repo look fresh. RepoRadar reports the real default-branch commit history and says "last push to any branch" when that is all it has.

## Data sources

All free, all keyless, no account required:

| Source | Supplies |
|---|---|
| [npm registry](https://registry.npmjs.org) | Search, versions, licences, deprecation |
| [npm downloads API](https://api.npmjs.org) | Weekly download counts |
| [deps.dev](https://deps.dev) (Google Open Source Insights) | Advisories, deprecation, licences, canonical source repo |
| [GitHub REST API](https://docs.github.com/rest) | Commits, releases, contributors, archived status |
| [OpenSSF Scorecard](https://securityscorecards.dev) | Supply-chain security posture |

GitHub is the only rate-limited one: 60 requests/hour unauthenticated, 5,000 with a token. RepoRadar picks up `GITHUB_TOKEN`, `GH_TOKEN`, or your local `gh auth login` automatically, and tells you in the report when it is running without one. Responses are cached on disk for 6 hours (`--no-cache` to bypass).

> **Note on Google Search:** the Google Custom Search JSON API is closed to new customers and shuts down on 1 January 2027, so it is not usable here. It also is not needed — GitHub and npm are the authoritative indexes for this problem, and the semantic half of the search is done by the LLM that is already running.

## Detectors

22 detectors, ordered so security and correctness findings surface first. Run `reporadar detectors` for the full list with match rules.

**Security** — insecure random IDs, fast-hash password hashing, hand-rolled JWTs, ad-hoc input validation
**Correctness** — CSV via `split(',')`, `JSON.parse(JSON.stringify())` clones, naive semver comparison, regex slugifiers, manual date formatting, query-string building
**Resilience** — retry/backoff, rate limiting, concurrency pools, TTL/LRU caches
**Utilities** — deep equal, deep merge (prototype pollution), debounce/throttle, event emitters
**Platform** — argv parsing, `.env` parsing, console-wrapper logging, recursive directory walks

Each detector is anchored on a **required** signal that names the capability, so a bare `for` loop or `setTimeout` cannot trigger a finding on its own. A detector is also **suppressed entirely** when the project already depends on something that solves it — recommending `p-retry` to a project that already imports `p-retry` is noise, and the suppression is reported so you know it was considered.

Recommendations prefer platform built-ins over dependencies. If `structuredClone`, `URLSearchParams`, `crypto.randomUUID`, `util.parseArgs` or `fs.glob` covers the case, that is the answer — zero dependencies beats a good dependency.

## Development

Zero runtime dependencies, so `npx reporadar` installs in under a second and carries no supply-chain surface.

```bash
npm install
npm run dev -- scan      # runs src/ directly via Node's native TypeScript support
npm test                 # 32 tests, all offline
npm run typecheck
npm run build
```

Requires Node 20.11+. `src/lib/http.ts` hand-rolls retry with backoff and a concurrency gate — precisely what this tool tells you not to do. That trade is deliberate and documented in the file: the zero-dependency constraint applies to a tool distributed by `npx`, not to the projects it scans. RepoRadar flags itself for it, which is the honest outcome.

## Status

v0.1.0. Scanning is JavaScript/TypeScript, and vetting is npm-first; other ecosystems are detected and reported but must be vetted by explicit `--package`. The roadmap, in order: flagging weak dependencies you already have, then reference implementations to learn from, then missing infrastructure.

MIT.
