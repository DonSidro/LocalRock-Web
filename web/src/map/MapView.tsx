import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { cellToMm, contentBoundsNorm, erasedRoomIds, mmToCell, type ParsedMap } from '../../../shared/map';
import { Icon } from '../icons';
import { useDark } from '../theme';
import {
  DARK, HERO, HERO_DARK, LIGHT, drawFloorPlanStrokes, drawLayer, drawMarkers, drawRestrictions, drawRoute,
  renderFloor, renderSelection, renderWalls, roundRect, type MapPalette, type ToScreen,
} from './render';
import { roomIconPath } from './roomIcons';
import {
  DEFAULT_3D_TILT, DEFAULT_3D_YAW, MAP_3D_MAX_TILT, MapTransform, fitScale, isTiltDrag, labelTextWidth,
  nextQuarterTurn, squashForTilt, supersampleFor,
} from './view';

/*
 * The interactive map: wheel / pinch zoom, drag to pan, tap to pick, double-click to reframe. With
 * a viewKey it can be turned in quarter turns and shown as a tilted 3D model (LocalRock 24b1b6c):
 * right-drag or Ctrl+drag (two fingers on touch) turns and tilts it. Screens add their own drawing
 * (overlay) and gestures (onPointerDown); everything goes through one transform.
 */

export interface PointerInfo {
  sx: number;
  sy: number;
  mm: [number, number];
  normX: number;
  normY: number;
  /** The room whose name was under the pointer; a name wins over the floor under it. */
  labelRoomId: number | null;
}

export interface CustomGesture {
  move: (p: PointerInfo) => void;
  end: (p: PointerInfo) => void;
  cancel?: () => void;
}

export interface MapViewApi {
  toScreen: ToScreen;
  toMm: (sx: number, sy: number) => [number, number];
  pxPerCell: () => number;
  /** Robot mm under the middle of the view. */
  centerMm: () => [number, number];
  /** Width of the visible area in mm. */
  visibleWidthMm: () => number;
  redraw: () => void;
}

export interface OverlayContext {
  ctx: CanvasRenderingContext2D;
  api: MapViewApi;
  palette: MapPalette;
  width: number;
  height: number;
}

interface Props {
  map: ParsedMap;
  selectedRoomIds?: number[];
  focusRoomId?: number | null;
  showLabels?: boolean;
  drawRestrictions?: boolean;
  overlay?: (o: OverlayContext) => void;
  /** Change it to redraw the overlay. */
  overlayKey?: unknown;
  onTap?: (p: PointerInfo) => void;
  onPointerDown?: (p: PointerInfo) => CustomGesture | null;
  drawing?: boolean;
  /** The robot's live map: black behind it, a light route, and the rotate and 3D buttons remembered under this key. */
  viewKey?: string;
  /** Whether the 3D view may show now (a drawing tool needs the flat map). */
  allow3D?: boolean;
  /** A thin faint route, for a robot that isn't cleaning. */
  faintRoute?: boolean;
}

const MIN_ZOOM = 0.4;
const MAX_ZOOM = 12;
const TAP_SLOP_PX = 6;
// Stylised, not to scale: tall enough that walls read as walls instead of thin borders.
const WALL_HEIGHT_CELLS = 7;
const TILT_DEGREES_PER_PX = 0.25;
const TURN_DEGREES_PER_PX = 0.4;
const TOUCH_TILT_DEGREES_PER_PX = 0.05 * 4;

interface ViewPrefs { rotation: number; yaw3d: number; tilt3d: number; is3d: boolean }

