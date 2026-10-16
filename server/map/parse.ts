import type { ParsedMap } from '../../shared/map.js';
import { parseB01Map } from './b01.js';
import { isLegacyMap, parseLegacyMap } from './legacy.js';

export interface ParseOutcome {
  map: ParsedMap | null;
  format: 'B01' | 'legacy' | null;
  error: string | null;
}

/**
 * Parse a map in whichever format it is. Legacy maps always start with "rr", so that is tried
 * first for them; anything else is tried as B01 first. Each falls back to the other format.
 */
export function parseAnyMap(data: Uint8Array): ParseOutcome {
  const order: Array<'legacy' | 'B01'> = isLegacyMap(data) ? ['legacy', 'B01'] : ['B01', 'legacy'];
  const errors: string[] = [];
  for (const format of order) {
    try {
      const map = format === 'legacy' ? parseLegacyMap(data) : parseB01Map(data);
      return { map, format, error: null };
    } catch (e) {
      errors.push(`${format}: ${(e as Error).message}`);
    }
  }
  return { map: null, format: null, error: errors.join('; ') };
}
