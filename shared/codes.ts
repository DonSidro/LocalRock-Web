/*
 * Roborock status codes and the values the app sends, ported from LocalRock's VacuumStatus.kt,
 * SmartPlan.kt and RoomCleanModes.kt. Shared by the server and the browser.
 */

/** The fields of get_status this app reads. Anything the robot did not report is undefined. */
export interface VacuumStatus {
  battery?: number;
  state?: number;
  fanPower?: number;
  cleanArea?: number;
  cleanTime?: number;
  errorCode?: number;
  waterBoxStatus?: number;
  /** `water_box_mode` on the wire. */
  waterBoxCustomMode?: number;
  chargeStatus?: number;
  dockErrorStatus?: number;
  dryStatus?: number;
  /** `rdt` on the wire: seconds of mop drying left. */
  remainingDryTimeSec?: number;
  /** Loaded map in the upper bits (see loadedMapFlag). */
  mapStatus?: number;
  /** Bit LAB_STATUS_MAP_SAVING while the robot keeps maps, LAB_STATUS_MULTI_LEVEL while multi-level maps are on. */
  labStatus?: number;
  /** 0 = recognise the floor automatically, 1 = pick the map by hand. */
  switchMapMode?: number;
  /** 0 once a clean job is over; non-zero through the breaks inside one. */
  inCleaning?: number;
  /** How far through the current job the robot says it is, 0..100. */
  cleanPercent?: number;
}

/** Wire name of each VacuumStatus field. */
export const STATUS_FIELDS: Record<keyof VacuumStatus, string> = {
  battery: 'battery',
  state: 'state',
  fanPower: 'fan_power',
  cleanArea: 'clean_area',
  cleanTime: 'clean_time',
  errorCode: 'error_code',
  waterBoxStatus: 'water_box_status',
  waterBoxCustomMode: 'water_box_mode',
  chargeStatus: 'charge_status',
  dockErrorStatus: 'dock_error_status',
  dryStatus: 'dry_status',
  remainingDryTimeSec: 'rdt',
  mapStatus: 'map_status',
  labStatus: 'lab_status',
  switchMapMode: 'switch_map_mode',
  inCleaning: 'in_cleaning',
  cleanPercent: 'clean_percent',
};

export const LAB_STATUS_MAP_SAVING = 1;
export const LAB_STATUS_MULTI_LEVEL = 2;
export const SWITCH_MAP_MODE_SMART = 0;
export const SWITCH_MAP_MODE_MANUAL = 1;

/** loadedMapFlag when no saved map is loaded: after a mapping run, or with no map at all (map_status 252-255). */
export const UNSAVED_MAP_FLAG = 63;
/** map_status bit set while the robot holds any map. */
export const MAP_STATUS_PRESENT = 1;

export function multiLevelEnabled(s: VacuumStatus): boolean | undefined {
  return s.labStatus === undefined ? undefined : (s.labStatus & LAB_STATUS_MULTI_LEVEL) !== 0;
}

/** False on a robot that will not store a map: it refuses manual_segment_map (issue #17). */
export function mapSavingEnabled(s: VacuumStatus): boolean | undefined {
  return s.labStatus === undefined ? undefined : (s.labStatus & LAB_STATUS_MAP_SAVING) !== 0;
}

/** mapFlag of the loaded map: map_status >> 2, or UNSAVED_MAP_FLAG while a new map is unsaved. */
export function loadedMapFlag(s: VacuumStatus): number | undefined {
  return s.mapStatus === undefined ? undefined : s.mapStatus >> 2;
}

/** True while the robot holds a newly built map that has not been saved. */
export function unsavedMapPresent(s: VacuumStatus): boolean {
  return loadedMapFlag(s) === UNSAVED_MAP_FLAG && s.mapStatus !== undefined && (s.mapStatus & MAP_STATUS_PRESENT) !== 0;
}

export const DockErrorCodes = {
  OK: 0,
  DUCT_BLOCKAGE: 34,
  WATER_EMPTY: 38,
  DIRTY_TANK_FULL: 39,
  DIRTY_TANK_LATCH_OPEN: 44,
  NO_DUSTBIN: 46,
  CLEANING_TANK_FULL_OR_BLOCKED: 53,
} as const;

export function describeDockError(code: number): string {
  switch (code) {
    case DockErrorCodes.OK: return '';
    case DockErrorCodes.DUCT_BLOCKAGE: return 'Dock dust duct blocked';
    case DockErrorCodes.WATER_EMPTY: return 'Clean water tank empty';
    case DockErrorCodes.DIRTY_TANK_FULL: return 'Dirty water tank full';
    case DockErrorCodes.DIRTY_TANK_LATCH_OPEN: return 'Dirty water tank latch open';
    case DockErrorCodes.NO_DUSTBIN: return 'Dock dust bag missing';
    case DockErrorCodes.CLEANING_TANK_FULL_OR_BLOCKED: return 'Dock cleaning tray full or blocked';
    default: return `Dock error ${code}`;
  }
}