function loadPrefs(key: string | undefined): ViewPrefs {
  const prefs: ViewPrefs = { rotation: 0, yaw3d: DEFAULT_3D_YAW, tilt3d: DEFAULT_3D_TILT, is3d: false };
  if (!key) return prefs;
  try {
    const raw = JSON.parse(localStorage.getItem(`localrock.mapView.${key}`) ?? '{}') as Partial<ViewPrefs>;
    if (typeof raw.rotation === 'number' && [0, 90, 180, 270].includes(raw.rotation)) prefs.rotation = raw.rotation;
    if (typeof raw.yaw3d === 'number' && Number.isFinite(raw.yaw3d)) prefs.yaw3d = raw.yaw3d;
    if (typeof raw.tilt3d === 'number' && raw.tilt3d >= 0 && raw.tilt3d <= MAP_3D_MAX_TILT) prefs.tilt3d = raw.tilt3d;
    prefs.is3d = raw.is3d === true;
  } catch { /* defaults */ }
  return prefs;
}

function savePrefs(key: string | undefined, prefs: ViewPrefs): void {
  if (!key) return;
  try { localStorage.setItem(`localrock.mapView.${key}`, JSON.stringify(prefs)); } catch { /* not kept */ }
}

/** What the floor layers are drawn from; a live update that only moved the robot keeps them. */
function floorKey(map: ParsedMap): string {
  let h = 2166136261;
  const mix = (a: Uint8Array | null) => {
    if (!a) { h = Math.imul(h ^ 7, 16777619); return; }
    for (let i = 0; i < a.length; i++) h = Math.imul(h ^ a[i]!, 16777619);
  };
  mix(map.grid);
  mix(map.originalGrid);
  mix(map.carpetMask);
  return [
    map.width, map.height, map.pixelOffsetLeft, map.pixelOffsetTop, map.format, h >>> 0,
    JSON.stringify([map.segmentMaterials, map.segmentMaterialDirections, map.zoneLines, map.eraserZones]),
  ].join('|');
}

