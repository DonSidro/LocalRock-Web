import type { RoomCleanMode, VacuumStatus } from './codes.js';
import type { MapPoint, MapRoom, MapZone, VirtualWall } from './map.js';

/* Data exchanged between the server and the browser. */

export interface FloorMap {
  name: string;
  mapFlag: number;
}

export interface ConsumableStatus {
  mainBrushWorkTime?: number;
  sideBrushWorkTime?: number;
  filterWorkTime?: number;
  sensorDirtyTime?: number;
  /** Wash-dock consumables; only dock-equipped models report them. */
  cleaningBrushWorkTime?: number;
  strainerWorkTime?: number;
}

export interface CleanRecord {
  beginEpoch: number;
  endEpoch: number;
  durationSeconds: number;
  areaMm2: number;
  errorCode: number;
  complete: number;
}

export interface CleanSummary {
  totalTimeSec: number;
  totalAreaMm2: number;
  totalCount: number;
}

export interface CleanTimer {
  id: string;
  enabled: boolean;
  hour: number;
  minute: number;
  /** 0 = Sunday ... 6 = Saturday; empty = every day. */
  weekdays: number[];
}

export interface RobotSettings {
  volume: number;
  childLock: boolean;
  ledEnabled: boolean;
  /** 0 avoid, 1 standard, 2 boost */
  carpetMode: number;
}

/** Dock settings as the robot reported them; null where it did not answer. */
export interface DockSettings {
  /** set_wash_towel_mode's wash_mode; see DockCapabilities.washModes. */
  washMode: number | null;
  smartWash: SmartWashSettings | null;
  /** set_dust_collection_mode's mode: 0 smart, 1 light, 2 balanced, 3 strong, 4 max. */
  autoEmptyMode: number | null;
  /** app_get_dryer_setting's status; null on a dock without drying. */
  mopDrying: boolean | null;
  dryTimeSeconds: number | null;
  /** 0 room temperature, 1 warm, 2 hot; null on a dock without heating. */
  washWaterTemperature: number | null;
}

/** The off-peak electricity window the robot is limited to, in the robot's local time. */
export interface ValleySettings {
  enabled: boolean;
  startHour: number;
  startMinute: number;
  endHour: number;
  endMinute: number;
}

export interface DndSettings {
  enabled: boolean;
  startHour: number;
  startMinute: number;
  endHour: number;
  endMinute: number;
}

/** Everything the browser shows about one robot except the map image. */
export interface VacuumSnapshot {
  duid: string;
  name: string;
  model: string | null;
  firmware: string | null;
  /** Decimal feature bits from the server, for DockCapabilities and the feature checks. */
  featureSet: string | null;
  /** Hex feature bits from the server. */
  newFeatureSet: string | null;
  supportsSmartPlan: boolean;
  supportsWaterSlide: boolean;
  status: VacuumStatus;
  mopMode: number | null;
  mapStatus: string;
  mapVersion: number;
  floorMaps: FloorMap[];
  floorMapsLoaded: boolean;
  maxFloorMaps: number | null;
  currentFloorFlag: number;
  unsavedMap: boolean;
  roomCleanModes: RoomCleanMode[];
  roomCleanModesLoaded: boolean;
  consumables: ConsumableStatus | null;
  cleanSummary: CleanSummary | null;
  cleanHistory: CleanRecord[];
  timers: CleanTimer[];
  robotSettings: RobotSettings;
  dockSettings: DockSettings;
  dnd: DndSettings | null;
  /** Default cleaning order for the loaded map (kept on the server, like the app keeps it). */
  defaultCleanOrder: number[];
}

/** A parsed map with its pixel layers as base64. */
export interface MapDto {
  version: number;
  width: number;
  height: number;
  /** Empty when originalGrid is given: the grid is derived from it (legacyGrid). */
  grid: string;
  originalGrid: string | null;
  rooms: MapRoom[];
  resolution: number;
  pixelOffsetLeft: number;
  pixelOffsetTop: number;
  chargerMm: MapPoint | null;
  robotMm: MapPoint | null;
  pathMm: Array<[number, number]>;
  noGoZones: MapZone[];
  noMopZones: MapZone[];
  virtualWalls: VirtualWall[];
  segmentMaterials: Record<number, number>;
  segmentMaterialDirections: Record<number, number>;
  unmodeledRestrictionBlocks: number[];
  format: 'LEGACY' | 'B01';
  carpetAreas: MapZone[];
  carpetFlagsPresent: boolean;
  thresholds: MapZone[];
}

export type Reachability = 'CHECKING' | 'ONLINE' | 'OFFLINE';

export interface DeviceSummary {
  duid: string;
  name: string;
  model: string | null;
  paired: boolean;
  /** The robot's own answer when it was asked, else the server's flag. */
  online: boolean;
  reachability: Reachability | null;
}

export interface AppState {
  serverBaseUrl: string | null;
  allowSelfSigned: boolean;
  signedIn: boolean;
  email: string | null;
  canReLogin: boolean;
  mqttConnected: boolean;
  mqttStarted: boolean;
  /** Shown while the session needs a manual sign-in. */
  sessionProblem: string | null;
  notify: { enabled: boolean; errors: boolean; finished: boolean; dock: boolean };
  hasAdminPassword: boolean;
  homeName: string | null;
}

export interface RobotAlert {
  duid: string;
  kind: 'error' | 'dock' | 'finished';
  title: string;
  body: string;
  /** True for something that needs a person, false for good news. */
  alert: boolean;
}

/** Server -> browser over the WebSocket. */
export type ServerMessage =
  | { t: 'app'; state: AppState }
  | { t: 'devices'; devices: DeviceSummary[]; error: string | null; refreshing: boolean }
  | { t: 'vac'; snapshot: VacuumSnapshot }
  | { t: 'map'; duid: string; map: MapDto | null }
  | { t: 'alert'; alert: RobotAlert };

/** Browser -> server over the WebSocket. */
export type ClientMessage = { t: 'watch'; duid: string } | { t: 'unwatch'; duid: string };

export interface OnboardingDevice {
  duid: string;
  name: string;
  connected: boolean;
  hasPublicKey: boolean;
}

export interface OnboardingState {
  running: boolean;
  step: string;
  serverStatus: string | null;
  result: string | null;
  error: string | null;
}
