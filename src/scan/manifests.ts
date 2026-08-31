import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Ecosystem, Manifest } from '../lib/types.ts';
import {
  parseCargoToml,
  parseGemfile,
  parseGoMod,
  parsePomXml,
  parsePyprojectToml,
  parseRequirementsTxt,
  type ParsedDeps,
} from './parse-manifests.ts';

/** Manifest files we know how to read, in the order we report them. */
const MANIFEST_FILES: Array<{ file: string; ecosystem: Ecosystem; parse: (text: string) => ParsedDeps }> = [
  { file: 'package.json', ecosystem: 'npm', parse: parsePackageJson },
  { file: 'requirements.txt', ecosystem: 'pypi', parse: parseRequirementsTxt },
  { file: 'pyproject.toml', ecosystem: 'pypi', parse: parsePyprojectToml },
  { file: 'Cargo.toml', ecosystem: 'cargo', parse: parseCargoToml },
  { file: 'go.mod', ecosystem: 'go', parse: parseGoMod },
  { file: 'Gemfile', ecosystem: 'rubygems', parse: parseGemfile },
  { file: 'pom.xml', ecosystem: 'maven', parse: parsePomXml },
];

async function readIfPresent(path: string): Promise<string | undefined> {
  try {
    const text = await readFile(path, 'utf8');
    // Editors on Windows routinely write a UTF-8 BOM. JSON.parse throws on it, which would have
    // us silently report a project as having no dependencies at all.
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  } catch {
    return undefined;
  }
}

function parsePackageJson(text: string): ParsedDeps {
  try {
    const pkg = JSON.parse(text) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    return {
      dependencies: { ...pkg.dependencies, ...pkg.peerDependencies, ...pkg.optionalDependencies },
      devDependencies: { ...pkg.devDependencies },
    };
  } catch {
    return { dependencies: {}, devDependencies: {} };
  }
}

/** Read every manifest at the scan root. Nested workspace manifests are out of scope for v1. */
export async function readManifests(root: string): Promise<Manifest[]> {
  const found: Manifest[] = [];
  for (const { file, ecosystem, parse } of MANIFEST_FILES) {
    const text = await readIfPresent(join(root, file));
    if (text === undefined) continue;
    found.push({ ecosystem, file, ...parse(text) });
  }
  return found;
}

/**
 * Flatten manifests into the dep-name sets used for detector suppression.
 *
 * `byEcosystem` is what suppression actually needs: a Python detector naming `backoff` must not be
 * silenced because an npm package of the same name is installed. Real collisions exist -- `attrs`,
 * `redis`, `six` and `mock` are all published on both npm and PyPI as unrelated packages.
 */
export function collectDependencyNames(manifests: Manifest[]): {
  direct: string[];
  dev: string[];
  all: Set<string>;
  byEcosystem: Map<Ecosystem, Set<string>>;
} {
  const direct = new Set<string>();
  const dev = new Set<string>();
  const byEcosystem = new Map<Ecosystem, Set<string>>();

  for (const m of manifests) {
    const bucket = byEcosystem.get(m.ecosystem) ?? new Set<string>();
    for (const name of Object.keys(m.dependencies)) {
      direct.add(name);
      bucket.add(name.toLowerCase());
    }
    for (const name of Object.keys(m.devDependencies)) {
      dev.add(name);
      bucket.add(name.toLowerCase());
    }
    byEcosystem.set(m.ecosystem, bucket);
  }

  return {
    direct: [...direct].sort(),
    dev: [...dev].sort(),
    all: new Set([...direct, ...dev].map((n) => n.toLowerCase())),
    byEcosystem,
  };
}

/** The ecosystem to vet against: whichever manifest we found first, defaulting to npm. */
export function primaryEcosystem(manifests: Manifest[]): Ecosystem {
  return manifests[0]?.ecosystem ?? 'npm';
}
