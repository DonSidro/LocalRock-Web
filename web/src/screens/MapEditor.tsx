import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { ACTIVE_STATES, ROOM_TYPES, roomNameProblem } from '../../../shared/codes';
import {
  FloorMaterial, MAX_MAP_COORD_MM, MAX_RESTRICTION_VERTICES, distanceToSegmentMm, isRoundCarpet, rectZone,
  resizeZoneFromCorner, restrictionVertexCount, roomAtNorm, rotateZone, thresholdCenterLine, thresholdStrip,
  translateWall, translateZone, wallFitsMap, wallWithEnd, zoneCenter, zoneContains, zoneCorners, zoneFitsMap,
  type MapZone, type ParsedMap, type VirtualWall, type ZoneKind,
} from '../../../shared/map';
import { advertisedUnsupportedMapEdits, editBlockedReason, mapIndexBlocker, restrictionSaveBlocker, saveMapIndex, unsupportedMapEditNote } from '../../../shared/mapEdit';
import { restrictionsMatch } from '../../../shared/verification';
import { call } from '../api';
import { Icon, type IconName } from '../icons';
import { MapView, type CustomGesture, type MapViewApi } from '../map/MapView';
import { WALL_COLOR, ZONE_COLORS, drawWall, drawZone, zonePath } from '../map/render';
import { navigate, setLeaveGuard, type Route } from '../router';
import { useVacuum } from '../store';
import { furnitureBlockedReason } from '../../../shared/furniture';
import { FurnitureEditor } from './FurnitureEditor';
import { ConfirmDialog, Empty, Field, IconButton, Panel, Select, Spinner, isTypingTarget } from '../ui';

/*
 * Map editor, ported from LocalRock's MapEditScreen.kt.
 *
 * Zones: no-go zones, walls, carpets and thresholds are edited locally and saved together. Each
 * kind is written as a complete set, so what is removed here is removed from the robot. Shapes
 * nobody touched keep their original corners.
 *
 * Rooms: rename, floor type, split and merge, each sent at once and only reported done once the
 * robot's next map shows it.
 */

type Mode = 'ZONES' | 'ROOMS';
type Tool = 'NO_GO' | 'WALL' | 'CARPET' | 'THRESHOLD';
type Selection = { type: 'zone'; index: number } | { type: 'wall'; index: number };
type RoomAction = { kind: 'none' } | { kind: 'split'; segment: number } | { kind: 'merge'; segment: number };
type DragTarget = { kind: 'body' } | { kind: 'corner'; index: number } | { kind: 'rotate' } | { kind: 'end'; end: 0 | 1 };
interface Notice { text: string; error: boolean }

/** Shapes smaller than this (a zone side or a line) are treated as accidental. */
const MIN_SHAPE_MM = 200;
const NEW_SHAPE_MARGIN_MM = 1_000;
const NEW_SHAPE_FRACTION = 0.18;
const HANDLE_DRAW_R = 9;
const HANDLE_TOUCH_R = 28;
const ROTATE_DISTANCE = 36;
const SPLIT_COLOR = '#ff9800';

const FLOOR_CHOICES: Array<{ label: string; material: number; direction: number | null }> = [
  { label: 'Default', material: FloorMaterial.DEFAULT, direction: null },
  { label: 'Wood, horizontal', material: FloorMaterial.WOOD, direction: 0 },
  { label: 'Wood, vertical', material: FloorMaterial.WOOD, direction: 90 },
  { label: 'Tile', material: FloorMaterial.TILE, direction: null },
];

const TOOLS: Array<{ tool: Tool; label: string; icon: IconName; color: string }> = [
  { tool: 'NO_GO', label: 'No-go', icon: 'block', color: ZONE_COLORS.NO_GO.solid },
  { tool: 'WALL', label: 'Wall', icon: 'wall', color: WALL_COLOR },
  { tool: 'CARPET', label: 'Carpet', icon: 'texture', color: ZONE_COLORS.CARPET.solid },
  { tool: 'THRESHOLD', label: 'Threshold', icon: 'door', color: ZONE_COLORS.THRESHOLD.solid },
];

const restrictionZones = (zones: MapZone[]) => zones.filter((z) => z.kind === 'NO_GO' || z.kind === 'NO_MOP');
/** Round carpets only move: what the robot makes of a stretched or rotated one is unknown. */
const canRotateOrResize = (z: MapZone) => z.kind === 'NO_GO' || (z.kind === 'CARPET' && !isRoundCarpet(z));

function kindTitle(kind: ZoneKind | null, round = false): string {
  switch (kind) {
    case null: return 'Wall';
    case 'NO_GO': return 'No-go zone';
    case 'NO_MOP': return 'No-mop zone';
    case 'CARPET': return round ? 'Round carpet' : 'Carpet';
    case 'THRESHOLD': return 'Threshold';
    case 'ERASER': return 'Removed area';
  }
}

