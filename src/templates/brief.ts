/**
 * The prompt installed as /codeisotope into whichever AI coding CLI the developer uses.
 *
 * Division of labour: the binary produces facts (what the code does, what the registry and
 * GitHub say about candidates), the host model produces judgement (is this really a
 * reinvention, and is replacing it worth the churn). The model must never invent a package --
 * every recommendation has to come back from `codeisotope vet`.
 *
 * {{ARGS}} is replaced with each CLI's own argument placeholder at install time.
 */
export const BRIEF_DESCRIPTION =
  'Find mature libraries this codebase reinvented by hand, grade the dependencies it already has, and report infrastructure it is missing';

export const BRIEF_BODY = `Find the battle-tested open-source libraries this codebase reinvented by hand, grade the dependencies it already relies on, report the infrastructure it has no answer for, and back all three with evidence.

Focus area (optional, may be empty): {{ARGS}}

## Step 1 -- fingerprint the codebase

Run:

\`\`\`
npx --yes codeisotope scan --json
\`\`\`

If a focus area was given, pass it as the path: \`npx --yes codeisotope scan <path> --json\`.

The output lists \`candidates\`: places where a well-known solved problem looks hand-implemented. Each carries a \`file\`, \`lines\`, \`excerpts\`, \`signalsHit\`, \`confidence\`, \`knownSolutions\` and often a \`note\`. Treat these as leads, not conclusions.

## Step 2 -- confirm each candidate yourself

The scanner matches patterns; you read code. For each candidate, open the file around the reported lines and decide:

- Is this genuinely a hand-rolled implementation of that capability, or an incidental pattern match?
- Is it load-bearing, or a throwaway in a test or script?
- Would a library actually replace it, or is the local version deliberately minimal and coupled to something specific?

Discard candidates that do not survive this. Say how many you discarded and why -- a short honest list beats a long padded one. Keep every candidate whose \`note\` starts with SECURITY or CORRECTNESS unless the code plainly disproves it; those are correctness and vulnerability claims, not style opinions.

## Step 3 -- audit the dependencies already installed

Run:

\`\`\`
npx --yes codeisotope audit --json
\`\`\`

This grades every direct dependency and returns a \`verdict\` per package:

- \`replace\` -- deprecated, archived, carrying a published advisory, or unmaintained for years.
- \`weak\` -- maintenance has stopped, or there is no licence, or no source repo to verify.
- \`aging\` -- slowing down; worth watching, not worth acting on today.
- \`healthy\` -- no action needed.

\`reasons\` says exactly why. Where the maintainer named a successor in the deprecation message it comes back as \`maintainerSuggestion\`; when \`builtIn\` is true the answer is to delete the dependency and use the platform feature, not to swap in another package.

**The audit deliberately does not choose replacements.** That part is yours: read the code that actually imports the dependency, work out which of its features are in use, then vet a replacement that covers them. \`searchTerms\` is a starting point, not an answer.

## Step 4 -- find what the project has no answer for

Run:

\`\`\`
npx --yes codeisotope gaps --json
\`\`\`

Steps 1-3 look at code that exists. This looks for code that does not: graceful shutdown, request validation, outbound timeouts, rate limiting on auth routes, structured logging, a health check, env validation, a lockfile.

\`profile.traits\` is what the binary established about the project by looking -- \`http-server\`, \`cli\`, \`database\`, \`auth\` and so on. **A gap is only ever reported when a trait makes it relevant**, so a CLI is never told it needs security headers. Each entry in \`missing\` carries:

- \`why\` -- the concrete failure it prevents. Quote this; it is written to be quoted.
- \`becauseTraits\` -- why the binary thinks this applies to your project.
- \`citations\` -- the file and line that justified raising it.
- \`severity\` -- \`high\` means fix before shipping.

Two things to check before you report a gap:

- **Verify the citation.** Open the cited line. The binary excludes comments and string literals from evidence, but you can see context it cannot.
- **A gap the project deliberately does not need is not a finding.** A worker with no HTTP surface does not need a health route even if a Dockerfile made it look containerised. Say so and move on.

\`satisfied\` lists gaps already handled and what handles them -- useful for confirming the project is in better shape than it looks. Ignore \`notApplicable\`.

## Step 5 -- gather evidence on replacements

For each surviving scan candidate, each \`replace\`/\`weak\` dependency worth acting on, and each gap where a library is the right answer:

\`\`\`
npx --yes codeisotope vet "<capability>" --seed <knownSolution> --seed <knownSolution> --json
\`\`\`

This returns real data for each package -- weekly downloads, last commit, release cadence, contributor concentration, published advisories, licence, OpenSSF Scorecard -- plus a 0-100 health score and \`flags\`.

Hard rules:

- **Never recommend a package that did not come back from \`vet\`.** No exceptions, no recalling one from memory. If \`vet\` found nothing usable, say so.
- Never recommend anything flagged \`deprecated\`, \`archived\`, or \`known-vulnerability\`.
- A \`@types/*\` package and a fork of the same abandoned codebase are not replacements. If the only candidates \`vet\` returns are those, report that no replacement was found.
- If \`notes\` reports a platform built-in that covers the case (\`structuredClone\`, \`URLSearchParams\`, \`crypto.randomUUID\`, \`util.parseArgs\`, \`fs.glob\`), recommend that first. Zero dependencies beats a good dependency.
- Several gaps are best closed with no dependency at all -- \`process.on("SIGTERM")\`, \`AbortSignal.timeout()\`, a route returning 200. Prefer those.
- Prefer the highest health score, but say plainly when a lower-scored option is the better fit and why.

## Step 6 -- when a pattern needs explaining, cite real code

Sometimes the answer is not "install this" but "your version is missing something". When you need to show how a mature library handles a case the local code gets wrong:

\`\`\`
npx --yes codeisotope reference "<capability>" --package <vetted package> --json
\`\`\`

This returns permalinks into the library's real source, pinned to a commit SHA. Two rules:

- **Quote only from a URL this returned.** You will be able to produce a convincing snippet of \`p-retry\`'s jitter handling from memory, and it will be subtly wrong. Fetch the file or cite the link; never reconstruct it.
- Sources are health-gated, so anything returned is worth imitating. If \`sources\` is empty, the notes say which candidates were rejected and why -- report that rather than falling back on memory.

\`files[].reasons\` explains why each path was picked. The binary ranks paths only; whether the file actually contains the pattern is yours to check.

## Step 7 -- report

Three sections. Lead with whichever holds the most serious problem: a dependency with a live advisory or a service that loses data on every deploy outranks a hand-rolled CSV parser.

**Hand-rolled code that a library already solves.** One entry per confirmed finding, security and correctness first:

- **What is hand-rolled** -- capability, file:line, and one line on what the local code does.
- **Why it matters** -- the concrete failure mode, not "best practice". Quote the scanner's note when it names one.
- **Recommended replacement** -- package and version, with the evidence that justifies it (downloads/week, last commit, release cadence, licence, score). Name the runner-up if it is close.
- **Migration cost** -- honest estimate: how many call sites, whether behaviour changes, whether it is worth doing at all.

**Dependencies that need attention.** One entry per \`replace\`/\`weak\` package:

- **The dependency and the problem** -- name, and the reason quoted from the audit.
- **Where it is used** -- the files that import it, and which of its features they use.
- **What to move to** -- a vetted replacement with its evidence, or the platform built-in, or an honest "nothing better exists; consider vendoring or forking".
- **Migration cost** -- as above.

**Infrastructure that is missing.** One entry per confirmed gap, \`high\` severity first:

- **What is missing, and what breaks without it** -- quote \`why\`.
- **Why it applies here** -- the trait and the cited line, so the developer can check the claim.
- **The smallest fix that closes it** -- the built-in where one exists, otherwise a vetted package.

Where you used \`reference\`, link the permalink next to the claim it supports. Mention \`aging\` dependencies in one line as a watch list. Finish with a short list of anything you deliberately left alone, so the developer knows it was considered rather than missed.

## Do not change code in this pass

This is a read-and-report pass. Do not edit files or install packages. End by asking which findings, if any, to act on.`;
