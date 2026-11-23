import { modelSubtitle } from '../../../shared/products';
import { useEffect, useRef } from 'react';
import type { DeviceSummary } from '../../../shared/api';
import { contentBoundsNorm, type ParsedMap } from '../../../shared/map';
import { post } from '../api';
import { Icon } from '../icons';
import { DARK, LIGHT, drawFloorPlanStrokes, renderFloor } from '../map/render';
import { batteryColor, isCharging, primaryAction, statusLine } from '../robotStatus';
import { navigate, vacRoute } from '../router';
import { attempt, useStore, useWatch } from '../store';
import { useDark } from '../theme';
import { Empty, Link, PageHeader, Spinner } from '../ui';
import { useRobotActions } from '../useRobot';

/* The home page: every robot as a card with its map, live state and quick controls. */

export function DeviceListScreen() {
  const devices = useStore((s) => s.devices);
  const error = useStore((s) => s.devicesError);
  const refreshing = useStore((s) => s.devicesRefreshing);
  const homeName = useStore((s) => s.app?.homeName);

  return (
    <div className="page">
      <PageHeader
        title="Vacuums"
        sub={homeName ?? undefined}
        actions={(
          <>
            <button type="button" className="btn secondary" disabled={refreshing} onClick={() => void attempt(() => post('/api/devices/refresh'))}>
              {refreshing ? <span className="spinner" /> : <Icon name="refresh" />}Refresh
            </button>
            <button type="button" className="btn" onClick={() => navigate({ name: 'add' })}><Icon name="add" />Add vacuum</button>
          </>
        )}
      />
      <div className="page-body">
        {error && (
          <div className="callout error">
            <Icon name="error" />
            <span className="grow">{error}</span>
            <button type="button" className="btn secondary sm" onClick={() => void attempt(() => post('/api/devices/refresh'))}>Retry</button>
          </div>
        )}
        {devices.length === 0 && refreshing && <div className="empty"><Spinner big /></div>}
        {devices.length === 0 && !refreshing && !error && (
          <Empty icon="robot" title="No vacuums yet" text="Vacuums imported on your server show up here.">
            <button type="button" className="btn" onClick={() => navigate({ name: 'add' })}><Icon name="add" />Add vacuum</button>
          </Empty>
        )}
        <div className="robot-grid">
          {devices.map((d) => <RobotCard key={d.duid} device={d} />)}
        </div>
      </div>
    </div>
  );
}

