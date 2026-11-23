import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { cellToMm, contentBoundsNorm, mmToCell, type ParsedMap } from '../../../shared/map';
import { useDark } from '../theme';
import { DARK, LIGHT, drawOverlays, renderFloor, type MapPalette, type ToScreen } from './render';

/*
 * The interactive map: wheel / pinch zoom, drag to pan, tap to pick, double-click to reframe on
 * the floor plan. Screens add their own drawing (overlay) and gestures (onPointerDown).
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
}

const MIN_ZOOM = 1;
const MAX_ZOOM = 12;
const TAP_SLOP_PX = 6;

export const MapView = forwardRef<MapViewApi, Props>(function MapView(props, ref) {
  // overlay, onTap and onPointerDown are read through `latest` so gesture handlers see the newest ones.
  const { map, selectedRoomIds, focusRoomId, showLabels = true, drawRestrictions = true, overlayKey, drawing } = props;
  const dark = useDark();
  const palette = dark ? DARK : LIGHT;
  const floor = useMemo(() => renderFloor(map, palette), [map, palette]);
  const bounds = useMemo(() => contentBoundsNorm(map), [map]);

  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const size = useRef({ w: 0, h: 0 });
  const view = useRef({ zoom: 1, cx: map.width / 2, cy: map.height / 2, framedFor: '' });
  // Until the user pans or zooms, the map stays framed when the window or layout changes size.
  const userMoved = useRef(false);
  const [zoomLabel, setZoomLabel] = useState<number | null>(null);
  const frame = useRef(0);
  const latest = useRef(props);
  latest.current = props;

  const base = () => Math.min(size.current.w / map.width, size.current.h / map.height) || 1;
  const pxPerCell = () => base() * view.current.zoom;

  const fitView = useCallback(() => {
    const { w, h } = size.current;
    if (w === 0 || h === 0) return;
    const bw = Math.max(0.01, bounds.right - bounds.left) * map.width;
    const bh = Math.max(0.01, bounds.bottom - bounds.top) * map.height;
    const b = Math.min(w / map.width, h / map.height);
    const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.min(w / (bw * b), h / (bh * b)) * 0.92));
    view.current = {
      zoom,
      cx: ((bounds.left + bounds.right) / 2) * map.width,
      cy: ((bounds.top + bounds.bottom) / 2) * map.height,
      framedFor: `${map.width}x${map.height}`,
    };
  }, [bounds, map.width, map.height]);

  // Bitmap pixel (col, row-from-bottom r) is drawn at x in [col, col+1) and y in [h-1-r, h-r).
  // mmToCell puts a point of row r at y = h-1-r', so the drawn position is one cell lower.
  const toScreen: ToScreen = useCallback((xMm, yMm) => {
    const c = mmToCell(map, xMm, yMm);
    const s = pxPerCell();
    return { x: size.current.w / 2 + (c.x - view.current.cx) * s, y: size.current.h / 2 + (c.y + 1 - view.current.cy) * s };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map]);

  const cellAt = (sx: number, sy: number) => {
    const s = pxPerCell();
    return { x: view.current.cx + (sx - size.current.w / 2) / s, y: view.current.cy + (sy - size.current.h / 2) / s };
  };

  const toMm = (sx: number, sy: number): [number, number] => {
    const c = cellAt(sx, sy);
    return cellToMm(map, { x: c.x, y: c.y - 1 });
  };

  const labelHits = useRef<LabelHit[]>([]);
  const info = (sx: number, sy: number): PointerInfo => {
    const c = cellAt(sx, sy);
    const hit = [...labelHits.current].reverse().find((l) => sx >= l.x0 && sx <= l.x1 && sy >= l.y0 && sy <= l.y1);
    return { sx, sy, mm: toMm(sx, sy), normX: c.x / map.width, normY: c.y / map.height, labelRoomId: hit?.roomId ?? null };
  };

  const draw = useCallback(() => {
    frame.current = 0;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const { w, h } = size.current;
    const dpr = window.devicePixelRatio || 1;
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const s = pxPerCell();
    const v = view.current;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(floor, w / 2 - v.cx * s, h / 2 - v.cy * s, map.width * s, map.height * s);
    const p = latest.current;
    drawOverlays(ctx, map, palette, toScreen, s, p.drawRestrictions ?? true);
    const api = apiRef.current;
    p.overlay?.({ ctx, api, palette, width: w, height: h });
    labelHits.current = [];
    if (p.showLabels ?? true) labelHits.current = drawLabels(ctx, map, p.selectedRoomIds ?? [], p.focusRoomId ?? null, w, h, (nx, ny) => ({
      x: w / 2 + (nx * map.width - v.cx) * s,
      y: h / 2 + (ny * map.height - v.cy) * s,
    }), dark);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [floor, map, palette, toScreen, dark]);

  const redraw = useCallback(() => {
    if (!frame.current) frame.current = requestAnimationFrame(draw);
  }, [draw]);

  const apiRef = useRef<MapViewApi>(null!);
  apiRef.current = {
    toScreen,
    toMm,
    pxPerCell,
    centerMm: () => toMm(size.current.w / 2, size.current.h / 2),
    visibleWidthMm: () => (size.current.w / pxPerCell()) * 50,
    redraw,
  };
  useImperativeHandle(ref, () => apiRef.current);

  const updateZoomLabel = () => {
    const { w, h } = size.current;
    const bw = Math.max(0.01, bounds.right - bounds.left) * map.width;
    const bh = Math.max(0.01, bounds.bottom - bounds.top) * map.height;
    const b = Math.min(w / map.width, h / map.height);
    const framed = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.min(w / (bw * b), h / (bh * b)) * 0.92));
    const rel = view.current.zoom / framed;
    setZoomLabel(rel > 1.05 ? Math.round(rel * 100) : null);
  };

  const clampView = () => {
    const v = view.current;
    v.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.zoom));
    v.cx = Math.min(map.width, Math.max(0, v.cx));
    v.cy = Math.min(map.height, Math.max(0, v.cy));
  };

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
      if (!userMoved.current || view.current.framedFor !== `${map.width}x${map.height}`) fitView();
      draw();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);
    resize();
    return () => ro.disconnect();
  }, [draw, fitView, map.width, map.height]);

  useEffect(() => { redraw(); }, [redraw, selectedRoomIds, focusRoomId, showLabels, drawRestrictions, overlayKey]);

  // Pointer gestures.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const pointers = new Map<number, { x: number; y: number }>();
    let mode: 'none' | 'pan' | 'pinch' | 'custom' = 'none';
    let custom: CustomGesture | null = null;
    let start = { x: 0, y: 0, t: 0 };
    let moved = false;
    let last = { x: 0, y: 0 };
    let pinch = { dist: 1, zoom: 1, cellX: 0, cellY: 0 };
    let panOnly = false;

    const local = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };

    const startPinch = () => {
      const [a, b] = [...pointers.values()];
      if (!a || !b) return;
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const c = cellAt(mid.x, mid.y);
      pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, zoom: view.current.zoom, cellX: c.x, cellY: c.y };
    };

    const down = (e: PointerEvent) => {
      if (e.pointerType === 'mouse' && e.button > 2) return;
      // The middle and right mouse buttons always pan, so drawing tools never trap the view.
      panOnly = e.pointerType === 'mouse' && e.button !== 0;
      canvas.setPointerCapture(e.pointerId);
      const p = local(e);
      pointers.set(e.pointerId, p);
      if (pointers.size === 2) {
        // A second finger always means zoom; an unfinished drawing is dropped.
        custom?.cancel?.();
        custom = null;
        mode = 'pinch';
        moved = true;
        startPinch();
        return;
      }
      if (pointers.size > 2) return;
      start = { x: p.x, y: p.y, t: performance.now() };
      last = p;
      moved = false;
      custom = panOnly ? null : latest.current.onPointerDown?.(info(p.x, p.y)) ?? null;
      mode = custom ? 'custom' : 'pan';
    };

    const move = (e: PointerEvent) => {
      if (!pointers.has(e.pointerId)) return;
      const p = local(e);
      pointers.set(e.pointerId, p);
      if (mode === 'pinch' && pointers.size >= 2) {
        userMoved.current = true;
        const [a, b] = [...pointers.values()];
        const dist = Math.hypot(a!.x - b!.x, a!.y - b!.y) || 1;
        const mid = { x: (a!.x + b!.x) / 2, y: (a!.y + b!.y) / 2 };
        view.current.zoom = pinch.zoom * (dist / pinch.dist);
        clampView();
        const s = pxPerCell();
        view.current.cx = pinch.cellX - (mid.x - size.current.w / 2) / s;
        view.current.cy = pinch.cellY - (mid.y - size.current.h / 2) / s;
        clampView();
        updateZoomLabel();
        redraw();
        return;
      }
      if (!moved && Math.hypot(p.x - start.x, p.y - start.y) < TAP_SLOP_PX) return;
      moved = true;
      if (mode === 'custom') {
        custom?.move(info(p.x, p.y));
      } else if (mode === 'pan') {
        userMoved.current = true;
        const s = pxPerCell();
        view.current.cx -= (p.x - last.x) / s;
        view.current.cy -= (p.y - last.y) / s;
        clampView();
        redraw();
      }
      last = p;
    };

    const up = (e: PointerEvent) => {
      if (!pointers.has(e.pointerId)) return;
      const p = local(e);
      pointers.delete(e.pointerId);
      if (mode === 'pinch') {
        if (pointers.size === 0) mode = 'none';
        else if (pointers.size === 1) { mode = 'pan'; last = [...pointers.values()][0]!; }
        return;
      }
      if (pointers.size > 0) return;
      const wasMode = mode;
      mode = 'none';
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
      userMoved.current = true;
      const r = canvas.getBoundingClientRect();
      const p = { x: e.clientX - r.left, y: e.clientY - r.top };
      const c = cellAt(p.x, p.y);
      const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
      view.current.zoom *= factor;
      clampView();
      const s = pxPerCell();
      view.current.cx = c.x - (p.x - size.current.w / 2) / s;
      view.current.cy = c.y - (p.y - size.current.h / 2) / s;
      clampView();
      updateZoomLabel();
      redraw();
    };

    const dbl = () => {
      userMoved.current = false;
      fitView();
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
  }, [map, redraw, fitView]);

  return (
    <div ref={wrapRef} style={{ position: 'absolute', inset: 0 }}>
      <canvas ref={canvasRef} className={`map-canvas ${drawing ? 'drawing' : ''}`} aria-label="Map" />
      {zoomLabel !== null && <div className="map-overlay-tr"><span className="zoom-pill">{zoomLabel}%</span></div>}
    </div>
  );
});

/** Room names in screen space, so they stay legible at any zoom. Picked rooms show their order. */
function drawLabels(
  ctx: CanvasRenderingContext2D,
  map: ParsedMap,
  selected: number[],
  focus: number | null,
  w: number,
  h: number,
  toScreen: (nx: number, ny: number) => { x: number; y: number },
  dark: boolean,
): LabelHit[] {
  const hits: LabelHit[] = [];
  ctx.font = '600 11px Roboto, "Segoe UI", system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  const styles = getComputedStyle(document.documentElement);
  const primary = styles.getPropertyValue('--primary').trim() || '#006a6a';
  const onPrimary = styles.getPropertyValue('--on-primary').trim() || '#fff';
  const onSurface = styles.getPropertyValue('--on-surface').trim() || '#1d1b20';
  const bg = dark ? 'rgba(22, 27, 30, 0.9)' : 'rgba(255, 255, 255, 0.92)';
  for (const room of map.rooms) {
    if (room.labelNormX == null || room.labelNormY == null) continue;
    const p = toScreen(room.labelNormX, room.labelNormY);
    if (p.x < 0 || p.x > w || p.y < 0 || p.y > h) continue;
    const order = selected.indexOf(room.id);
    const highlighted = order >= 0 || room.id === focus;
    const text = order >= 0 ? `${order + 1} · ${room.name}` : room.name;
    const tw = ctx.measureText(text).width;
    const padX = 6, boxH = 20;
    ctx.fillStyle = highlighted ? primary : bg;
    roundRect(ctx, p.x - tw / 2 - padX, p.y - boxH / 2, tw + padX * 2, boxH, 6);
    ctx.fill();
    ctx.fillStyle = highlighted ? onPrimary : onSurface;
    ctx.fillText(text, p.x, p.y + 0.5);
    hits.push({ roomId: room.id, x0: p.x - tw / 2 - padX, y0: p.y - boxH / 2, x1: p.x + tw / 2 + padX, y1: p.y + boxH / 2 });
  }
  return hits;
}

/** Where a room's name was drawn, in screen pixels, so a click on it selects that room. */
interface LabelHit { roomId: number; x0: number; y0: number; x1: number; y1: number }

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
