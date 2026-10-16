import { FanPower, MopRoute, WaterBoxMode } from '../shared/codes.js';
import { FloorMaterial, MAX_MAP_COORD_MM } from '../shared/map.js';
import type { App } from './app.js';
import { CAMERA_METHODS } from './vacuum/commands.js';
import { UserError } from './vacuum/errors.js';
import type { VacuumRepository } from './vacuum/repository.js';
import {
  bool, int, intList, num, obj, oneOf, point, roomModes, str, wallList, zoneList, type Args,
} from './validate.js';

/*
 * Every robot action the browser can ask for, by name, with its arguments checked. Mirrors what
 * LocalRock's screens call on VacuumViewModel / VacuumRepository.
 */

interface Call {
  run: (repo: VacuumRepository, args: Args, app: App, duid: string) => Promise<unknown>;
  /** Read the status again afterwards, as the app's VacuumViewModel.run does after an action. */
  refreshAfter?: boolean;
}

const FAN_LEVELS = [FanPower.QUIET, FanPower.BALANCED, FanPower.TURBO, FanPower.MAX, FanPower.OFF, FanPower.CUSTOM, FanPower.SMART] as const;
const WATER_LEVELS = [WaterBoxMode.OFF, WaterBoxMode.LOW, WaterBoxMode.MEDIUM, WaterBoxMode.HIGH, WaterBoxMode.CUSTOM, WaterBoxMode.SMART, WaterBoxMode.SLIDE_MEDIUM] as const;
const ROUTES = [MopRoute.STANDARD, MopRoute.DEEP, MopRoute.CUSTOM, MopRoute.DEEP_PLUS, MopRoute.FAST, MopRoute.SMART] as const;
const CONSUMABLE_FIELDS = new Set([
  'main_brush_work_time', 'side_brush_work_time', 'filter_work_time', 'sensor_dirty_time',
  'cleaning_brush_work_times', 'strainer_work_times',
]);

const action = (run: Call['run']): Call => ({ run, refreshAfter: true });
const read = (run: Call['run']): Call => ({ run });

