import type { Ecosystem, Manifest } from '../lib/types.ts';
import { readManifests } from '../scan/manifests.ts';
import { registryFor, supportedEcosystems } from './registries.ts';

/**
 * Work out which registry a command should query, from the project rather than from a default.
 *
 * This exists because of a real, confidently-wrong answer. `vet` defaulted to npm regardless of what
 * the project was written in, so a Python detector recommending `tenacity` produced:
 *
 *     $ codeisotope vet "retry" --package tenacity
 *       1. tenacity@1.0.4  F 18/100
 *          Living Styleguide Generator          <- an abandoned npm package, unrelated to the query
 *
 * The Python `tenacity` is a healthy B 84/100 with 4,010 dependents. The npm one is a dead styleguide
 * generator that happens to share a name. Nothing in the output said "this might be the wrong
 * registry", which is worse than refusing to answer: a graded card with signals and a licence reads
 * as authoritative.
 *
 * So the rule is: infer when the project says so unambiguously, and **fail loud** when it does not.
 * Guessing between two registries would preserve the exact failure this replaces.
 */

export type EcosystemSource = 'explicit' | 'inferred' | 'default';

export interface EcosystemDecision {
  ecosystem: Ecosystem;
  source: EcosystemSource;
  /** Human-readable justification, for the report's notes. */
  reason: string;
}

export interface EcosystemAmbiguity {
  kind: 'ambiguous';
  /** Every gradeable ecosystem the project declares, with the manifest that declared it. */
  candidates: Array<{ ecosystem: Ecosystem; manifest: string; directDeps: number }>;
  message: string;
}

export type EcosystemResult = EcosystemDecision | EcosystemAmbiguity;

export function isAmbiguous(result: EcosystemResult): result is EcosystemAmbiguity {
  return 'kind' in result && result.kind === 'ambiguous';
}

/** Gradeable ecosystems present in the manifests, in the order the manifests were read. */
export function gradeableEcosystems(manifests: readonly Manifest[]): Array<{ ecosystem: Ecosystem; manifest: string; directDeps: number }> {
  const seen = new Map<Ecosystem, { ecosystem: Ecosystem; manifest: string; directDeps: number }>();
  for (const m of manifests) {
    if (!registryFor(m.ecosystem)) continue;
    const directDeps = Object.keys(m.dependencies).length;
    const existing = seen.get(m.ecosystem);
    if (existing) {
      // Two manifests for one ecosystem -- requirements.txt and pyproject.toml both being present is
      // normal. Keep the one declaring more dependencies, since that is the one in use.
      if (directDeps > existing.directDeps) seen.set(m.ecosystem, { ecosystem: m.ecosystem, manifest: m.file, directDeps });
      continue;
    }
    seen.set(m.ecosystem, { ecosystem: m.ecosystem, manifest: m.file, directDeps });
  }
  return [...seen.values()];
}

/**
 * Decide the ecosystem for a `vet` or `reference` run.
 *
 * `explicit` always wins -- an author who passes `--ecosystem pypi` has answered the question. With
 * no flag, a single gradeable manifest decides it. Two or more is a genuine ambiguity and returns
 * `ambiguous` for the caller to reject.
 *
 * An empty project falls back to npm, which is honest rather than arbitrary: with no manifest there
 * is nothing to infer from, and a bare `vet "csv parser"` in an empty directory is a search of the
 * largest registry with search.
 */
export async function decideEcosystem(root: string, explicit?: string): Promise<EcosystemResult> {
  if (explicit) {
    const supported = supportedEcosystems();
    const ecosystem = explicit.toLowerCase() as Ecosystem;
    if (!supported.includes(ecosystem)) {
      return {
        kind: 'ambiguous',
        candidates: [],
        message: `unknown ecosystem "${explicit}". Supported: ${supported.join(', ')}.`,
      };
    }
    return { ecosystem, source: 'explicit', reason: `--ecosystem ${ecosystem} was given` };
  }

  const manifests = await readManifests(root).catch(() => [] as Manifest[]);
  const candidates = gradeableEcosystems(manifests);

  if (candidates.length === 1) {
    const only = candidates[0] as { ecosystem: Ecosystem; manifest: string; directDeps: number };
    return {
      ecosystem: only.ecosystem,
      source: 'inferred',
      reason: `inferred ${only.ecosystem} from ${only.manifest}`,
    };
  }

  if (candidates.length > 1) {
    // Prefer the manifest that actually declares dependencies. A polyglot repo often has a
    // near-empty package.json beside a real requirements.txt, and calling that ambiguous would be
    // pedantic -- but only when the difference is unmistakable.
    const withDeps = candidates.filter((c) => c.directDeps > 0);
    if (withDeps.length === 1) {
      const only = withDeps[0] as { ecosystem: Ecosystem; manifest: string; directDeps: number };
      return {
        ecosystem: only.ecosystem,
        source: 'inferred',
        reason: `inferred ${only.ecosystem} from ${only.manifest}; the other manifests declare no dependencies`,
      };
    }

    const list = candidates.map((c) => `${c.ecosystem} (${c.manifest}, ${c.directDeps} deps)`).join(', ');
    return {
      kind: 'ambiguous',
      candidates,
      message:
        `this project declares more than one ecosystem -- ${list}. ` +
        `Pass --ecosystem to say which one you mean. Guessing produces confidently wrong answers: ` +
        `\`tenacity\` on npm is an abandoned styleguide generator, unrelated to the Python retry library.`,
    };
  }

  return {
    ecosystem: 'npm',
    source: 'default',
    reason: 'no dependency manifest found, so npm was assumed',
  };
}
