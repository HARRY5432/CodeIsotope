import type { HealthSignal, HealthVerdict, RepoEvidence, SignalVerdict } from '../lib/types.ts';
import { adoptionSignal, busFactorSignal, licenseSignal, maintenanceSignal, releaseSignal, securitySignal } from './signals.ts';

/** Credit earned per verdict. 'unknown' is excluded from the maths entirely. */
const VERDICT_VALUE: Record<Exclude<SignalVerdict, 'unknown'>, number> = { good: 1, ok: 0.7, weak: 0.35, bad: 0 };

export interface HealthInput {
  repo?: RepoEvidence;
  weeklyDownloads?: number;
  deprecated?: { is: boolean; reason?: string };
  advisories?: string[];
  license?: string | null;
  scorecardScore?: number;
}

function grade(score: number): HealthVerdict['grade'] {
  if (score >= 85) return 'A';
  if (score >= 70) return 'B';
  if (score >= 55) return 'C';
  if (score >= 40) return 'D';
  return 'F';
}

function buildSummary(score: number, flags: string[], input: HealthInput): string {
  if (input.deprecated?.is) {
    const why = input.deprecated.reason ? `: ${input.deprecated.reason}` : '';
    return `Deprecated by its maintainers${why} -- do not adopt.`;
  }
  if (flags.includes('known-vulnerability')) return 'Has a published advisory against its current version -- do not adopt without confirming a fixed release.';
  if (flags.includes('archived')) return 'Repository is archived, so it will receive no further fixes -- treat as end-of-life.';
  if (flags.includes('no-evidence')) return 'Not enough public evidence to judge -- verify manually before adopting.';
  if (score >= 85) return 'Actively maintained, widely adopted, safe to adopt.';
  if (score >= 70) return 'Solid choice; minor gaps worth a glance first.';
  if (score >= 55) return 'Usable but has real weaknesses -- read the signals before committing.';
  if (score >= 40) return 'Risky: adopt only if nothing better exists and you could vendor it if it stalls.';
  return 'Not recommended on current evidence.';
}

/**
 * Score a candidate 0-100 from the gathered evidence.
 *
 * Two rules keep the number honest. Unknown signals are dropped from the average instead of counted
 * as failures, so a package is never penalised for a data source that simply has no entry for it.
 * And hard problems -- deprecated, archived, known CVE -- cap the score outright, so no amount of
 * popularity can bury them.
 */
export function scoreHealth(input: HealthInput): HealthVerdict {
  const signals: HealthSignal[] = [
    maintenanceSignal(input.repo),
    releaseSignal(input.repo),
    adoptionSignal(input.weeklyDownloads, input.repo),
    busFactorSignal(input.repo),
    securitySignal(input.advisories, input.scorecardScore),
    licenseSignal(input.license),
  ];

  let earned = 0;
  let possible = 0;
  for (const s of signals) {
    if (s.verdict === 'unknown') continue;
    earned += s.weight * VERDICT_VALUE[s.verdict];
    possible += s.weight;
  }
  let score = possible === 0 ? 0 : Math.round((earned / possible) * 100);

  const flags: string[] = [];
  if (input.deprecated?.is) {
    flags.push('deprecated');
    score = Math.min(score, 25);
  }
  if (input.repo?.archived) {
    flags.push('archived');
    score = Math.min(score, 30);
  }
  if (input.advisories && input.advisories.length > 0) {
    flags.push('known-vulnerability');
    score = Math.min(score, 40);
  }
  if (input.repo?.contributors.total === 1) flags.push('single-maintainer');
  if (!input.license) flags.push('no-license');
  if (input.repo?.isFork) flags.push('is-a-fork');
  if (possible === 0) flags.push('no-evidence');

  return { score, grade: grade(score), signals, flags, summary: buildSummary(score, flags, input) };
}
