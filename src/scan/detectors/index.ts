import type { Detector } from '../detector-types.ts';
import { DATA_DETECTORS } from './data.ts';
import { PLATFORM_DETECTORS } from './platform.ts';
import { RESILIENCE_DETECTORS } from './resilience.ts';
import { SECURITY_DETECTORS } from './security.ts';
import { UTIL_DETECTORS } from './utils.ts';

/** Security first: when several detectors fire on one file, the dangerous ones should surface first. */
export const DETECTORS: Detector[] = [
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
