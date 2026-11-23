import { newFeatureBit } from './codes.js';

/*
 * Robot options that newer firmware advertises through a newFeatureSet bit and exposes as a get/set
 * command pair, ported from LocalRock's BetaFeatures.kt. Bit indexes and command names follow
 * python-roborock (NewFeatureStrBit, RoborockCommand); a null bit means none is known, so the option
 * shows only if the robot answers its get command with a value it can hold. The set payload is not
 * documented there, so it mirrors the get reply's shape (see featureSetParamCandidates).
 */

/** The settings section an option is shown in, following the official app's grouping. */
export type FeatureSection = 'CARPET' | 'FLOOR' | 'OBSTACLE' | 'DOCK' | 'ROBOT' | 'BETA';

export interface FeatureChoice { value: number; label: string; description?: string }

/** How an option's set command takes the new value. */
export type FeatureWrite =
  /** The new value alone, in the shapes betaSetParamCandidates tries. */
  | 'VALUE'
  /** {"status": n}, whatever the get reply looks like. */
  | 'STATUS'
  /** The whole object read, with readKey changed, as a one-item list. */
  | 'ECHO';

export interface FeatureDef {
  id: string;
  title: string;
  description: string;
  bit: number | null;
  getMethod: string;
  setMethod: string;
  section: FeatureSection;
  /** Set for options reached through app_get/set_robot_setting by name. */
  settingName?: string;
  /** Set for an option with more than two values: shown as a picker. */
  choices?: FeatureChoice[];
  /** Id of an older option this one replaces on robots that advertise this one. */
  replaces?: string;
  /** Set when the value is one field of a larger reply, such as switch_status in get_status. */
  readKey?: string;
  /** Set when the option is some bits of the value read: it is on when any of them is set. */
  readMask?: number;
  write: FeatureWrite;
}

/**
 * The switch_status bit in get_status for Vacuum Carpet First. A Qrevo 2 Pro with the official app's
 * Vacuum Carpet First on and the other two options in that field off reports 8.
 */
export const SWITCH_STATUS_CARPET_FIRST = 0x8;

export const VOICE_ASSISTANT_BIT = 37;
export const MATTER_FEATURE_BIT = 67;
export const VIDEO_PATROL_FEATURE_BIT = 48;
export const PET_SNAPSHOT_FEATURE_BIT = 50;

const def = (d: Omit<FeatureDef, 'section' | 'write'> & Partial<Pick<FeatureDef, 'section' | 'write'>>): FeatureDef =>
  ({ section: 'BETA', write: 'VALUE', ...d });
const robotSetting = (id: string, title: string, description: string, bit: number, section: FeatureSection, settingName: string, extra: Partial<FeatureDef> = {}): FeatureDef =>
  def({ id, title, description, bit, getMethod: 'app_get_robot_setting', setMethod: 'app_set_robot_setting', section, settingName, ...extra });