export const MapView = forwardRef<MapViewApi, Props>(function MapView(props, ref) {
  // overlay, onTap and onPointerDown are read through `latest` so gesture handlers see the newest ones.
  const { map, selectedRoomIds, focusRoomId, showLabels = true, drawRestrictions: restrictions = true, overlayKey, drawing, viewKey, allow3D = true, faintRoute = false } = props;
  const dark = useDark();
  const hero = viewKey !== undefined;
  const palette = hero ? (dark ? HERO_DARK : HERO) : dark ? DARK : LIGHT;

  const fKey = useMemo(() => floorKey(map), [map]);
  const mapRef = useRef(map);
  mapRef.current = map;
  const scale = supersampleFor(map.width, map.height);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const floor = useMemo(() => renderFloor(mapRef.current, palette, scale), [fKey, palette, scale]);
  const selKey = (selectedRoomIds ?? []).join(',');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const selection = useMemo(() => renderSelection(mapRef.current, palette, selectedRoomIds ?? []), [fKey, palette, selKey]);

  const [prefs, setPrefsState] = useState<ViewPrefs>(() => loadPrefs(viewKey));
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  useEffect(() => { const p = loadPrefs(viewKey); prefsRef.current = p; setPrefsState(p); }, [viewKey]);
  const setPrefs = useCallback((change: Partial<ViewPrefs>) => {
    const next = { ...prefsRef.current, ...change };
    prefsRef.current = next;
    setPrefsState(next);
    savePrefs(viewKey, next);
  }, [viewKey]);
  const is3d = hero && prefs.is3d && allow3D;
  const is3dRef = useRef(is3d);
  is3dRef.current = is3d;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const walls = useMemo(() => (is3d ? renderWalls(mapRef.current, palette) : null), [fKey, palette, is3d]);

  // Framed once per map identity: a plan still growing must not re-centre under the pointer.
  const identity = `${map.width}x${map.height}:${map.pixelOffsetLeft}:${map.pixelOffsetTop}`;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const bounds = useMemo(() => contentBoundsNorm(mapRef.current), [identity]);

  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const size = useRef({ w: 0, h: 0 });
  // The user's zoom is a multiple of the framed view and the pan is in units of it, so a resize keeps both.
  const viewport = useRef({ zoom: 1, panX: 0, panY: 0 });
  useEffect(() => { viewport.current = { zoom: 1, panX: 0, panY: 0 }; }, [identity, is3d]);
  const [zoomLabel, setZoomLabel] = useState<number | null>(null);
  const frame = useRef(0);
  const latest = useRef(props);
  latest.current = props;

  const fitFor = (yaw: number, threeD: boolean) => {
    const m = mapRef.current;
    const { w, h } = size.current;
    const cw = Math.max(0.01, bounds.right - bounds.left) * m.width;
    const ch = Math.max(0.01, bounds.bottom - bounds.top) * m.height;
    return fitScale(w, h, cw, ch, yaw, 1, threeD) * (threeD ? 1.1 : 0.94);
  };

  const view = (): MapTransform => {
    const m = mapRef.current;
    const p = prefsRef.current;
    const threeD = is3dRef.current;
    const yaw = threeD ? p.yaw3d : p.rotation;
    const fit = fitFor(yaw, threeD);
    const v = viewport.current;
    return new MapTransform(
      size.current.w, size.current.h,
      ((bounds.left + bounds.right) / 2) * m.width, ((bounds.top + bounds.bottom) / 2) * m.height,
      fit * v.zoom, v.panX * fit, v.panY * fit, yaw, threeD ? squashForTilt(p.tilt3d) : 1,
    );
  };

  // A point of row r sits half a cell above the bottom of the row drawn at h-1-r, so +1 on mmToCell's y.
  const toScreen: ToScreen = (xMm, yMm) => {
    const c = mmToCell(mapRef.current, xMm, yMm);
    return view().toScreen(c.x, c.y + 1);
  };

  const toMm = (sx: number, sy: number): [number, number] => {
    const c = view().toCell(sx, sy);
    return cellToMm(mapRef.current, { x: c.x, y: c.y - 1 });
  };

  const labelHits = useRef<LabelHit[]>([]);
  const info = (sx: number, sy: number): PointerInfo => {
    const m = mapRef.current;
    const c = view().toCell(sx, sy);
    const hit = [...labelHits.current].reverse().find((l) => sx >= l.x0 && sx <= l.x1 && sy >= l.y0 && sy <= l.y1);
    return { sx, sy, mm: toMm(sx, sy), normX: c.x / m.width, normY: c.y / m.height, labelRoomId: hit?.roomId ?? null };
  };

  const draw = useCallback(() => {
    frame.current = 0;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const m = mapRef.current;
    const { w, h } = size.current;
    const dpr = window.devicePixelRatio || 1;
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (palette.background) {
      ctx.fillStyle = palette.background;
      ctx.fillRect(0, 0, w, h);
    }
    const v = view();
    const threeD = is3dRef.current;
    // Magnified, nearest-neighbour keeps cell edges crisp; so does a flat quarter turn. Zoomed out, smoothing avoids shimmer.
    const layerK = v.k / floor.scale;
    const quarter = !threeD && v.yawDeg % 90 === 0;
    const smooth = !((quarter && layerK >= 0.95) || layerK >= 2);
    drawLayer(ctx, floor.canvas, v, floor.scale, dpr, smooth);
    // A picked room is tinted over the floor, and the route goes over the tint.
    if (selection) drawLayer(ctx, selection, v, 1, dpr, v.k < 2);
    drawFloorPlanStrokes(ctx, floor.shapes, (x, y) => v.toScreen(x, y));
    const p = latest.current;
    const ts = toScreen;
    if (p.drawRestrictions ?? true) drawRestrictions(ctx, m, ts);
    drawRoute(ctx, m, palette, ts, v.k, p.faintRoute ?? false);
    drawMarkers(ctx, m, palette, ts, v.k);
    if (threeD && walls) {
      // Walls rise by stacking the wall layer at climbing heights, then capping it with the lighter top.
      const steps = Math.min(30, Math.max(2, Math.trunc((WALL_HEIGHT_CELLS * v.k * v.lift) / 1.5)));
      for (let i = 1; i <= steps; i++) drawLayer(ctx, walls[0], v, 1, dpr, v.k < 2, (WALL_HEIGHT_CELLS * i) / steps);
      drawLayer(ctx, walls[1], v, 1, dpr, v.k < 2, WALL_HEIGHT_CELLS);
    }
    const api = apiRef.current;
    p.overlay?.({ ctx, api, palette, width: w, height: h });
    labelHits.current = [];
    if (p.showLabels ?? true) {
      // Dark names on a light pill over the flat map; white on a dark pill over the 3D walls or a dark surface.
      labelHits.current = drawLabels(ctx, m, p.selectedRoomIds ?? [], p.focusRoomId ?? null, w, h, v, threeD, threeD || (!hero && dark));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [floor, selection, walls, palette, dark, hero, bounds]);

  const redraw = useCallback(() => {
    if (!frame.current) frame.current = requestAnimationFrame(draw);
  }, [draw]);

  const apiRef = useRef<MapViewApi>(null!);
  apiRef.current = {
    toScreen,
    toMm,
    pxPerCell: () => view().k,
    centerMm: () => toMm(size.current.w / 2, size.current.h / 2),
    visibleWidthMm: () => (size.current.w / view().k) * 50,
    redraw,
  };
  useImperativeHandle(ref, () => apiRef.current);

  const updateZoomLabel = () => {
    const z = viewport.current.zoom;
    setZoomLabel(z > 1.05 ? Math.round(z * 100) : null);
  };

  /** Moves the pan so the floor point `cell` is under screen (sx, sy). */
  const keepAt = (cell: { x: number; y: number }, sx: number, sy: number) => {
    const v = view();
    const s = v.toScreen(cell.x, cell.y);
    const fit = v.k / viewport.current.zoom;
    const vp = viewport.current;
    vp.panX = Math.min(size.current.w, Math.max(-size.current.w, vp.panX * fit + sx - s.x)) / fit;
    vp.panY = Math.min(size.current.h, Math.max(-size.current.h, vp.panY * fit + sy - s.y)) / fit;
  };

  const zoomAbout = (factor: number, sx: number, sy: number) => {
    const cell = view().toCell(sx, sy);
    viewport.current.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, viewport.current.zoom * factor));
    keepAt(cell, sx, sy);
  };

  /** Turns and tilts the 3D view about the middle of the canvas. */
  const turnBy = (dyaw: number, dtilt: number) => {
    const p = prefsRef.current;
    const sx = size.current.w / 2, sy = size.current.h / 2;
    const cell = view().toCell(sx, sy);
    const next = { yaw3d: (((p.yaw3d + dyaw) % 360) + 360) % 360, tilt3d: Math.min(MAP_3D_MAX_TILT, Math.max(0, p.tilt3d + dtilt)) };
    prefsRef.current = { ...p, ...next };
    keepAt(cell, sx, sy);
  };

  // Turning saves once the gesture ends, not on every pointer move.
  const commitPrefs = () => setPrefs({});

  // Size tracking.
  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const resize = () => {
      const r = wrap.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      size.current = { w: r.width, h: r.height };
      canvas.width = Math.max(1, Math.round(r.width * dpr));
      canvas.height = Math.max(1, Math.round(r.height * dpr));
      draw();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);
    resize();
    return () => ro.disconnect();
  }, [draw]);

  useEffect(() => { redraw(); }, [redraw, map, selectedRoomIds, focusRoomId, showLabels, restrictions, overlayKey, prefs, is3d, faintRoute]);

  // Pointer gestures.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const pointers = new Map<number, { x: number; y: number }>();
    let mode: 'none' | 'pan' | 'pinch' | 'custom' | 'turn' = 'none';
    let custom: CustomGesture | null = null;
    let start = { x: 0, y: 0, t: 0 };
    let moved = false;
    let last = { x: 0, y: 0 };
    let panOnly = false;
    let turning = false;

    const local = (e: PointerEvent | MouseEvent) => {
      const r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };

    const down = (e: PointerEvent) => {
      if (e.pointerType === 'mouse' && e.button > 2) return;
      // The middle and right mouse buttons always move the view, so drawing tools never trap it;
      // on the 3D map they (or Ctrl+drag) turn and tilt it.
      panOnly = e.pointerType === 'mouse' && e.button !== 0;
      turning = is3dRef.current && e.pointerType === 'mouse' && (e.button !== 0 || e.ctrlKey || e.shiftKey);
      canvas.setPointerCapture(e.pointerId);
      const p = local(e);
      pointers.set(e.pointerId, p);
      if (pointers.size === 2) {
        // A second finger always means zoom; an unfinished drawing is dropped.
        custom?.cancel?.();
        custom = null;
        mode = 'pinch';
        moved = true;
        return;
      }
      if (pointers.size > 2) return;
      start = { x: p.x, y: p.y, t: performance.now() };
      last = p;
      moved = false;
      custom = panOnly || turning ? null : latest.current.onPointerDown?.(info(p.x, p.y)) ?? null;
      mode = custom ? 'custom' : turning ? 'turn' : 'pan';
    };

    const move = (e: PointerEvent) => {
      if (!pointers.has(e.pointerId)) return;
      const before = [...pointers.values()];
      const p = local(e);
      pointers.set(e.pointerId, p);
      if (mode === 'pinch' && pointers.size >= 2) {
        const [a0, b0] = before;
        const [a1, b1] = [...pointers.values()];
        if (!a0 || !b0 || !a1 || !b1) return;
        const d0 = Math.hypot(a0.x - b0.x, a0.y - b0.y) || 1;
        const d1 = Math.hypot(a1.x - b1.x, a1.y - b1.y) || 1;
        const m0 = { x: (a0.x + b0.x) / 2, y: (a0.y + b0.y) / 2 };
        const m1 = { x: (a1.x + b1.x) / 2, y: (a1.y + b1.y) / 2 };
        const zoom = d1 / d0;
        let rot = ((Math.atan2(b1.y - a1.y, b1.x - a1.x) - Math.atan2(b0.y - a0.y, b0.x - a0.x)) * 180) / Math.PI;
        if (rot > 180) rot -= 360;
        if (rot < -180) rot += 360;
        const cell = view().toCell(m0.x, m0.y);
        viewport.current.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, viewport.current.zoom * zoom));
        // In 3D two fingers twist the model, and dragged up or down together tip the camera.
        const tilting = is3dRef.current && isTiltDrag(2, m1.x - m0.x, m1.y - m0.y, zoom, rot);
        if (is3dRef.current) {
          const p0 = prefsRef.current;
          prefsRef.current = {
            ...p0,
            yaw3d: (((p0.yaw3d + rot) % 360) + 360) % 360,
            tilt3d: tilting ? Math.min(MAP_3D_MAX_TILT, Math.max(0, p0.tilt3d - (m1.y - m0.y) * TOUCH_TILT_DEGREES_PER_PX)) : p0.tilt3d,
          };
        }
        keepAt(cell, tilting ? m0.x : m1.x, tilting ? m0.y : m1.y);
        updateZoomLabel();
        redraw();
        return;
      }
      if (!moved && Math.hypot(p.x - start.x, p.y - start.y) < TAP_SLOP_PX) return;
      moved = true;
      if (mode === 'custom') {
        custom?.move(info(p.x, p.y));
      } else if (mode === 'turn') {
        turnBy((p.x - last.x) * TURN_DEGREES_PER_PX, -(p.y - last.y) * TILT_DEGREES_PER_PX);
        redraw();
      } else if (mode === 'pan') {
        const fit = view().k / viewport.current.zoom;
        const vp = viewport.current;
        vp.panX = Math.min(size.current.w, Math.max(-size.current.w, vp.panX * fit + p.x - last.x)) / fit;
        vp.panY = Math.min(size.current.h, Math.max(-size.current.h, vp.panY * fit + p.y - last.y)) / fit;
        redraw();
      }
      last = p;
    };

    const up = (e: PointerEvent) => {
      if (!pointers.has(e.pointerId)) return;
      const p = local(e);
      pointers.delete(e.pointerId);
      if (mode === 'pinch') {
        if (pointers.size === 0) { mode = 'none'; if (is3dRef.current) commitPrefs(); }
        else if (pointers.size === 1) { mode = 'pan'; last = [...pointers.values()][0]!; }
        return;
      }
      if (pointers.size > 0) return;
      const wasMode = mode;
      mode = 'none';
      if (wasMode === 'turn') { commitPrefs(); return; }
      if (!moved) {
        custom?.cancel?.();
        custom = null;
        if (e.type === 'pointerup' && !panOnly && performance.now() - start.t < 600) latest.current.onTap?.(info(p.x, p.y));
        return;
      }
      if (wasMode === 'custom') custom?.end(info(p.x, p.y));
      custom = null;
    };

    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const p = local(e);
      zoomAbout(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), p.x, p.y);
      updateZoomLabel();
      redraw();
    };

    // Double click returns to the framed view; the heading is left as it is.
    const dbl = () => {
      viewport.current = { zoom: 1, panX: 0, panY: 0 };
      updateZoomLabel();
      redraw();
    };

    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
    canvas.addEventListener('wheel', wheel, { passive: false });
    const menu = (e: Event) => e.preventDefault();
    canvas.addEventListener('dblclick', dbl);
    canvas.addEventListener('contextmenu', menu);
    return () => {
      canvas.removeEventListener('contextmenu', menu);
      canvas.removeEventListener('pointerdown', down);
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', up);
      canvas.removeEventListener('pointercancel', up);
      canvas.removeEventListener('wheel', wheel);
      canvas.removeEventListener('dblclick', dbl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [redraw, bounds]);

  const rotate = () => {
    viewport.current = { zoom: viewport.current.zoom, panX: 0, panY: 0 };
    if (is3d) setPrefs({ yaw3d: ((prefs.yaw3d + 90) % 360 + 360) % 360 });
    else setPrefs({ rotation: nextQuarterTurn(prefs.rotation) });
  };

  return (
    <div ref={wrapRef} style={{ position: 'absolute', inset: 0, background: palette.background ?? undefined }}>
      <canvas ref={canvasRef} className={`map-canvas ${drawing ? 'drawing' : ''}`} aria-label="Map" />
      {hero && (
        <div className="map-view-buttons">
          {allow3D && (
            <button type="button" className="map-view-btn" onClick={() => setPrefs({ is3d: !prefs.is3d })}
              title={is3d ? 'Show the flat map' : 'Show the map in 3D (right-drag or Ctrl+drag to turn and tilt)'} aria-pressed={is3d}>
              {is3d ? '3D' : '2D'}
            </button>
          )}
          <button type="button" className="map-view-btn" onClick={rotate} title="Rotate the map 90°" aria-label="Rotate the map 90°">
            <Icon name="rotate" size={18} />
          </button>
        </div>
      )}
      {zoomLabel !== null && <div className="map-overlay-bc"><span className="zoom-pill">{zoomLabel}%</span></div>}
    </div>
  );
});

