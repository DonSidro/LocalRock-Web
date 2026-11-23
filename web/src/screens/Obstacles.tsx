import { useEffect, useState } from 'react';
import type { ObstaclePhotoDto, PatrolThumbnailDto } from '../../../shared/api';
import { confidencePercent, obstacleType, type MapObstacle, type PatrolPoint } from '../../../shared/obstacles';
import { call } from '../api';
import type { MapViewApi } from '../map/MapView';
import { Modal, Spinner } from '../ui';

/* Obstacles on the map with their photos, and the points of a Cruise run, from LocalRock's ObstacleMarkers and CruiseDetail. */

const MARKER_RADIUS = 9;

/** Small badges where the robot recognised obstacles; ignored ones are grey. */
export function drawObstacles(ctx: CanvasRenderingContext2D, api: MapViewApi, obstacles: MapObstacle[]): void {
  for (const o of obstacles) {
    const p = api.toScreen(o.x, o.y);
    ctx.fillStyle = o.ignored ? 'rgba(120,120,120,0.9)' : 'rgba(245,124,0,0.95)';
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(p.x, p.y, MARKER_RADIUS, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(o.photoId ? '◉' : '!', p.x, p.y + 0.5);
  }
}

/** The obstacle under a tap at screen (sx, sy), if any. */
export function obstacleAt(api: MapViewApi | null, obstacles: MapObstacle[], sx: number, sy: number): MapObstacle | null {
  if (!api) return null;
  let best: MapObstacle | null = null;
  let bestD = (MARKER_RADIUS + 6) ** 2;
  for (const o of obstacles) {
    const p = api.toScreen(o.x, o.y);
    const d = (p.x - sx) ** 2 + (p.y - sy) ** 2;
    if (d <= bestD) { best = o; bestD = d; }
  }
  return best;
}

/** Numbered points of a Cruise run. */
export function drawPatrolPoints(ctx: CanvasRenderingContext2D, api: MapViewApi, points: PatrolPoint[]): void {
  points.forEach((pt, i) => {
    const p = api.toScreen(pt.x, pt.y);
    ctx.fillStyle = 'rgba(11,122,117,0.95)';
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 11, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(i + 1), p.x, p.y + 0.5);
  });
}

/** The official obstacle sheet: name, description, confidence and the full photo with the robot's box. */
export function ObstacleDialog({ duid, obstacle, onClose }: { duid: string; obstacle: MapObstacle; onClose: () => void }) {
  const [photo, setPhoto] = useState<ObstaclePhotoDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    if (!obstacle.photoId) return;
    call<ObstaclePhotoDto>(duid, 'fetchObstaclePhoto', { photoId: obstacle.photoId }).then(setPhoto).catch((e: Error) => setError(e.message || "The robot didn't send the photo"));
  }, [duid, obstacle.photoId]);
  const type = obstacleType(obstacle.type);
  const conf = confidencePercent(obstacle);
  return (
    <Modal title={type.name} onClose={onClose} footer={<button type="button" className="btn secondary" onClick={onClose}>Close</button>}>
      <div className="col">
        <p className="small">{type.description}</p>
        {conf !== null && <span className="muted small">Confidence:{conf}%</span>}
        {obstacle.ignored && <span className="muted small">You told the robot to stop avoiding this.</span>}
        {!obstacle.photoId ? <span className="muted small">The robot kept no photo of this obstacle.</span>
          : error ? <span className="error-text small">{error}</span>
            : !photo ? <div className="row"><Spinner /><span>Getting the photo from the robot...</span></div>
              : (
                <div style={{ position: 'relative', width: '100%', aspectRatio: size ? `${size.w} / ${size.h}` : '4 / 3', borderRadius: 8, overflow: 'hidden' }}>
                  <img src={photo.dataUrl} alt={type.name} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                    onLoad={(e) => setSize({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })} />
                  {photo.box && size && (
                    <span style={{
                      position: 'absolute', border: '2px solid #ffb300', borderRadius: 4,
                      left: `${(photo.box.left / size.w) * 100}%`, top: `${(photo.box.top / size.h) * 100}%`,
                      width: `${((photo.box.right - photo.box.left) / size.w) * 100}%`, height: `${((photo.box.bottom - photo.box.top) / size.h) * 100}%`,
                    }} />
                  )}
                </div>
              )}
      </div>
    </Modal>
  );
}

/** A Cruise run's points, each with the thumbnails the robot took there, fetched when the point is opened. */
export function PatrolPointList({ duid, taskId, points }: { duid: string; taskId: number; points: PatrolPoint[] }) {
  const [open, setOpen] = useState<number | null>(points.length ? 0 : null);
  const [thumbs, setThumbs] = useState<Record<number, PatrolThumbnailDto[] | string>>({});
  const [big, setBig] = useState<string | null>(null);
  const load = (i: number) => {
    const pt = points[i]!;
    setThumbs((t) => { const n = { ...t }; delete n[i]; return n; });
    call<PatrolThumbnailDto[]>(duid, 'fetchPatrolThumbnails', { taskId, x: pt.x, y: pt.y })
      .then((list) => setThumbs((t) => ({ ...t, [i]: list })))
      .catch((e: Error) => setThumbs((t) => ({ ...t, [i]: e.message || "The robot didn't send the photo" })));
  };
  useEffect(() => { if (open !== null && thumbs[open] === undefined) load(open); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  if (points.length === 0) return <span className="muted small">This run has no cruise points.</span>;
  return (
    <div className="col tight">
      {points.map((pt, i) => {
        const t = thumbs[i];
        return (
          <div key={i} className="col tight">
            <button type="button" className="btn ghost sm" style={{ justifyContent: 'flex-start' }} onClick={() => setOpen(open === i ? null : i)}>
              Point {i + 1} · {pt.photoIds.length} photo{pt.photoIds.length === 1 ? '' : 's'}
            </button>
            {open === i && (t === undefined ? <div className="row"><Spinner /><span>Getting the photos...</span></div>
              : typeof t === 'string' ? <div className="row"><span className="error-text small grow">{t}</span><button type="button" className="btn secondary sm" onClick={() => load(i)}>Retry</button></div>
                : t.length === 0 ? <span className="muted small">No photos at this point.</span>
                  : <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>{t.map((th, j) => <img key={j} src={th.dataUrl} alt={`Point ${i + 1} photo ${j + 1}`} style={{ height: 72, borderRadius: 6, cursor: 'zoom-in' }} onClick={() => setBig(th.dataUrl)} />)}</div>)}
          </div>
        );
      })}
      {big && (
        <Modal title="Photo" onClose={() => setBig(null)} footer={<button type="button" className="btn secondary" onClick={() => setBig(null)}>Close</button>}>
          <img src={big} alt="Cruise photo" style={{ width: '100%', imageRendering: 'auto', borderRadius: 8 }} />
        </Modal>
      )}
    </div>
  );
}