export const FEATURE_DEFS: FeatureDef[] = [
  def({ id: 'right_brush_stretch', title: 'FlexiArm side brush', description: 'Extends the side brush to reach into corners and along edges', bit: 54, getMethod: 'get_right_brush_stretch_status', setMethod: 'set_right_brush_stretch_status', section: 'FLOOR' }),
  def({ id: 'corner_mop_stretch', title: 'FlexiArm mop', description: 'Extends the mop to clean corners', bit: 40, getMethod: 'get_stretch_tag_status', setMethod: 'set_stretch_tag_status', section: 'FLOOR' }),
  def({ id: 'gap_deep_clean', title: 'Gap deep clean', description: 'Cleans narrow gaps along walls and furniture', bit: 63, getMethod: 'get_gap_deep_clean_status', setMethod: 'set_gap_deep_clean_status', section: 'FLOOR' }),
  def({ id: 'pet_supplies_deep_clean', title: 'Pet supplies deep clean', description: 'Extra cleaning around pet bowls and beds', bit: 43, getMethod: 'get_pet_supplies_deep_clean_status', setMethod: 'set_pet_supplies_deep_clean_status', section: 'FLOOR' }),
  def({ id: 'dirty_object_detect', title: 'Dirty object detection', description: 'Spots dirty objects such as pet waste while cleaning', bit: 56, getMethod: 'get_dirty_object_detect_status', setMethod: 'set_dirty_object_detect_status', section: 'OBSTACLE' }),
  def({ id: 'avoid_collision', title: 'Collision avoidance', description: 'Steers around obstacles instead of bumping them', bit: 36, getMethod: 'get_collision_avoid_status', setMethod: 'set_collision_avoid_status', section: 'OBSTACLE' }),
  // With bit 118 (TWO_GEARS_NO_COLLISION) the official app shows the same value as a two-way picker:
  // a Qrevo 2 Pro reporting 1 showed "High Coverage"; an S8 MaxV went from 1 to 2 on the careful setting.
  def({
    id: 'collision_mode', title: 'Less collision mode', description: 'How closely the robot works around obstacles', bit: 118,
    getMethod: 'get_collision_avoid_status', setMethod: 'set_collision_avoid_status', section: 'OBSTACLE',
    choices: [
      { value: 1, label: 'High coverage', description: 'Reaches more of the floor and cleans closer, and may touch obstacles lightly' },
      { value: 2, label: 'Less collision', description: 'Moves more carefully to avoid bumping or getting stuck, and may miss some spots' },
    ],
    replaces: 'avoid_collision', write: 'STATUS',
  }),
  def({ id: 'water_leak_check', title: 'Water leak detection', description: 'Stops and alerts if the robot detects a water leak', bit: 60, getMethod: 'get_handle_leak_water_status', setMethod: 'set_handle_leak_water_status', section: 'ROBOT' }),
  def({ id: 'voice_control_led', title: 'Voice control light', description: 'Light on the robot that shows when it is listening', bit: 58, getMethod: 'get_ap_mic_led_status', setMethod: 'set_ap_mic_led_status', section: 'ROBOT' }),
  def({
    id: 'carpet_first', title: 'Vacuum carpet first', description: 'Vacuums carpets before mopping the rest, so the mop never wets them', bit: 23,
    getMethod: 'get_status', setMethod: 'app_set_priority_carpet_cleaning_status', section: 'CARPET',
    readKey: 'switch_status', readMask: SWITCH_STATUS_CARPET_FIRST, write: 'STATUS',
  }),
  def({ id: 'carpet_boost', title: 'Carpet boost', description: 'Turns suction up to maximum on carpet', bit: null, getMethod: 'get_carpet_mode', setMethod: 'set_carpet_mode', section: 'CARPET', readKey: 'enable', write: 'ECHO' }),
  def({ id: 'carpet_deep_clean', title: 'Carpet deep clean', description: 'Deeper cleaning passes over carpets', bit: 3, getMethod: 'app_get_carpet_deep_clean_status', setMethod: 'app_set_carpet_deep_clean_status', section: 'CARPET' }),
  robotSetting('avoid_carpet_wires', 'Avoid wires along carpet borders', 'Detects cables near carpet edges and keeps clear of them', 105, 'CARPET', 'nearbycarpet_detecting_wire_status'),
  robotSetting('carpet_side_brush_lift', 'Lower side brush on carpet', 'Keeps the side brush down while cleaning carpets', 104, 'CARPET', 'disable_sidebrush_lift_status'),
  def({ id: 'clean_fluid_delivery', title: 'Auto cleaning fluid', description: 'Adds cleaning fluid to the mop water from the dock', bit: 112, getMethod: 'get_auto_delivery_cleaning_fluid', setMethod: 'set_auto_delivery_cleaning_fluid', section: 'DOCK' }),
  def({ id: 'dust_collection_switch', title: 'Auto empty', description: 'Empties the dust bin into the dock after cleaning', bit: null, getMethod: 'get_dust_collection_switch_status', setMethod: 'set_dust_collection_switch_status', section: 'DOCK' }),
  // With bit 53 (AUTO_COLLECTION_2) the same value is a frequency: a Qrevo 2 Pro reporting 1 showed "Balanced".
  def({
    id: 'dust_collection_frequency', title: 'Auto-empty frequency', description: 'When the dock empties the dustbin', bit: 53,
    getMethod: 'get_dust_collection_switch_status', setMethod: 'set_dust_collection_switch_status', section: 'DOCK',
    choices: [
      { value: 0, label: 'Off', description: 'Never; empty the dustbin by hand' },
      { value: 1, label: 'Balanced', description: 'After each clean' },
      { value: 2, label: 'High', description: 'During cleaning as well, for homes with pets or a lot of carpet' },
    ],
    replaces: 'dust_collection_switch', write: 'STATUS',
  }),
  def({ id: 'identify_furniture', title: 'Furniture recognition', description: 'Recognizes furniture on the map', bit: null, getMethod: 'get_identify_furniture_status', setMethod: 'set_identify_furniture_status' }),
  def({ id: 'identify_ground_material', title: 'Floor type recognition', description: 'Recognizes carpet and hard floor', bit: null, getMethod: 'get_identify_ground_material_status', setMethod: 'set_identify_ground_material_status', section: 'FLOOR' }),
  def({ id: 'follow_ground_material', title: 'Clean by floor type', description: 'Adjusts cleaning to the floor type it detects', bit: null, getMethod: 'get_clean_follow_ground_material_status', setMethod: 'set_clean_follow_ground_material_status', section: 'FLOOR' }),
  robotSetting('uncleaned_area_reminder', 'Uncleaned area reminder', 'Tells you about any uncleaned area after each clean, with a one-tap option to clean it', 154, 'ROBOT', 'enable_omission_area_clean_status'),
  robotSetting('follow_low_obstacles', 'Follow low obstacles', 'Lets the robot follow low obstacles', 117, 'OBSTACLE', 'enable_follow_low_obs_status'),
  robotSetting('full_duplex', 'Full duplex voice', 'Talk and listen at the same time during voice chat', 115, 'ROBOT', 'full_duplex_switch'),
  robotSetting('climbing_arms_high_sill', 'Climbing arms on high thresholds', 'Uses the climbing arms to cross high door thresholds and carpet', 147, 'FLOOR', 'enable_sway_arm_for_high_door_sill_carpet'),
  robotSetting('cleaning_pattern', 'Cleaning pattern', 'How the robot lines up its passes', 70, 'FLOOR', 'clean_direction_status', {
    choices: [
      { value: 0, label: 'Smart', description: 'Runs along the long side of the room' },
      { value: 1, label: 'Along floor direction', description: 'Follows the floor boards or tiles' },
      { value: 2, label: 'Mixed pattern', description: "Crosses the last clean's direction, which is slower" },
    ],
    replaces: 'follow_ground_material',
  }),
  def({ id: 'optimize_battery', title: 'Smart charging', description: 'Charges to 80% first, then slowly to 100%, to protect the battery', bit: 74, getMethod: 'get_optimize_battery_status', setMethod: 'set_optimize_battery_status', section: 'ROBOT' }),
];