export const CALLS: Record<string, Call> = {
  refreshMap: read(async (repo) => {
    await repo.fetchMap();
    await repo.rooms().catch(() => undefined);
  }),
  refreshStatus: read((repo) => repo.refreshStatus()),

  clean: action((repo) => repo.clean()),
  cleanRooms: action((repo, a) => repo.cleanRooms(intList(a['rooms'], 'rooms', 0, 255, 64, 1), oneOf(a['repeat'], 'cleaning count', [1, 2, 3] as const))),
  pause: action((repo) => repo.pause()),
  stop: action((repo) => repo.stop()),
  dock: action((repo) => repo.dock()),

  setFanPower: action((repo, a) => repo.setFanPower(oneOf(a['level'], 'suction', FAN_LEVELS))),
  setWaterBoxMode: action((repo, a) => repo.setWaterBoxMode(oneOf(a['level'], 'water flow', WATER_LEVELS))),
  setMopMode: action((repo, a) => repo.setMopMode(oneOf(a['mode'], 'route', ROUTES))),
  setCleanMotorMode: action((repo, a) => repo.setCleanMotorMode(
    oneOf(a['fan'], 'suction', FAN_LEVELS), oneOf(a['water'], 'water flow', WATER_LEVELS), oneOf(a['mop'], 'route', ROUTES),
  )),
  fetchMopMode: read((repo) => repo.fetchMopMode()),
  fetchRoomCleanModes: read((repo) => repo.fetchRoomCleanModes()),
  saveRoomCleanModes: action((repo, a) => repo.saveRoomCleanModes(roomModes(a['modes']))),

  collectDust: action((repo) => repo.collectDust()),
  washMop: action((repo) => repo.washMop()),
  stopWash: action((repo) => repo.stopWash()),
  startDryer: action((repo) => repo.startDryer()),
  stopDryer: action((repo) => repo.stopDryer()),
  fetchDockSettings: read((repo) => repo.fetchDockSettings()),
  setWashMode: action((repo, a) => repo.setWashMode(int(a['mode'], 'washing mode', 0, 2))),
  setWashFreq: action((repo, a) => repo.setWashFreq(int(a['freq'], 'wash frequency', 0, 2))),
  setAutoEmptyMode: action((repo, a) => repo.setAutoEmptyMode(int(a['mode'], 'auto-empty mode', 0, 2))),

  fetchConsumables: read((repo) => repo.fetchConsumables()),
  resetConsumable: action(async (repo, a) => {
    const field = str(a['field'], 'consumable', 64);
    if (!CONSUMABLE_FIELDS.has(field)) throw new UserError('Unknown consumable');
    await repo.resetConsumable(field);
    await repo.fetchConsumables();
  }),
  fetchHistory: read((repo) => repo.fetchCleanHistory()),

  findMe: action((repo) => repo.findMe()),
  rcStart: read((repo) => repo.rcStart()),
  rcMove: read((repo, a) => repo.rcMove(num(a['velocity'], 'velocity', -0.3, 0.3), num(a['omega'], 'turn rate', -3.1416, 3.1416), int(a['durationMs'], 'duration', 100, 5000))),
  rcEnd: action((repo) => repo.rcEnd()),
  gotoTarget: action((repo, a) => repo.gotoTarget(int(a['x'], 'x', 0, MAX_MAP_COORD_MM), int(a['y'], 'y', 0, MAX_MAP_COORD_MM))),
  cleanZones: action((repo, a) => {
    const zones = a['zones'];
    if (!Array.isArray(zones) || zones.length === 0 || zones.length > 10) throw new UserError('Draw between 1 and 10 zones');
    return repo.cleanZones(zones.map((raw) => {
      const z = obj(raw, 'zone');
      const x1 = int(z['x1'], 'zone', 0, MAX_MAP_COORD_MM), y1 = int(z['y1'], 'zone', 0, MAX_MAP_COORD_MM);
      const x2 = int(z['x2'], 'zone', 0, MAX_MAP_COORD_MM), y2 = int(z['y2'], 'zone', 0, MAX_MAP_COORD_MM);
      if (x2 <= x1 || y2 <= y1) throw new UserError('Invalid zone');
      return { x1, y1, x2, y2, times: int(z['times'], 'cleaning count', 1, 3) };
    }));
  }),

  fetchTimers: read((repo) => repo.fetchTimers()),
  createTimer: action((repo, a) => repo.createTimer(int(a['hour'], 'hour', 0, 23), int(a['minute'], 'minute', 0, 59), intList(a['weekdays'], 'days', 0, 6, 7))),
  toggleTimer: action((repo, a) => repo.toggleTimer(str(a['id'], 'schedule', 64))),
  deleteTimer: action((repo, a) => repo.deleteTimer(str(a['id'], 'schedule', 64))),

  fetchRobotSettings: read((repo) => repo.fetchRobotSettings()),
  setVolume: action((repo, a) => repo.setVolume(int(a['volume'], 'volume', 0, 100))),
  setChildLock: action((repo, a) => repo.setChildLock(bool(a['locked'], 'child lock'))),
  setLed: action((repo, a) => repo.setLed(bool(a['on'], 'LED'))),
  setCarpetMode: action((repo, a) => repo.setCarpetMode(int(a['mode'], 'carpet mode', 0, 2))),

  fetchDnd: read((repo) => repo.fetchDnd()),
  setDnd: action((repo, a) => repo.setDnd(int(a['startHour'], 'hour', 0, 23), int(a['startMinute'], 'minute', 0, 59), int(a['endHour'], 'hour', 0, 23), int(a['endMinute'], 'minute', 0, 59))),
  disableDnd: action((repo) => repo.disableDnd()),

  fetchFloorMaps: read((repo) => repo.fetchFloorMaps()),
  switchFloor: action((repo, a) => repo.switchFloor(int(a['mapFlag'], 'map', 0, 62))),
  renameFloorMap: action((repo, a) => repo.renameFloorMap(int(a['mapFlag'], 'map', 0, 62), str(a['name'], 'map name', 64))),
  deleteFloorMap: action((repo, a) => repo.deleteFloorMap(int(a['mapFlag'], 'map', 0, 62))),
  startMapping: action((repo) => repo.startMapping()),
  setMultiLevel: action((repo, a) => repo.setMultiLevel(bool(a['enabled'], 'multi-level'), a['keepMapFlag'] === null || a['keepMapFlag'] === undefined ? null : int(a['keepMapFlag'], 'map', 0, 62))),
  enableMapSaving: action((repo) => repo.enableMapSaving()),
  setSmartMapSwitching: action((repo, a) => repo.setSmartMapSwitching(bool(a['smart'], 'floor recognition'))),
  saveNewMap: action((repo) => repo.saveNewMap()),

  saveCleanOrder: action(async (repo, a, app, duid) => {
    const order = intList(a['order'], 'order', 0, 255, 64, 1);
    await repo.saveCleanSequence(order);
    // Kept only once the robot has taken the order.
    app.store.setCleanOrder(duid, repo.currentFloorFlag(), order);
  }),
  removeCleanOrder: read(async (repo, _a, app, duid) => {
    app.store.setCleanOrder(duid, repo.currentFloorFlag(), []);
    await repo.refreshStatus();
  }),

  saveMapEdits: action((repo, a) => repo.saveMapEdits(
    zoneList(a['noGoZones'], 'NO_GO', 17),
    wallList(a['walls'], 34),
    zoneList(a['carpets'], 'CARPET', 64),
    zoneList(a['thresholds'], 'THRESHOLD', 64),
  )),
  splitRoom: action((repo, a) => repo.splitRoom(int(a['segment'], 'room', 0, 255), point(a['a'], 'line'), point(a['b'], 'line'))),
  mergeRooms: action((repo, a) => repo.mergeRooms(int(a['a'], 'room', 0, 255), int(a['b'], 'room', 0, 255))),
  setFloorMaterial: action(async (repo, a) => {
    const material = oneOf(a['material'], 'floor type', [FloorMaterial.DEFAULT, FloorMaterial.WOOD, FloorMaterial.TILE] as const);
    const direction = a['direction'] === null || a['direction'] === undefined ? null : oneOf(a['direction'], 'direction', [0, 90] as const);
    return { confirmed: await repo.setFloorMaterial(int(a['segment'], 'room', 0, 255), material, direction) };
  }),
  renameRoom: action((_repo, a, app, duid) => app.renameRoom(duid, int(a['segment'], 'room', 0, 255), str(a['name'], 'room name', 64))),

  cameraRpc: read(async (repo, a) => {
    const method = str(a['method'], 'method', 64);
    if (!CAMERA_METHODS.has(method)) throw new UserError('Not a camera command');
    const params = a['params'] ?? [];
    const okShape = Array.isArray(params) ? params.length === 0 : typeof params === 'object' && params !== null;
    if (!okShape) throw new UserError('Invalid camera parameters');
    for (const v of Object.values(params as object)) {
      if (typeof v !== 'string' || v.length > 65_536) throw new UserError('Invalid camera parameters');
    }
    const resp = await repo.session.sendCommandRaw(method, params as Record<string, string>);
    return { result: resp.result, error: resp.error };
  }),
  getCameraPin: read(async (_repo, _a, app, duid) => app.store.get().cameraPins[duid] ?? null),
  setCameraPin: read(async (_repo, a, app, duid) => {
    const pin = a['pin'] === null || a['pin'] === undefined || a['pin'] === '' ? null : str(a['pin'], 'PIN', 32);
    app.store.update((s) => { if (pin === null) delete s.cameraPins[duid]; else s.cameraPins[duid] = pin; });
  }),
};

export async function runCall(app: App, duid: string, name: string, args: Args): Promise<unknown> {
  const call = Object.prototype.hasOwnProperty.call(CALLS, name) ? CALLS[name] : undefined;
  if (!call) throw new UserError(`Unknown action: ${name}`);
  const repo = app.repository(duid);
  const result = await call.run(repo, args, app, duid);
  if (call.refreshAfter) await repo.refreshStatus();
  return result ?? null;
}
