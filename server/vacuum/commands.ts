import { NEW_RECT_CARPET_FLAGS, MAX_MAP_COORD_MM, MAX_RESTRICTION_VERTICES, restrictionVertexCount, type MapZone, type VirtualWall } from '../../shared/map.js';
import { FanPower, WaterBoxMode, mapNameBlocker, normalizeWaterMode, type RoomCleanMode } from '../../shared/codes.js';
import { mapIndexBlocker } from '../../shared/mapEdit.js';
import { asInt, errorCode, isObject, type V1Response } from '../protocol/envelope.js';
import { JsonDouble, type JsonValue } from '../protocol/json.js';
import { MapEditError, RobotCommandError, RobotSilentError, RobotUnsupportedCommandError } from './errors.js';
import type { DataParamsFormat, VacuumSession } from './session.js';

/*
 * Robot commands, ported from LocalRock's Commands.kt, MapEditCommands.kt, CleanSequence.kt,
 * RoomCleanModes.kt and SmartPlan.kt. Map-edit payloads are copied from captures of the official
 * app on an S8 Pro Ultra (see test/commands.test.ts for the captured strings).
 */

export function requireOk(resp: V1Response, method: string): V1Response {
  if (resp.error) throw new RobotCommandError(method, resp.error);
  return resp;
}

// ---- Basic control --------------------------------------------------------------------------

export const appStart = (s: VacuumSession) => s.sendCommand('app_start');
export const appPause = (s: VacuumSession) => s.sendCommand('app_pause');
export const appStop = (s: VacuumSession) => s.sendCommand('app_stop');
export const appCharge = (s: VacuumSession) => s.sendCommand('app_charge');
export const getRoomMapping = (s: VacuumSession) => s.sendCommand('get_room_mapping');
export const getStatusRaw = (s: VacuumSession, timeoutMs?: number) =>
  s.sendCommand('get_status', [], timeoutMs ? { timeoutMs } : {});

export function appSegmentClean(s: VacuumSession, roomIds: number[], repeat = 1) {
  return s.sendCommand('app_segment_clean', [{ segments: roomIds, repeat }]);
}

export const setCustomMode = (s: VacuumSession, level: number) => s.sendCommand('set_custom_mode', [level]);
export const setWaterBoxCustomMode = (s: VacuumSession, level: number) => s.sendCommand('set_water_box_custom_mode', [level]);
export const getConsumable = (s: VacuumSession) => s.sendCommand('get_consumable');
export const appStartCollectDust = (s: VacuumSession) => s.sendCommand('app_start_collect_dust');
export const appStartWash = (s: VacuumSession) => s.sendCommand('app_start_wash');
export const appStopWash = (s: VacuumSession) => s.sendCommand('app_stop_wash');
export const getCleanRecord = (s: VacuumSession, recordId: number) => s.sendCommand('get_clean_record', [recordId]);
export const getCleanSummary = (s: VacuumSession) => s.sendCommand('get_clean_summary');
export const resetConsumable = (s: VacuumSession, field: string) => s.sendCommand('reset_consumable', [field]);
export const findMe = (s: VacuumSession) => s.sendCommand('find_me');
export const appRcStart = (s: VacuumSession) => s.sendCommand('app_rc_start');
export const appRcEnd = (s: VacuumSession) => s.sendCommand('app_rc_end');

export function appRcMove(s: VacuumSession, velocity: number, omega: number, durationMs: number) {
  return s.sendCommand('app_rc_move', [{
    velocity: new JsonDouble(velocity),
    omega: new JsonDouble(omega),
    duration: Math.round(durationMs),
  }]);
}

export const appGotoTarget = (s: VacuumSession, x: number, y: number) => s.sendCommand('app_goto_target', [x, y]);

export interface ZoneRect { x1: number; y1: number; x2: number; y2: number; times: number }

export function appZonedClean(s: VacuumSession, zones: ZoneRect[]) {
  return s.sendCommand('app_zoned_clean', zones.map((z) => [z.x1, z.y1, z.x2, z.y2, z.times]));
}

export const getTimer = (s: VacuumSession) => s.sendCommand('get_timer');