/** The options this robot's newFeatureSet advertises (and those every robot is asked). */
export function supportedFeatures(newFeatureSet: string | null | undefined): FeatureDef[] {
  return FEATURE_DEFS.filter((d) => d.bit === null || newFeatureBit(newFeatureSet, d.bit));
}

/**
 * The order to read `defs` in: options gated on a feature bit first, then the ones every robot is
 * asked. A read stops at the first option with no reply, so a robot that ignores an ungated command
 * hides only the ungated options, not the ones its flags advertise.
 */
export function featureReadOrder(defs: FeatureDef[]): FeatureDef[] {
  return [...defs.filter((d) => d.bit !== null), ...defs.filter((d) => d.bit === null)];
}

/** Last read of one option. `key` is the field name in the reply, null when the reply was a bare number. */
export interface FeatureState {
  id: string;
  value: number | null;
  key: string | null;
  /** The object the value was read from, for an option written back whole (ECHO). */
  reply: Record<string, unknown> | null;
}

export function featureDef(id: string): FeatureDef | undefined {
  return FEATURE_DEFS.find((d) => d.id === id);
}

export function featureEnabled(d: FeatureDef, value: number | null): boolean {
  return d.readMask !== undefined ? value !== null && (value & d.readMask) !== 0 : value === 1;
}

