import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { CONSUMABLE_LIFETIME_S } from '../../../shared/codes';
import type { VacuumSnapshot } from '../../../shared/api';
import type { MapRoom } from '../../../shared/map';
import { Icon, type IconName } from '../icons';
import { ConfirmDialog, Empty, IconButton, Modal, Panel, Segmented, Select, SettingRow, Spinner, Switch } from '../ui';
import { useRobotActions } from '../useRobot';

/* The History, Maintenance and Settings tabs of a robot's workspace. */

type Actions = ReturnType<typeof useRobotActions>;

// ---- History ----------------------------------------------------------------------------------

export function HistoryTab({ snap, actions }: { snap: VacuumSnapshot; actions: Actions }) {
  const [loading, setLoading] = useState(true);
  const load = async () => {
    setLoading(true);
    await actions.run('fetchHistory');
    setLoading(false);
  };
  useEffect(() => { void load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const records = [...snap.cleanHistory].sort((a, b) => b.beginEpoch - a.beginEpoch);
  const summary = snap.cleanSummary;
  return (
    <div className="tab-page">
      <div className="tab-page-head">
        <h2 className="grow">Cleaning history</h2>
        <button type="button" className="btn secondary sm" disabled={loading} onClick={() => void load()}>{loading ? <span className="spinner" /> : <Icon name="refresh" />}Refresh</button>
      </div>
      {summary && (
        <div className="stat-tiles">
          <div className="stat-tile"><span className="stat-label">Sessions</span><span className="stat-big">{summary.totalCount}</span></div>
          <div className="stat-tile"><span className="stat-label">Total area</span><span className="stat-big">{Math.round(summary.totalAreaMm2 / 1_000_000)} m²</span></div>
          <div className="stat-tile"><span className="stat-label">Total time</span><span className="stat-big">{hm(summary.totalTimeSec)}</span></div>
        </div>
      )}
      {records.length === 0 ? (
        loading ? <div className="empty"><Spinner big /></div> : (
          <Empty icon="history" title="No history yet" text="Complete a cleaning session to see it here.">
            <button type="button" className="btn secondary" onClick={() => void load()}>Load history</button>
          </Empty>
        )
      ) : (
        <Panel>
          <table className="table">
            <thead>
              <tr><th>Started</th><th className="num">Duration</th><th className="num">Area</th><th>Result</th></tr>
            </thead>
            <tbody>
              {records.map((r) => {
                const done = r.complete === 1;
                return (
                  <tr key={r.beginEpoch}>
                    <td>{new Date(r.beginEpoch * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</td>
                    <td className="num">{Math.floor(r.durationSeconds / 60)} min</td>
                    <td className="num">{(r.areaMm2 / 1_000_000).toFixed(1)} m²</td>
                    <td>
                      {done
                        ? <span className="tag good"><Icon name="checkCircle" size={14} />Finished</span>
                        : <span className="tag bad"><Icon name="warning" size={14} />{r.errorCode !== 0 ? `Error ${r.errorCode}` : 'Not finished'}</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Panel>
      )}
    </div>
  );
}

function hm(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// ---- Maintenance ------------------------------------------------------------------------------

const CONSUMABLES: Array<{ key: keyof NonNullable<VacuumSnapshot['consumables']>; field: string; title: string; icon: IconName; tint: string; life: number; optional?: boolean; runs?: boolean }> = [
  { key: 'mainBrushWorkTime', field: 'main_brush_work_time', title: 'Main brush', icon: 'autorenew', tint: 'var(--good)', life: CONSUMABLE_LIFETIME_S.mainBrush },
  { key: 'sideBrushWorkTime', field: 'side_brush_work_time', title: 'Side brush', icon: 'autorenew', tint: 'var(--water)', life: CONSUMABLE_LIFETIME_S.sideBrush },
  { key: 'filterWorkTime', field: 'filter_work_time', title: 'Filter', icon: 'air', tint: 'var(--accent-purple)', life: CONSUMABLE_LIFETIME_S.filter },
  { key: 'sensorDirtyTime', field: 'sensor_dirty_time', title: 'Sensor', icon: 'find', tint: 'var(--warn)', life: CONSUMABLE_LIFETIME_S.sensor },
  { key: 'cleaningBrushWorkTime', field: 'cleaning_brush_work_times', title: 'Maintenance brush', icon: 'brush', tint: 'var(--accent-cyan)', life: CONSUMABLE_LIFETIME_RUNS.cleaningBrush, optional: true, runs: true },
  { key: 'strainerWorkTime', field: 'strainer_work_times', title: 'Strainer', icon: 'filter', tint: 'var(--accent-indigo)', life: CONSUMABLE_LIFETIME_RUNS.strainer, optional: true, runs: true },
];

export function MaintenanceTab({ snap, actions }: { snap: VacuumSnapshot; actions: Actions }) {
  const [loading, setLoading] = useState(true);
  const [resetting, setResetting] = useState<(typeof CONSUMABLES)[number] | null>(null);
  const load = async () => {
    setLoading(true);
    await actions.run('fetchConsumables');
    setLoading(false);
  };
  useEffect(() => { void load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const c = snap.consumables;
  return (
    <div className="tab-page">
      <div className="tab-page-head">
        <h2 className="grow">Maintenance</h2>
        <button type="button" className="btn secondary sm" disabled={loading} onClick={() => void load()}>{loading ? <span className="spinner" /> : <Icon name="refresh" />}Refresh</button>
      </div>
      {!c ? (
        loading ? <div className="empty"><Spinner big /></div> : (
          <Empty icon="build" title="Could not load consumable data">
            <button type="button" className="btn secondary" onClick={() => void load()}>Retry</button>
          </Empty>
        )
      ) : (
        <Panel>
          <table className="table">
            <thead>
              <tr><th>Part</th><th style={{ width: '40%' }}>Life left</th><th className="num">Left</th><th /></tr>
            </thead>
            <tbody>
              {CONSUMABLES.filter((x) => !x.optional || c[x.key] !== undefined).map((x) => {
                const used = c[x.key] ?? 0;
                const remaining = Math.max(0, x.life - used);
                const percent = percentLeft(used, x.life);
                const fraction = percent / 100;
                const color = fraction > 0.5 ? 'var(--good)' : fraction > 0.2 ? 'var(--warn)' : 'var(--error)';
                const h = Math.floor(remaining / 3600);
                const m = Math.floor((remaining % 3600) / 60);
                const left = x.runs ? `${remaining} ${remaining === 1 ? 'run' : 'runs'}` : h > 0 ? `${h}h ${m}m` : `${m}m`;
                return (
                  <tr key={x.key}>
                    <td>
                      <span className="row">
                        <span className="badge-icon" style={{ '--tint': x.tint } as CSSProperties}><Icon name={x.icon} /></span>
                        <span className="strong">{x.title}</span>
                      </span>
                    </td>
                    <td>
                      <span className="row">
                        <span className="progress grow"><span style={{ width: `${fraction * 100}%`, background: color }} /></span>
                        <span className="small strong" style={{ color, width: 40, textAlign: 'right' }}>{percent}%</span>
                      </span>
                    </td>
                    <td className="num">{left}</td>
                    <td style={{ textAlign: 'right' }}>
                      <button type="button" className="btn ghost sm" disabled={actions.busy} onClick={() => setResetting(x)}>Reset</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Panel>
      )}
      {resetting && (
        <ConfirmDialog
          title={`Reset ${resetting.title.toLowerCase()}?`}
          text="Do this after you have replaced or cleaned it. The robot starts counting its lifetime again."
          confirm="Reset"
          danger
          onConfirm={() => void actions.run('resetConsumable', { field: resetting.field }, `${resetting.title} reset`)}
          onClose={() => setResetting(null)}
        />
      )}
    </div>
  );
}

// ---- Settings ---------------------------------------------------------------------------------

const VOLUMES: Array<[number, string]> = [[0, 'Off'], [30, 'Low'], [60, 'Medium'], [100, 'High']];
const CARPET_MODES: Array<[number, string]> = [[0, 'Avoid carpet'], [1, 'Standard'], [2, 'Carpet boost']];
const WASH_FREQS: Array<[number, string]> = [[0, 'Every trip'], [1, 'Every 2 trips'], [2, 'Every 3 trips']];
const WASH_MODES: Array<[number, string]> = [[0, 'Light'], [1, 'Standard'], [2, 'Intensive']];
const EMPTY_MODES: Array<[number, string]> = [[0, 'Smart'], [1, 'Max suction'], [2, 'Normal']];

const SECTIONS: Array<[string, string]> = [
  ['robot', 'Robot'],
  ['dock', 'Dock'],
  ['quiet', 'Do Not Disturb'],
  ['order', 'Cleaning order'],
  ['about', 'About'],
];

export function RobotSettingsTab({ snap, rooms, actions }: { snap: VacuumSnapshot; rooms: MapRoom[]; actions: Actions }) {
  const { run, read, busy } = actions;
  const [found, setFound] = useState(false);
  useEffect(() => {
    void read('fetchRobotSettings');
    void read('fetchDockSettings');
    void read('fetchDnd');
  }, [read]);
  const r = snap.robotSettings;
  const d = snap.dockSettings;
  const volume = VOLUMES.reduce((best, [v]) => (Math.abs(v - r.volume) < Math.abs(best - r.volume) ? v : best), VOLUMES[0]![0]);
  const jump = (id: string) => document.getElementById(`settings-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  return (
    <div className="tab-page settings-layout">
      <nav className="settings-nav" aria-label="Settings sections">
        {SECTIONS.map(([id, label]) => <button key={id} type="button" onClick={() => jump(id)}>{label}</button>)}
      </nav>
      <div className="settings-sections">
        <Panel title="Robot" id="settings-robot">
          <div className="setting-list">
            <SettingRow title="Find robot" sub="Make the robot beep so you can find it.">
              <button type="button" className="btn secondary sm" onClick={() => { setFound(true); setTimeout(() => setFound(false), 4_000); void run('findMe'); }}>
                <Icon name="find" />{found ? 'Beeping...' : 'Find'}
              </button>
            </SettingRow>
            <SettingRow title="Voice volume" sub={volume === r.volume ? undefined : `The robot is set to ${r.volume}%.`}>
              <Select label="Voice volume" options={VOLUMES} value={volume} disabled={busy} onChange={(v) => void run('setVolume', { volume: v })} />
            </SettingRow>
            <SettingRow title="Child lock" sub={r.childLock ? 'The buttons on the robot are locked.' : 'The buttons on the robot work.'}>
              <Switch label="Child lock" checked={r.childLock} disabled={busy} onChange={(v) => void run('setChildLock', { locked: v })} />
            </SettingRow>
            <SettingRow title="Status light" sub="The light on top of the robot.">
              <Switch label="Status light" checked={r.ledEnabled} disabled={busy} onChange={(v) => void run('setLed', { on: v })} />
            </SettingRow>
        <Panel title="Carpet" id="settings-carpet">
          <div className="setting-list">
            <SettingRow title="Carpet mode" sub="What the robot does on carpet.">
              <Select label="Carpet mode" options={CARPET_MODES} value={r.carpetMode} disabled={busy} onChange={(v) => void run('setCarpetMode', { mode: v })} />
            </SettingRow>
          </div>
        </Panel>

        <Panel title="Dock" id="settings-dock">
          <div className="setting-list">
            <SettingRow title="Mop wash frequency" sub="How often the robot returns to wash the mop.">
              <Select label="Mop wash frequency" options={WASH_FREQS} value={d.washFreq} disabled={busy} onChange={(v) => void run('setWashFreq', { freq: v })} />
            </SettingRow>
            <SettingRow title="Washing mode">
              <Select label="Washing mode" options={WASH_MODES} value={d.washMode} disabled={busy} onChange={(v) => void run('setWashMode', { mode: v })} />
            </SettingRow>
            <SettingRow title="Auto-empty mode" sub="How the dock empties the robot's dustbin.">
              <Select label="Auto-empty mode" options={EMPTY_MODES} value={d.autoEmptyMode} disabled={busy} onChange={(v) => void run('setAutoEmptyMode', { mode: v })} />
            </SettingRow>
          </div>
        </Panel>

        <Panel title="Do Not Disturb" id="settings-quiet">
          <DndSettings snap={snap} actions={actions} />
        </Panel>

        <Panel title="Default cleaning order" id="settings-order">
          <OrderEditor rooms={rooms} saved={snap.defaultCleanOrder} busy={busy} run={run} />
        </Panel>

        <Panel title="About" id="settings-about">
          <dl className="facts">
            <dt>Model</dt><dd>{snap.model ?? 'Unknown'}</dd>
            <dt>Firmware</dt><dd>{snap.firmware ?? 'Unknown'}</dd>
            <dt>Device ID</dt><dd className="mono">{snap.duid}</dd>
          </dl>
        </Panel>
      </div>
    </div>
  );
}

function DndSettings({ snap, actions }: { snap: VacuumSnapshot; actions: Actions }) {
  const d = snap.dnd ?? { enabled: false, startHour: 22, startMinute: 0, endHour: 8, endMinute: 0 };
  const [draft, setDraft] = useState(d);
  const key = JSON.stringify(snap.dnd);
  useEffect(() => { if (snap.dnd) setDraft(snap.dnd); }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const time = (h: number, m: number) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  const commit = (next: typeof draft) => {
    setDraft(next);
    if (next.enabled) void actions.run('setDnd', { startHour: next.startHour, startMinute: next.startMinute, endHour: next.endHour, endMinute: next.endMinute });
    else void actions.run('disableDnd');
  };
  const parse = (v: string): [number, number] | null => {
    const m = /^(\d{2}):(\d{2})$/.exec(v);
    return m ? [Number(m[1]), Number(m[2])] : null;
  };
  return (
    <div className="setting-list">
      <SettingRow title="Quiet hours" sub={draft.enabled ? `The robot won't start cleaning between ${time(draft.startHour, draft.startMinute)} and ${time(draft.endHour, draft.endMinute)}.` : 'The robot cleans at any time.'}>
        <Switch label="Quiet hours" checked={draft.enabled} disabled={actions.busy} onChange={(v) => commit({ ...draft, enabled: v })} />
      </SettingRow>
      {draft.enabled && (
        <SettingRow title="From / until">
          <span className="row">
            <input className="input" type="time" aria-label="Start time" value={time(draft.startHour, draft.startMinute)} onChange={(e) => {
              const t = parse(e.target.value);
              if (t) commit({ ...draft, startHour: t[0], startMinute: t[1] });
            }} />
            <span className="muted">to</span>
            <input className="input" type="time" aria-label="End time" value={time(draft.endHour, draft.endMinute)} onChange={(e) => {
              const t = parse(e.target.value);
              if (t) commit({ ...draft, endHour: t[0], endMinute: t[1] });
            }} />
          </span>
        </SettingRow>
      )}
    </div>
  );
}

/** The order a full clean goes through the rooms in; drag rows or use the arrows. */
function OrderEditor({ rooms, saved, busy, run }: { rooms: MapRoom[]; saved: number[]; busy: boolean; run: Actions['run'] }) {
  const initial = useMemo(() => {
    const onMap = rooms.map((r) => r.id);
    return [...new Set([...saved.filter((id) => onMap.includes(id)), ...onMap])];
  }, [rooms, saved]);
  const initialKey = initial.join(',');
  const [order, setOrder] = useState(initial);
  useEffect(() => setOrder(initialKey ? initialKey.split(',').map(Number) : []), [initialKey]);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const dragFrom = useRef<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);
  const names = new Map(rooms.map((r) => [r.id, r.name]));
  const move = (from: number, to: number) => setOrder((o) => {
    const next = [...o];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item!);
    return next;
  });
  const unchanged = order.length === saved.length && order.every((v, i) => v === saved[i]);

  if (rooms.length === 0) return <p className="muted small">Load the map on the Overview tab to see the rooms.</p>;
  return (
    <div className="col">
      <p className="muted small">A clean without picked rooms goes through them in this order. Rooms you pick are still cleaned in the order you pick them.</p>
      <ol className="order-list">
        {order.map((id, i) => (
          <li
            key={id}
            draggable={!busy}
            className={dragOver === i ? 'drag-over' : ''}
            onDragStart={(e) => { dragFrom.current = i; e.dataTransfer.effectAllowed = 'move'; }}
            onDragOver={(e) => { e.preventDefault(); setDragOver(i); }}
            onDragLeave={() => setDragOver((v) => (v === i ? null : v))}
            onDrop={(e) => {
              e.preventDefault();
              if (dragFrom.current !== null && dragFrom.current !== i) move(dragFrom.current, i);
              dragFrom.current = null;
              setDragOver(null);
            }}
            onDragEnd={() => { dragFrom.current = null; setDragOver(null); }}
          >
            <Icon name="dragHandle" className="muted drag-handle" />
            <span className="order-badge">{i + 1}</span>
            <span className="grow ellipsis">{names.get(id) ?? `Room ${id}`}</span>
            <IconButton icon="chevronUp" label={`Move ${names.get(id) ?? 'room'} up`} disabled={busy || i === 0} onClick={() => move(i, i - 1)} />
            <IconButton icon="chevronDown" label={`Move ${names.get(id) ?? 'room'} down`} disabled={busy || i === order.length - 1} onClick={() => move(i, i + 1)} />
          </li>
        ))}
      </ol>
      <div className="btn-row">
        <button type="button" className="btn" disabled={busy || unchanged} onClick={() => void run('saveCleanOrder', { order }, 'Cleaning order saved')}>Save order</button>
        {saved.length > 0 && <button type="button" className="btn secondary" disabled={busy} onClick={() => setConfirmRemove(true)}>Remove default order</button>}
      </div>
      {confirmRemove && (
        <ConfirmDialog
          title="Remove the default order?"
          text="A full clean goes back to the order the robot picks itself."
          confirm="Remove"
          onConfirm={() => void run('removeCleanOrder', {}, 'Default order removed')}
          onClose={() => setConfirmRemove(false)}
        />
      )}
    </div>
  );
}