export function setTimer(s: VacuumSession, id: string, enabled: boolean, cron: string) {
  return s.sendCommand('set_timer', [[id, [enabled ? 'on' : 'off', [cron, ['start_clean', {}]]]]]);
}

export const delTimer = (s: VacuumSession, id: string) => s.sendCommand('del_timer', [id]);
export const updTimer = (s: VacuumSession, id: string, enabled: boolean) => s.sendCommand('upd_timer', [[id, enabled ? 'on' : 'off']]);

export const getSoundVolume = (s: VacuumSession) => s.sendCommand('get_sound_volume');
export const setSoundVolume = (s: VacuumSession, volume: number) => s.sendCommand('change_sound_volume', [volume]);
export const getChildLock = (s: VacuumSession) => s.sendCommand('get_child_lock_status');
export const setChildLock = (s: VacuumSession, locked: boolean) => s.sendCommandRaw('set_child_lock_status', { lock_status: locked ? 1 : 0 });
export const getLedStatus = (s: VacuumSession) => s.sendCommand('get_led_status');
/**
 * The LED is the bare value [1], the shape get_led_status answers: an S8 Pro Ultra (a70) and a Qrevo
 * Curv 2 Flow (a245) answer [{"led_status": 1}] with -10005 "Invalid type".
 */
export const ledStatusParams = (on: boolean): JsonValue => [on ? 1 : 0];
export const setLedStatus = (s: VacuumSession, on: boolean) => s.sendCommand('set_led_status', ledStatusParams(on));
export const getMopMode = (s: VacuumSession) => s.sendCommand('get_mop_mode');
export const setMopMode = (s: VacuumSession, mode: number) => s.sendCommand('set_mop_mode', [mode]);


/** Sets suction, water and route at once; the only way in or out of SmartPlan. */
export function encodeCleanMotorModeParams(fanPower: number, waterBoxMode: number, mopMode: number): JsonValue {
  return [{ fan_power: fanPower, water_box_mode: waterBoxMode, mop_mode: mopMode }];
}

export const setCleanMotorMode = (s: VacuumSession, fan: number, water: number, mop: number) =>
  s.sendCommandRaw('set_clean_motor_mode', encodeCleanMotorModeParams(fan, water, mop));

export const appSetDryerStatus = (s: VacuumSession, on: boolean) => s.sendCommandRaw('app_set_dryer_status', { status: on ? 1 : 0 });
export const getCarpetCleanMode = (s: VacuumSession) => s.sendCommand('get_carpet_clean_mode');
/** A bare object like the official app; a Curv 2 Flow refuses the list form ("param is not an object"). */
export const setCarpetCleanMode = (s: VacuumSession, mode: number) => s.sendCommandRaw('set_carpet_clean_mode', { carpet_clean_mode: mode });
export const getWashTowelMode = (s: VacuumSession) => s.sendCommand('get_wash_towel_mode');
export const setWashTowelMode = (s: VacuumSession, mode: number) => s.sendCommand('set_wash_towel_mode', [{ wash_mode: mode }]);
export const getSmartWashParams = (s: VacuumSession) => s.sendCommand('get_smart_wash_params');
export const setSmartWashParams = (s: VacuumSession, washFreq: number) =>
  s.sendCommand('set_smart_wash_params', [{ smart_wash: 0, wash_interval: washFreq + 1 }]);
export const getDustCollectionMode = (s: VacuumSession) => s.sendCommand('get_dust_collection_mode');
export const setDustCollectionMode = (s: VacuumSession, mode: number) => s.sendCommand('set_dust_collection_mode', [{ mode }]);
export const getDndTimer = (s: VacuumSession) => s.sendCommand('get_dnd_timer');
export const setDndTimer = (s: VacuumSession, sh: number, sm: number, eh: number, em: number) =>
  s.sendCommand('set_dnd_timer', [{ start_hour: sh, start_minute: sm, end_hour: eh, end_minute: em }]);
export const closeDndTimer = (s: VacuumSession) => s.sendCommand('close_dnd_timer');
export const getMultiMapsList = (s: VacuumSession) => s.sendCommand('get_multi_maps_list');

