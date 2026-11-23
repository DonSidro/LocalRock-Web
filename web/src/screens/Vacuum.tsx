import { useEffect, useMemo, useState } from 'react';
import {
  ACTIVE_STATES, DockErrorCodes, FanPower, MopRoute, State, SWITCH_MAP_MODE_SMART, WaterBoxMode, isCustomizeModeSet,
  isSmartModeSet, mapNameBlocker, mapSavingEnabled, multiLevelEnabled, normalizeWaterMode, roomCleanModesFor,
  type RoomCleanMode,
} from '../../../shared/codes';
import type { FloorMap, VacuumSnapshot } from '../../../shared/api';
import { roomAtNorm, type MapRoom, type ParsedMap } from '../../../shared/map';
import { Icon, type IconName } from '../icons';
import { MapView } from '../map/MapView';
import { ACTIVE_CLEANING, batteryColor, isCharging, primaryAction, statusLine } from '../robotStatus';
import { navigate, vacRoute, type MapTool, type VacTab } from '../router';
import { useStore, useVacuum } from '../store';
import {
  ConfirmDialog, Dialog, Empty, Field, IconButton, Kbd, Link, MenuButton, Modal, PageHeader, Panel, Segmented, Select,
  SettingRow, Spinner, Switch, formatArea, formatDuration, useShortcuts,
} from '../ui';
import { useRobotActions } from '../useRobot';
import { CameraScreen } from './Camera';
import { MapEditorScreen } from './MapEditor';
import { RemoteScreen } from './Remote';
import { ScheduleTab } from './Schedule';
import { HistoryTab, MaintenanceTab, RobotSettingsTab } from './VacuumSettings';

/*
 * A robot's workspace: name, state and the main controls on top, then tabs. The Overview tab is
 * the map with an inspector column; clicks on the map pick rooms, draw zones or set a Pin & Go
 * target, depending on the tool.
 */

const FAN_OPTIONS: Array<[number, string]> = [[FanPower.QUIET, 'Quiet'], [FanPower.BALANCED, 'Standard'], [FanPower.TURBO, 'Strong'], [FanPower.MAX, 'MAX']];
/** A room can also go without suction, the official app's mop-only setting. */
const ROOM_FAN_OPTIONS: Array<[number, string]> = [[FanPower.OFF, 'Off'], ...FAN_OPTIONS];
const WATER_OPTIONS: Array<[number, string]> = [[WaterBoxMode.OFF, 'Off'], [WaterBoxMode.LOW, 'Low'], [WaterBoxMode.MEDIUM, 'Medium'], [WaterBoxMode.HIGH, 'High']];
const ROUTE_OPTIONS: Array<[number, string]> = [[MopRoute.STANDARD, 'Standard'], [MopRoute.DEEP, 'Deep'], [MopRoute.DEEP_PLUS, 'Deep+'], [MopRoute.FAST, 'Fast']];

type Plan = 'SMART' | 'MANUAL' | 'PER_ROOM';
const PLAN_LABEL: Record<Plan, string> = { SMART: 'SmartPlan', MANUAL: 'Manual', PER_ROOM: 'Per room' };

const TABS: Array<[VacTab, string, IconName]> = [
  ['overview', 'Overview', 'map'],
  ['edit', 'Edit map', 'edit'],
  ['schedule', 'Schedule', 'schedule'],
  ['history', 'History', 'history'],
  ['maintenance', 'Maintenance', 'build'],
  ['settings', 'Settings', 'settings'],
  ['camera', 'Camera', 'videocam'],
  ['remote', 'Remote', 'gamepad'],
];

type Run = ReturnType<typeof useRobotActions>['run'];
type Read = ReturnType<typeof useRobotActions>['read'];