function RobotCard({ device }: { device: DeviceSummary }) {
  // Watching keeps the card live, the same as having the robot's page open.
  useWatch(device.paired ? device.duid : null);
  const snap = useStore((s) => s.vacs[device.duid]);
  const map = useStore((s) => s.maps[device.duid]);
  const { run, busy } = useRobotActions(device.duid);
  const to = vacRoute(device.duid);

  if (device.unpaired) {
    return (
      <article className="robot-card">
        <Link to={{ name: 'add', duid: device.duid }} className="robot-card-map" title={`Pair ${device.name}`}><Icon name="robot" size={40} className="muted" /></Link>
        <div className="robot-card-body">
          <h3 className="ellipsis">{device.name}</h3>
          {modelSubtitle(device.name, device.modelName) && <span className="muted small">{modelSubtitle(device.name, device.modelName)}</span>}
          <span className="row small" style={{ color: 'var(--error)' }}><span className="dot" style={{ background: 'var(--error)' }} />Not paired yet</span>
          <p className="muted small">Your server has never heard from this robot. Pair it with Add vacuum to control it here.</p>
          <Link to={{ name: 'add', duid: device.duid }} className="btn secondary sm">Add vacuum</Link>
        </div>
      </article>
    );
  }

  if (!device.paired) {
    return (
      <article className="robot-card disabled">
        <div className="robot-card-map"><Icon name="robot" size={40} className="muted" /></div>
        <div className="robot-card-body">
          <h3 className="ellipsis">{device.name}</h3>
          {modelSubtitle(device.name, device.modelName) && <span className="muted small">{modelSubtitle(device.name, device.modelName)}</span>}
          <span className="row small" style={{ color: 'var(--error)' }}><span className="dot" style={{ background: 'var(--error)' }} />Setup incomplete</span>
          <p className="muted small">This robot has no local key yet. Re-run pairing on your server to control it.</p>
        </div>
      </article>
    );
  }

  const line = snap && device.online ? statusLine(snap) : null;
  const offline = !device.online && device.reachability !== 'CHECKING';
  const action = snap ? primaryAction(snap) : 'clean';
  const battery = snap?.status.battery;
  return (
    <article className="robot-card">
      <Link to={to} className="robot-card-map" title={`Open ${device.name}`}>
        {map ? <MapThumb map={map} /> : <Icon name="robot" size={40} className="muted" />}
      </Link>
      <div className="robot-card-body">
        <div className="row">
          <h3 className="grow ellipsis"><Link to={to}>{device.name}</Link></h3>
          {battery !== undefined && !offline && (
            <span className="battery small" style={{ color: batteryColor(battery) }} title={snap && isCharging(snap) ? 'Charging' : 'Battery'}>
              <span className="battery-icon"><i style={{ height: `${Math.max(0, Math.min(100, battery)) * 0.9}%` }} /></span>
              <span style={{ color: 'var(--on-surface)' }}>{battery}%</span>
            </span>
          )}
        </div>
        {modelSubtitle(device.name, device.modelName) && <span className="muted small">{modelSubtitle(device.name, device.modelName)}</span>}
        <span className="row small" style={{ gap: 6, color: offline ? 'var(--on-surface-variant)' : line?.color ?? 'var(--on-surface-variant)' }}>
          {line?.active ? <span className="pulse" /> : <span className="dot" style={{ background: offline ? 'var(--outline)' : line?.error ? 'var(--error)' : 'var(--good)' }} />}
          {offline ? 'Offline' : line?.text ?? (device.reachability === 'CHECKING' ? 'Checking...' : 'Online')}
        </span>
      </div>
      <div className="robot-card-actions">
        <button
          type="button"
          className="btn sm"
          disabled={busy || offline || !snap}
          onClick={() => void run(action === 'pause' ? 'pause' : 'clean', {}, action === 'clean' ? 'Cleaning started' : undefined)}
        >
          <Icon name={action === 'pause' ? 'pause' : 'play'} />{action === 'pause' ? 'Pause' : action === 'resume' ? 'Resume' : 'Clean'}
        </button>
        <button type="button" className="btn secondary sm" disabled={busy || offline || !snap} onClick={() => void run('dock', {}, 'Returning to dock')}>
          <Icon name="home" />Dock
        </button>
        <span className="grow" />
        <Link to={to} className="btn ghost sm">Open<Icon name="chevronRight" /></Link>
      </div>
    </article>
  );
}

/** A still picture of the floor plan, cropped to the rooms. */
function MapThumb({ map }: { map: ParsedMap }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const dark = useDark();
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const floor = renderFloor(map, dark ? DARK : LIGHT, 2);
    const b = contentBoundsNorm(map);
    const sx = b.left * map.width, sy = b.top * map.height;
    const sw = Math.max(1, (b.right - b.left) * map.width), sh = Math.max(1, (b.bottom - b.top) * map.height);
    const w = c.clientWidth, h = c.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.max(1, Math.round(w * dpr));
    c.height = Math.max(1, Math.round(h * dpr));
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = true;
    const scale = Math.min(w / sw, h / sh) * 0.88;
    const ox = (w - sw * scale) / 2, oy = (h - sh * scale) / 2;
    const s = floor.scale;
    ctx.drawImage(floor.canvas, sx * s, sy * s, sw * s, sh * s, ox, oy, sw * scale, sh * scale);
    drawFloorPlanStrokes(ctx, floor.shapes, (x, y) => ({ x: ox + (x - sx) * scale, y: oy + (y - sy) * scale }));
  }, [map, dark]);
  return <canvas ref={ref} className="map-thumb" aria-hidden="true" />;
}