// ---- The {"data": ..., "need_retry": 1} form and its plain fallback ------------------------

/** The robot's answer to params in a shape it does not take (S7: "Param is not an array"). */
export const PARAM_FORMAT_REFUSED_CODE = -10005;
/** The robot's answer when it can't divide a room along the given line. */
export const SPLIT_FAILED_CODE = -10006;
/** Firmware that knows the wrapped form acknowledged it with ["retry"] within a second. */
const RETRY_ACK_TIMEOUT_MS = 6_000;
/** Map edits make the robot rewrite its map; the captured final answers took 2-4 s. */
export const MAP_EDIT_TIMEOUT_MS = 20_000;

export function withRetry(data: JsonValue): JsonValue {
  return { data, need_retry: 1 };
}

/**
 * Send a command whose captured params are {"data": data, "need_retry": 1}. Older firmware takes
 * `data` alone, so the plain form follows when the robot refuses the shape (-10005) or stays
 * silent. Once the plain form has been taken, `format` keeps the robot on it.
 */
export async function sendDataCommand(
  format: DataParamsFormat,
  data: JsonValue,
  send: (params: JsonValue, wrapped: boolean) => Promise<V1Response>,
): Promise<V1Response> {
  if (!format.plain) {
    let answer: V1Response | null = null;
    try {
      answer = await send(withRetry(data), true);
    } catch (e) {
      if (!(e instanceof RobotSilentError)) throw e;
    }
    if (answer && errorCode(answer.error) !== PARAM_FORMAT_REFUSED_CODE) return answer;
  }
  const answer = await send(data, false);
  if (errorCode(answer.error) !== PARAM_FORMAT_REFUSED_CODE) format.plain = true;
  return answer;
}

export async function sendData(s: VacuumSession, method: string, data: JsonValue): Promise<V1Response> {
  const answer = await sendDataCommand(s.dataParamsFormat, data, (params, wrapped) =>
    s.sendCommandRaw(method, params, {
      timeoutMs: MAP_EDIT_TIMEOUT_MS,
      ...(wrapped ? { firstReplyTimeoutMs: RETRY_ACK_TIMEOUT_MS } : {}),
    }));
  return requireOk(answer, method);
}

// ---- Map editing ----------------------------------------------------------------------------

const SAVE_MAP_TYPE_NO_GO = 0;
const SAVE_MAP_TYPE_WALL = 1;
/** Trailing entry the official app always appends to save_map: [100, mapIndex]. */
const SAVE_MAP_TYPE_MAP_INDEX = 100;
const NO_DIRECTION = -1;
export const CARPET_AREA_TYPE = 1;
export const THRESHOLD_TYPE = 2;

function coord(v: number): number {
  if (!Number.isInteger(v) || v < 0 || v > MAX_MAP_COORD_MM) throw new MapEditError(`Coordinate ${v} mm is outside the map`);
  return v;
}

function quad(z: MapZone): number[] {
  return [coord(z.x0), coord(z.y0), coord(z.x1), coord(z.y1), coord(z.x2), coord(z.y2), coord(z.x3), coord(z.y3)];
}

/** [walls..., no-go zones..., [100, mapIndex]], the order the official app used. */
export function saveMapData(noGoZones: MapZone[], walls: VirtualWall[], mapIndex: number): JsonValue {
  if (mapIndex !== 0) throw new MapEditError('Saving zones is only confirmed for map index 0');
  const vertices = restrictionVertexCount(walls.length, noGoZones.length);
  if (vertices > MAX_RESTRICTION_VERTICES) {
    throw new MapEditError(`Too many restrictions: ${vertices} of ${MAX_RESTRICTION_VERTICES} points used`);
  }
  const entries: JsonValue[] = [];
  for (const w of walls) entries.push([SAVE_MAP_TYPE_WALL, coord(w.x0), coord(w.y0), coord(w.x1), coord(w.y1)]);
  for (const z of noGoZones) entries.push([SAVE_MAP_TYPE_NO_GO, ...quad(z)]);
  entries.push([SAVE_MAP_TYPE_MAP_INDEX, mapIndex]);
  return entries;
}

