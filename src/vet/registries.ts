import type { Ecosystem } from '../lib/types.ts';
import { CRATES_CLIENT } from './crates.ts';
import { GO_CLIENT } from './goproxy.ts';
import { NPM_CLIENT } from './npm.ts';
import { PYPI_CLIENT } from './pypi.ts';
import type { RegistryClient } from './registry.ts';

/**
 * Which registries we can gather first-party evidence from.
 *
 * An ecosystem absent here is still *detected* and reported -- the manifest reader understands
 * seven of them -- but its packages cannot be graded, and `audit` says so explicitly rather than
 * pretending the project is clean.
 */
const CLIENTS: Partial<Record<Ecosystem, RegistryClient>> = {
  npm: NPM_CLIENT,
  pypi: PYPI_CLIENT,
  cargo: CRATES_CLIENT,
  go: GO_CLIENT,
};

export function registryFor(ecosystem: Ecosystem): RegistryClient | undefined {
  return CLIENTS[ecosystem];
}

export function supportedEcosystems(): Ecosystem[] {
  return Object.keys(CLIENTS) as Ecosystem[];
}

/** Ecosystems whose registry has a search API we can rely on. */
export function searchableEcosystems(): Ecosystem[] {
  return supportedEcosystems().filter((e) => CLIENTS[e]?.search !== undefined);
}
