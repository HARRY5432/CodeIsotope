/**
 * A section-aware reader for the manifest formats that are not JSON.
 *
 * Deliberately not a full TOML implementation: we need dependency *names* and their version
 * constraints, not typed values, and a real TOML parser is a dependency this tool refuses to take.
 * What matters -- and what a line-at-a-time matcher gets wrong -- is knowing which section a line
 * belongs to. Without that, `Cargo.toml` reports `name`, `version` and `edition` from `[package]`
 * as dependencies, and files `[dev-dependencies]` as runtime ones.
 */

export interface ParsedDeps {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
}

const empty = (): ParsedDeps => ({ dependencies: {}, devDependencies: {} });

/** Strip a trailing comment, respecting quotes so a `#` inside a string survives. */
function stripComment(line: string, marker: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (!inSingle && !inDouble && line.startsWith(marker, i)) return line.slice(0, i);
  }
  return line;
}

/**
 * Split a TOML-ish document into sections keyed by header, preserving line order within each.
 * `[[array]]` headers are normalised to `array` since we only ever ask which table we are in.
 */
export function tomlSections(text: string): Map<string, string[]> {
  const sections = new Map<string, string[]>();
  let current = '';
  sections.set(current, []);

  for (const raw of text.split(/\r?\n/)) {
    const line = stripComment(raw, '#').trim();
    if (!line) continue;

    const header = /^\[\[?\s*([^\]]+?)\s*\]\]?$/.exec(line);
    if (header?.[1]) {
      current = header[1].trim();
      if (!sections.has(current)) sections.set(current, []);
      continue;
    }
    sections.get(current)?.push(line);
  }
  return sections;
}

/** `tokio = { version = "1", features = [...] }` -> "1"; `serde = "1.0"` -> "1.0". */
function versionFromValue(value: string): string {
  const trimmed = value.trim();
  const plain = /^['"]([^'"]*)['"]/.exec(trimmed);
  if (plain?.[1] !== undefined) return plain[1] || '*';
  const inline = /\bversion\s*=\s*['"]([^'"]+)['"]/.exec(trimmed);
  if (inline?.[1]) return inline[1];
  // A git or path dependency has no version at all, which is worth saying rather than faking.
  if (/\bgit\s*=/.test(trimmed)) return 'git';
  if (/\bpath\s*=/.test(trimmed)) return 'path';
  if (/\bworkspace\s*=\s*true/.test(trimmed)) return 'workspace';
  return '*';
}

/** Collect `name = value` pairs from one section's lines. */
function keyValues(lines: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of lines) {
    const match = /^([A-Za-z0-9_.\-]+)\s*=\s*(.+)$/.exec(line);
    const name = match?.[1];
    if (!name || match[2] === undefined) continue;
    out[name] = versionFromValue(match[2]);
  }
  return out;
}

/**
 * Cargo.
 *
 * Dependency tables can appear four ways, and all four are common in real crates:
 *   [dependencies]                          plain
 *   [dependencies.tokio]                    one table per dependency
 *   [target.'cfg(unix)'.dependencies]       platform-conditional
 *   [workspace.dependencies]                workspace-wide
 * `[dev-dependencies]` and `[build-dependencies]` are both development-time, so they are reported
 * as dev: a stale benchmark harness is not a production risk.
 */
export function parseCargoToml(text: string): ParsedDeps {
  const sections = tomlSections(text);
  const out = empty();

  const RUNTIME = /(^|\.)dependencies$/;
  const DEV = /(^|\.)(dev-dependencies|build-dependencies)$/;

  for (const [header, lines] of sections) {
    if (!header) continue;

    // [dependencies.tokio] -- the table name after the last `dependencies.` is the dep itself.
    const nested = /(^|\.)(dependencies|dev-dependencies|build-dependencies)\.([A-Za-z0-9_-]+)$/.exec(header);
    if (nested?.[3]) {
      const target = nested[2] === 'dependencies' ? out.dependencies : out.devDependencies;
      const inline = keyValues(lines);
      target[nested[3]] = inline['version'] ?? (lines.some((l) => /^git\s*=/.test(l)) ? 'git' : lines.some((l) => /^path\s*=/.test(l)) ? 'path' : '*');
      continue;
    }

    if (DEV.test(header)) Object.assign(out.devDependencies, keyValues(lines));
    else if (RUNTIME.test(header)) Object.assign(out.dependencies, keyValues(lines));
  }
  return out;
}

