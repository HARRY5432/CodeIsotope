# How the health score is calibrated

This document exists because "the weights are arbitrary" is a fair criticism, and the honest answer
is that they were chosen by judgement rather than derived from data. What follows is that judgement
written down so it can be argued with, and the plan for replacing it with measurement.

If you disagree with a number here, that is the point. Open an issue with a package the score gets
wrong and the reasoning will move.

## The six signals and their weights

| Signal | Weight | Why that much |
|---|---|---|
| Maintenance | 25 | The single strongest predictor of future pain. Every other problem is recoverable if someone is still working on the project; nothing is if they are not. |
| Adoption | 20 | Not a quality measure — a proxy for how many people have already hit the bugs, how many answers exist, and how cheap a migration will be. |
| Release cadence | 15 | Distinct from maintenance: commits show activity, releases show that activity reaching consumers. A project with 200 commits and no release in two years is not shipping fixes. |
| Bus factor | 15 | Predicts what happens when the current maintainer stops. Weighted below maintenance because it is a *conditional* risk rather than a present one. |
| Security | 15 | A published advisory is decisive, but it is handled by a cap (below) rather than by weight, so the weight mostly carries Scorecard posture. |
| License | 10 | Lowest weight because it is binary and cheap to check rather than a matter of degree — but non-zero, because a missing licence makes the package legally unusable regardless of quality. |

**These are opinions.** Maintenance at 25 rather than 30 is not derived from incident data. Nobody has
measured whether release cadence predicts outages better than bus factor. See *Replacing judgement
with measurement* below.

## Two rules that matter more than the weights

### Unknown signals are dropped, not scored zero

A package with no OpenSSF Scorecard has not failed a security check — it has an unpublished one.
Scoring absence as zero systematically punishes smaller, well-run libraries that never adopted a
particular metric, and flatters large projects for merely participating in reporting.

So the average is taken over the signals that *have* an answer. A package with four known signals is
scored out of those four.

The corollary: **a missing signal is never also reported as a shortcoming.** An earlier version listed
"no OpenSSF Scorecard published" in the `gaps` field while also excluding it from the average, which
counted the same absence twice — once neutrally in the maths and once as a criticism in prose.

### Hard problems cap the total

Some facts are not tradeable against popularity:

| Problem | Cap | Reasoning |
|---|---|---|
| Deprecated by its maintainers | 25 | The author has said stop. No amount of adoption overrides that. |
| Repository archived | 30 | Read-only means no fix will ever arrive, including a security fix. |
| Published advisory on the current version | 40 | A known exploit path, today. |

`async-retry` has ~31 million downloads a week and lands at **D**, because its last commit was five
years ago. Without caps, adoption weight alone would have carried it to a B.

**Known tension:** `request` is deprecated *and* carries an advisory, so it caps at 25. `async-retry` is
merely abandoned and scores ~46. Is a deprecated-with-advisory package worse than a silently dead
one? Usually yes, because the deprecation notice tells you what to do instead. But the scores do not
explain that reasoning, and two packages capping at the same number for different reasons is a real
weakness in how this is presented.

## Adoption thresholds are per-ecosystem, and why

Download counts are **not comparable across registries.** `requests` records roughly 297 million PyPI
downloads a week; a thriving npm package sits nearer 1 million. The difference is not popularity, it
is that PyPI counts every CI mirror pull and npm does not.

| Ecosystem | "de facto standard" | Note |
|---|---|---|
| npm | 1,000,000/wk | True weekly installs. |
| PyPI | 20,000,000/wk | ~20x higher, because mirrors and CI inflate the count. |
| crates.io | 2,000,000/wk | Published as a rolling 90-day figure, normalised to a nominal week. |
| Go | — | The module proxy publishes no download data at all. |

A single global threshold would either flatter every Python package to "de facto standard" or condemn
every healthy Rust crate. The 20x multiplier for PyPI is an estimate from comparing well-known
equivalents, not a measured ratio.

**Dependent counts are preferred wherever available**, and those *are* portable: "how many published
packages depend on this" means the same thing on every registry, because it measures what an
ecosystem chose to build on rather than how often a tarball was fetched.

## Known false positives, and what was done about them

Two have been found and fixed. Both are recorded because the pattern matters more than the instances.

### Bus factor on a small team

`tenacity` has two active maintainers and is perfectly healthy, but "top 3 contributors are 83% of
commits" scored it `weak`. With three contributors the top three are *by definition* 100% of commits —
the metric was measuring sample size, not risk.

Now: with four or fewer contributors the top-3 share is reported as not meaningful, and the honest
signal is the contributor count itself. One person is a genuine risk; two or three is a small team.

### Grading a prerelease

deps.dev reports `isDefault: true` for httpx's `1.0.0.dev5`, which has 34 dependents against 38,576
for the stable `0.28.1` that people actually install. Grading the prerelease scored one of Python's
most-depended-on HTTP clients at **F 33/100** with "modest adoption".

Now: the newest stable release is preferred, in both PEP 440 and SemVer conventions, falling back to
`isDefault` only when every version is a prerelease.

## Gap severity

`high` / `medium` / `low` is likewise judgement, applied on one test: **does this fire on every deploy,
or only under an unusual condition?**

- `high` — the failure is routine. No graceful shutdown severs in-flight requests on *every* deploy.
  No lockfile means CI can receive untested code on *any* install.
- `medium` — the failure needs a trigger. No health check only matters once an instance is unhealthy.
- `low` — currently unused. Retained so the scale has somewhere to put "worth knowing, not worth
  scheduling".

No incident data backs the boundary between high and medium. `codeisotope gap-list` prints each gap's
severity alongside the traits that gate it, so the reasoning is at least inspectable.

## Replacing judgement with measurement

The honest position is that this is a defensible heuristic, not a calibrated model. Turning it into
one requires data the project does not have yet:

1. **Which signal actually predicted trouble.** For a corpus of packages that caused a real incident —
   an outage, a CVE, an urgent migration — which signal was already `weak` or `bad` beforehand? That
   is a retrospective study, and it is what would justify moving maintenance from 25 to 30 or
   collapsing release cadence into it.
2. **False-positive rate by signal.** Every case like `tenacity` above is a data point. Collected
   systematically, they show which signals misfire and on what kind of project.
3. **Threshold ratios per ecosystem, measured.** The PyPI 20x figure should come from comparing the
   download-to-dependent ratio across a few hundred packages, not from inspection of a handful.

Until that exists, the weights are stated here rather than hidden in the source, and every score
ships with the six signals that produced it so a reader can disagree with the total while still using
the parts.