/** Whether a read can be shown as a switch or picker. */
export function featureToggleable(d: FeatureDef, value: number | null): boolean {
  return d.choices || d.readMask !== undefined ? value !== null : value === 0 || value === 1;
}

export function choiceLabelFor(choices: FeatureChoice[], value: number): string {
  return choices.find((c) => c.value === value)?.label ?? `Other (${value})`;
}

/** Drops an older option once the option that replaces it has answered, so a failed read keeps the old one. */
export function withoutReplaced<T extends { id: string }>(states: T[]): T[] {
  const replaced = new Set(states.map((s) => featureDef(s.id)?.replaces).filter((r): r is string => !!r));
  return states.filter((s) => !replaced.has(s.id));
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const intOf = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) ? v : null);

/** Reads a reply that holds one number: 1, [1], {"status":1} or [{"status":1}]. */
export function parseBetaReply(result: unknown): { key: string | null; value: number } | null {
  const e = Array.isArray(result) && result.length === 1 ? result[0] : result;
  const n = intOf(e);
  if (n !== null) return { key: null, value: n };
  if (isObj(e)) {
    const entries = Object.entries(e);
    if (entries.length !== 1) return null;
    const v = intOf(entries[0]![1]);
    return v === null ? null : { key: entries[0]![0], value: v };
  }
  return null;
}

/** Reads `d`'s value from its get reply: the readKey field when it has one, else the reply's only number. */
export function parseFeatureReply(d: FeatureDef, result: unknown): { key: string | null; value: number; reply: Record<string, unknown> | null } | null {
  if (d.readKey === undefined) {
    const p = parseBetaReply(result);
    return p ? { ...p, reply: null } : null;
  }
  const o = Array.isArray(result) && result.length === 1 ? result[0] : result;
  if (!isObj(o)) return null;
  const value = intOf(o[d.readKey]);
  return value === null ? null : { key: d.readKey, value, reply: o };
}

/** Param shapes to try for a set command, in order: the wrapped form of the get reply first, then the other usual forms. */
export function betaSetParamCandidates(key: string | null, value: number): unknown[] {
  const obj = key !== null ? { [key]: value } : null;
  return [[obj ?? value], ...(obj ? [obj, [value]] : [])];
}

/** Param shapes to try for writing `value` to an option, in order; empty when the last read lacks what the write needs. */
export function featureSetParamCandidates(d: FeatureDef, state: FeatureState, value: number): unknown[] {
  switch (d.write) {
    case 'VALUE': return betaSetParamCandidates(state.key, value);
    case 'STATUS': return [{ status: value }, [{ status: value }]];
    case 'ECHO': {
      if (d.readKey === undefined || state.reply === null) return [];
      const obj = { ...state.reply, [d.readKey]: value };
      return [[obj], obj];
    }
  }
}

/**
 * Codes a robot answers to a param shape it does not take. Most options say -10007 "invalid params";
 * a Qrevo Curv 2 Flow (a245) says -10005 to the wrapped set_identify_ground_material_status.
 */
export const BETA_SHAPE_REFUSAL_CODES: ReadonlySet<number> = new Set([-10007, -10005]);

/** Indices into the candidate list in the order to try them, the shape the robot last took first. */
export function betaSetTryOrder(count: number, accepted: number | undefined): number[] {
  const all = Array.from({ length: count }, (_, i) => i);
  return accepted === undefined || accepted < 0 || accepted >= count ? all : [accepted, ...all.filter((i) => i !== accepted)];
}

/**
 * Names for newFeatureSet bits from 32 up (python-roborock NewFeatureStrBit), for listing what a robot
 * advertises that LocalRock has no controls for.
 */