/** Strip PEP 508 extras and environment markers: `httpx[http2]>=0.27; python_version<"3.9"`. */
function pythonRequirement(spec: string): { name: string; version: string } | undefined {
  const withoutMarker = spec.split(';')[0]?.trim() ?? '';
  if (!withoutMarker) return undefined;
  const match = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*(.*)$/.exec(withoutMarker);
  const name = match?.[1];
  if (!name) return undefined;
  const constraint = (match[2] ?? '').trim();
  return { name, version: constraint.length > 0 ? constraint : '*' };
}

/** Read every quoted string out of a possibly multi-line TOML array. */
function tomlArrayStrings(lines: readonly string[], startIndex: number): { values: string[]; nextIndex: number } {
  const values: string[] = [];
  let depth = 0;
  let i = startIndex;
  for (; i < lines.length; i++) {
    const line = lines[i] ?? '';
    for (const m of line.matchAll(/['"]([^'"]+)['"]/g)) {
      if (m[1]) values.push(m[1]);
    }
    depth += (line.match(/\[/g) ?? []).length - (line.match(/\]/g) ?? []).length;
    if (depth <= 0 && i > startIndex - 1) break;
  }
  return { values, nextIndex: i };
}

/**
 * pyproject.toml, which has two incompatible conventions in wide use:
 *   PEP 621: [project] dependencies = ["httpx>=0.27"], plus [project.optional-dependencies]
 *   Poetry:  [tool.poetry.dependencies] httpx = "^0.27"
 * Both are read. Poetry's `python` entry is the interpreter constraint, not a package, so it is
 * skipped -- otherwise every Poetry project reports a phantom dependency called "python".
 */
export function parsePyprojectToml(text: string): ParsedDeps {
  const sections = tomlSections(text);
  const out = empty();

  const project = sections.get('project') ?? [];
  for (let i = 0; i < project.length; i++) {
    const line = project[i] ?? '';
    if (!/^dependencies\s*=/.test(line)) continue;
    const { values, nextIndex } = tomlArrayStrings(project, i);
    for (const spec of values) {
      const dep = pythonRequirement(spec);
      if (dep) out.dependencies[dep.name] = dep.version;
    }
    i = nextIndex;
  }

  // PEP 735 dependency-groups and PEP 621 optional-dependencies are both development-time in
  // practice: they are extras a consumer opts into, not what the package needs to run.
  for (const [header, lines] of sections) {
    if (!/^(project\.optional-dependencies|dependency-groups)$/.test(header)) continue;
    for (let i = 0; i < lines.length; i++) {
      const { values, nextIndex } = tomlArrayStrings(lines, i);
      for (const spec of values) {
        const dep = pythonRequirement(spec);
        if (dep) out.devDependencies[dep.name] = dep.version;
      }
      i = nextIndex;
    }
  }

  const poetry = sections.get('tool.poetry.dependencies') ?? [];
  for (const [name, version] of Object.entries(keyValues(poetry))) {
    if (name.toLowerCase() === 'python') continue;
    out.dependencies[name] = version;
  }
  for (const header of ['tool.poetry.dev-dependencies', 'tool.poetry.group.dev.dependencies', 'tool.poetry.group.test.dependencies']) {
    for (const [name, version] of Object.entries(keyValues(sections.get(header) ?? []))) {
      if (name.toLowerCase() === 'python') continue;
      out.devDependencies[name] = version;
    }
  }

  return out;
}

/**
 * requirements.txt.
 *
 * The lines that are not requirements matter as much as the ones that are: `-r base.txt` includes
 * another file, `-e .` installs the project itself, and `--index-url` configures pip. Treating any
 * of those as a package name produces a dependency that cannot exist.
 */
