import type { AuditReport, AuditedDep, DepKind, DepVerdict, Ecosystem, Manifest } from '../lib/types.ts';
import { TOOL_NAME, TOOL_VERSION } from '../lib/version.ts';
import { primaryEcosystem, readManifests } from '../scan/manifests.ts';
import { gatherEvidence } from '../vet/evidence.ts';
import { isAuthenticated } from '../vet/github.ts';
import { classifyDep, compareDeps, maintainerSuggestion, replacementSearchTerms } from './verdict.ts';

/**
 * Audit the dependencies the project already has.
 *
 * Scope is direct dependencies only, and that is a decision rather than a limitation. Transitive
 * advisories are what `npm audit` already does well, and duplicating it would add noise. The gap
 * nobody covers is the dependency *you chose* that has quietly been abandoned for three years --
 * no advisory will ever be filed against it, so no audit tool will ever mention it.
 *
 * The binary states the problem and supplies search terms; it does not pick the replacement.
 * Choosing a functional equivalent needs to know what the code actually uses the dependency for,
 * which is the host model's job -- see `replacementSearchTerms`.
 */

export interface AuditOptions {
  /** Include devDependencies as well as runtime dependencies. */
  includeDev?: boolean;
  /** Restrict the audit to these package names. */
  only?: string[];
  /** Cap how many dependencies to audit. */
  limit?: number;
}

interface DeclaredDep {
  name: string;
  kind: DepKind;
  range: string;
  manifest: string;
}

/** Flatten every manifest into one list, preferring the runtime declaration when a dep is in both. */
export function declaredDeps(manifests: Manifest[]): DeclaredDep[] {
  const byName = new Map<string, DeclaredDep>();
  for (const manifest of manifests) {
    for (const [name, range] of Object.entries(manifest.dependencies)) {
      byName.set(name, { name, kind: 'direct', range, manifest: manifest.file });
    }
  }
  for (const manifest of manifests) {
    for (const [name, range] of Object.entries(manifest.devDependencies)) {
      if (byName.has(name)) continue;
      byName.set(name, { name, kind: 'dev', range, manifest: manifest.file });
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function auditDependencies(root: string, opts: AuditOptions = {}): Promise<AuditReport> {
  const { includeDev = false, only, limit = 60 } = opts;

  const notes: string[] = [];
  const manifests = await readManifests(root);
  const ecosystem = primaryEcosystem(manifests);

  let declared = declaredDeps(manifests);
  if (!includeDev) declared = declared.filter((d) => d.kind === 'direct');
  if (only && only.length > 0) {
    const wanted = new Set(only.map((n) => n.toLowerCase()));
    declared = declared.filter((d) => wanted.has(d.name.toLowerCase()));
  }

  if (manifests.length === 0) notes.push('No dependency manifest found at the scan root.');
  if (ecosystem !== 'npm' && declared.length > 0) {
    notes.push(`Evidence gathering is npm-only in this version, so ${ecosystem} dependencies are reported as unresolved.`);
  }
  if (declared.length > limit) {
    notes.push(`Auditing the first ${limit} of ${declared.length} dependencies; raise --limit to cover the rest.`);
    declared = declared.slice(0, limit);
  }

  const unresolved: AuditReport['unresolved'] = [];
  const deps: AuditedDep[] = [];

  if (declared.length > 0 && ecosystem === 'npm') {
    const evidence = await gatherEvidence(declared.map((d) => d.name), ecosystem, 4);

    declared.forEach((dep, i) => {
      const found = evidence[i];
      if (!found || found.health.flags.includes('no-evidence')) {
        unresolved.push({
          name: dep.name,
          kind: dep.kind,
          reason: found ? found.gaps.join('; ') || 'no public evidence available' : 'package not found on the registry',
        });
        return;
      }
      const { verdict, reasons } = classifyDep(found, dep.kind);
      const audited: AuditedDep = {
        name: dep.name,
        kind: dep.kind,
        range: dep.range,
        manifest: dep.manifest,
        verdict,
        reasons,
        evidence: found,
      };
      const suggestion = maintainerSuggestion(found.deprecated?.reason);
      if (suggestion) audited.maintainerSuggestion = suggestion;
      if (verdict === 'replace' || verdict === 'weak') audited.searchTerms = replacementSearchTerms(found);
      deps.push(audited);
    });
  } else {
    for (const dep of declared) {
      unresolved.push({ name: dep.name, kind: dep.kind, reason: `${ecosystem} packages cannot be vetted in this version` });
    }
  }

  deps.sort(compareDeps);

  const totals = {
    audited: deps.length,
    healthy: deps.filter((d) => d.verdict === 'healthy').length,
    aging: deps.filter((d) => d.verdict === 'aging').length,
    weak: deps.filter((d) => d.verdict === 'weak').length,
    replace: deps.filter((d) => d.verdict === 'replace').length,
  };

  if (deps.length > 0 && !(await isAuthenticated())) {
    notes.push('Running unauthenticated against the GitHub API (60 requests/hour), which limits how many dependencies can be checked in one run. Set GITHUB_TOKEN or run `gh auth login` for 5,000/hour.');
  }

  return {
    tool: { name: TOOL_NAME, version: TOOL_VERSION },
    root,
    ecosystem,
    generatedAt: new Date().toISOString(),
    totals,
    deps,
    unresolved,
    notes,
  };
}

/** Worst verdict present, for `--fail-on`. Returns undefined when nothing was audited. */
export function worstVerdict(report: AuditReport): DepVerdict | undefined {
  const order: DepVerdict[] = ['replace', 'weak', 'aging', 'healthy'];
  return order.find((v) => report.deps.some((d) => d.verdict === v));
}
