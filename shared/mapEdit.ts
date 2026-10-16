import type { ParsedMap } from './map.js';

/*
 * Rules for when map edits may be saved, ported from LocalRock's MapEditCommands.kt. Shared so the
 * editor in the browser and the server refuse exactly the same things.
 */

/** The map index save_map needs: known only when the robot holds exactly one map (the captured case). */
export function saveMapIndex(floorMaps: { mapFlag: number }[]): number | null {
  return floorMaps.length === 1 ? floorMaps[0]!.mapFlag : null;
}

/** Every captured map edit named map index 0 on a robot with one saved map; anything else is unconfirmed. */
export function mapIndexBlocker(mapIndex: number | null): string | null {
  if (mapIndex === null) return 'Saving map edits is only supported on robots with a single saved map for now.';
  if (mapIndex === 0) return null;
  return `Saving map edits is only confirmed for map 0. This robot's map is ${mapIndex}.`;
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