export function parseRequirementsTxt(text: string): ParsedDeps {
  const out = empty();
  for (const raw of text.split(/\r?\n/)) {
    const line = stripComment(raw, '#').trim();
    if (!line || line.startsWith('-') || line.startsWith('.')) continue;
    // A bare URL or VCS reference names no package we can look up.
    if (/^[a-z+]+:\/\//i.test(line) || line.includes('@ git+')) continue;
    const dep = pythonRequirement(line);
    if (dep) out.dependencies[dep.name] = dep.version;
  }
  return out;
}

/**
 * go.mod.
 *
 * Two things must be respected. `// indirect` marks a transitive dependency that Go records for
 * reproducibility -- counting those as direct would triple the audit and report packages the
 * developer never chose. And `exclude` / `replace` / `retract` directives are not dependencies at
 * all, so a line-matcher that only looks for `path version` pairs picks up all three.
 */
export function parseGoMod(text: string): ParsedDeps {
  const out = empty();
  let inRequireBlock = false;

  for (const raw of text.split(/\r?\n/)) {
    const withComment = raw.trim();
    const line = stripComment(withComment, '//').trim();
    const isIndirect = /\/\/\s*indirect\b/.test(withComment);

    if (!line) continue;

    if (/^require\s*\($/.test(line)) {
      inRequireBlock = true;
      continue;
    }
    if (inRequireBlock && line === ')') {
      inRequireBlock = false;
      continue;
    }
    // Any other block directive ends require parsing and is not a dependency source.
    if (/^(exclude|replace|retract)\s*\($/.test(line)) {
      inRequireBlock = false;
      continue;
    }

    const single = /^require\s+([^\s]+)\s+(v[\w.+\-]+)/.exec(line);
    if (single?.[1] && single[2]) {
      if (!isIndirect) out.dependencies[single[1]] = single[2];
      continue;
    }

    if (!inRequireBlock) continue;
    const entry = /^([^\s]+)\s+(v[\w.+\-]+)/.exec(line);
    if (entry?.[1] && entry[2]) {
      // Indirect dependencies are real, but they are not what the developer chose, and `audit`
      // reports direct dependencies by design.
      if (isIndirect) out.devDependencies[entry[1]] = entry[2];
      else out.dependencies[entry[1]] = entry[2];
    }
  }
  return out;
}

/** Gemfile. `gem "rails", "~> 7.0"`, with group blocks marking development gems. */
export function parseGemfile(text: string): ParsedDeps {
  const out = empty();
  let devDepth = 0;

  for (const raw of text.split(/\r?\n/)) {
    const line = stripComment(raw, '#').trim();
    if (!line) continue;

    if (/^group\s+.*(:development|:test)/.test(line)) {
      devDepth++;
      continue;
    }
    if (devDepth > 0 && /^end$/.test(line)) {
      devDepth--;
      continue;
    }

    const gem = /^gem\s+['"]([^'"]+)['"]\s*(?:,\s*['"]([^'"]+)['"])?/.exec(line);
    if (!gem?.[1]) continue;
    const version = gem[2] ?? '*';
    // An inline `group:` overrides the surrounding block.
    const inlineDev = /:group\s*=>\s*:(development|test)|group:\s*:(development|test)/.test(line);
    if (devDepth > 0 || inlineDev) out.devDependencies[gem[1]] = version;
    else out.dependencies[gem[1]] = version;
  }
  return out;
}

/**
 * pom.xml. Maven coordinates are groupId:artifactId, and the artifactId alone is ambiguous, so
 * both are kept. `<scope>test</scope>` marks a development dependency.
 */
export function parsePomXml(text: string): ParsedDeps {
  const out = empty();
  for (const match of text.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)) {
    const block = match[1] ?? '';
    const groupId = /<groupId>\s*([^<\s]+)\s*<\/groupId>/.exec(block)?.[1];
    const artifactId = /<artifactId>\s*([^<\s]+)\s*<\/artifactId>/.exec(block)?.[1];
    if (!artifactId) continue;
    const version = /<version>\s*([^<\s]+)\s*<\/version>/.exec(block)?.[1] ?? '*';
    const scope = /<scope>\s*([^<\s]+)\s*<\/scope>/.exec(block)?.[1];
    const name = groupId ? `${groupId}:${artifactId}` : artifactId;
    if (scope === 'test' || scope === 'provided') out.devDependencies[name] = version;
    else out.dependencies[name] = version;
  }
  return out;
}
