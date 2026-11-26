import { useEffect, useSyncExternalStore } from 'react';
import type { AppState, ClientMessage, DeviceSummary, MapDto, RobotAlert, ServerMessage, VacuumSnapshot } from '../../shared/api';
import { legacyGrid, type ParsedMap } from '../../shared/map';

/*
 * Live state from the server over one WebSocket: app state, the device list, and for every robot
 * a page has open, its snapshot and map. Plus the toast queue.
 */

export interface Toast {
  id: number;
  text: string;
  error: boolean;
}

export interface State {
  connected: boolean;
  app: AppState | null;
  devices: DeviceSummary[];
  devicesError: string | null;
  devicesRefreshing: boolean;
  vacs: Record<string, VacuumSnapshot>;
  maps: Record<string, ParsedMap | null | undefined>;
  toasts: Toast[];
}

let state: State = {
  connected: false,
  app: null,
  devices: [],
  devicesError: null,
  devicesRefreshing: false,
  vacs: {},
  maps: {},
  toasts: [],
};

const listeners = new Set<() => void>();

function set(change: Partial<State>): void {
  state = { ...state, ...change };
  for (const l of listeners) l();
}

export function useStore<T>(select: (s: State) => T): T {
  return useSyncExternalStore(
    (l) => { listeners.add(l); return () => listeners.delete(l); },
    () => select(state),
  );
}

export function getState(): State {
  return state;
}

// ---- Toasts ----

let toastId = 0;

export function toast(text: string, error = false): void {
  const id = ++toastId;
  set({ toasts: [...state.toasts.slice(-2), { id, text, error }] });
  setTimeout(() => dismissToast(id), error ? 7_000 : 4_000);
}

export function dismissToast(id: number): void {
  set({ toasts: state.toasts.filter((t) => t.id !== id) });
}

/** Run an action and report the outcome as a toast. Returns false when it failed. */
export async function attempt(action: () => Promise<unknown>, success?: string): Promise<boolean> {
  try {
    await action();
    if (success) toast(success);
    return true;
  } catch (e) {
    toast((e as Error).message || 'Something went wrong', true);
    return false;
  }
}

// ---- Maps ----

function b64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function decodeMap(dto: MapDto): ParsedMap {
  const originalGrid = dto.originalGrid ? b64(dto.originalGrid) : null;
  return {
    width: dto.width,
    height: dto.height,
    grid: originalGrid ? legacyGrid(originalGrid) : b64(dto.grid),
    originalGrid,
    rooms: dto.rooms,
    resolution: dto.resolution,
    pixelOffsetLeft: dto.pixelOffsetLeft,
    pixelOffsetTop: dto.pixelOffsetTop,
    chargerMm: dto.chargerMm,
    robotMm: dto.robotMm,
    pathMm: dto.pathMm.map(([x, y]) => ({ x, y, angle: 0 })),
    noGoZones: dto.noGoZones,
    noMopZones: dto.noMopZones,
    virtualWalls: dto.virtualWalls,
    segmentMaterials: dto.segmentMaterials,
    segmentMaterialDirections: dto.segmentMaterialDirections,
    unmodeledRestrictionBlocks: dto.unmodeledRestrictionBlocks,
    format: dto.format,
    carpetAreas: dto.carpetAreas,
    carpetFlagsPresent: dto.carpetFlagsPresent,
    thresholds: dto.thresholds,
    obstacles: dto.obstacles ?? [],
    patrolPoints: dto.patrolPoints ?? [],
    patrolTaskId: dto.patrolTaskId ?? null,
    pathFlags: dto.pathFlags ?? [],
    carpetMask: dto.carpetMask ? b64(dto.carpetMask) : null,
    zoneLines: dto.zoneLines ?? [],
    eraserZones: dto.eraserZones ?? [],
    furnitureBlocks: dto.furnitureBlocks ?? [],
  };
}

// ---- WebSocket ----

let socket: WebSocket | null = null;
let retryMs = 1_000;
const watchCounts = new Map<string, number>();
const unwatchTimers = new Map<string, ReturnType<typeof setTimeout>>();

function send(msg: ClientMessage): void {
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
}

function onMessage(msg: ServerMessage): void {
  switch (msg.t) {
    case 'app':
      set({ app: msg.state });
      break;
    case 'devices':
      set({ devices: msg.devices, devicesError: msg.error, devicesRefreshing: msg.refreshing });
      break;
    case 'vac':
      set({ vacs: { ...state.vacs, [msg.snapshot.duid]: msg.snapshot } });
      break;
    case 'map':
      set({ maps: { ...state.maps, [msg.duid]: msg.map ? decodeMap(msg.map) : null } });
      break;
    case 'alert':
      showAlert(msg.alert);
      break;
  }
}

function showAlert(alert: RobotAlert): void {
  toast(`${alert.title}: ${alert.body}`, alert.alert);
  if (typeof Notification !== 'undefined' && Notification.permission === 'granted' && document.hidden) {
    try {
      new Notification(alert.title, { body: alert.body, tag: `${alert.duid}-${alert.kind}` });
    } catch {
      // Some browsers only allow notifications from a service worker.
    }
  }
}

export function connect(): void {
  if (socket) return;
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
  const ws = new WebSocket(url);
  socket = ws;
  ws.onopen = () => {
    retryMs = 1_000;
    set({ connected: true });
    for (const duid of watchCounts.keys()) send({ t: 'watch', duid });
  };
  ws.onmessage = (ev) => {
    try {
      onMessage(JSON.parse(String(ev.data)) as ServerMessage);
    } catch {
      // ignore malformed
    }
  };
  ws.onclose = () => {
    socket = null;
    set({ connected: false });
    setTimeout(connect, retryMs);
    retryMs = Math.min(retryMs * 2, 10_000);
  };
}

export function disconnect(): void {
  const ws = socket;
  socket = null;
  if (ws) {
    ws.onclose = null;
    ws.close();
  }
  set({ connected: false });
}

/** Keep a robot's live state flowing while a component is mounted. */
export function useWatch(duid: string | null): void {
  useEffect(() => {
    if (!duid) return;
    const pending = unwatchTimers.get(duid);
    if (pending) {
      // A watch is lingering after the last user left (count 1); this mount takes it over.
      clearTimeout(pending);
      unwatchTimers.delete(duid);
    } else {
      const n = watchCounts.get(duid) ?? 0;
      watchCounts.set(duid, n + 1);
      if (n === 0) send({ t: 'watch', duid });
    }
    return () => {
      const left = (watchCounts.get(duid) ?? 1) - 1;
      if (left > 0) {
        watchCounts.set(duid, left);
        return;
      }
      // Moving between a robot's screens unmounts and mounts again; linger instead of
      // stopping the robot's polling for that. The count stays 1 while lingering.
      unwatchTimers.set(duid, setTimeout(() => {
        unwatchTimers.delete(duid);
        watchCounts.delete(duid);
        send({ t: 'unwatch', duid });
      }, 3_000));
    };
  }, [duid]);
}

export function useVacuum(duid: string): { snap: VacuumSnapshot | undefined; map: ParsedMap | null | undefined } {
  useWatch(duid);
  const snap = useStore((s) => s.vacs[duid]);
  const map = useStore((s) => s.maps[duid]);
  return { snap, map };
}