export const State = {
  STARTING: 1,
  CHARGER_DISCONNECTED: 2,
  IDLE: 3,
  REMOTE_CONTROL_ACTIVE: 4,
  CLEANING: 5,
  RETURNING_HOME: 6,
  MANUAL_MODE: 7,
  CHARGING: 8,
  CHARGING_ERROR: 9,
  PAUSED: 10,
  SPOT_CLEANING: 11,
  ERROR: 12,
  SHUTTING_DOWN: 13,
  UPDATING: 14,
  DOCKING: 15,
  GOING_TO_TARGET: 16,
  ZONED_CLEANING: 17,
  SEGMENT_CLEANING: 18,
  EMPTYING_BIN: 22,
  WASHING_MOP: 23,
  NOT_CHARGING: 24,
  GOING_TO_WASH_MOP: 26,
  DRYING_MOP: 27,
  RETURNING_TO_DOCK_FOR_DRYING: 28,
  /** The robot reports 29 for the whole app_start_build_map run. */
  MAPPING: 29,
  CHARGING_COMPLETE: 100,
} as const;

export function describeState(state: number): string {
  switch (state) {
    case State.STARTING: return 'Starting';
    case State.CHARGER_DISCONNECTED: return 'Charger disconnected';
    case State.IDLE: return 'Idle';
    case State.REMOTE_CONTROL_ACTIVE: return 'Remote control';
    case State.CLEANING: return 'Cleaning';
    case State.RETURNING_HOME: return 'Returning home';
    case State.MANUAL_MODE: return 'Manual mode';
    case State.CHARGING: return 'Charging';
    case State.CHARGING_ERROR: return 'Charging error';
    case State.PAUSED: return 'Paused';
    case State.SPOT_CLEANING: return 'Spot cleaning';
    case State.ERROR: return 'Error';
    case State.SHUTTING_DOWN: return 'Shutting down';
    case State.UPDATING: return 'Updating';
    case State.DOCKING: return 'Docking';
    case State.GOING_TO_TARGET: return 'Going to target';
    case State.ZONED_CLEANING: return 'Zoned cleaning';
    case State.SEGMENT_CLEANING: return 'Room cleaning';
    case State.MAPPING: return 'Mapping';
    case State.NOT_CHARGING: return 'Idle';
    case State.WASHING_MOP: return 'Washing mop';
    case State.GOING_TO_WASH_MOP: return 'Going to wash mop';
    case State.DRYING_MOP: return 'Drying mop';
    case State.RETURNING_TO_DOCK_FOR_DRYING: return 'Returning to dock';
    case State.EMPTYING_BIN: return 'Emptying the bin';
    case State.CHARGING_COMPLETE: return 'Fully charged';
    default: return `State ${state}`;
  }
}

const ERROR_TEXT: Record<number, string> = {
  1: 'Laser sensor fault',
  2: 'Collision sensor fault',
  3: 'Wheel floating',
  4: 'Cliff sensor fault',
  5: 'Main brush blocked',
  6: 'Side brush blocked',
  7: 'Wheel blocked',
  8: 'Robot stuck',
  9: 'Dustbin missing',
  10: 'Filter blocked',
  11: 'Magnetic field detected',
  12: 'Low battery',
  13: 'Charging problem',
  14: 'Battery failure',
  15: 'Wall sensor fault',
  16: 'Uneven surface',
  17: 'Side brush failure',
  18: 'Suction fan failure',
  19: 'Unpowered dock',
  21: 'Laser pressure sensor problem',
  22: 'Charge sensor problem',
  23: 'Dock problem',
  24: 'No-go zone or invisible wall detected',
  25: 'Mop pad dirty',
  26: 'Mop wash tank empty',
  27: 'Dirty water tank full',
  28: 'Mop pad not installed',
  29: 'Battery overheating',
  30: 'Mop pad blocked',
  31: 'Mop pad not installed',
  32: 'Dustbin not installed',
};

export function describeError(code: number): string {
  if (code === 0) return '';
  return ERROR_TEXT[code] ?? `Error code ${code}`;
}

export const FanPower = {
  QUIET: 101,
  BALANCED: 102,
  TURBO: 103,
  MAX: 104,
  /** No suction: what the official app sets for its Mop tab. */
  OFF: 105,
  CUSTOM: 106,
  SMART: 110,
} as const;

export const WaterBoxMode = {
  OFF: 200,
  LOW: 201,
  MEDIUM: 202,
  HIGH: 203,
  CUSTOM: 204,
  SMART: 209,
  SLIDE_MEDIUM: 235,
} as const;

