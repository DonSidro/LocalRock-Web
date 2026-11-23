import type { ParsedMap } from './map.js';

/*
 * Rules for when map edits may be saved, ported from LocalRock's MapEditCommands.kt. Shared so the
 * editor in the browser and the server refuse exactly the same things.
 */

/** The map index save_map needs: known only when the robot holds exactly one map (the captured case). */
export function saveMapIndex(floorMaps: { mapFlag: number }[]): number | null {
  return floorMaps.length === 1 ? floorMaps[0]!.mapFlag : null;
}

/**
 * Map edits name the map they change by its mapFlag (save_map's [100, n], and "map_index": n on carpets
 * and thresholds). The map being edited is only certain when the robot holds exactly one map. That map
 * need not be map 0: a robot that once had a second floor can keep its only map as map 1.
 */
export function mapIndexBlocker(mapIndex: number | null): string | null {
  return mapIndex === null ? 'Saving map edits is only supported on robots with a single saved map for now.' : null;
}

export type UnsupportedKind = 'CARPET' | 'THRESHOLD';

/** new_feature_info bit for drawing carpet areas (python-roborock is_map_carpet_add_support). */
const MAP_CARPET_ADD_BIT = 30;
/** Masks over the last 8 characters of new_feature_info_str for thresholds (is_support_custom_door_sill / smart_door_sill). */
const CUSTOM_DOOR_SILL_MASK = 32;
const SMART_DOOR_SILL_MASK = 1024;

/**
 * Kinds the robot's own flags say it can't store, so the editor can grey their tools out before
 * anything is drawn. An S7 on 02.16.12 reports neither carpet areas nor thresholds, and answers both
 * commands with unknown_method. An unknown flag blocks nothing, and neither does a kind the map already
 * holds: the robot plainly stores those.
 */
export function advertisedUnsupportedMapEdits(
  newFeatureInfo: string | null, newFeatureInfoStr: string | null, mapHasCarpets: boolean, mapHasThresholds: boolean,
): UnsupportedKind[] {
  const out: UnsupportedKind[] = [];
  if (newFeatureInfo !== null && /^\d+$/.test(newFeatureInfo) && ((BigInt(newFeatureInfo) >> BigInt(MAP_CARPET_ADD_BIT)) & 1n) === 0n && !mapHasCarpets) out.push('CARPET');
  const low = newFeatureInfoStr && newFeatureInfoStr.length >= 8 ? parseInt(newFeatureInfoStr.slice(-8), 16) : NaN;
  if (!Number.isNaN(low) && (low & (CUSTOM_DOOR_SILL_MASK | SMART_DOOR_SILL_MASK)) === 0 && !mapHasThresholds) out.push('THRESHOLD');
  return out;
}

function unsupportedKindsText(kinds: UnsupportedKind[]): string {
  return [kinds.includes('CARPET') ? 'carpet areas' : null, kinds.includes('THRESHOLD') ? 'thresholds' : null].filter(Boolean).join(' or ');
}

/** What to tell the user after a save in which the robot refused `refused`. */
export function unsupportedMapEditMessage(refused: UnsupportedKind[], savedOther: boolean): string {
  return `This robot doesn't support ${unsupportedKindsText(refused)}, so they were not saved.${savedOther ? ' Your other changes were saved.' : ''}`;
}

/** Note for the editor when the robot doesn't support some kinds, or null. */
export function unsupportedMapEditNote(unsupported: UnsupportedKind[]): string | null {
  const text = unsupportedKindsText(unsupported);
  return text ? `This robot doesn't support ${text}.` : null;
}

const MOP_ONLY_AREAS_BLOCK = 23;

/**
 * Why the map's restrictions can't be saved safely, or null. save_map replaces the robot's whole
 * set, so anything on the map this app can't write back must block it.
 */
export function restrictionSaveBlocker(map: ParsedMap, mapIndex: number | null): string | null {
  const indexProblem = mapIndexBlocker(mapIndex);
  if (indexProblem) return indexProblem;
  if (map.noMopZones.length > 0) {
    return "This map has no-mop zones. LocalRock can't write them back yet, so saving here could delete them.";
  }
  if (map.unmodeledRestrictionBlocks.includes(MOP_ONLY_AREAS_BLOCK)) {
    return "This map has mop-only areas. LocalRock can't write them back yet, so saving here could delete them.";
  }
  return null;
}

/** Why the map can't be edited right now, or null. */
export function editBlockedReason(map: ParsedMap | null, busy: boolean): string | null {
  if (busy) return 'The robot is busy. Dock it or let it finish before editing the map.';
  if (!map) return 'The map has not loaded yet';
  if (map.format !== 'LEGACY') return "Map editing is not supported for this robot's map format yet";
  return null;
}
