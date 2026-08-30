import { tryJson } from '../lib/http.ts';
import { pickRepoUrl, type RegistryClient, type RegistryFacts } from './registry.ts';

const PYPI = 'https://pypi.org';

interface PypiResponse {
  info?: {
    name?: string;
    version?: string;
    summary?: string;
    license?: string;
    /** PEP 639 SPDX expression. Newer and far cleaner than the free-text `license` field. */
    license_expression?: string;
    home_page?: string;
    project_urls?: Record<string, string>;
    yanked?: boolean;
    yanked_reason?: string;
    classifiers?: string[];
    requires_python?: string;
  };
  urls?: Array<{ upload_time_iso_8601?: string }>;
}

/**
 * PyPI reports a licence in three different places depending on the package's age: the modern SPDX
 * `license_expression`, a free-text `license` that ranges from "MIT" to a pasted licence body, and a
 * trove classifier. Prefer them in that order, and give up rather than guess from prose -- a wrong
 * licence claim is worse than an honest unknown.
 */
const CLASSIFIER_LICENSE = /^License :: (?:OSI Approved :: )?(.+)$/;

const CLASSIFIER_TO_SPDX: Record<string, string> = {
  'MIT License': 'MIT',
  'MIT No Attribution License (MIT-0)': 'MIT-0',
  'Apache Software License': 'Apache-2.0',
  'BSD License': 'BSD-3-Clause',
  'ISC License (ISCL)': 'ISC',
  'GNU General Public License v2 (GPLv2)': 'GPL-2.0',
  'GNU General Public License v3 (GPLv3)': 'GPL-3.0',
  'GNU Lesser General Public License v3 (LGPLv3)': 'LGPL-3.0',
  'Mozilla Public License 2.0 (MPL 2.0)': 'MPL-2.0',
  'The Unlicense (Unlicense)': 'Unlicense',
};

export function normalizePypiLicense(info: NonNullable<PypiResponse['info']>): string | null {
  const expression = info.license_expression?.trim();
  if (expression) return expression;

  const free = info.license?.trim();
  // A licence field holding the full licence text is common on older packages. Anything this long
  // is prose, not an identifier, so fall through to the classifier instead of reporting a novel.
  if (free && free.length > 0 && free.length <= 40 && !free.includes('\n')) return free;

  for (const classifier of info.classifiers ?? []) {
    const match = CLASSIFIER_LICENSE.exec(classifier);
    const label = match?.[1]?.trim();
    if (!label || label === 'OSI Approved') continue;
    return CLASSIFIER_TO_SPDX[label] ?? label;
  }
  return free && free.length > 0 ? 'non-standard' : null;
}

/**
 * PyPI has no deprecation flag. The closest equivalents are a *yanked* release, which means the
 * maintainer pulled it and nobody should install it, and the "Inactive" development-status
 * classifier, which is the maintainer saying in metadata that the project is done.
 */
function pypiDeprecation(info: NonNullable<PypiResponse['info']>): RegistryFacts['deprecated'] {
  if (info.yanked) {
    const reason = info.yanked_reason?.trim();
    return { is: true, ...(reason ? { reason: `release was yanked from PyPI: ${reason}` } : { reason: 'release was yanked from PyPI' }) };
  }
  const inactive = (info.classifiers ?? []).some((c) => /^Development Status :: 7 - Inactive$/.test(c));
  if (inactive) return { is: true, reason: 'classified by its maintainers as "Development Status :: 7 - Inactive"' };
  return { is: false };
}

async function fetchPypiPackage(name: string): Promise<RegistryFacts | undefined> {
  const res = await tryJson<PypiResponse>(`${PYPI}/pypi/${encodeURIComponent(name)}/json`);
  const info = res?.info;
  if (!info?.name) return undefined;

  const facts: RegistryFacts = {
    name: info.name,
    license: normalizePypiLicense(info),
    deprecated: pypiDeprecation(info),
  };
  if (info.version) facts.version = info.version;
  if (info.summary) facts.description = info.summary;

  const repoUrl = pickRepoUrl({ ...info.project_urls, home_page: info.home_page });
  if (repoUrl) facts.repoUrl = repoUrl;
  const homepage = info.project_urls?.['Homepage'] ?? info.home_page;
  if (homepage) facts.homepage = homepage;

  // `urls` describes the newest release's files, so its upload time is that release's date.
  const uploaded = res?.urls?.[0]?.upload_time_iso_8601;
  if (uploaded) facts.publishedAt = uploaded;

  return facts;
}

/**
 * PyPI's own search endpoint was withdrawn (it returned XML-RPC and was disabled for abuse), so
 * there is no first-party JSON search. Rather than scrape the website, this client declares no
 * search capability and the caller reports that Python packages must be named explicitly.
 */
export const PYPI_CLIENT: RegistryClient = {
  ecosystem: 'pypi',
  label: 'PyPI',
  fetchPackage: fetchPypiPackage,
};
