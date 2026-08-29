import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Ecosystem, Manifest } from '../lib/types.ts';

/** Manifest files we know how to read, in the order we report them. */
const MANIFEST_FILES: Array<{ file: string; ecosystem: Ecosystem }> = [
  { file: 'package.json', ecosystem: 'npm' },
  { file: 'requirements.txt', ecosystem: 'pypi' },
  { file: 'pyproject.toml', ecosystem: 'pypi' },
  { file: 'Cargo.toml', ecosystem: 'cargo' },
  { file: 'go.mod', ecosystem: 'go' },
  { file: 'Gemfile', ecosystem: 'rubygems' },
  { file: 'pom.xml', ecosystem: 'maven' },
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

function parsePackageJson(text: string): Pick<Manifest, 'dependencies' | 'devDependencies'> {
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

/** Best-effort: enough to know a capability is already covered, not a full TOML/XML parser. */
function parseLoose(text: string, ecosystem: Ecosystem): Pick<Manifest, 'dependencies' | 'devDependencies'> {
  const dependencies: Record<string, string> = {};
  const lines = text.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) continue;

    if (ecosystem === 'pypi') {
      const m = /^([A-Za-z0-9._-]+)\s*(?:[=<>!~]{1,2}\s*([^\s;#]+))?/.exec(trimmed);
      if (m?.[1]) dependencies[m[1]] = m[2] ?? '*';
    } else if (ecosystem === 'go') {
      const m = /^(?:require\s+)?([a-z0-9][\w./-]*\/[\w./-]+)\s+(v[\w.+-]+)/i.exec(trimmed);
      if (m?.[1]) dependencies[m[1]] = m[2] ?? '*';
    } else if (ecosystem === 'cargo') {
      const m = /^([A-Za-z0-9_-]+)\s*=\s*[{"]/.exec(trimmed);
      if (m?.[1]) dependencies[m[1]] = '*';
    } else if (ecosystem === 'rubygems') {
      const m = /^gem\s+['"]([^'"]+)['"]/.exec(trimmed);
      if (m?.[1]) dependencies[m[1]] = '*';
    } else if (ecosystem === 'maven') {
      const m = /<artifactId>([^<]+)<\/artifactId>/.exec(trimmed);
      if (m?.[1]) dependencies[m[1]] = '*';
    }
  }
  return { dependencies, devDependencies: {} };
}

/** Read every manifest at the scan root. Nested workspace manifests are out of scope for v1. */
export async function readManifests(root: string): Promise<Manifest[]> {
  const found: Manifest[] = [];
  for (const { file, ecosystem } of MANIFEST_FILES) {
    const text = await readIfPresent(join(root, file));
    if (text === undefined) continue;
    const parsed = file === 'package.json' ? parsePackageJson(text) : parseLoose(text, ecosystem);
    found.push({ ecosystem, file, ...parsed });
  }
  return found;
}

/** Flatten manifests into the dep-name sets used for detector suppression. */
export function collectDependencyNames(manifests: Manifest[]): { direct: string[]; dev: string[]; all: Set<string> } {
  const direct = new Set<string>();
  const dev = new Set<string>();
  for (const m of manifests) {
    for (const name of Object.keys(m.dependencies)) direct.add(name);
    for (const name of Object.keys(m.devDependencies)) dev.add(name);
  }
  return {
    direct: [...direct].sort(),
    dev: [...dev].sort(),
    all: new Set([...direct, ...dev].map((n) => n.toLowerCase())),
  };
}

/** The ecosystem to vet against: whichever manifest we found first, defaulting to npm. */
export function primaryEcosystem(manifests: Manifest[]): Ecosystem {
  return manifests[0]?.ecosystem ?? 'npm';
}