export function VacuumWorkspace({ duid, tab, tool }: { duid: string; tab: VacTab; tool: MapTool }) {
  const { snap, map } = useVacuum(duid);
  const devices = useStore((s) => s.devices);
  const actions = useRobotActions(duid);
  const { run, busy } = actions;
  // Kept here so a room pick survives a look at another tab.
  const [selected, setSelected] = useState<number[]>([]);
  const [sessionRooms, setSessionRooms] = useState<number[]>([]);
  const [count, setCount] = useState(1);
  const [mapsOpen, setMapsOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [found, setFound] = useState(false);

  const action = snap ? primaryAction(snap) : 'clean';
  const primary = () => {
    if (!snap) return;
    if (action === 'pause') void run('pause');
    else if (action === 'resume') void run('resume');
    else { setSessionRooms([]); void run('clean', {}, action === 'clean' ? 'Cleaning started' : undefined); }
  };
  const dock = () => { setSessionRooms([]); void run('dock', {}, 'Returning to dock'); };
  useShortcuts({ c: primary, d: dock, '?': () => setHelpOpen(true) }, !!snap);

  const device = devices.find((d) => d.duid === duid);
  if (!snap) {
    const problem = devices.length === 0 ? null
      : !device ? 'This robot is not in your device list.'
        : !device.paired ? 'This robot has no local key yet. Re-run pairing on your server to control it.' : null;
    return (
      <div className="page">
        <PageHeader title={device?.name ?? 'Loading'} sub={device?.model ?? undefined} />
        {problem ? <Empty icon="robot" title="Can't open this robot" text={problem} /> : <div className="empty"><Spinner big /></div>}
      </div>
    );
  }

  const line = statusLine(snap);
  const s = snap.status;
  const cleaning = s.state !== undefined && ACTIVE_CLEANING.has(s.state);
  const paused = s.state === State.PAUSED;
  const battery = s.battery;

  return (
    <div className={`page workspace tab-${tab}`}>
      <PageHeader
        title={snap.name}
        actions={(
          <>
            <button type="button" className="btn" disabled={busy} onClick={primary} title={`${action === 'pause' ? 'Pause' : action === 'resume' ? 'Resume' : 'Clean the whole home'} (C)`}>
              <Icon name={action === 'pause' ? 'pause' : 'play'} />{action === 'pause' ? 'Pause' : action === 'resume' ? 'Resume' : 'Full clean'}
            </button>
            {(cleaning || paused) && (
              <button type="button" className="btn secondary" disabled={busy} onClick={() => { setSessionRooms([]); void run('stop'); }}><Icon name="stop" />Stop</button>
            )}
            <button type="button" className="btn secondary" disabled={busy} onClick={dock} title="Return to dock (D)"><Icon name="home" />Dock</button>
            <MenuButton
              label="More actions"
              items={[
                { label: found ? 'Beeping...' : 'Find robot', icon: 'find', onClick: () => { setFound(true); setTimeout(() => setFound(false), 4_000); void run('findMe'); } },
                { label: 'Manage maps', icon: 'layers', onClick: () => setMapsOpen(true) },
                { label: 'Keyboard shortcuts', icon: 'keyboard', onClick: () => setHelpOpen(true) },
              ]}
            />
          </>
        )}
      >
        <div className="header-meta">
          {snap.model && <span className="muted">{snap.model}</span>}
          <span className="chip-status" style={{ color: line.color }}>
            {line.error ? <Icon name="error" size={16} /> : line.active ? <span className="pulse" /> : <span className="dot" style={{ background: 'var(--good)' }} />}
            {line.text}
          </span>
          {battery !== undefined && (
            <span className="chip-status" style={{ color: batteryColor(battery) }}>
              <span className="battery-icon small"><i style={{ height: `${Math.max(0, Math.min(100, battery)) * 0.9}%` }} /></span>
              <span style={{ color: 'var(--on-surface)' }}>{battery}%{isCharging(snap) ? ', charging' : ''}</span>
            </span>
          )}
        </div>
      </PageHeader>

      <nav className="tabbar" aria-label={`${snap.name} sections`}>
        {TABS.map(([t, label, icon]) => (
          <Link key={t} to={vacRoute(duid, t)} className="tab" current={t === tab}><Icon name={icon} />{label}</Link>
        ))}
      </nav>

      <div className="workspace-body">
        {tab === 'overview' && (
          <Overview
            duid={duid}
            snap={snap}
            map={map ?? null}
            tool={tool}
            run={run}
            read={actions.read}
            busy={busy}
            selected={selected}
            setSelected={setSelected}
            sessionRooms={sessionRooms}
            setSessionRooms={setSessionRooms}
            count={count}
            setCount={setCount}
            onMaps={() => setMapsOpen(true)}
          />
        )}
        {tab === 'edit' && <MapEditorScreen duid={duid} />}
        {tab === 'schedule' && <ScheduleTab duid={duid} />}
        {tab === 'history' && <HistoryTab snap={snap} actions={actions} />}
        {tab === 'maintenance' && <MaintenanceTab snap={snap} actions={actions} />}
        {tab === 'settings' && <RobotSettingsTab snap={snap} rooms={map?.rooms ?? []} actions={actions} />}
        {tab === 'camera' && <CameraScreen duid={duid} />}
        {tab === 'remote' && <RemoteScreen duid={duid} />}
      </div>

      {mapsOpen && <MapsDialog snap={snap} busy={busy} run={run} read={actions.read} onClose={() => setMapsOpen(false)} />}
      {helpOpen && <ShortcutsDialog onClose={() => setHelpOpen(false)} />}
    </div>
  );
}

function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const rows: Array<[string, string]> = [
    ['C', 'Full clean, pause or resume'],
    ['D', 'Return to dock'],
    ['R', 'Refresh the map (Overview)'],
    ['1 / 2 / 3', 'Rooms, Zones or Pin & Go tool (Overview)'],
    ['Esc', 'Clear the picked rooms, zones or pin'],
    ['Delete', 'Remove the selected shape (Edit map)'],
    ['Arrow keys / Space', 'Drive / stop (Remote)'],
    ['?', 'This list'],
  ];
  return (
    <Modal title="Keyboard shortcuts" onClose={onClose}>
      <table className="table">
        <tbody>
          {rows.map(([k, v]) => <tr key={k}><td style={{ width: 150 }}><Kbd>{k}</Kbd></td><td>{v}</td></tr>)}
        </tbody>
      </table>
      <p className="muted small" style={{ marginTop: 12 }}>On the map: scroll to zoom, drag to pan (right-drag while drawing), double-click to fit.</p>
    </Modal>
  );
}

// ---- Overview ---------------------------------------------------------------------------------

interface Zone { x1: number; y1: number; x2: number; y2: number }
const MIN_ZONE_SIDE_MM = 500;
const MAX_ZONES = 10;

