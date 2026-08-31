import type { Ecosystem } from '../lib/types.ts';
import { registryFor } from './registries.ts';

/**
 * Confirm that a package name actually exists in an ecosystem.
 *
 * This turns the tool's central rule from an instruction into a check. The installed prompt says
 * "never recommend a package that did not come back from `vet`", and that was fair criticism: a
 * prompt is not a contract, and nothing stopped a model from naming a package it remembered.
 *
 * `verify` closes it. A model can be told to run this before naming anything, and CI or a human can
 * run it after the fact against a finished report. Existence is a fact the binary can settle in one
 * request, which is exactly the kind of work that belongs on this side of the fact/judgement line.
 */

export type VerifyStatus = 'exists' | 'not-found' | 'wrong-ecosystem' | 'unsupported';

export interface VerifyResult {
  name: string;
  ecosystem: Ecosystem;
  status: VerifyStatus;
  /** The version the registry considers current, when the package exists. */
  version?: string;
  /** One line a reader can act on. */
  detail: string;
  /** Ecosystems where the name *does* exist, when it is missing from the one asked for. */
  foundIn?: Ecosystem[];
}

/** Ecosystems to search when a name is missing, in rough order of how often the mistake happens. */
const CROSS_CHECK: Ecosystem[] = ['npm', 'pypi', 'cargo', 'go'];

/**
 * Check one name, and when it is absent, say whether it exists somewhere else.
 *
 * The cross-check matters more than it sounds. The most damaging failure this tool has had was
 * `tenacity` resolving on npm -- an abandoned styleguide generator -- when the caller meant the
 * Python retry library. "Not found on pypi, but npm has a package by that name" is the sentence that
 * would have caught it, so `verify` says it explicitly rather than reporting a bare absence.
 */
export async function verifyPackage(name: string, ecosystem: Ecosystem): Promise<VerifyResult> {
  const registry = registryFor(ecosystem);
  if (!registry) {
    return {
      name,
      ecosystem,
      status: 'unsupported',
      detail: `${ecosystem} cannot be verified in this version`,
    };
  }

  const facts = await registry.fetchPackage(name).catch(() => undefined);
  if (facts) {
    const result: VerifyResult = {
      name,
      ecosystem,
      status: 'exists',
      detail: `${name} exists on ${registry.label}`,
    };
    if (facts.version) {
      result.version = facts.version;
      result.detail = `${name}@${facts.version} exists on ${registry.label}`;
    }
    return result;
  }

  const elsewhere: Ecosystem[] = [];
  for (const other of CROSS_CHECK) {
    if (other === ecosystem) continue;
    const client = registryFor(other);
    if (!client) continue;
    const found = await client.fetchPackage(name).catch(() => undefined);
    if (found) elsewhere.push(other);
  }

  if (elsewhere.length > 0) {
    return {
      name,
      ecosystem,
      status: 'wrong-ecosystem',
      foundIn: elsewhere,
      detail:
        `${name} does not exist on ${registry.label}, but ${elsewhere.join(' and ')} has a package by that name. ` +
        `A name shared across registries is usually a different project: \`tenacity\` on npm is an abandoned ` +
        `styleguide generator, not the Python retry library.`,
    };
  }

  return {
    name,
    ecosystem,
    status: 'not-found',
    detail: `${name} does not exist on ${registry.label}. If a model suggested it, it was invented.`,
  };
}

export interface VerifyReport {
  tool: { name: string; version: string };
  ecosystem: Ecosystem;
  generatedAt: string;
  results: VerifyResult[];
  /** True when every name checked exists in the ecosystem asked for. */
  ok: boolean;
}

export async function verifyPackages(names: readonly string[], ecosystem: Ecosystem): Promise<VerifyResult[]> {
  const out: VerifyResult[] = [];
  for (const name of names) {
    out.push(await verifyPackage(name.trim(), ecosystem));
  }
  return out;
}