export function splitSegmentData(segment: number, xA: number, yA: number, xB: number, yB: number): JsonValue {
  return [segment, coord(xA), coord(yA), coord(xB), coord(yB)];
}

export function mergeSegmentData(a: number, b: number): JsonValue {
  return [a, b];
}

/** {"data": [[segment, material, direction]]}; direction is -1 unless the floor is wood. */
export function encodeGroundMaterialParams(segment: number, materialId: number, direction: number | null): JsonValue {
  return { data: [[segment, materialId, direction ?? NO_DIRECTION]] };
}

/** One row of the robot's segment table, as get_room_mapping returns it. */
export interface SegmentEntry {
  segment: number;
  roomId: string;
  tagId: number;
}

/** The whole table sorted by segment, like the official app sent it. */
export function nameSegmentData(table: SegmentEntry[]): JsonValue {
  return [...table]
    .sort((a, b) => a.segment - b.segment)
    .map((e) => ({ iotRoomId: e.roomId, robotRoomId: e.segment, robotTagId: e.tagId }));
}

/** The final name_segment answer: [{"oldId": 16, "newId": 16}, ...] as old -> new. */
export function parseSegmentRenumbering(result: unknown): Map<number, number> {
  const out = new Map<number, number>();
  if (!Array.isArray(result)) return out;
  for (const e of result) {
    if (!isObject(e)) continue;
    const oldId = asInt(e['oldId']);
    const newId = asInt(e['newId']);
    if (oldId !== null && newId !== null) out.set(oldId, newId);
  }
  return out;
}

/**
 * {"map_index": 0, "type": 1, "zone_data": [[8 coords], ...]}, the complete set of carpets. A map
 * that stores carpet flags gets "flags" first, one per carpet; new carpets get the rectangle value.
 */
export function encodeCarpetAreaParams(carpets: MapZone[], mapIndex: number, withFlags: boolean): JsonValue {
  const problem = mapIndexBlocker(mapIndex);
  if (problem) throw new MapEditError(problem);
  const out: Record<string, JsonValue> = {};
  if (withFlags) out['flags'] = carpets.map((c) => c.flags ?? NEW_RECT_CARPET_FLAGS);
  out['map_index'] = mapIndex;
  out['type'] = CARPET_AREA_TYPE;
  out['zone_data'] = carpets.map(quad);
  return out;
}

/** {"map_index": 0, "sides_infos": [[0,0,0,0], ...], "zones": [[2, 8 coords], ...]}, the complete set. */
export function encodeThresholdParams(thresholds: MapZone[], mapIndex: number): JsonValue {
  const problem = mapIndexBlocker(mapIndex);
  if (problem) throw new MapEditError(problem);
  return {
    map_index: mapIndex,
    sides_infos: thresholds.map(() => [0, 0, 0, 0]),
    zones: thresholds.map((t) => [THRESHOLD_TYPE, ...quad(t)]),
  };
}

/**
 * The two ways to send a split line, in the order to try them: the robot refused a line and
 * accepted it with its ends swapped; the accepted one started at the lower Y.
 */
export function splitLineAttempts(a: [number, number], b: [number, number]): Array<[[number, number], [number, number]]> {
  const aFirst = a[1] < b[1] || (a[1] === b[1] && a[0] <= b[0]);
  const first: [[number, number], [number, number]] = aFirst ? [a, b] : [b, a];
  return [first, [first[1], first[0]]];
}

export const startEditMap = async (s: VacuumSession) => requireOk(await s.sendCommand('start_edit_map'), 'start_edit_map');
export const endEditMap = async (s: VacuumSession) => requireOk(await s.sendCommand('end_edit_map'), 'end_edit_map');

/** Run `block` between start_edit_map and end_edit_map; end_edit_map is sent even when it fails. */
export async function inEditSession<T>(s: VacuumSession, block: () => Promise<T>): Promise<T> {
  await startEditMap(s);
  try {
    return await block();
  } finally {
    try { await endEditMap(s); } catch { /* best effort */ }
  }
}

