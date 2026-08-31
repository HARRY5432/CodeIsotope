import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { declaredDeps } from '../src/audit/audit.ts';
import { readManifests } from '../src/scan/manifests.ts';
import {
  parseCargoToml,
  parseGemfile,
  parseGoMod,
  parsePomXml,
  parsePyprojectToml,
  parseRequirementsTxt,
  tomlSections,
} from '../src/scan/parse-manifests.ts';
import { adoptionSignal, maintenanceSignal, releaseSignal } from '../src/score/signals.ts';
import { chooseVersion, isPrerelease } from '../src/vet/depsdev.ts';
import { registryFor, searchableEcosystems, supportedEcosystems } from '../src/vet/registries.ts';
import { githubSlugFrom, pickRepoUrl } from '../src/vet/registry.ts';
import { normalizePypiLicense } from '../src/vet/pypi.ts';
import { escapeGoModulePath } from '../src/vet/goproxy.ts';

const DAY = 86_400_000;
const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * DAY).toISOString();

async function project(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'codeisotope-eco-'));
  for (const [name, body] of Object.entries(files)) {
    await writeFile(join(root, name), body, 'utf8');
  }
  return root;
}

// --- Cargo ---------------------------------------------------------------------------------

const CARGO = `
[package]
name = "my-service"
version = "0.1.0"
edition = "2021"
license = "MIT"

[dependencies]
tokio = { version = "1", features = ["full"] }
serde = "1.0"

[dev-dependencies]
criterion = "0.5"

[build-dependencies]
cc = "1.0"

[profile.release]
opt-level = 3

[[bin]]
name = "server"
path = "src/main.rs"
`;

test('Cargo.toml reports dependencies, not package metadata', () => {
  // The loose line-matcher this replaced reported name, version, edition, license and path as
  // dependencies, because it had no idea which section a line belonged to.
  const parsed = parseCargoToml(CARGO);
  assert.deepEqual(Object.keys(parsed.dependencies).sort(), ['serde', 'tokio']);
  for (const notADep of ['name', 'version', 'edition', 'license', 'path', 'opt-level']) {
    assert.ok(!(notADep in parsed.dependencies), `"${notADep}" is not a dependency`);
    assert.ok(!(notADep in parsed.devDependencies), `"${notADep}" is not a dev dependency`);
  }
});

test('Cargo dev- and build-dependencies are both development-time', () => {
  const parsed = parseCargoToml(CARGO);
  assert.deepEqual(Object.keys(parsed.devDependencies).sort(), ['cc', 'criterion']);
});

test('a Cargo inline table yields its version, not the whole table', () => {
  assert.equal(parseCargoToml(CARGO).dependencies['tokio'], '1');
});

test('Cargo per-dependency tables and platform sections are understood', () => {
  const parsed = parseCargoToml(`
[dependencies.reqwest]
version = "0.12"
default-features = false

[target.'cfg(unix)'.dependencies]
nix = "0.29"

[workspace.dependencies]
anyhow = "1.0"
`);
  assert.equal(parsed.dependencies['reqwest'], '0.12');
  assert.equal(parsed.dependencies['nix'], '0.29');
  assert.equal(parsed.dependencies['anyhow'], '1.0');
});

test('a git or path Cargo dependency says so instead of faking a version', () => {
  const parsed = parseCargoToml(`
[dependencies]
mine = { path = "../mine" }
forked = { git = "https://github.com/me/forked" }
shared = { workspace = true }
`);
  assert.equal(parsed.dependencies['mine'], 'path');
  assert.equal(parsed.dependencies['forked'], 'git');
  assert.equal(parsed.dependencies['shared'], 'workspace');
});

test('a comment inside a TOML string is not treated as a comment', () => {
  const sections = tomlSections(`
[dependencies]
thing = { version = "1", note = "uses # for anchors" }
`);
  assert.match((sections.get('dependencies') ?? []).join(' '), /anchors/);
});

// --- Python --------------------------------------------------------------------------------

test('pyproject.toml reads PEP 621 dependencies across multiple lines', () => {
  const parsed = parsePyprojectToml(`
[project]
name = "my-api"
dependencies = [
  "httpx[http2]>=0.27",
  "pydantic>=2.0",
  "uvicorn",
  "sqlalchemy>=2.0; python_version >= '3.9'",
]

[project.optional-dependencies]
dev = ["pytest>=8.0", "ruff"]
`);
  assert.deepEqual(Object.keys(parsed.dependencies).sort(), ['httpx', 'pydantic', 'sqlalchemy', 'uvicorn']);
  // Extras and environment markers are packaging syntax, not part of the name.
  assert.equal(parsed.dependencies['httpx'], '>=0.27');
  assert.equal(parsed.dependencies['sqlalchemy'], '>=2.0');
  assert.deepEqual(Object.keys(parsed.devDependencies).sort(), ['pytest', 'ruff']);
});

