import type { AuditReport, AuditedDep, DepKind, DepVerdict, Ecosystem, Manifest } from '../lib/types.ts';
import { TOOL_NAME, TOOL_VERSION } from '../lib/version.ts';
import { primaryEcosystem, readManifests } from '../scan/manifests.ts';
import { gatherEvidence } from '../vet/evidence.ts';
import { isAuthenticated } from '../vet/github.ts';
import { registryFor, supportedEcosystems } from '../vet/registries.ts';
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
  /**
   * The ecosystem of the manifest this came from, not the project's "primary" one.
   *
   * Carrying it per-dependency is the whole point. An earlier version picked one ecosystem for the
   * entire project and graded everything against that single registry, so a repo with both a
   * `pyproject.toml` and a `go.mod` looked up `github.com/gin-gonic/gin` on PyPI, found nothing,
   * and reported a healthy Go module as `F 0/100` with "no licence detected -- legally unsafe to
   * ship". Polyglot repositories are the normal case, not an edge case.
   */
  ecosystem: Ecosystem;
}

/**
 * Flatten every manifest into one list.
 *
 * Keyed by ecosystem *and* name: `redis` exists on both npm and PyPI as unrelated packages, so a
 * name alone would let one silently shadow the other. Within one ecosystem a runtime declaration
 * wins over a dev one, since that is the stricter grading.
 */
export function declaredDeps(manifests: Manifest[]): DeclaredDep[] {
  const byKey = new Map<string, DeclaredDep>();
  const key = (ecosystem: Ecosystem, name: string) => `${ecosystem}\u0000${name}`;

  for (const manifest of manifests) {
    for (const [name, range] of Object.entries(manifest.dependencies)) {
      byKey.set(key(manifest.ecosystem, name), {
        name,
        kind: 'direct',
        range,
        manifest: manifest.file,
        ecosystem: manifest.ecosystem,
      });
    }
  }
  for (const manifest of manifests) {
    for (const [name, range] of Object.entries(manifest.devDependencies)) {
      const k = key(manifest.ecosystem, name);
      if (byKey.has(k)) continue;
      byKey.set(k, { name, kind: 'dev', range, manifest: manifest.file, ecosystem: manifest.ecosystem });
    }
  }
  return [...byKey.values()].sort((a, b) => a.ecosystem.localeCompare(b.ecosystem) || a.name.localeCompare(b.name));
}

/** Group dependencies by ecosystem so each batch is graded against the right registry. */
function byEcosystem(deps: readonly DeclaredDep[]): Map<Ecosystem, DeclaredDep[]> {
  const groups = new Map<Ecosystem, DeclaredDep[]>();
  for (const dep of deps) {
    const list = groups.get(dep.ecosystem) ?? [];
    list.push(dep);
    groups.set(dep.ecosystem, list);
  }
  return groups;
}

export async function auditDependencies(root: string, opts: AuditOptions = {}): Promise<AuditReport> {
  const { includeDev = false, only, limit = 60 } = opts;

  const notes: string[] = [];
  const manifests = await readManifests(root);
  const primary = primaryEcosystem(manifests);

  let declared = declaredDeps(manifests);
  if (!includeDev) declared = declared.filter((d) => d.kind === 'direct');
  if (only && only.length > 0) {
    const wanted = new Set(only.map((n) => n.toLowerCase()));
    declared = declared.filter((d) => wanted.has(d.name.toLowerCase()));
  }

  if (manifests.length === 0) notes.push('No dependency manifest found at the scan root.');
  if (declared.length > limit) {
    notes.push(`Auditing the first ${limit} of ${declared.length} dependencies; raise --limit to cover the rest.`);
    declared = declared.slice(0, limit);
  }

  const groups = byEcosystem(declared);
  if (groups.size > 1) {
    const summary = [...groups.entries()].map(([eco, list]) => `${list.length} ${eco}`).join(', ');
    notes.push(`Polyglot project: ${summary}. Each dependency is graded against its own registry.`);
  }

  const ungraded = [...groups.keys()].filter((eco) => !registryFor(eco));
  if (ungraded.length > 0) {
    notes.push(`Cannot grade ${ungraded.join(', ')} packages in this version, so they are reported as unresolved. Supported: ${supportedEcosystems().join(', ')}.`);
  }

  const unresolved: AuditReport['unresolved'] = [];
  const deps: AuditedDep[] = [];

  // One batch per ecosystem, each against its own registry.
  for (const [ecosystem, group] of groups) {
    if (!registryFor(ecosystem)) {
      for (const dep of group) {
        unresolved.push({ name: dep.name, kind: dep.kind, reason: `${ecosystem} packages cannot be graded in this version` });
      }
      continue;
    }

    const evidence = await gatherEvidence(group.map((d) => d.name), ecosystem, 4);

    group.forEach((dep, i) => {
      const found = evidence[i];
      if (!found || found.health.flags.includes('no-evidence')) {
        unresolved.push({
          name: dep.name,
          kind: dep.kind,
          reason: found ? found.gaps.join('; ') || 'no public evidence available' : `not found on ${ecosystem}`,
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
    ecosystem: primary,
    ecosystems: [...groups.keys()].sort(),
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
