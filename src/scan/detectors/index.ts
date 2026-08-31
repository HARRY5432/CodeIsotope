import type { Detector } from '../detector-types.ts';
import { DATA_DETECTORS } from './data.ts';
import { PLATFORM_DETECTORS } from './platform.ts';
import { PYTHON_DETECTORS } from './python.ts';
import { RESILIENCE_DETECTORS } from './resilience.ts';
import { SECURITY_DETECTORS } from './security.ts';
import { UTIL_DETECTORS } from './utils.ts';

/**
 * Security first: when several detectors fire on one file, the dangerous ones should surface first.
 *
 * Python detectors lead the list because three of them -- SQL built by string formatting, tokens
 * from `random`, and `pickle.loads` on request data -- are remote-code-execution and injection
 * classes rather than hardening opportunities.
 */
export const DETECTORS: Detector[] = [
  ...PYTHON_DETECTORS,
  ...SECURITY_DETECTORS,
  ...DATA_DETECTORS,
  ...RESILIENCE_DETECTORS,
  ...UTIL_DETECTORS,
  ...PLATFORM_DETECTORS,
];

export function detectorById(id: string): Detector | undefined {
  return DETECTORS.find((d) => d.id === id);
}

/** Detector ids grouped by the file extensions they care about, for cheap per-file filtering. */
export function detectorsForExt(ext: string): Detector[] {
  return DETECTORS.filter((d) => d.ext.includes(ext));
}
