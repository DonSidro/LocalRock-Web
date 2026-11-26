import { useEffect, useRef, useState } from 'react';
import type { MapDto } from '../../../shared/api';
import {
  FURNITURE_CATALOG, editablePlacements, furnitureKind, movedPlacement, newFurniture, placementContains,
  placementDepth, placementWidth, resizedFromHandle, rotatedFromHandle, rotatedPlacement, validFurniturePlacement,
  type FurnitureKind, type FurniturePlacement, type FurnitureSupport,
} from '../../../shared/furniture';
import type { ParsedMap } from '../../../shared/map';
import { call } from '../api';
import { Icon } from '../icons';
import { MapView, type CustomGesture, type MapViewApi } from '../map/MapView';
import { drawFurnitureSymbol } from '../map/render';
import { decodeMap } from '../store';
import { ConfirmDialog, IconButton, Panel, Spinner, isTypingTarget } from '../ui';

/*
 * Furniture editor, ported from LocalRock's FurnitureEditScreen.kt and FurnitureEditGeometry.kt.
 *
 * The editor reads a fresh map from the robot (never the one on screen), edits a local draft and
 * saves it in one start_edit_map / save_furnitures / end_edit_map session. The save only counts once
 * a fresh map shows every change and leaves every other record untouched. A failed or unconfirmed
 * save is never retried: the editor needs a reload first.
 *
 * The selected item gets a padded, dashed box with four handles: top left deletes, top right rotates,
 * bottom left moves and bottom right resizes. The padding is drawn only and is never saved.
 */

type Handle = 'DELETE' | 'ROTATE' | 'MOVE' | 'RESIZE';
const HANDLE_CORNER: Record<Handle, number> = { DELETE: 0, ROTATE: 1, RESIZE: 2, MOVE: 3 };
const HANDLE_ICON: Record<Handle, string> = { DELETE: '×', ROTATE: '↻', MOVE: '✥', RESIZE: '⤡' };
const HANDLE_R = 13;
const HANDLE_TOUCH_R = 24;
const SELECTION_GAP = 14;
const SELECTION_MIN_SIDE = 56;
const ROTATE_STEP = 15;
const SIZE_STEP_MM = 100;

interface Loaded { map: ParsedMap; support: FurnitureSupport }
interface Notice { text: string; error: boolean }

const pt = (x: number, y: number) => ({ x, y });

/** Screen-space decoration only: the padding never becomes part of the saved footprint. */
function selectionCorners(points: Array<{ x: number; y: number }>, gap: number, minSide: number) {
  const width = Math.hypot(points[1]!.x - points[0]!.x, points[1]!.y - points[0]!.y);
  const height = Math.hypot(points[3]!.x - points[0]!.x, points[3]!.y - points[0]!.y);
  if (width <= 0 || height <= 0) return points;
  const u = pt((points[1]!.x - points[0]!.x) / width, (points[1]!.y - points[0]!.y) / width);
  const v = pt((points[3]!.x - points[0]!.x) / height, (points[3]!.y - points[0]!.y) / height);
  const x = Math.max(gap, (minSide - width) / 2), y = Math.max(gap, (minSide - height) / 2);
  return [
    pt(points[0]!.x - u.x * x - v.x * y, points[0]!.y - u.y * x - v.y * y),
    pt(points[1]!.x + u.x * x - v.x * y, points[1]!.y + u.y * x - v.y * y),
    pt(points[2]!.x + u.x * x + v.x * y, points[2]!.y + u.y * x + v.y * y),
    pt(points[3]!.x - u.x * x + v.x * y, points[3]!.y - u.y * x + v.y * y),
  ];
}

const sameDraft = (a: FurniturePlacement[], b: FurniturePlacement[]) =>
  a.length === b.length && a.every((p, i) => p.key === b[i]!.key && p.corners.every((c, j) => c.x === b[i]!.corners[j]!.x && c.y === b[i]!.corners[j]!.y));