function kindHelp(kind: ZoneKind | null, round: boolean): string {
  if (round) return 'Drag to move. Resize round carpets in the Roborock app.';
  switch (kind) {
    case null: case 'THRESHOLD': return 'Drag to move, drag the ends to reshape.';
    case 'NO_GO': case 'CARPET': return 'Drag to move. Corners resize, the knob rotates.';
    case 'NO_MOP': case 'ERASER': return "Set in the Roborock app. LocalRock can't change it yet.";
  }
}

export function MapEditorScreen({ duid }: { duid: string }) {
  const { snap, map } = useVacuum(duid);
  const view = useRef<MapViewApi>(null);
  const [mode, setMode] = useState<Mode>('ZONES');
  const [zones, setZones] = useState<MapZone[]>([]);
  const [walls, setWalls] = useState<VirtualWall[]>([]);
  const [dirty, setDirty] = useState(false);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [selectedRoom, setSelectedRoom] = useState<number | null>(null);
  const [roomAction, setRoomAction] = useState<RoomAction>({ kind: 'none' });
  const [pendingSplit, setPendingSplit] = useState<{ segment: number; a: [number, number]; b: [number, number] } | null>(null);
  const [pendingMerge, setPendingMerge] = useState<{ a: number; b: number } | null>(null);
  const [splitLine, setSplitLine] = useState<{ a: [number, number]; b: [number, number] } | null>(null);
  const [working, setWorking] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [confirmSave, setConfirmSave] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [furnitureOpen, setFurnitureOpen] = useState(false);
  const [furnitureChecking, setFurnitureChecking] = useState(true);
  const [furnitureCheck, setFurnitureCheck] = useState(0);

  // Only the robot's own live answer may offer furniture editing; a failed read leaves it unknown.
  useEffect(() => {
    let alive = true;
    setFurnitureChecking(true);
    void call(duid, 'fetchFurnitureSupport').catch(() => undefined).finally(() => { if (alive) setFurnitureChecking(false); });
    return () => { alive = false; };
  }, [duid, furnitureCheck]);

  // Follow the robot's map until the user starts editing; then local edits own the state.
  useEffect(() => {
    if (!dirty && map) {
      setZones([...map.noGoZones, ...map.noMopZones, ...map.carpetAreas, ...map.thresholds]);
      setWalls(map.virtualWalls);
      setSelection(null);
    }
  }, [map, dirty]);

  useEffect(() => {
    if (notice && !notice.error) {
      const t = setTimeout(() => setNotice(null), 4_000);
      return () => clearTimeout(t);
    }
  }, [notice]);

  // Closing the tab must not silently drop unsaved edits.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  // Leaving the tab with unsaved edits asks first. Closing or reloading the page is covered above.
  const [pendingLeave, setPendingLeave] = useState<Route | null>(null);
  useEffect(() => {
    if (!dirty) return;
    return setLeaveGuard((to) => {
      setPendingLeave(to);
      setConfirmDiscard(true);
      return false;
    });
  }, [dirty]);

  // Delete removes the selected shape, Escape lets go of it or cancels a split or merge.
  const keys = useRef<(e: KeyboardEvent) => void>(() => undefined);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target) || document.querySelector('.scrim')) return;
      keys.current(e);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (furnitureOpen) {
    return (
      <FurnitureEditor
        duid={duid}
        onClose={() => setFurnitureOpen(false)}
        onSaved={() => { setFurnitureOpen(false); setNotice({ text: "Saved. The robot's map shows your furniture.", error: false }); }}
      />
    );
  }

  if (!snap || !map) {
    return (
      <div className="tab-page">
        {!snap ? <div className="empty"><Spinner big /></div> : <Empty icon="map" title="Map not loaded" text="Load the map on the Overview tab first." />}
      </div>
    );
  }

  const robotBusy = snap.status.state !== undefined && ACTIVE_STATES.has(snap.status.state);
  const blockedReason = editBlockedReason(map, robotBusy);
  const floorsLoaded = snap.floorMapsLoaded;
  const mapIndex = saveMapIndex(snap.floorMaps);
  // Until the robot's map list arrives nothing is blocked for drawing; only Save waits for it.
  const indexBlocker = !floorsLoaded ? null : snap.floorMaps.length === 0 ? 'The robot has no saved map yet. Map edits need a saved map.' : mapIndexBlocker(mapIndex);
  const saveBlocker = floorsLoaded ? restrictionSaveBlocker(map, mapIndex) : null;
  const restrictionsChanged = !restrictionsMatch(map, zones.filter((z) => z.kind === 'NO_GO'), map.noMopZones, walls);
  const vertices = restrictionVertexCount(walls.length, restrictionZones(zones).length);
  const editable = blockedReason === null && !working;
  const unsupported = advertisedUnsupportedMapEdits(snap.featureSet, snap.newFeatureSet, map.carpetAreas.length > 0, map.thresholds.length > 0);
  const toolEnabled = (t: Tool) => editable && (t === 'NO_GO' || t === 'WALL' ? saveBlocker === null : indexBlocker === null && !unsupported.includes(t));
  const selectedZone = selection?.type === 'zone' ? zones[selection.index] ?? null : null;
  const canModifySelection = editable && (selection?.type === 'wall'
    ? saveBlocker === null
    : selectedZone?.kind === 'NO_GO' ? saveBlocker === null
      : selectedZone?.kind === 'CARPET' || selectedZone?.kind === 'THRESHOLD' ? indexBlocker === null
        : false);
  const canSave = blockedReason === null && floorsLoaded && indexBlocker === null && (saveBlocker === null || !restrictionsChanged);

  const runEdit = async (success: string, block: () => Promise<string | null>) => {
    setWorking(true);
    setNotice(null);
    try {
      setNotice({ text: (await block()) ?? success, error: false });
    } catch (e) {
      setNotice({ text: (e as Error).message || 'Something went wrong', error: true });
    } finally {
      setWorking(false);
    }
  };

  const addShape = (t: Tool) => {
    const api = view.current;
    if (!api) return;
    const clamp = (v: number) => Math.min(MAX_MAP_COORD_MM - NEW_SHAPE_MARGIN_MM, Math.max(NEW_SHAPE_MARGIN_MM, Math.round(v)));
    const [rx, ry] = api.centerMm();
    const cx = clamp(rx), cy = clamp(ry);
    const side = Math.round(Math.min(3_000, Math.max(600, api.visibleWidthMm() * NEW_SHAPE_FRACTION)));
    const half = Math.trunc(side / 2);
    const limitHit = t === 'NO_GO' ? restrictionVertexCount(walls.length, restrictionZones(zones).length + 1) > MAX_RESTRICTION_VERTICES
      : t === 'WALL' ? restrictionVertexCount(walls.length + 1, restrictionZones(zones).length) > MAX_RESTRICTION_VERTICES : false;
    if (limitHit) {
      setNotice({ text: `The robot stores at most ${MAX_RESTRICTION_VERTICES} zone and wall points. Remove one first.`, error: true });
      return;
    }
    if (t === 'WALL') {
      const w = Math.trunc((half * 6) / 5);
      setWalls([...walls, { x0: cx - w, y0: cy, x1: cx + w, y1: cy }]);
      setSelection({ type: 'wall', index: walls.length });
    } else {
      const zone = t === 'NO_GO' ? rectZone(cx - half, cy - half, cx + half, cy + half, 'NO_GO')
        : t === 'CARPET' ? rectZone(cx - Math.trunc((half * 8) / 5), cy - half, cx + Math.trunc((half * 8) / 5), cy + half, 'CARPET')
          // A doorway is roughly 0.9 m whatever the zoom.
          : thresholdStrip([cx - 450, cy], [cx + 450, cy]);
      setZones([...zones, zone]);
      setSelection({ type: 'zone', index: zones.length });
    }
    setDirty(true);
    setNotice(null);
  };

  const slopMm = (api: MapViewApi, px: number) => (px / api.pxPerCell()) * 50;

  const handles = (api: MapViewApi): Array<{ target: DragTarget; x: number; y: number }> => {
    const sel = selection;
    if (!sel) return [];
    const scr = (x: number, y: number) => api.toScreen(x, y);
    if (sel.type === 'wall') {
      const w = walls[sel.index];
      if (!w) return [];
      return [{ target: { kind: 'end', end: 0 }, ...scr(w.x0, w.y0) }, { target: { kind: 'end', end: 1 }, ...scr(w.x1, w.y1) }];
    }
    const z = zones[sel.index];
    if (!z) return [];
    if (z.kind === 'THRESHOLD') {
      const [a, b] = thresholdCenterLine(z);
      return [{ target: { kind: 'end', end: 0 }, ...scr(a[0], a[1]) }, { target: { kind: 'end', end: 1 }, ...scr(b[0], b[1]) }];
    }
    if (!canRotateOrResize(z)) return [];
    const corners = zoneCorners(z).map(([x, y]) => scr(x, y));
    const [cmx, cmy] = zoneCenter(z);
    const c = scr(Math.trunc(cmx), Math.trunc(cmy));
    const mid = { x: (corners[0]!.x + corners[1]!.x) / 2, y: (corners[0]!.y + corners[1]!.y) / 2 };
    let dx = mid.x - c.x, dy = mid.y - c.y;
    const len = Math.hypot(dx, dy);
    if (len < 1) { dx = 0; dy = -1; } else { dx /= len; dy /= len; }
    return [
      ...corners.map((p, i) => ({ target: { kind: 'corner', index: i } as DragTarget, ...p })),
      { target: { kind: 'rotate' }, x: mid.x + dx * ROTATE_DISTANCE, y: mid.y + dy * ROTATE_DISTANCE },
    ];
  };

  const onPointerDown = (p: { sx: number; sy: number; mm: [number, number] }): CustomGesture | null => {
    const api = view.current;
    if (!api) return null;
    if (mode === 'ROOMS') {
      if (!(editable && roomAction.kind === 'split')) return null;
      const a = p.mm;
      return {
        move: (q) => setSplitLine({ a, b: q.mm }),
        end: (q) => {
          setSplitLine(null);
          if (Math.hypot(q.mm[0] - a[0], q.mm[1] - a[1]) >= MIN_SHAPE_MM) setPendingSplit({ segment: roomAction.segment, a, b: q.mm });
        },
        cancel: () => setSplitLine(null),
      };
    }
    const sel = selection;
    if (!sel || !canModifySelection) return null;
    // What this touch does is decided where it lands: a handle or the selected shape's body edits it.
    let target: DragTarget | null = null;
    let best = Infinity;
    for (const h of handles(api)) {
      const d = Math.hypot(h.x - p.sx, h.y - p.sy);
      if (d <= HANDLE_TOUCH_R && d < best) { best = d; target = h.target; }
    }
    if (!target) {
      const [x, y] = p.mm;
      const slop = slopMm(api, HANDLE_TOUCH_R);
      const onBody = sel.type === 'wall'
        ? (() => { const w = walls[sel.index]; return !!w && distanceToSegmentMm(x, y, w.x0, w.y0, w.x1, w.y1) <= slop; })()
        : (() => {
          const z = zones[sel.index];
          if (!z) return false;
          if (z.kind === 'THRESHOLD') { const [a, b] = thresholdCenterLine(z); return distanceToSegmentMm(x, y, a[0], a[1], b[0], b[1]) <= slop; }
          return zoneContains(z, x, y);
        })();
      if (!onBody) return null;
      target = { kind: 'body' };
    }
    const startMm = p.mm;
    const startZone = sel.type === 'zone' ? zones[sel.index] : undefined;
    const startWall = sel.type === 'wall' ? walls[sel.index] : undefined;
    const t = target;
    // Each move is applied to the shape as it was when the drag began, so rounding never accumulates.
    const apply = (now: [number, number]) => {
      const dx = now[0] - startMm[0];
      const dy = now[1] - startMm[1];
      if (sel.type === 'wall' && startWall) {
        let next: VirtualWall;
        if (t.kind === 'body') next = translateWall(startWall, dx, dy);
        else if (t.kind === 'end') {
          const [ex, ey] = t.end === 0 ? [startWall.x0, startWall.y0] : [startWall.x1, startWall.y1];
          next = wallWithEnd(startWall, t.end, ex + dx, ey + dy);
          if (Math.hypot(next.x1 - next.x0, next.y1 - next.y0) < MIN_SHAPE_MM) return;
        } else return;
        if (!wallFitsMap(next)) return;
        setWalls((ws) => ws.map((w, i) => (i === sel.index ? next : w)));
      } else if (sel.type === 'zone' && startZone) {
        let next: MapZone;
        if (t.kind === 'body') next = translateZone(startZone, dx, dy);
        else if (t.kind === 'corner') {
          const [cx, cy] = zoneCorners(startZone)[t.index]!;
          next = resizeZoneFromCorner(startZone, t.index, cx + dx, cy + dy, MIN_SHAPE_MM);
        } else if (t.kind === 'rotate') {
          const [cx, cy] = zoneCenter(startZone);
          next = rotateZone(startZone, Math.atan2(now[1] - cy, now[0] - cx) - Math.atan2(startMm[1] - cy, startMm[0] - cx));
        } else {
          if (startZone.kind !== 'THRESHOLD') return;
          const [a, b] = thresholdCenterLine(startZone);
          const na: [number, number] = t.end === 0 ? [a[0] + dx, a[1] + dy] : a;
          const nb: [number, number] = t.end === 1 ? [b[0] + dx, b[1] + dy] : b;
          if (Math.hypot(nb[0] - na[0], nb[1] - na[1]) < MIN_SHAPE_MM) return;
          next = thresholdStrip(na, nb);
        }
        if (!zoneFitsMap(next)) return;
        setZones((zs) => zs.map((z, i) => (i === sel.index ? next : z)));
      }
      setDirty(true);
      setNotice(null);
    };
    return { move: (q) => apply(q.mm), end: (q) => apply(q.mm) };
  };

  const onTap = (p: { mm: [number, number]; normX: number; normY: number; labelRoomId?: number | null }) => {
    const api = view.current;
    if (!api) return;
    if (mode === 'ROOMS') {
      const segment = p.labelRoomId ?? roomAtNorm(map, p.normX, p.normY)?.id ?? null;
      if (segment === null) return;
      if (roomAction.kind === 'merge' && segment !== roomAction.segment) setPendingMerge({ a: roomAction.segment, b: segment });
      else if (roomAction.kind === 'none') setSelectedRoom(segment);
      return;
    }
    const [x, y] = p.mm;
    const slop = slopMm(api, 24);
    let hit: Selection | null = null;
    for (let i = walls.length - 1; i >= 0; i--) {
      const w = walls[i]!;
      if (distanceToSegmentMm(x, y, w.x0, w.y0, w.x1, w.y1) <= slop) { hit = { type: 'wall', index: i }; break; }
    }
    if (!hit) {
      for (let i = zones.length - 1; i >= 0; i--) {
        const z = zones[i]!;
        const nearLine = z.kind === 'THRESHOLD' && (() => { const [a, b] = thresholdCenterLine(z); return distanceToSegmentMm(x, y, a[0], a[1], b[0], b[1]) <= slop; })();
        if (zoneContains(z, x, y) || nearLine) { hit = { type: 'zone', index: i }; break; }
      }
    }
    const same = hit && selection && hit.type === selection.type && hit.index === selection.index;
    setSelection(same ? null : hit);
  };

  const warning = blockedReason ?? (mode === 'ZONES' ? indexBlocker ?? saveBlocker : null);
  const roomName = (id: number) => map.rooms.find((r) => r.id === id)?.name ?? `Room ${id}`;
  const deleteSelection = () => {
    if (!selection || !canModifySelection) return;
    if (selection.type === 'zone') setZones((zs) => zs.filter((_, i) => i !== selection.index));
    else setWalls((ws) => ws.filter((_, i) => i !== selection.index));
    setSelection(null);
    setDirty(true);
  };
  const switchMode = (m: Mode) => { setMode(m); setSelection(null); setSelectedRoom(null); setRoomAction({ kind: 'none' }); };
  keys.current = (e) => {
    if (e.key === 'Escape') {
      if (roomAction.kind !== 'none') setRoomAction({ kind: 'none' });
      else if (selection) setSelection(null);
      else if (selectedRoom !== null) setSelectedRoom(null);
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && mode === 'ZONES' && selection) {
      e.preventDefault();
      deleteSelection();
    }
  };
  const selectionKind = selection?.type === 'wall' ? null : selectedZone?.kind ?? null;
  const selectionRound = !!selectedZone && isRoundCarpet(selectedZone);

  return (
    <div className="editor">
      <div className="editor-canvas">
        <MapView
          ref={view}
          map={map}
          showLabels={mode === 'ROOMS'}
          focusRoomId={roomAction.kind !== 'none' ? roomAction.segment : selectedRoom}
          drawRestrictions={false}
          drawing={mode === 'ROOMS' && roomAction.kind === 'split'}
          overlayKey={[zones, walls, selection, mode, splitLine, canModifySelection]}
          onTap={onTap}
          onPointerDown={onPointerDown}
          overlay={({ ctx, api }) => {
            const dim = mode === 'ROOMS';
            zones.forEach((z, i) => {
              const sel = selection?.type === 'zone' && selection.index === i;
              drawZone(ctx, z, api.toScreen, sel ? 3.5 : 1.5, dim);
            });
            walls.forEach((w, i) => drawWall(ctx, w, api.toScreen, selection?.type === 'wall' && selection.index === i ? 6 : 3, dim));
            if (splitLine) {
              const a = api.toScreen(splitLine.a[0], splitLine.a[1]);
              const b = api.toScreen(splitLine.b[0], splitLine.b[1]);
              ctx.strokeStyle = SPLIT_COLOR;
              ctx.lineWidth = 3;
              ctx.setLineDash([12, 6]);
              ctx.beginPath();
              ctx.moveTo(a.x, a.y);
              ctx.lineTo(b.x, b.y);
              ctx.stroke();
              ctx.setLineDash([]);
            }
            if (mode === 'ZONES' && selection && canModifySelection) {
              const ring = selection.type === 'wall' ? WALL_COLOR : ZONE_COLORS[zones[selection.index]?.kind ?? 'NO_GO'].solid;
              // Outline the selection once more so it stands out.
              if (selection.type === 'zone' && zones[selection.index]) {
                zonePath(ctx, zones[selection.index]!, api.toScreen);
                ctx.strokeStyle = ring;
                ctx.lineWidth = 2;
                ctx.stroke();
              }
              for (const h of handles(api)) {
                if (h.target.kind === 'rotate') {
                  ctx.fillStyle = ring;
                  ctx.beginPath(); ctx.arc(h.x, h.y, HANDLE_DRAW_R, 0, Math.PI * 2); ctx.fill();
                  ctx.fillStyle = '#fff';
                  ctx.beginPath(); ctx.arc(h.x, h.y, HANDLE_DRAW_R * 0.45, 0, Math.PI * 2); ctx.fill();
                } else {
                  ctx.fillStyle = '#fff';
                  ctx.beginPath(); ctx.arc(h.x, h.y, HANDLE_DRAW_R, 0, Math.PI * 2); ctx.fill();
                  ctx.strokeStyle = ring;
                  ctx.lineWidth = 2;
                  ctx.stroke();
                }
              }
            }
          }}
        />
        <div className="map-hint">
          {mode === 'ROOMS'
            ? roomAction.kind === 'split' ? 'Drag a line across the room, wall to wall. Right-drag to pan.'
              : roomAction.kind === 'merge' ? 'Click the neighbouring room to merge with.' : 'Click a room to edit it.'
            : selection ? kindHelp(selectionKind, selectionRound) : 'Click a shape to select it. Scroll to zoom, drag to pan.'}
        </div>
        {notice && (
          <div className={`notice-pill ${notice.error ? 'error' : ''}`} role="status">
            <span className="small">{notice.text}</span>
            <IconButton icon="close" label="Dismiss" onClick={() => setNotice(null)} />
          </div>
        )}
      </div>

      <aside className="inspector" aria-label="Map editor">
        <Panel>
          {/* Room edits reshape the map under unsaved zone edits, so save or discard first. */}
          <div className="segmented block" role="group" aria-label="Edit mode">
            <button type="button" aria-pressed={mode === 'ZONES'} disabled={working} onClick={() => switchMode('ZONES')}>Zones</button>
            <button type="button" aria-pressed={mode === 'ROOMS'} disabled={working || dirty} title={dirty ? 'Save or discard the zone changes first' : undefined} onClick={() => switchMode('ROOMS')}>Rooms</button>
          </div>
          {warning ? (
            <div className="callout error small"><Icon name="error" /><span>{warning}</span></div>
          ) : !floorsLoaded && mode === 'ZONES' ? (
            <div className="callout small"><Spinner /><span>Checking the robot's saved maps. You can edit now; saving waits for this.</span></div>
          ) : null}
        </Panel>

        {mode === 'ZONES' ? (
          <>
            <Panel
              title="Add to map"
              actions={<span className="small" style={{ color: vertices >= MAX_RESTRICTION_VERTICES ? 'var(--error)' : 'var(--on-surface-variant)' }} title="The robot stores a limited number of zone and wall points">{vertices}/{MAX_RESTRICTION_VERTICES} points</span>}
            >
              <div className="tool-grid">
                {TOOLS.map((t) => (
                  <button key={t.tool} type="button" className="tool-btn" disabled={!toolEnabled(t.tool)} onClick={() => addShape(t.tool)} aria-label={`Add ${t.label.toLowerCase()}`}>
                    <span className="disc" style={{ '--tint': t.color } as CSSProperties}><Icon name={t.icon} /></span>
                    {t.label}
                  </button>
                ))}
              </div>
              {unsupportedMapEditNote(unsupported) && <p className="muted small">{unsupportedMapEditNote(unsupported)}</p>}
              {snap.furnitureSupport === 'SUPPORTED' && (
                <>
                  <p className="muted small">Furniture editing needs a single saved map and is kept on the first map.</p>
                  <div className="tool-grid">
                    <button type="button" className="tool-btn" disabled={!editable || dirty || furnitureChecking} onClick={() => setFurnitureOpen(true)} aria-label="Edit furniture">
                      <span className="disc" style={{ '--tint': 'var(--primary)' } as CSSProperties}><Icon name="chair" /></span>
                      Furniture
                    </button>
                  </div>
                  {dirty && <p className="muted small">Save or discard your map changes before editing furniture.</p>}
                </>
              )}
              {furnitureChecking && snap.furnitureSupport !== 'SUPPORTED' && <p className="muted small">Checking furniture support...</p>}
              {!furnitureChecking && snap.furnitureSupport === 'UNKNOWN' && (
                <p className="muted small">
                  {furnitureBlockedReason('UNKNOWN')}{' '}
                  <button type="button" className="btn ghost sm" onClick={() => setFurnitureCheck((n) => n + 1)}>Retry furniture check</button>
                </p>
              )}
            </Panel>

            {selection && (
              <Panel
                title={<span className="row"><span className="dot" style={{ width: 12, height: 12, background: selection.type === 'wall' ? WALL_COLOR : ZONE_COLORS[selectedZone?.kind ?? 'NO_GO'].solid }} />{kindTitle(selectionKind, selectionRound)}</span>}
              >
                <p className="muted small">{canModifySelection || selectedZone?.kind === 'NO_MOP' ? kindHelp(selectionKind, selectionRound) : "Can't be changed right now."}</p>
                <div className="btn-row">
                  {canModifySelection && <button type="button" className="btn secondary sm" title="Delete (Del)" onClick={deleteSelection}><Icon name="delete" />Delete</button>}
                  <button type="button" className="btn secondary sm" title="Done (Esc)" onClick={() => setSelection(null)}><Icon name="check" />Done</button>
                </div>
              </Panel>
            )}

            <Panel title="Changes">
              {working ? (
                <div className="row small"><Spinner /><span>Saving to the robot...</span></div>
              ) : (
                <p className="muted small">{dirty ? 'You have changes that are not on the robot yet.' : 'No unsaved changes.'}</p>
              )}
              <div className="btn-row">
                <button type="button" className="btn" disabled={!dirty || !canSave || working} onClick={() => setConfirmSave(true)}>Save to robot</button>
                <button type="button" className="btn secondary" disabled={!dirty || working} onClick={() => { setPendingLeave(null); setConfirmDiscard(true); }}>Discard</button>
              </div>
            </Panel>
          </>
        ) : (
          <>
            {roomAction.kind !== 'none' && (
              <Panel title={roomAction.kind === 'split' ? `Split ${roomName(roomAction.segment)}` : `Merge ${roomName(roomAction.segment)}`}>
                <p className="muted small">{roomAction.kind === 'split' ? 'Draw a line across the room on the map, wall to wall.' : 'Click the neighbouring room to merge with.'}</p>
                <button type="button" className="btn secondary" onClick={() => setRoomAction({ kind: 'none' })}>Cancel</button>
              </Panel>
            )}
            {roomAction.kind === 'none' && selectedRoom !== null && (
              <RoomPanel
                key={selectedRoom}
                map={map}
                segment={selectedRoom}
                tag={snap.roomTags[selectedRoom] ?? null}
                working={working}
                enabled={blockedReason === null}
                onClose={() => setSelectedRoom(null)}
                onRename={(name) => void runEdit('Room renamed.', async () => { await call(duid, 'renameRoom', { segment: selectedRoom, name }); return null; })}
                onType={(tag) => void runEdit('Room type set.', async () => { await call(duid, 'setRoomType', { segment: selectedRoom, tag }); return null; })}
                onFloor={(choice) => void runEdit("Floor type set. The robot's map shows the change.", async () => {
                  const r = await call<{ confirmed: boolean }>(duid, 'setFloorMaterial', { segment: selectedRoom, material: choice.material, direction: choice.direction });
                  return r?.confirmed ? null : "Floor type sent. This robot's map doesn't report floor types, so LocalRock can't confirm it.";
                })}
                onSplit={() => { setRoomAction({ kind: 'split', segment: selectedRoom }); setNotice(null); }}
                onMerge={() => { setRoomAction({ kind: 'merge', segment: selectedRoom }); setNotice(null); }}
              />
            )}
            <Panel title="Rooms" actions={working ? <Spinner /> : undefined}>
              <ul className="room-list">
                {map.rooms.map((r) => (
                  <li key={r.id}>
                    <button
                      type="button"
                      className={`room-row ${selectedRoom === r.id ? 'selected' : ''}`}
                      disabled={roomAction.kind !== 'none'}
                      onClick={() => setSelectedRoom(selectedRoom === r.id ? null : r.id)}
                    >
                      <span className="grow ellipsis">{r.name}</span>
                      <Icon name="chevronRight" size={18} className="muted" />
                    </button>
                  </li>
                ))}
              </ul>
            </Panel>
          </>
        )}
      </aside>

      {confirmSave && (
        <ConfirmDialog
          title="Save to robot?"
          text={`The robot will keep exactly these: ${zones.filter((z) => z.kind === 'NO_GO').length} no-go zone(s), ${walls.length} wall(s), ${zones.filter((z) => z.kind === 'CARPET').length} carpet area(s) and ${zones.filter((z) => z.kind === 'THRESHOLD').length} threshold(s). Anything removed here is removed from the robot.`}
          confirm="Save"
          onConfirm={() => {
            const noGoZones = zones.filter((z) => z.kind === 'NO_GO');
            const carpets = zones.filter((z) => z.kind === 'CARPET');
            const thresholds = zones.filter((z) => z.kind === 'THRESHOLD');
            void runEdit("Saved. The robot's map shows the changes.", async () => {
              await call(duid, 'saveMapEdits', { noGoZones, walls, carpets, thresholds });
              setDirty(false);
              setSelection(null);
              return null;
            });
          }}
          onClose={() => setConfirmSave(false)}
        />
      )}
      {confirmDiscard && (
        <ConfirmDialog
          title="Discard changes?"
          text="Your map changes have not been saved to the robot."
          confirm="Discard"
          danger
          onConfirm={() => {
            setDirty(false);
            if (pendingLeave) navigate(pendingLeave, false, true);
          }}
          onClose={() => { setConfirmDiscard(false); setPendingLeave(null); }}
        />
      )}
      {pendingSplit && (
        <ConfirmDialog
          title={`Split ${roomName(pendingSplit.segment)}?`}
          text="The robot divides the room along the line you drew. The line must cross the room from wall to wall. Both parts get new room numbers, so give them names afterwards and check any schedules that include this room."
          confirm="Split"
          onConfirm={() => {
            const s = pendingSplit;
            setRoomAction({ kind: 'none' });
            void runEdit("Room split. The robot's map shows the new rooms. Name them from the room list.", async () => {
              await call(duid, 'splitRoom', { segment: s.segment, a: s.a, b: s.b });
              return null;
            });
          }}
          onClose={() => setPendingSplit(null)}
        />
      )}
      {pendingMerge && (
        <ConfirmDialog
          title="Merge rooms?"
          text={`${roomName(pendingMerge.a)} and ${roomName(pendingMerge.b)} become one room. They must be next to each other, or the robot refuses. The merged room may lose its name, and schedules that include either room may need updating.`}
          confirm="Merge"
          onConfirm={() => {
            const m = pendingMerge;
            setRoomAction({ kind: 'none' });
            setSelectedRoom(null);
            void runEdit("Rooms merged. The robot's map shows one room.", async () => {
              await call(duid, 'mergeRooms', { a: m.a, b: m.b });
              return null;
            });
          }}
          onClose={() => setPendingMerge(null)}
        />
      )}
    </div>
  );
}

