import type { RoomCleanMode, VacuumStatus } from './codes.js';
import type { SmartWashSettings } from './dock.js';
import type { AdvertisedFeature } from './features.js';
import type { MapObstacle, PatrolPoint } from './obstacles.js';
import type { FirmwareCheck, FirmwareProgress } from './firmware.js';
import type { VoiceInstallState } from './voice.js';
import type { MapPoint, MapRoom, MapZone, VirtualWall } from './map.js';

/* Data exchanged between the server and the browser. */

/**
 * A saved map. savedAt is when the robot last stored it and backupAt when its on-robot backup was
 * made, both in the robot's own epoch seconds; backupAt is null when the map has no backup.
 */
export interface FloorMap {
  name: string;
  mapFlag: number;
  savedAt: number | null;
  backupAt: number | null;
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
  /** What started the run (see startTypeLabel); 0 when the robot did not say. */
  startType: number;
  /** 1 full clean; 5, 6 and 10 are camera runs (Cruise, pet search). */
  cleanType: number;
  finishReason: number;
  dustCollected: boolean;
  washCount: number;
  /** The area the official app shows, when the robot reports it. */
  cleanedAreaMm2: number | null;
}

export interface CleanSummary {
  totalTimeSec: number;
  totalAreaMm2: number;
  totalCount: number;
  /** Cruise and pet-search runs. */
  patrolCount: number;
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
  /** Null until read, or on a robot without off-peak charging. */
  valley: ValleySettings | null;
  /** Segment -> room type tag from the robot's room table (see ROOM_TYPES). */
  roomTags: Record<number, number>;
  /** What the server last heard from the robot; only set while the robot is not answering. */
  lastKnown: LastKnown | null;
  voice: VoiceSnapshot;
  voiceInstall: VoiceInstallState | null;
  /** Null until checked. */
  firmwareCheck: FirmwareCheck | null;
  firmwareProgress: FirmwareProgress;
  /** The map shown is the last one the server kept, not a live one. */
  offlineMap: boolean;
  /** Robot options that answered (see FEATURE_DEFS), in the table's order. */
  features: Array<{ id: string; value: number | null }>;
  featuresLoading: boolean;
  /** newFeatureSet bits the robot advertises that have no control here. */
  unlistedFeatures: AdvertisedFeature[];
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
  obstacles: MapObstacle[];
  patrolPoints: PatrolPoint[];
  patrolTaskId: number | null;
}

export type Reachability = 'CHECKING' | 'ONLINE' | 'OFFLINE';

export interface DeviceSummary {
  duid: string;
  name: string;
  model: string | null;
  paired: boolean;
  /** The server has never heard from this robot (and a probe did not find it): it still needs Add vacuum. */
  unpaired: boolean;
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

/** An obstacle photo for the page, and where the robot boxed the obstacle in it (image pixels). */
export interface ObstaclePhotoDto {
  dataUrl: string;
  box: { left: number; top: number; right: number; bottom: number } | null;
}

/** One cruise-point thumbnail. */
export interface PatrolThumbnailDto { x: number; y: number; width: number; height: number; angle: number; dataUrl: string }

/** What the Voice Assistant page shows; null where the robot did not answer. */
export interface VoiceSnapshot {
  switchKey: string | null;
  enabled: boolean | null;
  languageCode: string | null;
  historyCount: number | null;
  currentSid: number | null;
  location: string | null;
}

/** What the server last heard from a robot that has stopped answering. */
export interface LastKnown {
  /** ISO times from the server. */
  lastSeenAt: string | null;
  offlineAt: string | null;
  state: number | null;
  battery: number | null;
  errorCode: number | null;
  /** Where it was last seen, robot mm. */
  robotMm: { x: number; y: number } | null;
}

/** A routine ("scene") saved with the official app; the server runs its steps, so only the name is shown. */
export interface Routine {
  id: number;
  name: string;
  enabled: boolean;
}

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