export function FurnitureEditor({ duid, onClose, onSaved }: { duid: string; onClose: () => void; onSaved: () => void }) {
  const view = useRef<MapViewApi>(null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [baseline, setBaseline] = useState<FurniturePlacement[]>([]);
  const [draft, setDraft] = useState<FurniturePlacement[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  /** A failed or unconfirmed save: the robot may hold part of it, so only a reload may continue. */
  const [needsReload, setNeedsReload] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [confirmBack, setConfirmBack] = useState(false);
  const nextKey = useRef(-1);

  useEffect(() => {
    let alive = true;
    setLoaded(null);
    setLoadError(null);
    setNeedsReload(false);
    setSelected(null);
    void call<{ map: MapDto; support: FurnitureSupport }>(duid, 'loadFurnitureEditor').then((r) => {
      if (!alive) return;
      const map = decodeMap(r.map);
      const items = editablePlacements(map);
      setLoaded({ map, support: r.support });
      setBaseline(items);
      setDraft(items);
    }).catch((e: Error) => { if (alive) setLoadError(e.message || "Couldn't load the robot's furniture."); });
    return () => { alive = false; };
  }, [duid, attempt]);

  const dirty = !sameDraft(draft, baseline);
  const item = draft.find((p) => p.key === selected) ?? null;
  const canEdit = !!loaded && !saving && !needsReload;

  const update = (key: number, next: FurniturePlacement) => {
    if (!validFurniturePlacement(next)) return false;
    setDraft((d) => d.map((p) => (p.key === key ? next : p)));
    setNotice(null);
    return true;
  };
  const remove = (key: number) => {
    setDraft((d) => d.filter((p) => p.key !== key));
    if (selected === key) setSelected(null);
  };
  const add = (k: FurnitureKind) => {
    const api = view.current;
    if (!api || !canEdit) return;
    const [x, y] = api.centerMm();
    const next = newFurniture(nextKey.current--, k, Math.round(x), Math.round(y));
    if (!validFurniturePlacement(next)) {
      setNotice({ text: 'Move the map so its middle is on the floor, then add the item.', error: true });
      return;
    }
    setDraft((d) => [...d, next]);
    setSelected(next.key);
    setNotice(null);
  };

  const save = async () => {
    setSaving(true);
    setNotice(null);
    try {
      await call(duid, 'saveFurnitureEdits', { items: draft });
      onSaved();
    } catch (e) {
      setNeedsReload(true);
      setNotice({ text: `${(e as Error).message || 'The furniture could not be saved.'} Reload before another save.`, error: true });
    } finally {
      setSaving(false);
    }
  };

  // Delete removes the selected item, Escape lets go of it.
  const keys = useRef<(e: KeyboardEvent) => void>(() => undefined);
  keys.current = (e) => {
    if (e.key === 'Escape') setSelected(null);
    else if ((e.key === 'Delete' || e.key === 'Backspace') && item && canEdit) { e.preventDefault(); remove(item.key); }
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (!isTypingTarget(e.target) && !document.querySelector('.scrim')) keys.current(e); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const screenCorners = (api: MapViewApi, p: FurniturePlacement) => p.corners.map((c) => api.toScreen(c.x, c.y));
  const handleAt = (api: MapViewApi, p: FurniturePlacement, sx: number, sy: number): Handle | null => {
    const box = selectionCorners(screenCorners(api, p), SELECTION_GAP, SELECTION_MIN_SIDE);
    let best: Handle | null = null, bestD = Infinity;
    for (const h of Object.keys(HANDLE_CORNER) as Handle[]) {
      const c = box[HANDLE_CORNER[h]]!;
      const d = Math.hypot(c.x - sx, c.y - sy);
      if (d <= HANDLE_TOUCH_R && d < bestD) { best = h; bestD = d; }
    }
    return best;
  };

  const onPointerDown = (p: { sx: number; sy: number; mm: [number, number] }): CustomGesture | null => {
    const api = view.current;
    if (!api || !canEdit) return null;
    const start = item;
    let handle: Handle | null = start ? handleAt(api, start, p.sx, p.sy) : null;
    let target = start;
    if (!handle) {
      // Dragging an item moves it, and picks it first if it wasn't selected.
      const hit = [...draft].reverse().find((d) => placementContains(d, p.mm[0], p.mm[1])) ?? null;
      if (!hit) return null;
      target = hit;
      handle = 'MOVE';
      if (hit.key !== selected) setSelected(hit.key);
    }
    if (!target) return null;
    if (handle === 'DELETE') {
      const key = target.key;
      return { move: () => undefined, end: () => remove(key) };
    }
    const from = target;
    const startMm = { x: p.mm[0], y: p.mm[1] };
    const apply = (now: [number, number]) => {
      const dx = Math.round(now[0] - startMm.x), dy = Math.round(now[1] - startMm.y);
      const next = handle === 'MOVE' ? movedPlacement(from, dx, dy)
        : handle === 'RESIZE' ? resizedFromHandle(from, dx, dy)
          : rotatedFromHandle(from, startMm, { x: now[0], y: now[1] });
      update(from.key, next);
    };
    return { move: (q) => apply(q.mm), end: (q) => apply(q.mm) };
  };

  const onTap = (p: { mm: [number, number] }) => {
    const hit = [...draft].reverse().find((d) => placementContains(d, p.mm[0], p.mm[1])) ?? null;
    setSelected(hit && hit.key !== selected ? hit.key : hit ? selected : null);
  };

  const back = () => { if (dirty && !needsReload) setConfirmBack(true); else onClose(); };
  const label = (p: FurniturePlacement) => furnitureKind(p.type, p.subtype)?.label ?? 'Furniture';

  return (
    <div className="editor">
      <div className="editor-canvas">
        {loaded ? (
          <MapView
            ref={view}
            map={loaded.map}
            showLabels={false}
            drawFurniture={false}
            overlayKey={[draft, selected, canEdit]}
            onTap={onTap}
            onPointerDown={onPointerDown}
            overlay={({ ctx, api }) => {
              for (const d of draft) drawFurnitureSymbol(ctx, screenCorners(api, d), d.type, d.subtype, api.pxPerCell());
              const sel = draft.find((d) => d.key === selected);
              if (!sel) return;
              const box = selectionCorners(screenCorners(api, sel), SELECTION_GAP, SELECTION_MIN_SIDE);
              ctx.save();
              ctx.strokeStyle = '#1e88e5';
              ctx.lineWidth = 2;
              ctx.setLineDash([8, 5]);
              ctx.beginPath();
              box.forEach((c, i) => (i === 0 ? ctx.moveTo(c.x, c.y) : ctx.lineTo(c.x, c.y)));
              ctx.closePath();
              ctx.stroke();
              ctx.setLineDash([]);
              if (canEdit) {
                ctx.font = '600 15px system-ui, sans-serif';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                for (const h of Object.keys(HANDLE_CORNER) as Handle[]) {
                  const c = box[HANDLE_CORNER[h]]!;
                  ctx.fillStyle = h === 'DELETE' ? '#e53935' : '#1e88e5';
                  ctx.beginPath(); ctx.arc(c.x, c.y, HANDLE_R, 0, Math.PI * 2); ctx.fill();
                  ctx.fillStyle = '#fff';
                  ctx.fillText(HANDLE_ICON[h], c.x, c.y + 1);
                }
              }
              ctx.restore();
            }}
          />
        ) : (
          <div className="empty">
            {loadError ? (
              <div className="col" style={{ alignItems: 'center', maxWidth: 420, textAlign: 'center' }}>
                <Icon name="error" size={40} />
                <p>{loadError}</p>
                <div className="btn-row">
                  <button type="button" className="btn" onClick={() => setAttempt((a) => a + 1)}>Try again</button>
                  <button type="button" className="btn secondary" onClick={onClose}>Back</button>
                </div>
              </div>
            ) : (
              <div className="col" style={{ alignItems: 'center' }}><Spinner big /><p>Reading the robot's map...</p></div>
            )}
          </div>
        )}
        {loaded && (
          <div className="map-hint">
            {item ? 'Drag the item to move it. Corners: delete, rotate, move, resize.' : 'Click an item to select it, or add one from the catalog. Scroll to zoom, drag to pan.'}
          </div>
        )}
        {notice && (
          <div className={`notice-pill ${notice.error ? 'error' : ''}`} role="status">
            <span className="small">{notice.text}</span>
            <IconButton icon="close" label="Dismiss" onClick={() => setNotice(null)} />
          </div>
        )}
      </div>

      <aside className="inspector" aria-label="Furniture editor">
        <Panel title="Furniture" actions={<IconButton icon="close" label="Back to the map editor" onClick={back} />}>
          <p className="muted small">Furniture shows the robot what stands where. It is kept on the first saved map only.</p>
          {needsReload && (
            <div className="callout error small"><Icon name="error" /><span>Reload the robot's map before another save, so nothing is written twice.</span></div>
          )}
        </Panel>

        {item ? (
          <Panel title={label(item)}>
            <p className="muted small">{(placementWidth(item) / 1000).toFixed(2)} × {(placementDepth(item) / 1000).toFixed(2)} m</p>
            <div className="btn-row">
              <button type="button" className="btn secondary sm" disabled={!canEdit} onClick={() => update(item.key, rotatedPlacement(item, ROTATE_STEP))} aria-label="Rotate left 15 degrees">↺ 15°</button>
              <button type="button" className="btn secondary sm" disabled={!canEdit} onClick={() => update(item.key, rotatedPlacement(item, -ROTATE_STEP))} aria-label="Rotate right 15 degrees">↻ 15°</button>
              <button type="button" className="btn secondary sm" disabled={!canEdit} onClick={() => update(item.key, resizedFromHandle(item, SIZE_STEP_MM, -SIZE_STEP_MM))} aria-label="Make larger">Larger</button>
              <button type="button" className="btn secondary sm" disabled={!canEdit} onClick={() => update(item.key, resizedFromHandle(item, -SIZE_STEP_MM, SIZE_STEP_MM))} aria-label="Make smaller">Smaller</button>
            </div>
            <div className="btn-row">
              <button type="button" className="btn secondary sm" disabled={!canEdit} onClick={() => remove(item.key)}><Icon name="delete" />Delete</button>
              <button type="button" className="btn secondary sm" onClick={() => setSelected(null)}><Icon name="check" />Done</button>
            </div>
          </Panel>
        ) : (
          <Panel title="Add furniture">
            <div className="furniture-grid">
              {FURNITURE_CATALOG.map((k) => (
                <button key={`${k.type}-${k.subtype}`} type="button" className="furniture-tile" disabled={!canEdit} onClick={() => add(k)} aria-label={`Add ${k.label.toLowerCase()}`}>
                  <img src={k.image} alt="" loading="lazy" />
                  <span>{k.label}</span>
                </button>
              ))}
            </div>
          </Panel>
        )}

        <Panel title={`Items (${draft.length})`}>
          {draft.length === 0 ? <p className="muted small">No furniture on this map yet.</p> : (
            <ul className="room-list">
              {draft.map((p) => {
                const k = furnitureKind(p.type, p.subtype);
                return (
                  <li key={p.key}>
                    <button type="button" className={`room-row ${selected === p.key ? 'selected' : ''}`} onClick={() => setSelected(selected === p.key ? null : p.key)}>
                      {k && <img src={k.image} alt="" className="furniture-thumb" />}
                      <span className="grow ellipsis">{label(p)}{p.key < 0 ? ' (new)' : ''}</span>
                      <Icon name="chevronRight" size={18} className="muted" />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>

        <Panel title="Changes">
          {saving ? (
            <div className="row small"><Spinner /><span>Saving to the robot and checking its map...</span></div>
          ) : (
            <p className="muted small">{dirty ? 'You have furniture changes that are not on the robot yet.' : 'No unsaved changes.'}</p>
          )}
          <div className="btn-row">
            <button type="button" className="btn" disabled={!dirty || !canEdit} onClick={() => void save()}>Save to robot</button>
            {needsReload
              ? <button type="button" className="btn secondary" disabled={saving} onClick={() => setAttempt((a) => a + 1)}>Reload</button>
              : <button type="button" className="btn secondary" disabled={!dirty || saving} onClick={() => { setDraft(baseline); setSelected(null); }}>Discard</button>}
          </div>
        </Panel>
      </aside>

      {confirmBack && (
        <ConfirmDialog
          title="Discard furniture changes?"
          text="Your furniture changes have not been saved to the robot."
          confirm="Discard"
          danger
          onConfirm={onClose}
          onClose={() => setConfirmBack(false)}
        />
      )}
    </div>
  );
}