test('pyproject.toml reads Poetry layout and skips the python constraint', () => {
  const parsed = parsePyprojectToml(`
[tool.poetry.dependencies]
python = "^3.11"
requests = "^2.31"

[tool.poetry.group.dev.dependencies]
black = "^24.0"
`);
  // "python" is the interpreter requirement; reporting it would be a phantom dependency.
  assert.ok(!('python' in parsed.dependencies));
  assert.equal(parsed.dependencies['requests'], '^2.31');
  assert.equal(parsed.devDependencies['black'], '^24.0');
});

test('requirements.txt ignores pip directives and self-installs', () => {
  const parsed = parseRequirementsTxt(`
# core
requests==2.31.0
flask>=2.0
-r base.txt
-e .
--index-url https://example.com/simple
.
https://example.com/pkg.tar.gz
mypkg @ git+https://github.com/me/mypkg
`);
  assert.deepEqual(Object.keys(parsed.dependencies).sort(), ['flask', 'requests']);
});

// --- Go ------------------------------------------------------------------------------------

const GO_MOD = `
module github.com/me/svc

go 1.23

require (
	github.com/gin-gonic/gin v1.12.0
	github.com/BurntSushi/toml v1.6.0
	golang.org/x/crypto v0.28.0 // indirect
)

require github.com/redis/go-redis/v9 v9.7.0

exclude (
	github.com/bad/pkg v1.0.0
)
`;

test('go.mod separates direct requirements from indirect ones', () => {
  // Indirect dependencies are recorded for reproducibility, not chosen by the developer. Counting
  // them as direct would triple the audit and report packages nobody picked.
  const parsed = parseGoMod(GO_MOD);
  assert.deepEqual(Object.keys(parsed.dependencies).sort(), [
    'github.com/BurntSushi/toml',
    'github.com/gin-gonic/gin',
    'github.com/redis/go-redis/v9',
  ]);
  assert.deepEqual(Object.keys(parsed.devDependencies), ['golang.org/x/crypto']);
});

test('go.mod exclude and replace blocks are not dependencies', () => {
  assert.ok(!('github.com/bad/pkg' in parseGoMod(GO_MOD).dependencies));
  const replaced = parseGoMod(`
replace (
	github.com/old/pkg v1.0.0 => github.com/new/pkg v2.0.0
)
`);
  assert.deepEqual(Object.keys(replaced.dependencies), []);
});

test('Go module paths escape uppercase letters as the proxy protocol requires', () => {
  // Without this a large fraction of real modules silently 404 on the proxy.
  assert.equal(escapeGoModulePath('github.com/BurntSushi/toml'), 'github.com/!burnt!sushi/toml');
  assert.equal(escapeGoModulePath('github.com/gin-gonic/gin'), 'github.com/gin-gonic/gin');
});

// --- Ruby and Maven ------------------------------------------------------------------------

test('Gemfile group blocks mark development gems', () => {
  const parsed = parseGemfile(`
source "https://rubygems.org"
gem "rails", "~> 7.0"
gem "puma"

group :development, :test do
  gem "rspec"
end

gem "byebug", group: :development
`);
  assert.deepEqual(Object.keys(parsed.dependencies).sort(), ['puma', 'rails']);
  assert.deepEqual(Object.keys(parsed.devDependencies).sort(), ['byebug', 'rspec']);
  assert.equal(parsed.dependencies['rails'], '~> 7.0');
});

test('pom.xml keeps the full Maven coordinate and honours test scope', () => {
  const parsed = parsePomXml(`
<dependencies>
  <dependency>
    <groupId>com.google.guava</groupId>
    <artifactId>guava</artifactId>
    <version>33.0.0-jre</version>
  </dependency>
  <dependency>
    <groupId>junit</groupId>
    <artifactId>junit</artifactId>
    <version>4.13.2</version>
    <scope>test</scope>
  </dependency>
</dependencies>
`);
  // artifactId alone is ambiguous across groups, so the coordinate is kept whole.
  assert.equal(parsed.dependencies['com.google.guava:guava'], '33.0.0-jre');
  assert.equal(parsed.devDependencies['junit:junit'], '4.13.2');
});

// --- polyglot projects ---------------------------------------------------------------------