function Overview({ duid, snap, map, tool, run, read, busy, selected, setSelected, sessionRooms, setSessionRooms, count, setCount, onMaps }: {
  duid: string;
  snap: VacuumSnapshot;
  map: ParsedMap | null;
  tool: MapTool;
  run: Run;
  read: Read;
  busy: boolean;
  selected: number[];
  setSelected: (f: (s: number[]) => number[]) => void;
  sessionRooms: number[];
  setSessionRooms: (r: number[]) => void;
  count: number;
  setCount: (n: number) => void;
  onMaps: () => void;
}) {
  const [hoverRoom, setHoverRoom] = useState<number | null>(null);
  const [zones, setZones] = useState<Zone[]>([]);
  const [draft, setDraft] = useState<Zone | null>(null);
  const [zoneTimes, setZoneTimes] = useState(1);
  const [zonesSent, setZonesSent] = useState(false);
  const [target, setTarget] = useState<[number, number] | null>(null);
  const [pinSent, setPinSent] = useState(false);
  const [lastArea, setLastArea] = useState<number | null>(null);

  useEffect(() => {
    if ((snap.status.cleanArea ?? 0) > 0) setLastArea(snap.status.cleanArea!);
  }, [snap.status.cleanArea]);

  const setTool = (t: MapTool) => navigate({ name: 'vacuum', duid, tab: 'overview', tool: t === 'rooms' ? undefined : t }, true);
  const rooms = map?.rooms ?? [];
  const toggleRoom = (id: number) => setSelected((s) => (s.includes(id) ? s.filter((r) => r !== id) : [...s, id]));
  const cleanRooms = () => {
    const picked = selected;
    setSessionRooms(picked);
    setSelected(() => []);
    void run('cleanRooms', { rooms: picked, repeat: count });
  };
  const cleanZones = async () => {
    const ok = await run('cleanZones', { zones: zones.map((z) => ({ ...z, times: zoneTimes })) }, 'Zone cleaning started');
    if (ok !== undefined) setZonesSent(true);
  };
  const goPin = async () => {
    if (!target) return;
    const ok = await run('gotoTarget', { x: target[0], y: target[1] });
    if (ok !== undefined) setPinSent(true);
  };
  const clearTool = () => {
    if (tool === 'rooms') setSelected(() => []);
    if (tool === 'zones') { setZones([]); setZonesSent(false); }
    if (tool === 'pin') { setTarget(null); setPinSent(false); }
  };

  useShortcuts({
    r: () => { if (!busy) void run('refreshMap'); },
    1: () => setTool('rooms'),
    2: () => setTool('zones'),
    3: () => setTool('pin'),
    Escape: clearTool,
  });

  const sessionNames = snap.status.state === State.SEGMENT_CLEANING && sessionRooms.length > 0
    ? sessionRooms.map((id) => rooms.find((r) => r.id === id)?.name ?? `Room ${id}`)
    : [];
  const hint = tool === 'rooms' ? 'Click rooms to pick them. Scroll to zoom, drag to pan, double-click to fit.'
    : tool === 'zones' ? (zones.length >= MAX_ZONES ? `At most ${MAX_ZONES} zones.` : 'Drag to draw a zone. Right-drag to pan, scroll to zoom.')
      : 'Click where the robot should go. Scroll to zoom, drag to pan.';

  return (
    <div className="overview">
      <section className="map-pane" aria-label="Map">
        <div className="map-toolbar">
          <Segmented label="Map tool" options={[['rooms', 'Rooms'], ['zones', 'Zones'], ['pin', 'Pin & Go']] as Array<[MapTool, string]>} value={tool} onChange={setTool} />
          {snap.floorMaps.length > 1 && (
            <Select
              label="Floor"
              options={snap.floorMaps.map((f) => [f.mapFlag, f.name] as [number, string])}
              value={snap.currentFloorFlag}
              disabled={busy}
              onChange={(flag) => void run('switchFloor', { mapFlag: flag })}
            />
          )}
          <span className="grow" />
          <IconButton icon="refresh" label="Refresh map" shortcut="R" busy={busy} disabled={busy} onClick={() => void run('refreshMap')} />
          <button type="button" className="btn secondary sm" onClick={onMaps}><Icon name="layers" />Maps</button>
          <Link to={vacRoute(duid, 'edit')} className="btn secondary sm"><Icon name="edit" />Edit map</Link>
        </div>
        <div className="map-stage">
          {map ? (
            <MapView
              map={map}
              selectedRoomIds={tool === 'rooms' ? selected : []}
              focusRoomId={tool === 'rooms' ? hoverRoom : null}
              drawing={tool !== 'rooms'}
              overlayKey={[tool, zones, draft, target]}
              overlay={({ ctx, api }) => {
                if (tool === 'zones') {
                  const color = getComputedStyle(document.documentElement).getPropertyValue('--primary').trim() || '#0b7a75';
                  const drawZone = (z: Zone, dashed: boolean) => {
                    const a = api.toScreen(z.x1, z.y2);
                    const b = api.toScreen(z.x2, z.y1);
                    ctx.globalAlpha = dashed ? 0.15 : 0.3;
                    ctx.fillStyle = color;
                    ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
                    ctx.globalAlpha = 1;
                    ctx.strokeStyle = color;
                    ctx.lineWidth = 2;
                    ctx.setLineDash(dashed ? [8, 5] : []);
                    ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
                    ctx.setLineDash([]);
                  };
                  zones.forEach((z) => drawZone(z, false));
                  if (draft) drawZone(draft, true);
                }
                if (tool === 'pin' && target) {
                  const p = api.toScreen(target[0], target[1]);
                  ctx.fillStyle = 'rgba(229, 57, 53, 0.9)';
                  ctx.beginPath();
                  ctx.arc(p.x, p.y, 13, 0, Math.PI * 2);
                  ctx.fill();
                  ctx.fillStyle = '#fff';
                  ctx.beginPath();
                  ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
                  ctx.fill();
                }
              }}
              onTap={(p) => {
                if (tool === 'rooms') {
                  const room = roomAtNorm(map, p.normX, p.normY);
                  if (room) toggleRoom(room.id);
                } else if (tool === 'pin') {
                  setTarget(p.mm);
                  setPinSent(false);
                }
              }}
              onPointerDown={(p) => {
                if (tool !== 'zones' || zones.length >= MAX_ZONES) return null;
                const [ax, ay] = p.mm;
                const rect = (bx: number, by: number): Zone => ({ x1: Math.min(ax, bx), y1: Math.min(ay, by), x2: Math.max(ax, bx), y2: Math.max(ay, by) });
                return {
                  move: (q) => setDraft(rect(q.mm[0], q.mm[1])),
                  end: (q) => {
                    const z = rect(q.mm[0], q.mm[1]);
                    setDraft(null);
                    if (z.x2 - z.x1 >= MIN_ZONE_SIDE_MM && z.y2 - z.y1 >= MIN_ZONE_SIDE_MM) {
                      setZones((zs) => [...zs, z]);
                      setZonesSent(false);
                    }
                  },
                  cancel: () => setDraft(null),
                };
              }}
            />
          ) : (
            <div className="empty" style={{ height: '100%', justifyContent: 'center' }}>
              <Icon name="map" />
              <h3>No map loaded</h3>
              <p className="muted small">Load the latest map from your robot.</p>
              <div className="row">
                <button type="button" className="btn" disabled={busy} onClick={() => void run('refreshMap')}><Icon name="refresh" />{busy ? 'Loading...' : 'Load map'}</button>
                <button type="button" className="btn secondary" disabled={busy} onClick={onMaps}>Saved maps</button>
              </div>
            </div>
          )}
          {sessionNames.length > 0 && (
            <div className="map-overlay-tl">
              <span className="map-pill primary"><span className="pulse" /><span className="ellipsis">Cleaning {sessionNames.join(', ')}</span></span>
            </div>
          )}
          {map && <div className="map-hint">{hint}</div>}
        </div>
      </section>

      <aside className="inspector" aria-label="Controls">
        <StatusPanel snap={snap} lastArea={lastArea} duid={duid} />
        {tool === 'rooms' && (
          <Panel
            title={selected.length > 0 ? `Rooms · ${selected.length} picked` : 'Rooms'}
            actions={rooms.length > 0 ? (
              <>
                <button type="button" className="btn ghost sm" disabled={busy} onClick={() => setSelected(() => rooms.map((r) => r.id))}>All</button>
                <button type="button" className="btn ghost sm" disabled={selected.length === 0} onClick={() => setSelected(() => [])}>None</button>
              </>
            ) : undefined}
          >
            {rooms.length === 0 ? (
              <p className="muted small">Load the map to see the rooms.</p>
            ) : (
              <>
                <ul className="room-list">
                  {rooms.map((r) => {
                    const order = selected.indexOf(r.id);
                    return (
                      <li key={r.id}>
                        <label className="room-row" onMouseEnter={() => setHoverRoom(r.id)} onMouseLeave={() => setHoverRoom(null)}>
                          <input type="checkbox" checked={order >= 0} disabled={busy} onChange={() => toggleRoom(r.id)} />
                          <span className="grow ellipsis">{r.name}</span>
                          {order >= 0 && <span className="order-badge" title="Cleaning order">{order + 1}</span>}
                        </label>
                      </li>
                    );
                  })}
                </ul>
                <p className="muted tiny">
                  Picked rooms are cleaned in the order you pick them. A full clean uses the{' '}
                  <Link to={vacRoute(duid, 'settings')}>default order</Link>.
                </p>
                <button type="button" className="btn block" disabled={busy || selected.length === 0} onClick={cleanRooms}>
                  <Icon name="play" />{selected.length === 0 ? 'Pick rooms to clean' : selected.length === 1 ? 'Clean 1 room' : `Clean ${selected.length} rooms`}
                </button>
              </>
            )}
          </Panel>
        )}
        {tool === 'zones' && (
          <Panel title="Zones" actions={zones.length > 0 ? <button type="button" className="btn ghost sm" onClick={() => { setZones([]); setZonesSent(false); }}>Clear</button> : undefined}>
            {zones.length === 0 ? (
              <p className="muted small">Drag on the map to draw up to {MAX_ZONES} rectangles. The robot cleans inside them.</p>
            ) : (
              <ul className="zone-list">
                {zones.map((z, i) => (
                  <li key={`${z.x1}-${z.y1}-${i}`} className="row">
                    <span className="zone-swatch" />
                    <span className="grow">Zone {i + 1}</span>
                    <span className="muted small">{((z.x2 - z.x1) / 1000).toFixed(1)} × {((z.y2 - z.y1) / 1000).toFixed(1)} m</span>
                    <IconButton icon="close" label={`Remove zone ${i + 1}`} onClick={() => { setZones((zs) => zs.filter((_, j) => j !== i)); setZonesSent(false); }} />
                  </li>
                ))}
              </ul>
            )}
            <SettingRow title="Passes">
              <Segmented label="Passes" options={[[1, '×1'], [2, '×2'], [3, '×3']]} value={zoneTimes} onChange={setZoneTimes} />
            </SettingRow>
            <button type="button" className="btn block" disabled={busy || zones.length === 0 || zonesSent} onClick={() => void cleanZones()}>
              <Icon name="play" />{zonesSent ? 'Zone cleaning started' : zones.length === 1 ? 'Clean 1 zone' : `Clean ${zones.length} zones`}
            </button>
          </Panel>
        )}
        {tool === 'pin' && (
          <Panel title="Pin & Go" actions={target ? <button type="button" className="btn ghost sm" onClick={() => { setTarget(null); setPinSent(false); }}>Clear</button> : undefined}>
            <p className="muted small">
              {pinSent ? 'Sent. The robot is heading there.' : target ? `Target set at ${(target[0] / 1000).toFixed(1)}, ${(target[1] / 1000).toFixed(1)} m.` : 'Click the map where the robot should go.'}
            </p>
            <button type="button" className="btn block" disabled={busy || !target || pinSent} onClick={() => void goPin()}><Icon name="place" />Go there</button>
          </Panel>
        )}
        <CleaningModePanel snap={snap} rooms={rooms} busy={busy} count={count} onCount={setCount} run={run} read={read} />
        <DockPanel snap={snap} busy={busy} run={run} duid={duid} />
      </aside>
    </div>
  );
}