/** Pure-water-flow robots report 201/202/203 back as 225/235/245. */
export function normalizeWaterMode(code: number | undefined): number | undefined {
  switch (code) {
    case 225: return WaterBoxMode.LOW;
    case WaterBoxMode.SLIDE_MEDIUM: return WaterBoxMode.MEDIUM;
    case 245: return WaterBoxMode.HIGH;
    default: return code;
  }
}

export const MopRoute = {
  STANDARD: 300,
  DEEP: 301,
  CUSTOM: 302,
  DEEP_PLUS: 303,
  FAST: 304,
  SMART: 306,
} as const;

/** States in which the robot is out doing something and map or settings edits are refused. */
export const ACTIVE_STATES: ReadonlySet<number> = new Set([
  State.STARTING,
  State.CLEANING,
  State.RETURNING_HOME,
  State.MANUAL_MODE,
  State.PAUSED,
  State.SPOT_CLEANING,
  State.DOCKING,
  State.GOING_TO_TARGET,
  State.ZONED_CLEANING,
  State.SEGMENT_CLEANING,
  State.MAPPING,
]);

export const CLEANING_STATES: ReadonlySet<number> = new Set([
  State.CLEANING,
  State.SPOT_CLEANING,
  State.ZONED_CLEANING,
  State.SEGMENT_CLEANING,
]);

/** Reads bit `bit` of the hex newFeatureSet string, counting from its last character. */
export function newFeatureBit(newFeatureSet: string | null | undefined, bit: number): boolean {
  if (!newFeatureSet) return false;
  const fromEnd = 1 + Math.floor(bit / 4);
  if (fromEnd > newFeatureSet.length) return false;
  const nibble = parseInt(newFeatureSet[newFeatureSet.length - fromEnd]!, 16);
  if (Number.isNaN(nibble)) return false;
  return ((nibble >> (bit % 4)) & 1) === 1;
}

/** python-roborock NewFeatureStrBit.SMART_CLEAN_MODE_SET */
export const isSmartPlanSupported = (nfs: string | null | undefined) => newFeatureBit(nfs, 55);
/** python-roborock NewFeatureStrBit.WATER_SLIDE_MODE */
export const isWaterSlideSupported = (nfs: string | null | undefined) => newFeatureBit(nfs, 106);

/** SmartPlan is on if any of the three values is its smart code. */
export function isSmartModeSet(fan?: number, water?: number, mop?: number | null): boolean {
  return fan === FanPower.SMART || water === WaterBoxMode.SMART || mop === MopRoute.SMART;
}

/** Per-room settings are on if any of the three values is its custom code. */
export function isCustomizeModeSet(fan?: number, water?: number, mop?: number | null): boolean {
  return fan === FanPower.CUSTOM || water === WaterBoxMode.CUSTOM || mop === MopRoute.CUSTOM;
}

/** One room's settings, with codes from FanPower, WaterBoxMode and MopRoute. */
export interface RoomCleanMode {
  segment: number;
  fanPower: number;
  waterBoxMode: number;
  mopMode: number;
}

/** What a room without stored settings starts from. */
export function defaultRoomCleanMode(segment: number): RoomCleanMode {
  return { segment, fanPower: FanPower.BALANCED, waterBoxMode: WaterBoxMode.LOW, mopMode: MopRoute.STANDARD };
}

/** One entry per room in `segments`, the stored one where the robot has it. */
export function roomCleanModesFor(segments: number[], stored: RoomCleanMode[]): RoomCleanMode[] {
  const bySegment = new Map(stored.map((m) => [m.segment, m]));
  return segments.map((s) => bySegment.get(s) ?? defaultRoomCleanMode(s));
}

export const CONSUMABLE_LIFETIME_S = {
  mainBrush: 300 * 3600,
  sideBrush: 200 * 3600,
  filter: 150 * 3600,
  sensor: 30 * 3600,
  cleaningBrush: 300 * 3600,
  strainer: 150 * 3600,
} as const;

/**
 * Only plain ASCII names for map names: the captured `length` can't tell a character count from a
 * byte count, and the two differ for names like "Kælder".
 */
export function mapNameBlocker(name: string): string | null {
  if (name.trim().length === 0) return 'Give the map a name';
  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i);
    if (code < 0x20 || code > 0x7e) {
      return 'Map names can only use plain letters, digits and punctuation for now (no æ, ø, å or emoji)';
    }
  }
  return null;
}

/** Longest room name allowed (the server's real limit is unknown; 23 keeps map labels short). */
export const MAX_ROOM_NAME_LENGTH = 23;

/** Problem with a room name, or null. A leading { or [ makes the server read the form body as JSON. */
export function roomNameProblem(name: string): string | null {
  const clean = name.trim();
  if (clean.length === 0) return 'Enter a room name';
  if (clean.length > MAX_ROOM_NAME_LENGTH) return `Room names can be at most ${MAX_ROOM_NAME_LENGTH} characters`;
  if (clean.startsWith('{') || clean.startsWith('[')) return "Room names can't start with { or [";
  return null;
}
