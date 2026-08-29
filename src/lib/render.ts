import type { AuditReport, AuditedDep, DepVerdict, Fingerprint, HealthVerdict, PackageEvidence, VetReport } from './types.ts';

const useColor = process.stdout.isTTY === true && !process.env.NO_COLOR;
const c = (code: string) => (s: string) => (useColor ? `\u001b[${code}m${s}\u001b[0m` : s);

export const bold = c('1');
export const dim = c('2');
export const red = c('31');
export const green = c('32');
export const yellow = c('33');
export const cyan = c('36');

const GRADE_COLOR: Record<HealthVerdict['grade'], (s: string) => string> = {
  A: green, B: green, C: yellow, D: red, F: red,
};

const VERDICT_MARK: Record<string, string> = {
  good: green('+'), ok: green('~'), weak: yellow('!'), bad: red('x'), unknown: dim('?'),
};

const CONFIDENCE_MARK: Record<string, string> = {
  high: red('high  '), medium: yellow('medium'), low: dim('low   '),
};

export function renderFingerprint(fp: Fingerprint): string {
  const out: string[] = [];
  const langs = fp.languages.slice(0, 4).map((l) => `${l.name} ${l.share}%`).join(', ') || 'none detected';
  out.push(bold('CodeIsotope scan'));
  out.push(dim(`${fp.scanned.files} files, ${(fp.scanned.bytes / 1024).toFixed(0)} KB, ${fp.scanned.durationMs} ms`));
  out.push(dim(`languages: ${langs}`));
  out.push(dim(`manifests: ${fp.manifests.map((m) => m.file).join(', ') || 'none'} | direct deps: ${fp.deps.direct.length}`));
  out.push('');

  if (fp.candidates.length === 0) {
    out.push(green('No hand-rolled reinventions detected.'));
    if (fp.suppressed.length > 0) {
      out.push(dim(`${fp.suppressed.length} capability check(s) skipped because a real library is already in use.`));
    }
    return out.join('\n');
  }

  out.push(bold(`${fp.candidates.length} possible reinvention${fp.candidates.length === 1 ? '' : 's'}:`));
  out.push('');
  for (const cand of fp.candidates) {
    out.push(`  ${CONFIDENCE_MARK[cand.confidence] ?? cand.confidence}  ${bold(cand.capability)}`);
    out.push(`          ${cyan(cand.file)}:${cand.lines[0] ?? '?'}  ${dim(`[${cand.detectorId}] signals: ${cand.signalsHit.join(', ')}`)}`);
    for (const line of cand.excerpts) out.push(dim(`            ${line}`));
    if (cand.note) out.push(`          ${cand.note.startsWith('SECURITY') || cand.note.startsWith('CORRECTNESS') ? yellow(cand.note) : dim(cand.note)}`);
    out.push(dim(`          known solutions: ${cand.knownSolutions.join(', ')}`));
    out.push('');
  }

  if (fp.suppressed.length > 0) {
    out.push(dim(`Skipped (already solved in this project): ${fp.suppressed.map((s) => `${s.capability} (${s.reason})`).join('; ')}`));
  }
  return out.join('\n');
}

function renderCandidate(pkg: PackageEvidence, index: number): string[] {
  const out: string[] = [];
  const grade = GRADE_COLOR[pkg.health.grade](`${pkg.health.grade} ${pkg.health.score}/100`);
  out.push(`  ${index + 1}. ${bold(pkg.name)}${pkg.version ? dim(`@${pkg.version}`) : ''}  ${grade}`);
  if (pkg.description) out.push(`     ${pkg.description.slice(0, 110)}`);
  out.push(`     ${pkg.health.summary}`);
  if (pkg.health.flags.length > 0) out.push(`     ${red(`flags: ${pkg.health.flags.join(', ')}`)}`);
  for (const s of pkg.health.signals) {
    out.push(`       ${VERDICT_MARK[s.verdict] ?? '?'} ${s.label.padEnd(15)} ${dim(s.detail)}`);
  }
  if (pkg.repo) out.push(dim(`       repo: ${pkg.repo.url}`));
  if (pkg.gaps.length > 0) out.push(dim(`       unknowns: ${pkg.gaps.join('; ')}`));
  out.push('');
  return out;
}

export function renderVetReport(report: VetReport): string {
  const out: string[] = [];
  out.push(bold(`CodeIsotope vet: ${report.query}`));
  out.push(dim(`ecosystem: ${report.ecosystem} | candidates: ${report.candidates.length}`));
  out.push('');
  for (const note of report.notes) out.push(`  ${yellow('note')} ${note}`);
  if (report.notes.length > 0) out.push('');
  report.candidates.forEach((pkg, i) => out.push(...renderCandidate(pkg, i)));
  if (report.candidates.length === 0) out.push(dim('  nothing to show'));
  return out.join('\n');
}

const VERDICT_LABEL: Record<DepVerdict, string> = {
  replace: red('replace'),
  weak: red('weak   '),
  aging: yellow('aging  '),
  healthy: green('healthy'),
};

function renderDep(dep: AuditedDep): string[] {
  const out: string[] = [];
  const kind = dep.kind === 'dev' ? dim(' (dev)') : '';
  const grade = GRADE_COLOR[dep.evidence.health.grade](`${dep.evidence.health.grade} ${dep.evidence.health.score}/100`);
  out.push(`  ${VERDICT_LABEL[dep.verdict]}  ${bold(dep.name)}${dim(`@${dep.range}`)}${kind}  ${grade}`);
  for (const reason of dep.reasons) out.push(`            ${reason}`);
  if (dep.evidence.repo) out.push(dim(`            repo: ${dep.evidence.repo.url}`));
  if (dep.maintainerSuggestion) {
    const s = dep.maintainerSuggestion;
    out.push(`            ${cyan(s.builtIn ? `maintainer says use ${s.name} -- drop the dependency` : `maintainer says use: ${s.name}`)}`);
  }
  if (dep.searchTerms && dep.searchTerms.length > 0) {
    out.push(dim(`            find a replacement: codeisotope vet "${dep.searchTerms[0]}"`));
  }
  out.push('');
  return out;
}

export function renderAuditReport(report: AuditReport): string {
  const out: string[] = [];
  const t = report.totals;
  out.push(bold('CodeIsotope audit'));
  out.push(dim(`${t.audited} direct dependencies | ecosystem: ${report.ecosystem}`));
  const summary = [
    t.replace > 0 ? red(`${t.replace} replace`) : '',
    t.weak > 0 ? red(`${t.weak} weak`) : '',
    t.aging > 0 ? yellow(`${t.aging} aging`) : '',
    green(`${t.healthy} healthy`),
  ].filter(Boolean);
  out.push(summary.join(dim(' | ')));
  out.push('');

  for (const note of report.notes) out.push(`  ${yellow('note')} ${note}`);
  if (report.notes.length > 0) out.push('');

  const flagged = report.deps.filter((d) => d.verdict !== 'healthy');
  if (flagged.length === 0 && t.audited > 0) {
    out.push(green('Every direct dependency is actively maintained with no known problems.'));
  }
  for (const dep of flagged) out.push(...renderDep(dep));

  const healthy = report.deps.filter((d) => d.verdict === 'healthy');
  if (healthy.length > 0 && flagged.length > 0) {
    out.push(dim(`Healthy: ${healthy.map((d) => d.name).join(', ')}`));
  }
  if (report.unresolved.length > 0) {
    out.push('');
    out.push(dim(`Could not verify: ${report.unresolved.map((u) => `${u.name} (${u.reason})`).join('; ')}`));
  }
  return out.join('\n');
}