function StatusPanel({ snap, lastArea, duid }: { snap: VacuumSnapshot; lastArea: number | null; duid: string }) {
  const s = snap.status;
  const cleaningNow = s.state !== undefined && ACTIVE_CLEANING.has(s.state);
  const battery = s.battery;
  return (
    <Panel title="Status" actions={<Link to={vacRoute(duid, 'history')} className="btn ghost sm">History</Link>}>
      <div className="stats">
        <div className="stat">
          <span className="stat-label">Battery</span>
          <span className="stat-value" style={{ color: batteryColor(battery) }}>{battery !== undefined ? `${battery}%` : '—'}</span>
          <div className="progress"><div style={{ width: `${battery ?? 0}%`, background: batteryColor(battery) }} /></div>
        </div>
        <div className="stat">
          <span className="stat-label">{cleaningNow ? 'Area so far' : 'Last clean'}</span>
          <span className="stat-value">{lastArea !== null ? formatArea(lastArea) : '—'}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Time</span>
          <span className="stat-value">{s.cleanTime && s.cleanTime > 0 ? formatDuration(s.cleanTime) : '—'}</span>
        </div>
      </div>
      <p className="muted tiny">Map: {snap.mapStatus}</p>
    </Panel>
  );
}

function CleaningModePanel({ snap, rooms, busy, count, onCount, run, read }: {
  snap: VacuumSnapshot;
  rooms: MapRoom[];
  busy: boolean;
  count: number;
  onCount: (n: number) => void;
  run: Run;
  read: Read;
}) {
  const s = snap.status;
  const fan = s.fanPower;
  const water = s.waterBoxCustomMode;
  const route = snap.mopMode;
  const smart = isSmartModeSet(fan, water, route);
  const perRoom = isCustomizeModeSet(fan, water, route);
  const plan: Plan = smart ? 'SMART' : perRoom ? 'PER_ROOM' : 'MANUAL';
  const plans: Plan[] = [
    ...((snap.supportsSmartPlan || smart) ? ['SMART' as const] : []),
    'MANUAL',
    ...((rooms.length > 0 || perRoom) ? ['PER_ROOM' as const] : []),
  ];
  const [type, setType] = useState(() => ((water ?? WaterBoxMode.OFF) === WaterBoxMode.OFF ? 2 : fan === FanPower.QUIET ? 1 : 0));
  const [roomsOpen, setRoomsOpen] = useState(false);

  useEffect(() => { void read('fetchMopMode'); }, [read]);

  const choosePlan = (p: Plan) => {
    if (p === plan) return;
    if (p === 'SMART') void run('setCleanMotorMode', { fan: FanPower.SMART, water: WaterBoxMode.SMART, mop: MopRoute.SMART });
    else if (p === 'MANUAL') void run('setCleanMotorMode', { fan: FanPower.BALANCED, water: snap.supportsWaterSlide ? WaterBoxMode.SLIDE_MEDIUM : WaterBoxMode.LOW, mop: MopRoute.STANDARD });
    else void run('setCleanMotorMode', { fan: FanPower.CUSTOM, water: WaterBoxMode.CUSTOM, mop: MopRoute.CUSTOM });
  };
  const chooseType = (i: number) => {
    setType(i);
    const waterOff = (water ?? WaterBoxMode.OFF) === WaterBoxMode.OFF;
    if (i === 0 && waterOff) void run('setWaterBoxMode', { level: WaterBoxMode.LOW });
    if (i === 1) {
      void run('setFanPower', { level: FanPower.QUIET });
      if (waterOff) void run('setWaterBoxMode', { level: WaterBoxMode.LOW });
    }
    if (i === 2) void run('setWaterBoxMode', { level: WaterBoxMode.OFF });
  };

  const passes = (
    <SettingRow title="Passes">
      <Segmented label="Passes" options={[[1, '×1'], [2, '×2']]} value={count} onChange={onCount} />
    </SettingRow>
  );
  const suction = (
    <SettingRow title="Suction">
      <Select label="Suction" options={FAN_OPTIONS} value={fan} disabled={busy} onChange={(level) => void run('setFanPower', { level })} />
    </SettingRow>
  );
  const waterRow = (
    <SettingRow title="Water flow">
      <Select label="Water flow" options={WATER_OPTIONS} value={normalizeWaterMode(water)} disabled={busy} onChange={(level) => void run('setWaterBoxMode', { level })} />
    </SettingRow>
  );
  const routeRow = (
    <SettingRow title="Mop route">
      <Select label="Mop route" options={ROUTE_OPTIONS} value={route} disabled={busy} onChange={(mode) => void run('setMopMode', { mode })} />
    </SettingRow>
  );

  return (
    <Panel title="Cleaning mode">
      {plans.length > 1 && <Segmented label="Mode" block options={plans.map((p) => [p, PLAN_LABEL[p]] as [Plan, string])} value={plan} disabled={busy} onChange={choosePlan} />}
      {smart ? (
        <>
          <p className="muted small">SmartPlan picks suction, water and route for each room.</p>
          {passes}
        </>
      ) : perRoom ? (
        <>
          <p className="muted small">Each room is cleaned with its own suction, water and route.</p>
          <button type="button" className="btn secondary block" disabled={rooms.length === 0} onClick={() => setRoomsOpen(true)}><Icon name="tune" />Room settings</button>
          {passes}
        </>
      ) : (
        <>
          <Segmented label="Cleaning type" block options={[[0, 'Vac & Mop'], [1, 'Mop'], [2, 'Vacuum']]} value={type} disabled={busy} onChange={chooseType} />
          <div className="setting-list">
            {type !== 1 && suction}
            {type !== 2 && waterRow}
            {type !== 2 && routeRow}
            {passes}
          </div>
        </>
      )}
      {roomsOpen && <RoomModesDialog snap={snap} rooms={rooms} busy={busy} run={run} read={read} onClose={() => setRoomsOpen(false)} />}
    </Panel>
  );
}