/** Where a room's name was drawn, in screen pixels, so a click on it selects that room. */
interface LabelHit { roomId: number; x0: number; y0: number; x1: number; y1: number }

const LABEL_FONT = '600 11px Roboto, "Segoe UI", system-ui, sans-serif';
const MIN_LABEL_WIDTH = 36;
const BADGE = 16;
const BADGE_GAP = 3;
const PAD_X = 6;
const PAD_Y = 3;
const EDGE = 4;

/** text cut with an ellipsis to fit maxPx. */
function fitText(ctx: CanvasRenderingContext2D, text: string, maxPx: number): string {
  if (ctx.measureText(text).width <= maxPx) return text;
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (ctx.measureText(`${text.slice(0, mid)}…`).width <= maxPx) lo = mid; else hi = mid - 1;
  }
  return lo > 0 ? `${text.slice(0, lo)}…` : '…';
}

/**
 * Room names on pills with a round room-type badge in front, as in the Roborock app. A room the
 * robot's room table has no entry for shows the badge alone; a picked room keeps its numbered pill.
 * A name is shortened to fit inside its room and slides in from the view's edge.
 */
function drawLabels(
  ctx: CanvasRenderingContext2D,
  map: ParsedMap,
  selected: number[],
  focus: number | null,
  w: number,
  h: number,
  view: MapTransform,
  threeD: boolean,
  darkPill: boolean,
): LabelHit[] {
  const hits: LabelHit[] = [];
  ctx.font = LABEL_FONT;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  const styles = getComputedStyle(document.documentElement);
  const primary = styles.getPropertyValue('--primary').trim() || '#006a6a';
  const onPrimary = styles.getPropertyValue('--on-primary').trim() || '#fff';
  const gone = erasedRoomIds(map);
  const yaw = (view.yawDeg * Math.PI) / 180;
  for (const room of map.rooms) {
    if (room.labelNormX == null || room.labelNormY == null || gone.has(room.id)) continue;
    const at = view.toScreen(room.labelNormX * map.width, room.labelNormY * map.height, threeD ? WALL_HEIGHT_CELLS * 0.5 : 0);
    if (at.x < -40 || at.x > w + 40 || at.y < -20 || at.y > h + 20) continue;
    const order = selected.indexOf(room.id);
    const picked = order >= 0 || room.id === focus;
    const unnamed = !picked && !(room.inRoomTable || room.name !== `Room ${room.id}`);
    const badge = picked ? 0 : BADGE;
    const gap = picked ? 0 : BADGE_GAP;
    const spanCells = Math.abs(Math.cos(yaw)) * (room.labelSpanCells ?? 0) + Math.abs(Math.sin(yaw)) * (room.labelSpanCellsY ?? room.labelSpanCells ?? 0);
    const viewRoom = Math.max(1, Math.trunc(w - 2 * (PAD_X + EDGE) - badge - gap));
    const textRoom = labelTextWidth(room.labelSpanCells != null, spanCells * view.k - badge - gap, MIN_LABEL_WIDTH, viewRoom);
    const raw = order >= 0 ? `${order + 1} · ${room.name}` : room.name;
    const text = unnamed ? '' : fitText(ctx, raw, textRoom);
    const tw = unnamed ? 0 : ctx.measureText(text).width;
    const total = picked ? tw : badge + (unnamed ? 0 : gap + tw);
    const pillW = total + PAD_X * 2;
    const pillH = Math.max(14, badge) + PAD_Y * 2;
    const lx = w > pillW + 2 * EDGE ? Math.min(w - pillW / 2 - EDGE, Math.max(pillW / 2 + EDGE, at.x)) : at.x;
    const ly = h > pillH + 2 * EDGE ? Math.min(h - pillH / 2 - EDGE, Math.max(pillH / 2 + EDGE, at.y)) : at.y;
    const x0 = lx - pillW / 2, y0 = ly - pillH / 2;
    if (!unnamed) {
      ctx.fillStyle = picked ? primary : darkPill ? 'rgba(0,0,0,0.6)' : 'rgba(255,255,255,0.8)';
      roundRect(ctx, x0, y0, pillW, pillH, pillH / 2);
      ctx.fill();
    }
    hits.push({ roomId: room.id, x0, y0, x1: x0 + pillW, y1: y0 + pillH });
    const left = lx - total / 2;
    if (!picked) {
      const cx = left + badge / 2;
      ctx.fillStyle = '#14202B';
      ctx.beginPath();
      ctx.arc(cx, ly, badge / 2, 0, Math.PI * 2);
      ctx.fill();
      const glyph = badge * 0.6;
      ctx.save();
      ctx.translate(cx - glyph / 2, ly - glyph / 2);
      ctx.scale(glyph / 24, glyph / 24);
      ctx.fillStyle = '#fff';
      ctx.fill(roomIconPath(room.tag));
      ctx.restore();
    }
    if (!unnamed) {
      ctx.fillStyle = picked ? onPrimary : darkPill ? '#fff' : '#0E1A26';
      ctx.fillText(text, left + badge + gap, ly + 0.5);
    }
  }
  return hits;
}