test('each dependency carries the ecosystem of the manifest it came from', async () => {
  // The bug this prevents: audit picked one ecosystem for the whole project, so a repo with both a
  // pyproject.toml and a go.mod looked up github.com/gin-gonic/gin on PyPI, found nothing, and
  // reported a healthy Go module as F 0/100 with "no licence detected -- legally unsafe to ship".
  const root = await project({
    'pyproject.toml': '[project]\ndependencies = ["httpx>=0.27"]\n',
    'go.mod': 'module x\n\nrequire github.com/gin-gonic/gin v1.12.0\n',
  });
  const deps = declaredDeps(await readManifests(root));
  const httpx = deps.find((d) => d.name === 'httpx');
  const gin = deps.find((d) => d.name === 'github.com/gin-gonic/gin');
  assert.equal(httpx?.ecosystem, 'pypi');
  assert.equal(gin?.ecosystem, 'go');
});

test('the same package name in two ecosystems is not collapsed', async () => {
  // `redis` on npm and `redis` on PyPI are unrelated packages; keying by name alone loses one.
  const root = await project({
    'package.json': JSON.stringify({ dependencies: { redis: '^4.6.0' } }),
    'requirements.txt': 'redis==5.0.1\n',
  });
  const deps = declaredDeps(await readManifests(root));
  const redis = deps.filter((d) => d.name === 'redis');
  assert.equal(redis.length, 2, 'both ecosystems must survive');
  assert.deepEqual(redis.map((d) => d.ecosystem).sort(), ['npm', 'pypi']);
});

// --- registry dispatch ---------------------------------------------------------------------

test('every supported ecosystem resolves to a client, and unsupported ones do not', () => {
  for (const eco of supportedEcosystems()) {
    assert.ok(registryFor(eco), `${eco} claims support but has no client`);
  }
  assert.equal(registryFor('maven'), undefined);
  assert.equal(registryFor('rubygems'), undefined);
});

test('only ecosystems with a real search API claim to be searchable', () => {
  const searchable = searchableEcosystems();
  assert.ok(searchable.includes('npm'));
  assert.ok(searchable.includes('cargo'));
  // PyPI withdrew its JSON search endpoint and pkg.go.dev has none. Claiming otherwise would mean
  // scraping a web page whose markup changes without notice.
  assert.ok(!searchable.includes('pypi'));
  assert.ok(!searchable.includes('go'));
});

test('a repo URL is recognised in the shapes registries actually use', () => {
  assert.equal(githubSlugFrom('git+https://github.com/sindresorhus/p-retry.git'), 'sindresorhus/p-retry');
  assert.equal(githubSlugFrom('git@github.com:encode/httpx.git'), 'encode/httpx');
  assert.equal(githubSlugFrom(undefined, 'https://github.com/tokio-rs/tokio'), 'tokio-rs/tokio');
  assert.equal(githubSlugFrom('https://example.com/not-a-forge'), undefined);
});

test('an explicit source link beats a documentation link', () => {
  // PyPI lets a maintainer put anything in project_urls, and Documentation pointing at a docs site
  // is common. Picking that would send the reader somewhere with no code in it.
  const url = pickRepoUrl({
    Documentation: 'https://www.python-httpx.org',
    Source: 'https://github.com/encode/httpx',
  });
  assert.equal(url, 'https://github.com/encode/httpx');
});

// --- PyPI licence normalisation -------------------------------------------------------------

test('a PyPI licence is read from whichever of three fields carries it', () => {
  assert.equal(normalizePypiLicense({ license_expression: 'Apache-2.0' }), 'Apache-2.0');
  assert.equal(normalizePypiLicense({ license: 'MIT' }), 'MIT');
  assert.equal(
    normalizePypiLicense({ classifiers: ['License :: OSI Approved :: MIT License'] }),
    'MIT',
    'a trove classifier maps to its SPDX identifier',
  );
});

test('a licence field holding the whole licence text is not reported as an identifier', () => {
  const body = 'Permission is hereby granted, free of charge, to any person obtaining a copy of this software';
  assert.equal(normalizePypiLicense({ license: body }), 'non-standard');
});

// --- per-ecosystem adoption ------------------------------------------------------------------

test('download thresholds differ by ecosystem', () => {
  // PyPI counts every CI mirror pull, so 2M/week there is ordinary while on npm it is excellent.
  const onNpm = adoptionSignal(2_000_000, undefined, 'npm');
  const onPypi = adoptionSignal(2_000_000, undefined, 'pypi');
  assert.equal(onNpm.verdict, 'good');
  assert.equal(onPypi.verdict, 'good', 'still good, but it sits at a lower tier');
  const modestOnPypi = adoptionSignal(50_000, undefined, 'pypi');
  const strongOnNpm = adoptionSignal(50_000, undefined, 'npm');
  assert.equal(modestOnPypi.verdict, 'weak');
  assert.equal(strongOnNpm.verdict, 'ok');
});