function roomModeSummary(m: RoomCleanMode): string {
  const fan = ROOM_FAN_OPTIONS.find(([c]) => c === m.fanPower)?.[1] ?? 'Other';
  const water = WATER_OPTIONS.find(([c]) => c === normalizeWaterMode(m.waterBoxMode))?.[1] ?? 'Other';
  if (m.waterBoxMode === WaterBoxMode.OFF) return `Vacuum ${fan}`;
  if (m.fanPower === FanPower.OFF) return `Mop ${water}`;
  return `Vacuum ${fan}, mop ${water}`;
}

/** Every room in one table; nothing is sent until Save. */
function RoomModesDialog({ snap, rooms, busy, run, read, onClose }: { snap: VacuumSnapshot; rooms: MapRoom[]; busy: boolean; run: Run; read: Read; onClose: () => void }) {
  const [state, setState] = useState<'loading' | 'ok' | 'failed'>('loading');
  useEffect(() => { void read('fetchRoomCleanModes').then((ok) => setState(ok ? 'ok' : 'failed')); }, [read]);
  const saved = useMemo(() => roomCleanModesFor(rooms.map((r) => r.id), snap.roomCleanModes), [rooms, snap.roomCleanModes]);
  // Snapshots arrive every few seconds with new arrays; only a real change resets the draft.
  const savedKey = JSON.stringify(saved);
  const [draft, setDraft] = useState(saved);
  useEffect(() => setDraft(JSON.parse(savedKey) as RoomCleanMode[]), [savedKey]);
  const unsaved = JSON.stringify(draft) !== savedKey || rooms.some((r) => !snap.roomCleanModes.some((s) => s.segment === r.id));
  const update = (m: RoomCleanMode) => setDraft((d) => d.map((x) => (x.segment === m.segment ? m : x)));

  return (
    <Modal
      title="Room settings"
      wide
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn secondary" onClick={onClose}>Cancel</button>
          <button type="button" className="btn" disabled={busy || state !== 'ok' || !unsaved} onClick={() => { void run('saveRoomCleanModes', { modes: draft }, 'Room settings saved'); onClose(); }}>Save</button>
        </>
      )}
    >
      {state === 'loading' && <div className="row"><Spinner /><span>Reading the room settings from the robot...</span></div>}
      {state === 'failed' && <p className="error-text">Couldn't read the room settings from the robot. Close this window and open it again.</p>}
      {state === 'ok' && (
        <table className="table">
          <thead>
            <tr><th>Room</th><th>Suction</th><th>Water flow</th><th>Mop route</th><th className="muted">Summary</th></tr>
          </thead>
          <tbody>
            {rooms.map((room) => {
              const m = draft.find((x) => x.segment === room.id);
              if (!m) return null;
              return (
                <tr key={room.id}>
                  <td className="strong">{room.name}</td>
                  <td>
                    <Select label={`${room.name} suction`} options={ROOM_FAN_OPTIONS} value={m.fanPower} disabled={busy} onChange={(f) => {
                      // A room with neither suction nor water would not be cleaned at all.
                      const w = f === FanPower.OFF && m.waterBoxMode === WaterBoxMode.OFF ? WaterBoxMode.LOW : m.waterBoxMode;
                      update({ ...m, fanPower: f, waterBoxMode: w });
                    }} />
                  </td>
                  <td>
                    <Select label={`${room.name} water flow`} options={WATER_OPTIONS} value={normalizeWaterMode(m.waterBoxMode)} disabled={busy} onChange={(w) => {
                      const f = w === WaterBoxMode.OFF && m.fanPower === FanPower.OFF ? FanPower.BALANCED : m.fanPower;
                      update({ ...m, fanPower: f, waterBoxMode: w });
                    }} />
                  </td>
                  <td>
                    {m.waterBoxMode !== WaterBoxMode.OFF
                      ? <Select label={`${room.name} mop route`} options={ROUTE_OPTIONS} value={m.mopMode} disabled={busy} onChange={(r) => update({ ...m, mopMode: r })} />
                      : <span className="muted">—</span>}
                  </td>
                  <td className="muted small">{roomModeSummary(m)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Modal>
  );
}

function DockPanel({ snap, busy, run, duid }: { snap: VacuumSnapshot; busy: boolean; run: Run; duid: string }) {
  const s = snap.status;
  const dockError = s.dockErrorStatus;
  const drying = s.dryStatus === 1 || s.state === State.DRYING_MOP;
  const waterAttached = s.waterBoxStatus === 1;
  const row = (label: string, value: string, bad: boolean | null) => {
    const color = bad === null ? 'var(--on-surface-variant)' : bad ? 'var(--error)' : 'var(--good)';
    return (
      <div className="dock-row">
        <span className="dot" style={{ background: color }} />
        <span className="grow">{label}</span>
        <span className="strong" style={{ color }}>{value}</span>
      </div>
    );
  };
  return (
    <Panel title="Dock" actions={<Link to={vacRoute(duid, 'settings')} className="btn ghost sm">Settings</Link>}>
      <div className="col tight">
        {row('Clean water tank', dockError === undefined ? 'Unknown' : dockError === DockErrorCodes.WATER_EMPTY ? 'Empty, refill' : 'OK', dockError === undefined ? null : dockError === DockErrorCodes.WATER_EMPTY)}
        {row('Dirty water tank',
          dockError === undefined ? 'Unknown' : dockError === DockErrorCodes.DIRTY_TANK_FULL ? 'Full, empty it' : dockError === DockErrorCodes.DIRTY_TANK_LATCH_OPEN ? 'Latch open' : 'OK',
          dockError === undefined ? null : dockError === DockErrorCodes.DIRTY_TANK_FULL || dockError === DockErrorCodes.DIRTY_TANK_LATCH_OPEN)}
        {row('Dust bag',
          dockError === undefined ? 'Unknown' : dockError === DockErrorCodes.NO_DUSTBIN ? 'Missing' : dockError === DockErrorCodes.DUCT_BLOCKAGE ? 'Duct blocked' : 'OK',
          dockError === undefined ? null : dockError === DockErrorCodes.NO_DUSTBIN || dockError === DockErrorCodes.DUCT_BLOCKAGE)}
        {drying && (
          <div className="dock-row">
            <span className="dot" style={{ background: 'var(--warn)' }} />
            <span className="grow">Mop dryer</span>
            <span className="strong" style={{ color: 'var(--warn)' }}>
              {s.remainingDryTimeSec && s.remainingDryTimeSec > 0 ? `Drying, ${Math.ceil(s.remainingDryTimeSec / 60)}m left` : 'Drying'}
            </span>
          </div>
        )}
      </div>
      <div className="btn-row">
        <button type="button" className="btn secondary sm" disabled={busy} onClick={() => void run('collectDust')}><Icon name="delete" />Empty</button>
        <button type="button" className="btn secondary sm" disabled={busy || !waterAttached} title={waterAttached ? undefined : 'No water tank attached'} onClick={() => void run('washMop')}><Icon name="water" />Wash mop</button>
        {drying
          ? <button type="button" className="btn secondary sm" disabled={busy} onClick={() => void run('stopDryer')}><Icon name="stop" />Stop drying</button>
          : <button type="button" className="btn secondary sm" disabled={busy} onClick={() => void run('startDryer')}><Icon name="air" />Dry</button>}
      </div>
    </Panel>
  );
}

// ---- Maps -------------------------------------------------------------------------------------

function MapsDialog({ snap, busy, run, read, onClose }: { snap: VacuumSnapshot; busy: boolean; run: Run; read: Read; onClose: () => void }) {
  const [loading, setLoading] = useState(true);
  const [renaming, setRenaming] = useState<FloorMap | null>(null);
  const [deleting, setDeleting] = useState<FloorMap | null>(null);
  const [choosingKeep, setChoosingKeep] = useState(false);
  const recheck = async () => {
    setLoading(true);
    await read('fetchFloorMaps');
    setLoading(false);
  };
  useEffect(() => { void recheck(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const s = snap.status;
  const robotBusy = s.state !== undefined && ACTIVE_STATES.has(s.state);
  const blocked = robotBusy ? 'The robot is busy. Dock it or let it finish first.' : null;
  const canManage = !busy && !loading && !blocked;
  const floors = snap.floorMaps;
  const canAdd = floors.length < (snap.maxFloorMaps ?? 1);
  const multi = multiLevelEnabled(s);
  const smart = s.switchMapMode === undefined ? undefined : s.switchMapMode === SWITCH_MAP_MODE_SMART;

  return (
    <Modal
      title="Maps"
      onClose={onClose}
      footer={<button type="button" className="btn secondary" disabled={busy} onClick={() => void recheck()}><Icon name="refresh" />Re-check</button>}
    >
      <div className="col">
        <p className="muted small">The maps stored on your robot. Moved the dock somewhere the map doesn't cover? Delete the map, then let the robot map the home again.</p>
        {blocked && <div className="callout error"><Icon name="error" /><span>{blocked}</span></div>}
        {mapSavingEnabled(s) === false && floors.length === 0 && !loading && (
          <div className="callout col" style={{ alignItems: 'stretch' }}>
            <h3>Map saving is off</h3>
            <p className="small">This robot does not keep a map yet, so there are no rooms, zones or floors to work with. Turn map saving on to let it store one.</p>
            <button type="button" className="btn secondary" disabled={!canManage} onClick={() => void run('enableMapSaving', {}, 'Map saving on')}>Turn on map saving</button>
          </div>
        )}
        {multi !== undefined && (
          <div className="setting-list">
            <SettingRow title="Multi-level maps" sub="Keep up to one map per floor. Turning this off keeps one map and deletes the rest.">
              <Switch
                label="Multi-level maps"
                checked={multi}
                disabled={!canManage}
                onChange={(on) => {
                  if (on) void run('setMultiLevel', { enabled: true, keepMapFlag: null }, 'Multi-level maps on');
                  else if (floors.length > 1) setChoosingKeep(true);
                  else void run('setMultiLevel', { enabled: false, keepMapFlag: null }, 'Multi-level maps off');
                }}
              />
            </SettingRow>
            {multi && smart !== undefined && (
              <SettingRow title="Recognise the floor automatically" sub="Off: you pick the map before cleaning another floor.">
                <Switch label="Recognise the floor automatically" checked={smart} disabled={!canManage} onChange={(v) => void run('setSmartMapSwitching', { smart: v })} />
              </SettingRow>
            )}
          </div>
        )}
        {snap.unsavedMap && (
          <div className="callout primary col" style={{ alignItems: 'stretch' }}>
            <h3>New map not saved</h3>
            <p className="small">The robot has built a new map. Stop the mapping run when it has covered the home, then save it so it is kept and split into rooms.</p>
            <button type="button" className="btn" disabled={!canManage} onClick={() => void run('saveNewMap', {}, 'New map saved')}>Save new map</button>
          </div>
        )}
        {loading && floors.length === 0 ? (
          <div className="row"><Spinner /><span>Checking robot for saved maps...</span></div>
        ) : floors.length === 0 ? (
          <div className="col">
            <h3>No saved maps on the robot.</h3>
            <p className="muted small">The robot leaves the dock and drives through the home to build a new map. Stop it once it has covered everything, then save the map here. Open the doors to every room you want on it.</p>
            <button type="button" className="btn" disabled={!canManage || snap.unsavedMap} onClick={() => { onClose(); void run('startMapping', {}, 'Mapping started'); }}><Icon name="map" />Map the home</button>
          </div>
        ) : (
          <>
            <table className="table">
              <thead><tr><th>Map</th><th /><th style={{ textAlign: 'right' }}>Actions</th></tr></thead>
              <tbody>
                {floors.map((f) => {
                  const loaded = f.mapFlag === snap.currentFloorFlag;
                  return (
                    <tr key={f.mapFlag}>
                      <td className="strong">{f.name}</td>
                      <td>{loaded && <span className="tag">Loaded</span>}</td>
                      <td>
                        <div className="row" style={{ justifyContent: 'flex-end', gap: 4 }}>
                          {floors.length > 1 && !loaded && (
                            <button type="button" className="btn secondary sm" disabled={busy} onClick={() => { onClose(); void run('switchFloor', { mapFlag: f.mapFlag }); }}>Load</button>
                          )}
                          <IconButton icon="edit" label={`Rename ${f.name}`} disabled={!canManage} onClick={() => setRenaming(f)} />
                          <IconButton icon="delete" label={`Delete ${f.name}`} disabled={!canManage} onClick={() => setDeleting(f)} />
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {canAdd && <button type="button" className="btn secondary" disabled={!canManage || snap.unsavedMap} onClick={() => { onClose(); void run('startMapping', {}, 'Mapping started'); }}><Icon name="map" />Map another floor</button>}
          </>
        )}
      </div>
      {renaming && <RenameMapDialog floor={renaming} onClose={() => setRenaming(null)} onRename={(name) => void run('renameFloorMap', { mapFlag: renaming.mapFlag, name }, 'Map renamed')} />}
      {deleting && (
        <ConfirmDialog
          title={`Delete "${deleting.name}"?`}
          text="The robot forgets this map and everything on it: rooms, room names, floor types, no-go zones, walls, carpets and thresholds. This can't be undone."
          confirm="Delete map"
          danger
          onConfirm={() => void run('deleteFloorMap', { mapFlag: deleting.mapFlag }, 'Map deleted')}
          onClose={() => setDeleting(null)}
        />
      )}
      {choosingKeep && floors.length > 0 && (
        <KeepMapDialog floors={floors} current={snap.currentFloorFlag} onClose={() => setChoosingKeep(false)} onKeep={(keep) => void run('setMultiLevel', { enabled: false, keepMapFlag: keep }, 'Multi-level maps off')} />
      )}
    </Modal>
  );
}

function RenameMapDialog({ floor, onRename, onClose }: { floor: FloorMap; onRename: (name: string) => void; onClose: () => void }) {
  const [name, setName] = useState(floor.name);
  const problem = mapNameBlocker(name.trim());
  const show = problem !== null && name.length > 0;
  const ok = problem === null && name.trim() !== floor.name;
  return (
    <Dialog
      title="Rename map"
      onClose={onClose}
      actions={(
        <>
          <button type="button" className="btn secondary" onClick={onClose}>Cancel</button>
          <button type="button" className="btn" disabled={!ok} onClick={() => { onClose(); onRename(name.trim()); }}>Rename</button>
        </>
      )}
    >
      <Field label="Map name" invalid={show} hint={show ? problem! : undefined}>
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && ok) { onClose(); onRename(name.trim()); } }} />
      </Field>
    </Dialog>
  );
}

/** Turning multi-level maps off keeps one map; the robot deletes the others. */
function KeepMapDialog({ floors, current, onKeep, onClose }: { floors: FloorMap[]; current: number; onKeep: (flag: number) => void; onClose: () => void }) {
  const [keep, setKeep] = useState(floors.find((f) => f.mapFlag === current)?.mapFlag ?? floors[0]!.mapFlag);
  return (
    <Dialog
      title="Keep which map?"
      onClose={onClose}
      actions={(
        <>
          <button type="button" className="btn secondary" onClick={onClose}>Cancel</button>
          <button type="button" className="btn danger" onClick={() => { onClose(); onKeep(keep); }}>Keep this map</button>
        </>
      )}
    >
      <p>Single-level mode keeps one map. The robot deletes the others with their rooms and zones. This can't be undone.</p>
      <div>
        {floors.map((f) => (
          <label key={f.mapFlag} className="radio-row">
            <input type="radio" name="keep" checked={keep === f.mapFlag} onChange={() => setKeep(f.mapFlag)} />
            <span>{f.name}</span>
          </label>
        ))}
      </div>
    </Dialog>
  );
}