export const saveMap = (s: VacuumSession, noGo: MapZone[], walls: VirtualWall[], mapIndex: number) =>
  sendData(s, 'save_map', saveMapData(noGo, walls, mapIndex));

/** True when the answer is "unknown_method", bare or as the only item of a list. */
export function isUnknownMethod(resp: V1Response): boolean {
  const r = resp.result;
  const v = Array.isArray(r) && r.length === 1 ? r[0] : r;
  return v === 'unknown_method';
}

/** requireOk, and also fails when the robot doesn't know the command; that answer carries no error object. */
export function requireApplied(resp: V1Response, method: string): V1Response {
  requireOk(resp, method);
  if (isUnknownMethod(resp)) throw new RobotUnsupportedCommandError(method);
  return resp;
}

export const setCarpetAreas = async (s: VacuumSession, carpets: MapZone[], mapIndex: number, withFlags: boolean) =>
  requireOk(await s.sendCommandRaw('set_carpet_area', encodeCarpetAreaParams(carpets, mapIndex, withFlags), { timeoutMs: MAP_EDIT_TIMEOUT_MS }), 'set_carpet_area');

export const setThresholds = async (s: VacuumSession, thresholds: MapZone[], mapIndex: number) =>
  requireOk(await s.sendCommandRaw('app_set_smart_door_sill', encodeThresholdParams(thresholds, mapIndex), { timeoutMs: MAP_EDIT_TIMEOUT_MS }), 'app_set_smart_door_sill');

export const mergeSegment = (s: VacuumSession, a: number, b: number) => sendData(s, 'merge_segment', mergeSegmentData(a, b));

export const splitSegment = (s: VacuumSession, segment: number, xA: number, yA: number, xB: number, yB: number) =>
  sendData(s, 'split_segment', splitSegmentData(segment, xA, yA, xB, yB));

export const setSegmentGroundMaterial = async (s: VacuumSession, segment: number, materialId: number, direction: number | null) =>
  requireOk(await s.sendCommandRaw('set_segment_ground_material', encodeGroundMaterialParams(segment, materialId, direction), { timeoutMs: MAP_EDIT_TIMEOUT_MS }), 'set_segment_ground_material');

export const nameSegment = (s: VacuumSession, table: SegmentEntry[]) => sendData(s, 'name_segment', nameSegmentData(table));

// ---- Map management -------------------------------------------------------------------------

/** [{"length": 4, "multi_map": 0, "name": "Test"}] */
export function encodeNameMultiMapParams(mapFlag: number, name: string): JsonValue {
  const problem = mapNameBlocker(name);
  if (problem) throw new MapEditError(problem);
  return [{ length: name.length, multi_map: mapFlag, name }];
}

export const nameMultiMap = async (s: VacuumSession, mapFlag: number, name: string) =>
  requireOk(await s.sendCommand('name_multi_map', encodeNameMultiMapParams(mapFlag, name)), 'name_multi_map');

/** Deletes the map with its rooms, names, zones, walls, carpets and thresholds. */
export const deleteMap = async (s: VacuumSession, mapFlag: number) => requireOk(await s.sendCommand('del_map', [mapFlag]), 'del_map');

export const startBuildMap = async (s: VacuumSession) => requireOk(await s.sendCommand('app_start_build_map'), 'app_start_build_map');

export const loadMultiMap = (s: VacuumSession, mapFlag: number) => sendData(s, 'load_multi_map', [mapFlag]);

/** manual_segment_map [{"map_flag": -1}]: store the map just built as a new map (answer took ~7 s). */
export const saveNewMap = async (s: VacuumSession) =>
  requireOk(await s.sendCommand('manual_segment_map', [{ map_flag: -1 }], { timeoutMs: 60_000 }), 'manual_segment_map');

export function labStatusData(labStatus: number, reserveMap: number | null): JsonValue {
  const entry: Record<string, JsonValue> = { lab_status: labStatus };
  if (reserveMap !== null) entry['reserve_map'] = reserveMap;
  return [entry];
}