const ADVERTISED_FEATURE_NAMES: Record<number, string> = {
  32: 'Two-key real-time video', 33: 'Two-key video while charging', 34: 'Dirty replenish clean', 35: 'Auto delivery status',
  37: 'Voice control', 38: 'New endpoint', 39: 'Pumping water', 41: 'Hot wash towel', 42: 'Floor direction clean any time',
  45: 'Mop shake water max', 47: 'Exact custom mode', 48: 'Video patrol', 49: 'Carpet custom clean', 50: 'Pet snapshot',
  51: 'Custom clean mode count', 52: 'New AI recognition', 53: 'Auto collection 2', 57: 'No carpet press setting',
  62: 'Min battery 15% to clean', 64: 'Object detect check', 66: 'Identify room', 67: 'Matter', 69: 'Workday and holiday',
  70: 'Clean direct status', 71: 'Map eraser', 72: 'Optimize battery', 73: 'Video while charging and standby',
  75: 'Long-haired carpet', 76: 'Clean history timeline', 77: 'Max zones opened', 78: 'Exhibition function', 79: 'LDS lifting',
  80: 'Auto tear down mop', 81: 'Small side mop', 82: 'Side brush up and down', 83: 'Dry interval timer', 84: 'UVC sterilize',
  85: 'Midway back to dock', 86: 'Main brush up and down', 87: 'Egg dance mode', 89: 'Mechanical arm mode', 91: 'Clean timeline',
  93: 'Clean then mop mode', 94: 'Type identify', 96: 'Get particular status', 97: '3D mapping inner test', 98: 'Sync server name',
  99: 'Show arm overload', 100: 'Collect dust count', 101: 'App stop grasp', 102: 'Clean then mop with repeat',
  104: 'Side brush lift on carpet', 105: 'Detect wire carpet', 107: 'Soak and wash', 108: 'Clean efficiency',
  109: 'Back wash new smart', 110: 'Dual-band Wi-Fi', 111: 'Program mode', 113: 'Long-haired carpet EX',
  114: 'Overseas clean then mop', 115: 'Full duplex switch', 116: 'Low area access', 117: 'Follow low obstacles',
  118: 'Two gears no collision', 119: 'Carpet shape type', 120: 'SR map', 128: 'Roller mop',
};

/** Bits with their own place in the app or that name no setting. */
const HANDLED_ELSEWHERE_BITS = new Set([35, 38, 41, 42, 47, 49, 51, 52, 53, 55, 57, 62, 67, 106]);

export interface AdvertisedFeature { bit: number; name: string | null }

/** What the robot advertises in newFeatureSet (bit 32 and up) that has no switch here, in bit order. */
export function unlistedAdvertisedFeatures(newFeatureSet: string | null | undefined): AdvertisedFeature[] {
  if (!newFeatureSet) return [];
  const covered = new Set<number>([...FEATURE_DEFS.map((d) => d.bit).filter((b): b is number => b !== null), ...HANDLED_ELSEWHERE_BITS, VOICE_ASSISTANT_BIT]);
  const out: AdvertisedFeature[] = [];
  for (let bit = 32; bit < newFeatureSet.length * 4; bit++) {
    if (!covered.has(bit) && newFeatureBit(newFeatureSet, bit)) out.push({ bit, name: ADVERTISED_FEATURE_NAMES[bit] ?? null });
  }
  return out;
}

/** The hex feature flags in an app_get_init_status answer (new_feature_info_str), or null. */
export function featureSetFromInitStatus(result: unknown): string | null {
  const o = Array.isArray(result) ? result[0] : result;
  if (!isObj(o)) return null;
  const text = typeof o['new_feature_info_str'] === 'string' ? o['new_feature_info_str'].trim() : '';
  return text && /^[0-9a-fA-F]+$/.test(text) ? text : null;
}

/** The new_feature_info number from the same answer; it can exceed 2^53 in theory, so it is kept as text. */
export function newFeatureInfoFromInitStatus(result: unknown): string | null {
  const o = Array.isArray(result) ? result[0] : result;
  if (!isObj(o)) return null;
  const v = o['new_feature_info'];
  return typeof v === 'number' && Number.isInteger(v) ? String(v) : typeof v === 'string' && /^\d+$/.test(v) ? v : null;
}