test('dependent counts outrank downloads, being the only portable measure', () => {
  const signal = adoptionSignal(5_000, undefined, 'pypi', { direct: 89_027, total: 179_998 });
  assert.equal(signal.verdict, 'good');
  assert.match(signal.detail, /89,027 packages depend on this/);
});

test('a package almost nothing depends on is graded honestly', () => {
  const signal = adoptionSignal(undefined, undefined, 'npm', { direct: 2 });
  assert.equal(signal.verdict, 'bad');
});

// --- registry publish date as a maintenance fallback -----------------------------------------

test('a publish date stands in for maintenance when no repository is linked', () => {
  // Older PyPI packages often link nowhere. Without this the signal went unknown and dropped out
  // of the average, which scored nose at B/70 despite its last release being 2015.
  const abandoned = maintenanceSignal(undefined, iso(4_100));
  assert.equal(abandoned.verdict, 'bad');
  assert.match(abandoned.detail, /11\.2 years ago/);

  const recent = maintenanceSignal(undefined, iso(30));
  assert.equal(recent.verdict, 'ok');

  // With neither a repo nor a date, unknown remains the honest answer.
  assert.equal(maintenanceSignal(undefined, undefined).verdict, 'unknown');
});

test('release cadence also falls back to the registry publish date', () => {
  assert.equal(releaseSignal(undefined, iso(4_100)).verdict, 'bad');
  assert.equal(releaseSignal(undefined, iso(60)).verdict, 'ok');
  assert.equal(releaseSignal(undefined, undefined).verdict, 'unknown');
});

// --- prerelease selection --------------------------------------------------------------------

test('PEP 440 and SemVer prereleases are recognised', () => {
  for (const version of ['1.0.0.dev5', '2.0b1', '3.0rc2', '1.0.0a1', '1.0.0-beta.1', '2.0.0-rc.1', '1.0.0-canary']) {
    assert.ok(isPrerelease(version), `${version} is a prerelease`);
  }
  for (const version of ['1.0.0', '0.28.1', '2.34.2', '1.53.1', 'v1.12.0']) {
    assert.ok(!isPrerelease(version), `${version} is a stable release`);
  }
});

test('a prerelease marked default is not what a package gets graded on', () => {
  // The bug this prevents: deps.dev reports isDefault for httpx's 1.0.0.dev5, and that version has
  // 34 dependents against 38,576 for the stable 0.28.1 people actually install. Grading the
  // prerelease scored one of Python's most-used HTTP clients at F 33/100 with "modest adoption".
  const versions = [
    { versionKey: { version: '0.27.0' } },
    { versionKey: { version: '0.28.1' } },
    { versionKey: { version: '1.0.0.dev5' }, isDefault: true },
  ];
  assert.equal(chooseVersion(versions)?.versionKey?.version, '0.28.1');
});

test('the registry own current version wins over deps.dev default', () => {
  // PyPI and crates.io distinguish stable from prerelease more reliably than deps.dev does.
  const versions = [
    { versionKey: { version: '1.0.0' } },
    { versionKey: { version: '2.0.0' }, isDefault: true },
  ];
  assert.equal(chooseVersion(versions, '1.0.0')?.versionKey?.version, '1.0.0');
});

test('a stable version flagged default is still preferred', () => {
  const versions = [
    { versionKey: { version: '1.0.0' } },
    { versionKey: { version: '2.0.0' }, isDefault: true },
    { versionKey: { version: '3.0.0rc1' } },
  ];
  assert.equal(chooseVersion(versions)?.versionKey?.version, '2.0.0');
});

test('a package with only prereleases still resolves to something', () => {
  // A brand-new library that has never cut a stable release is not an error to report.
  const versions = [{ versionKey: { version: '0.1.0a1' } }, { versionKey: { version: '0.1.0a2' }, isDefault: true }];
  assert.equal(chooseVersion(versions)?.versionKey?.version, '0.1.0a2');
});

test('with no default flag the newest stable version is chosen', () => {
  // deps.dev returns versions oldest-first.
  const versions = [
    { versionKey: { version: '1.0.0' } },
    { versionKey: { version: '1.1.0' } },
    { versionKey: { version: '2.0.0-rc.1' } },
  ];
  assert.equal(chooseVersion(versions)?.versionKey?.version, '1.1.0');
});