function RoomPanel({ map, segment, tag, working, enabled, onClose, onRename, onType, onFloor, onSplit, onMerge }: {
  map: ParsedMap;
  segment: number;
  /** The robot's type tag for the room, or null when its room table doesn't list one. */
  tag: number | null;
  working: boolean;
  enabled: boolean;
  onClose: () => void;
  onRename: (name: string) => void;
  onType: (tag: number) => void;
  onFloor: (c: (typeof FLOOR_CHOICES)[number]) => void;
  onSplit: () => void;
  onMerge: () => void;
}) {
  const current = map.rooms.find((r) => r.id === segment)?.name ?? `Room ${segment}`;
  const [name, setName] = useState(current);
  useEffect(() => setName(current), [current]);
  const problem = roomNameProblem(name);
  const canAct = enabled && !working;
  const canRename = canAct && problem === null && name.trim() !== current;
  const materialId = map.segmentMaterials[segment];
  const direction = map.segmentMaterialDirections[segment];
  const currentChoice = FLOOR_CHOICES.find((c) => materialId === c.material && (c.direction === null || direction === c.direction));
  return (
    <Panel title={current} actions={<IconButton icon="close" label="Close room" onClick={onClose} />}>
      <form className="row" style={{ alignItems: 'flex-end' }} onSubmit={(e) => { e.preventDefault(); if (canRename) onRename(name); }}>
        <div className="grow">
          <Field label="Name" invalid={problem !== null} hint={problem ?? undefined}>
            <input className="input" value={name} disabled={!canAct} onChange={(e) => setName(e.target.value)} />
          </Field>
        </div>
        <button type="submit" className="btn secondary" style={{ marginBottom: problem !== null ? 20 : 0 }} disabled={!canRename}>Rename</button>
      </form>
      <div className="col tight">
        <span className="field-label">Room type</span>
        <Select
          label="Room type"
          options={ROOM_TYPES.map((t): [number, string] => [t.tag, t.label])}
          value={tag}
          disabled={!canAct}
          onChange={(v) => { if (v !== tag) onType(v); }}
        />
        <span className="muted tiny">The robot uses the type to adjust its cleaning in the smart modes. Picking one also names the room after it; a custom name keeps the type.</span>
      </div>
      <div className="col tight">
        <span className="field-label">Floor type</span>
        <div className="segmented block wrap" role="group" aria-label="Floor type">
          {FLOOR_CHOICES.map((c) => (
            <button key={c.label} type="button" aria-pressed={c === currentChoice} disabled={!canAct} onClick={() => { if (c !== currentChoice) onFloor(c); }}>{c.label}</button>
          ))}
        </div>
        <span className="muted tiny">
          {materialId === undefined ? "This robot's map doesn't report the current floor type."
            : currentChoice ? `Current: ${currentChoice.label}`
              : materialId === FloorMaterial.WOOD ? 'Current: Wood'
                : materialId === FloorMaterial.CARPET ? 'Current: Carpet (set on the robot or in the Roborock app)'
                : `Current: a type LocalRock doesn't know (id ${materialId})`}
        </span>
      </div>
      <div className="btn-row">
        <button type="button" className="btn secondary sm" disabled={!canAct} onClick={onSplit}>Split room</button>
        <button type="button" className="btn secondary sm" disabled={!canAct || map.rooms.length < 2} onClick={onMerge}>Merge with...</button>
      </div>
    </Panel>
  );
}