export const setLabStatus = (s: VacuumSession, labStatus: number, reserveMap: number | null) =>
  sendData(s, 'set_lab_status', labStatusData(labStatus, reserveMap));

export const setSwitchMapMode = async (s: VacuumSession, mode: number) =>
  requireOk(await s.sendCommandRaw('set_switch_map_mode', { mode }), 'set_switch_map_mode');

// ---- Cleaning order -------------------------------------------------------------------------

export function parseCleanSequence(result: unknown): number[] {
  if (!Array.isArray(result)) return [];
  return result.map(asInt).filter((v): v is number => v !== null);
}

/**
 * The sequence to store so the robot cleans `picked` in that order: picked rooms first, then the
 * rest of `stored`. Null when nothing has to change.
 */
export function cleanSequenceFor(picked: number[], stored: number[]): number[] | null {
  const order = [...new Set(picked)];
  if (order.length < 2) return null;
  const storedPicked = stored.filter((s) => order.includes(s));
  if (storedPicked.length === order.length && storedPicked.every((v, i) => v === order[i])) return null;
  return [...new Set([...order, ...stored])];
}

export const getCleanSequence = async (s: VacuumSession) => requireOk(await s.sendCommand('get_clean_sequence'), 'get_clean_sequence');
export const setCleanSequence = (s: VacuumSession, order: number[]) => sendData(s, 'set_clean_sequence', order);

// ---- Per-room settings ----------------------------------------------------------------------

/** [{"fan_power", "mop_mode", "segment", "water_box_mode"}, ...], keys in the captured order. */
export function customizeCleanModeData(modes: RoomCleanMode[]): JsonValue {
  if (modes.length === 0) throw new MapEditError('There are no rooms to save settings for');
  if (modes.some((m) => m.fanPower === FanPower.OFF && m.waterBoxMode === WaterBoxMode.OFF)) {
    throw new MapEditError('Every room needs suction or water');
  }
  return modes.map((m) => ({ fan_power: m.fanPower, mop_mode: m.mopMode, segment: m.segment, water_box_mode: m.waterBoxMode }));
}

export function parseCustomizeCleanMode(result: unknown): RoomCleanMode[] {
  if (!Array.isArray(result)) return [];
  const out: RoomCleanMode[] = [];
  for (const e of result) {
    if (!isObject(e)) continue;
    const segment = asInt(e['segment']);
    const fanPower = asInt(e['fan_power']);
    const waterBoxMode = asInt(e['water_box_mode']);
    const mopMode = asInt(e['mop_mode']);
    if (segment === null || fanPower === null || waterBoxMode === null || mopMode === null) continue;
    out.push({ segment, fanPower, waterBoxMode, mopMode });
  }
  return out;
}

/** True when the robot holds `sent`, whatever else it holds and in whatever order. */
export function roomCleanModesStored(sent: RoomCleanMode[], stored: RoomCleanMode[]): boolean {
  const key = (m: RoomCleanMode) => `${m.segment}:${m.fanPower}:${normalizeWaterMode(m.waterBoxMode) ?? m.waterBoxMode}:${m.mopMode}`;
  const held = new Set(stored.map(key));
  return sent.every((m) => held.has(key(m)));
}

export const getCustomizeCleanMode = async (s: VacuumSession) =>
  requireOk(await s.sendCommand('get_customize_clean_mode'), 'get_customize_clean_mode');
export const setCustomizeCleanMode = (s: VacuumSession, modes: RoomCleanMode[]) =>
  sendData(s, 'set_customize_clean_mode', customizeCleanModeData(modes));

// ---- Camera ---------------------------------------------------------------------------------

/** The camera RPCs the browser may send; each takes a bare object or no params, as captured. */
export const CAMERA_METHODS: ReadonlySet<string> = new Set([
  'check_homesec_password',
  'set_homesec_password',
  'reset_homesec_password',
  'get_homesec_connect_status',
  'start_camera_preview',
  'stop_camera_preview',
  'get_camera_status',
  'get_turn_server',
  'send_sdp_to_robot',
  'get_device_sdp',
  'send_ice_to_robot',
  'get_device_ice',
]);
