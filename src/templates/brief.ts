/**
 * The prompt installed as /reporadar into whichever AI coding CLI the developer uses.
 *
 * Division of labour: the binary produces facts (what the code does, what the registry and
 * GitHub say about candidates), the host model produces judgement (is this really a
 * reinvention, and is replacing it worth the churn). The model must never invent a package --
 * every recommendation has to come back from `reporadar vet`.
 *
 * {{ARGS}} is replaced with each CLI's own argument placeholder at install time.
 */
export const BRIEF_DESCRIPTION =
  'Find mature, well-maintained libraries that already solve what this codebase hand-rolled';

export const BRIEF_BODY = `Find the battle-tested open-source libraries this codebase reinvented by hand, and report them with evidence.

Focus area (optional, may be empty): {{ARGS}}

## Step 1 -- fingerprint the codebase

Run:

\`\`\`
npx --yes reporadar scan --json
\`\`\`

If a focus area was given, pass it as the path: \`npx --yes reporadar scan <path> --json\`.

The output lists \`candidates\`: places where a well-known solved problem looks hand-implemented. Each carries a \`file\`, \`lines\`, \`excerpts\`, \`signalsHit\`, \`confidence\`, \`knownSolutions\` and often a \`note\`. Treat these as leads, not conclusions.

## Step 2 -- confirm each candidate yourself

The scanner matches patterns; you read code. For each candidate, open the file around the reported lines and decide:

- Is this genuinely a hand-rolled implementation of that capability, or an incidental pattern match?
- Is it load-bearing, or a throwaway in a test or script?
- Would a library actually replace it, or is the local version deliberately minimal and coupled to something specific?

Discard candidates that do not survive this. Say how many you discarded and why -- a short honest list beats a long padded one. Keep every candidate whose \`note\` starts with SECURITY or CORRECTNESS unless the code plainly disproves it; those are correctness and vulnerability claims, not style opinions.

## Step 3 -- gather evidence on replacements

For each surviving candidate, run:

\`\`\`
npx --yes reporadar vet "<capability>" --seed <knownSolution> --seed <knownSolution> --json
\`\`\`

This returns real data for each package -- weekly downloads, last commit, release cadence, contributor concentration, published advisories, licence, OpenSSF Scorecard -- plus a 0-100 health score and \`flags\`.

Hard rules:

- **Never recommend a package that did not come back from \`vet\`.** No exceptions, no recalling one from memory. If \`vet\` found nothing usable, say so.
- Never recommend anything flagged \`deprecated\`, \`archived\`, or \`known-vulnerability\`.
- If \`notes\` reports a platform built-in that covers the case (\`structuredClone\`, \`URLSearchParams\`, \`crypto.randomUUID\`, \`util.parseArgs\`, \`fs.glob\`), recommend that first. Zero dependencies beats a good dependency.
- Prefer the highest health score, but say plainly when a lower-scored option is the better fit and why.

## Step 4 -- report

One section per confirmed finding, ordered with security and correctness issues first:

- **What is hand-rolled** -- capability, file:line, and one line on what the local code does.
- **Why it matters** -- the concrete failure mode, not "best practice". Quote the scanner's note when it names one.
- **Recommended replacement** -- package and version, with the evidence that justifies it (downloads/week, last commit, release cadence, licence, score). Name the runner-up if it is close.
- **Migration cost** -- honest estimate: how many call sites, whether behaviour changes, whether it is worth doing at all.

Finish with a short list of anything you deliberately left alone, so the developer knows it was considered rather than missed.

## Do not change code in this pass

This is a read-and-report pass. Do not edit files or install packages. End by asking which findings, if any, to act on.`;
