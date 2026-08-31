import type { AuditReport, AuditedDep, DepVerdict, Fingerprint, GapReport, HealthVerdict, PackageEvidence, ReferenceReport, VetReport } from './types.ts';

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
  // The ecosystem tag matters in a polyglot report: `redis` on npm and `redis` on PyPI are
  // different packages, and without it the two entries are indistinguishable.
  const eco = dim(` [${dep.evidence.ecosystem}]`);
  out.push(`  ${VERDICT_LABEL[dep.verdict]}  ${bold(dep.name)}${dim(`@${dep.range}`)}${eco}${kind}  ${grade}`);
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
  // Name every ecosystem present, not just the first manifest's: a polyglot report that claims one
  // language is how the "all Go modules looked up on PyPI" bug hid in plain sight.
  const ecosystems = report.ecosystems?.length ? report.ecosystems.join(', ') : report.ecosystem;
  out.push(dim(`${t.audited} direct dependencies | ${report.ecosystems?.length > 1 ? 'ecosystems' : 'ecosystem'}: ${ecosystems}`));
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

const SEVERITY_LABEL: Record<string, string> = {
  high: red('high  '),
  medium: yellow('medium'),
  low: dim('low   '),
};

/** Wrap prose to a fixed width; the `why` text is a paragraph, not a label. */
function wrap(text: string, width: number, indent: string): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    if (current.length === 0) current = word;
    else if (`${current} ${word}`.length <= width) current += ` ${word}`;
    else {
      lines.push(indent + current);
      current = word;
    }
  }
  if (current) lines.push(indent + current);
  return lines;
}

export function renderGapReport(report: GapReport): string {
  const out: string[] = [];
  out.push(bold('CodeIsotope gaps'));
  out.push(dim(`${report.profile.scanned.files} files, ${report.profile.scanned.durationMs} ms`));
  out.push(dim(`project profile: ${report.profile.traits.join(', ') || 'could not be established'}`));
  out.push('');

  for (const note of report.notes) out.push(`  ${yellow('note')} ${note}`);
  if (report.notes.length > 0) out.push('');

  if (report.missing.length === 0) {
    out.push(green('No missing infrastructure found for this kind of project.'));
  } else {
    const high = report.missing.filter((m) => m.severity === 'high').length;
    out.push(bold(`${report.missing.length} missing capabilit${report.missing.length === 1 ? 'y' : 'ies'}${high > 0 ? ` (${high} to fix before shipping)` : ''}:`));
    out.push('');
    for (const gap of report.missing) {
      out.push(`  ${SEVERITY_LABEL[gap.severity] ?? gap.severity}  ${bold(gap.capability)}  ${dim(`[${gap.gapId}]`)}`);
      out.push(...wrap(gap.why, 92, '            '));
      out.push(dim(`            applies because: ${gap.becauseTraits.join(', ')}`));
      for (const c of gap.citations) {
        out.push(dim(`            ${cyan(`${c.file}:${c.line}`)}  ${c.text.slice(0, 78)}`));
      }
      out.push(dim(`            known solutions: ${gap.knownSolutions.join(', ')}`));
      out.push('');
    }
  }

  if (report.satisfied.length > 0) {
    out.push(dim(`Already handled: ${report.satisfied.map((s) => `${s.capability} (${s.by})`).join('; ')}`));
  }
  if (report.notApplicable.length > 0) {
    out.push(dim(`Not applicable to this project: ${report.notApplicable.map((n) => n.capability).join('; ')}`));
  }
  return out.join('\n');
}

function formatSize(bytes: number): string {
  if (bytes <= 0) return '';
  return bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} B`;
}

const VERIFY_MARK: Record<string, string> = {
  exists: green('exists         '),
  'not-found': red('INVENTED       '),
  'wrong-ecosystem': red('WRONG REGISTRY '),
  unsupported: dim('unsupported    '),
};

/**
 * Render a verification result.
 *
 * Phrased bluntly on purpose. "not-found" is rendered INVENTED because that is what it means when a
 * model suggested the name: the registry has no record of it, so it came from somewhere other than
 * reality. A softer word invites the reader to assume a typo.
 */
export function renderVerifyResults(
  results: ReadonlyArray<{ name: string; status: string; detail: string; version?: string }>,
  decided: { ecosystem: string; source: string; reason: string },
): string {
  const out: string[] = [];
  out.push(bold(`CodeIsotope verify: ${decided.ecosystem}`));
  if (decided.source !== 'explicit') out.push(dim(`  ${decided.reason}`));
  out.push('');
  for (const r of results) {
    out.push(`  ${VERIFY_MARK[r.status] ?? r.status}  ${bold(r.name)}${r.version ? dim(`@${r.version}`) : ''}`);
    if (r.status !== 'exists') out.push(`      ${r.detail}`);
  }
  out.push('');
  const bad = results.filter((r) => r.status !== 'exists').length;
  out.push(
    bad === 0
      ? green(`All ${results.length} name(s) exist on ${decided.ecosystem}.`)
      : red(`${bad} of ${results.length} name(s) could not be confirmed. Do not recommend those.`),
  );
  return out.join('\n');
}

export function renderReferenceReport(report: ReferenceReport): string {
  const out: string[] = [];
  out.push(bold(`CodeIsotope reference: ${report.query}`));
  out.push(dim(`${report.sources.length} source${report.sources.length === 1 ? '' : 's'}, pinned to a commit`));
  out.push('');

  for (const note of report.notes) out.push(`  ${yellow('note')} ${note}`);
  if (report.notes.length > 0) out.push('');

  if (report.sources.length === 0) {
    out.push(dim('  nothing to show'));
    return out.join('\n');
  }

  for (const source of report.sources) {
    const grade = GRADE_COLOR[source.health.grade](`${source.health.grade} ${source.health.score}/100`);
    const version = source.version ? dim(`@${source.version}`) : '';
    out.push(`  ${bold(source.package)}${version}  ${grade}  ${dim(source.license ?? 'no licence')}`);
    out.push(`     ${source.health.summary}`);
    out.push(dim(`     ${source.slug} @ ${source.commit.slice(0, 10)} (${source.defaultBranch})`));
    out.push('');

    for (const file of source.files) {
      const size = formatSize(file.size);
      out.push(`     ${cyan(file.path)}${size ? dim(`  ${size}`) : ''}`);
      out.push(dim(`       ${file.reasons.join('; ')}`));
      out.push(`       ${file.url}`);
    }
    if (source.note) out.push(`     ${yellow(source.note)}`);
    out.push('');
  }

  out.push(dim('Links are pinned to a commit, so they will not drift. Read the code before adopting a pattern from it.'));
  return out.join('\n');
}
