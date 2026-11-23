import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { CONSUMABLE_LIFETIME_RUNS, CONSUMABLE_LIFETIME_S, describeError, isDockedAndIdle, percentLeft } from '../../../shared/codes';
import { DockCapabilities, WASH_WATER_TEMPERATURES, dryTimeLabel, labelFor, washFrequencyLabel } from '../../../shared/dock';
import { choiceLabelFor, featureDef, featureEnabled, type FeatureSection } from '../../../shared/features';
import type { CleanRecord, MapDto, VacuumSnapshot } from '../../../shared/api';
import type { ParsedMap } from '../../../shared/map';
import {
  cleanAreaLabel, cleanDurationLabel, cleanRecordTags, cleanTypeLabel, cruiseTitle, finishReasonLabel, isCruise, shownAreaMm2,
  startTypeLabel, timelineDetail, timelineTitle, totalAreaLabel, type CleanTimelineStep,
} from '../../../shared/history';
import { call } from '../api';
import { MapView } from '../map/MapView';
import { PatrolPointList, drawPatrolPoints } from './Obstacles';
import { decodeMap, useStore } from '../store';
import type { MapRoom } from '../../../shared/map';
import { Icon, type IconName } from '../icons';
import { ConfirmDialog, Empty, IconButton, Modal, Panel, Segmented, Select, SettingRow, Spinner, Switch } from '../ui';
import { useRobotActions } from '../useRobot';
import { MatterDialog } from './Matter';
import { VoicePanel } from './Voice';
import { isVoiceAssistantSupported } from '../../../shared/voice';
import { isMatterSupported } from '../../../shared/matter';
import { FIRMWARE_MIN_BATTERY, firmwareInstallBlocker, firmwareProgressText, firmwareRunning } from '../../../shared/firmware';

/* The History, Maintenance and Settings tabs of a robot's workspace. */

type Actions = ReturnType<typeof useRobotActions>;

// ---- History ----------------------------------------------------------------------------------

export function HistoryTab({ snap, actions }: { snap: VacuumSnapshot; actions: Actions }) {
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<'clean' | 'cruise'>('clean');
  const [open, setOpen] = useState<CleanRecord | null>(null);
  const load = async () => {
    setLoading(true);
    await actions.run('fetchHistory');
    setLoading(false);
  };
  useEffect(() => { void load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const all = [...snap.cleanHistory].sort((a, b) => b.beginEpoch - a.beginEpoch);
  const summary = snap.cleanSummary;
  // Cleaning and Cruise tabs only when the robot has cruise runs, as the official app does.
  const hasCruise = (summary?.patrolCount ?? 0) > 0 || all.some(isCruise);
  const records = hasCruise && tab === 'cruise' ? all.filter(isCruise) : all.filter((r) => !isCruise(r));
  return (
    <div className="tab-page">
      <div className="tab-page-head">
        <h2 className="grow">History</h2>
        <button type="button" className="btn secondary sm" disabled={loading} onClick={() => void load()}>{loading ? <span className="spinner" /> : <Icon name="refresh" />}Refresh</button>
      </div>
      {summary && (
        <div className="stat-tiles">
          <div className="stat-tile"><span className="stat-label">Total Area</span><span className="stat-big">{totalAreaLabel(summary.totalAreaMm2)}</span></div>
          <div className="stat-tile"><span className="stat-label">Total Time</span><span className="stat-big">{hm(summary.totalTimeSec)}</span></div>
          <div className="stat-tile"><span className="stat-label">Working Times</span><span className="stat-big">{summary.totalCount}</span></div>
        </div>
      )}
      {hasCruise && <Segmented label="History" options={[['clean', 'Cleaning'], ['cruise', 'Cruise']] as Array<['clean' | 'cruise', string]>} value={tab} onChange={setTab} />}
      {records.length === 0 ? (
        loading ? <div className="empty"><Spinner big /></div> : (
          <Empty icon="history" title="No history yet" text={tab === 'cruise' ? 'Cruise and pet searches show up here.' : 'Complete a cleaning session to see it here.'}>
            <button type="button" className="btn secondary" onClick={() => void load()}>Load history</button>
          </Empty>
        )
      ) : (
        <Panel>
          <table className="table hover">
            <thead>
              <tr><th>Started</th><th>{tab === 'cruise' ? 'Run' : 'Mode'}</th><th className="num">Duration</th><th className="num">Area</th><th>Result</th></tr>
            </thead>
            <tbody>
              {records.map((r) => {
                const result = finishReasonLabel(r);
                const done = result === 'Finished cleaning';
                return (
                  <tr key={r.beginEpoch} className="clickable" tabIndex={0} onClick={() => setOpen(r)} onKeyDown={(e) => { if (e.key === 'Enter') setOpen(r); }}>
                    <td>{new Date(r.beginEpoch * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</td>
                    <td>{isCruise(r) ? cruiseTitle(r) : cleanTypeLabel(r.cleanType) ?? startTypeLabel(r.startType) ?? '—'}</td>
                    <td className="num">{cleanDurationLabel(r.durationSeconds)}</td>
                    <td className="num">{cleanAreaLabel(shownAreaMm2(r))}</td>
                    <td>
                      {done
                        ? <span className="tag good"><Icon name="checkCircle" size={14} />{result}</span>
                        : <span className="tag bad"><Icon name="warning" size={14} />{r.errorCode !== 0 ? describeError(r.errorCode) : result}</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Panel>
      )}
      {open && <RunDialog duid={snap.duid} record={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

/** One run: its map (asked from the robot), the result, the tags and the timeline, as the official app's run page. */
function RunDialog({ duid, record, onClose }: { duid: string; record: CleanRecord; onClose: () => void }) {
  const [map, setMap] = useState<ParsedMap | null>(null);
  const [mapState, setMapState] = useState<'loading' | 'ok' | 'none'>('loading');
  const [timeline, setTimeline] = useState<CleanTimelineStep[] | null | undefined>(undefined);
  const roomNames = useStore((s) => s.maps[duid]?.rooms);
  useEffect(() => {
    let live = true;
    call<MapDto>(duid, 'fetchCleanRecordMap', { begin: record.beginEpoch })
      .then((dto) => { if (live) { setMap(decodeMap(dto)); setMapState('ok'); } })
      .catch(() => { if (live) setMapState('none'); });
    call<CleanTimelineStep[] | null>(duid, 'fetchCleanTimeline', { begin: record.beginEpoch, end: record.endEpoch })
      .then((t) => { if (live) setTimeline(t); })
      .catch(() => { if (live) setTimeline(null); });
    return () => { live = false; };
  }, [duid, record.beginEpoch, record.endEpoch]);
  const tags = cleanRecordTags(record);
  const nameOf = (segment: number) => roomNames?.find((r) => r.id === segment)?.name ?? null;
  // The run's map with the home's room names, which the live map carries.
  const namedMap = useMemo(() => (map ? { ...map, rooms: map.rooms.map((r) => ({ ...r, name: roomNames?.find((x) => x.id === r.id)?.name ?? r.name })) } : null), [map, roomNames]);
  const clock = (t: number) => new Date(t * 1000).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return (
    <Modal title={new Date(record.beginEpoch * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })} wide onClose={onClose}
      footer={<button type="button" className="btn secondary" onClick={onClose}>Close</button>}>
      <div className="col">
        <div className="run-map" style={{ height: 300, position: 'relative', borderRadius: 12, overflow: 'hidden' }}>
          {mapState === 'ok' && namedMap ? <MapView map={namedMap} showLabels overlayKey={namedMap.patrolPoints} overlay={({ ctx, api }) => drawPatrolPoints(ctx, api, namedMap.patrolPoints)} />
            : mapState === 'loading' ? <div className="empty"><Spinner big /></div>
              : <div className="empty"><span className="muted">The robot did not send this run's map.</span></div>}
        </div>
        <div className="col tight">
          <strong>{isCruise(record) ? cruiseTitle(record) : finishReasonLabel(record)}</strong>
          {tags.length > 0 && <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>{tags.map((t) => <span key={t} className="tag">{t}</span>)}</div>}
          <span className="muted small">{cleanDurationLabel(record.durationSeconds)} · {cleanAreaLabel(shownAreaMm2(record))}{record.errorCode !== 0 ? ` · ${describeError(record.errorCode)}` : ''}</span>
        </div>
        {isCruise(record) && (
          <div className="col tight">
            <strong>Cruise points</strong>
            {mapState === 'loading' ? <span className="muted small">Reading the run's map...</span>
              : map && map.patrolTaskId !== null ? <PatrolPointList duid={duid} taskId={map.patrolTaskId} points={map.patrolPoints} />
                : <span className="muted small">This run has no cruise points, as with a pet search.</span>}
          </div>
        )}
        <div className="col tight">
          <strong>Timeline</strong>
          {timeline === undefined ? <div className="row"><Spinner /><span>Reading the timeline...</span></div>
            : timeline === null || timeline.length === 0 ? <span className="muted small">No timeline for this run.</span>
              : (
                <ol className="timeline">
                  {timeline.map((s, i) => (
                    <li key={i} className={s.kind === 'error' ? 'bad' : ''}>
                      <span className="muted tiny">{clock(s.time)}</span>
                      <span>{timelineTitle(s, nameOf)}</span>
                      {timelineDetail(s) && <span className="muted small">{timelineDetail(s)}</span>}
                    </li>
                  ))}
                </ol>
              )}
        </div>
      </div>
    </Modal>
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
/** set_carpet_clean_mode in value order, as the official app names them; 3 only when the robot reports it. */
function carpetModes(current: number): Array<[number, string]> {
  const base: Array<[number, string]> = [[0, 'Avoid carpet'], [1, 'Rise (vacuum only)'], [2, 'Vacuum and mop (can wet carpet)']];
  return current === 3 ? [...base, [3, 'Dynamic lift']] : base;
}

const SECTIONS: Array<[string, string]> = [
  ['robot', 'Robot'],
  ['voice', 'Voice Assistant'],
  ['carpet', 'Carpet'],
  ['floor', 'Floor cleaning'],
  ['obstacle', 'Obstacles'],
  ['dock', 'Dock'],
  ['beta', 'Beta'],
  ['quiet', 'Do Not Disturb'],
  ['order', 'Cleaning order'],
  ['about', 'About'],
];

export function RobotSettingsTab({ snap, rooms, actions }: { snap: VacuumSnapshot; rooms: MapRoom[]; actions: Actions }) {
  const { run, read, busy } = actions;
  const [found, setFound] = useState(false);
  const [matterOpen, setMatterOpen] = useState(false);
  useEffect(() => {
    void read('fetchRobotSettings');
    void read('fetchFeatures');
    void read('fetchDockSettings');
    void read('fetchValley');
    void read('fetchDnd');
  }, [read]);
  const r = snap.robotSettings;
  const volume = r.volume <= 0 ? 0 : VOLUMES.slice(1).reduce((best, [v]) => (Math.abs(v - r.volume) < Math.abs(best - r.volume) ? v : best), VOLUMES[1]![0]);
  const jump = (id: string) => document.getElementById(`settings-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  return (
    <div className="tab-page settings-layout">
      <nav className="settings-nav" aria-label="Settings sections">
        {SECTIONS.filter(([id]) => sectionShown(snap, id)).map(([id, label]) => <button key={id} type="button" onClick={() => jump(id)}>{label}</button>)}
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
            <FeatureRows snap={snap} actions={actions} section="ROBOT" />
            {isMatterSupported(snap.newFeatureSet) && (
              <SettingRow title="Matter" sub="Add the robot to a smart home app with its Matter setup code.">
                <button type="button" className="btn secondary sm" onClick={() => setMatterOpen(true)}><Icon name="qr" />Set up</button>
              </SettingRow>
            )}
          </div>
          {matterOpen && <MatterDialog duid={snap.duid} onClose={() => setMatterOpen(false)} />}
        </Panel>

        {isVoiceAssistantSupported(snap.newFeatureSet) && (
          <Panel title="Voice Assistant" id="settings-voice">
            <VoicePanel snap={snap} actions={actions} />
          </Panel>
        )}

        <Panel title="Carpet" id="settings-carpet">
          <div className="setting-list">
            <SettingRow title="Carpet mode" sub="What the robot does on carpet.">
              <Select label="Carpet mode" options={carpetModes(r.carpetMode)} value={r.carpetMode} disabled={busy} onChange={(v) => void run('setCarpetMode', { mode: v })} />
            </SettingRow>
            <FeatureRows snap={snap} actions={actions} section="CARPET" />
          </div>
        </Panel>

        {sectionHas(snap, 'FLOOR') && (
          <Panel title="Floor cleaning" id="settings-floor">
            <div className="setting-list"><FeatureRows snap={snap} actions={actions} section="FLOOR" /></div>
          </Panel>
        )}

        {sectionHas(snap, 'OBSTACLE') && (
          <Panel title="Obstacles" id="settings-obstacle">
            <div className="setting-list"><FeatureRows snap={snap} actions={actions} section="OBSTACLE" /></div>
          </Panel>
        )}

        <Panel title="Dock" id="settings-dock">
          <DockSettingsPanel snap={snap} actions={actions} />
        </Panel>

        {(sectionHas(snap, 'BETA') || snap.unlistedFeatures.length > 0) && (
          <Panel title="Beta" id="settings-beta">
            <div className="setting-list">
              <FeatureRows snap={snap} actions={actions} section="BETA" />
              {snap.unlistedFeatures.length > 0 && (
                <SettingRow
                  title="Also advertised by this robot"
                  sub={`Features the robot reports that LocalRock has no controls for yet: ${snap.unlistedFeatures.map((f) => f.name ?? `bit ${f.bit}`).join(', ')}.`}
                />
              )}
            </div>
          </Panel>
        )}

        <Panel title="Do Not Disturb" id="settings-quiet">
          <DndSettings snap={snap} actions={actions} />
        </Panel>

        <Panel title="Default cleaning order" id="settings-order">
          <OrderEditor rooms={rooms} saved={snap.defaultCleanOrder} busy={busy} run={run} />
        </Panel>

        <Panel title="About" id="settings-about">
          <dl className="facts">
            <dt>Model</dt><dd>{snap.modelName ?? 'Unknown'}{snap.model && snap.modelName !== snap.model ? <span className="muted"> ({snap.model})</span> : null}</dd>
            <dt>Firmware</dt><dd>{snap.firmware ?? 'Unknown'}</dd>
            <dt>Device ID</dt><dd className="mono">{snap.duid}</dd>
          </dl>
          <FirmwarePanel snap={snap} actions={actions} />
        </Panel>
      </div>
    </div>
  );
}

/** The update check and install, from LocalRock's FirmwareUpdateScreen. The server follows the install, so a reload keeps it. */
function FirmwarePanel({ snap, actions }: { snap: VacuumSnapshot; actions: Actions }) {
  const [confirm, setConfirm] = useState(false);
  const check = snap.firmwareCheck;
  const progress = snap.firmwareProgress;
  const running = firmwareRunning(progress);
  const s = snap.status;
  const blocker = firmwareInstallBlocker(s.state, s.battery, s.chargeStatus, s.inCleaning, s.errorCode);
  return (
    <div className="col" style={{ marginTop: 12 }}>
      {check === null ? (
        <div className="row">
          <span className="grow muted small">Your server asks Roborock's cloud for new firmware on the robot's behalf, so the robot stays off it.</span>
          <button type="button" className="btn secondary sm" onClick={() => void actions.read('checkFirmware')}><Icon name="refresh" />Check for update</button>
        </div>
      ) : check.kind === 'checking' ? (
        <div className="row"><Spinner /><span>Checking for updates...</span></div>
      ) : check.kind === 'unavailable' ? (
        <div className="col tight">
          <strong>The update check is not available.</strong>
          <span className="error-text small">{check.reason}</span>
          <span className="muted small">It needs local_roborock_server with firmware support (#255).</span>
        </div>
      ) : check.kind === 'upToDate' ? (
        <div className="row"><Icon name="checkCircle" /><span>Up to date{check.current ? ` (${check.current})` : ''}.</span></div>
      ) : (
        <div className="col tight">
          <strong>{check.force ? 'Update required' : 'Update available'}: {check.latest ?? 'new version'}</strong>
          <span className="muted small">Installed: {check.current ?? snap.firmware ?? 'unknown'}</span>
          {check.notes && <p className="small" style={{ whiteSpace: 'pre-wrap' }}>{check.notes}</p>}
        </div>
      )}
      {progress.kind !== 'idle' && (
        <div className={`callout ${progress.kind === 'failed' ? 'error' : 'primary'} col`} style={{ alignItems: 'stretch' }} role="status">
          <span>{firmwareProgressText(progress)}</span>
          {progress.kind === 'downloading' && progress.percent !== null && <span className="progress"><span style={{ width: `${progress.percent}%`, background: 'var(--primary)' }} /></span>}
        </div>
      )}
      {check?.kind === 'available' && !running && (
        <>
          <p className="muted small">The update is downloaded from your server and installed by the robot. It needs the robot on its dock with at least {FIRMWARE_MIN_BATTERY}% battery, and it restarts when it is done.</p>
          {blocker && <span className="error-text small">{blocker}</span>}
          <button type="button" className="btn" disabled={blocker !== null || actions.busy} onClick={() => setConfirm(true)}>Update now</button>
        </>
      )}
      {check !== null && check.kind !== 'checking' && !running && (
        <button type="button" className="btn secondary sm" onClick={() => void actions.read('checkFirmware')}>Check again</button>
      )}
      {confirm && (
        <ConfirmDialog
          title="Update the firmware?"
          text="The robot will download the update, install it and restart. It is unavailable for a few minutes. Keep it on its dock and do not turn it off."
          confirm="Update"
          onConfirm={() => void actions.run('startFirmwareUpdate')}
          onClose={() => setConfirm(false)}
        />
      )}
    </div>
  );
}

function sectionHas(snap: VacuumSnapshot, section: FeatureSection): boolean {
  return snap.features.some((f) => featureDef(f.id)?.section === section);
}

function sectionShown(snap: VacuumSnapshot, id: string): boolean {
  if (id === 'voice') return isVoiceAssistantSupported(snap.newFeatureSet);
  if (id === 'floor') return sectionHas(snap, 'FLOOR');
  if (id === 'obstacle') return sectionHas(snap, 'OBSTACLE');
  if (id === 'beta') return sectionHas(snap, 'BETA') || snap.unlistedFeatures.length > 0;
  return true;
}

/** The robot options on one settings section: a switch, or a picker for options with more than two values. */
function FeatureRows({ snap, actions, section }: { snap: VacuumSnapshot; actions: Actions; section: FeatureSection }) {
  const rows = snap.features.flatMap((f) => {
    const d = featureDef(f.id);
    return d && d.section === section ? [{ d, value: f.value }] : [];
  });
  return (
    <>
      {rows.map(({ d, value }) => d.choices ? (
        <SettingRow key={d.id} title={d.title} sub={(value !== null ? d.choices.find((c) => c.value === value)?.description : undefined) ?? d.description}>
          <Select
            label={d.title}
            options={[...d.choices.map((c): [number, string] => [c.value, c.label]), ...(value !== null && !d.choices.some((c) => c.value === value) ? [[value, choiceLabelFor(d.choices, value)] as [number, string]] : [])]}
            value={value}
            disabled={actions.busy}
            onChange={(v) => void actions.run('setFeature', { id: d.id, value: v })}
          />
        </SettingRow>
      ) : (
        <SettingRow key={d.id} title={d.title} sub={d.description}>
          <Switch label={d.title} checked={featureEnabled(d, value)} disabled={actions.busy} onChange={(on) => void actions.run('setFeature', { id: d.id, value: on ? 1 : 0 })} />
        </SettingRow>
      ))}
    </>
  );
}

function DockSettingsPanel({ snap, actions }: { snap: VacuumSnapshot; actions: Actions }) {
  const { run, busy } = actions;
  const [confirmEmpty, setConfirmEmpty] = useState(false);
  const caps = useMemo(() => new DockCapabilities(snap.model, snap.featureSet, snap.newFeatureSet), [snap.model, snap.featureSet, snap.newFeatureSet]);
  const d = snap.dockSettings;
  const { dockType, dockStatus } = snap.status;
  const dockKnown = dockType !== undefined && dockType !== 0;
  const freqOptions = caps.washFrequencyOptions;
  const freqIndex = freqOptions.findIndex((o) => d.smartWash !== null && o.mode === d.smartWash.mode && (o.mode !== 0 || (o.intervalMinutes ?? 0) * 60 === d.smartWash.intervalSeconds));
  const washModes = caps.washModes(dockType, dockStatus);
  const washCode = caps.washModeCode(d.washMode, dockType);
  const emptyModes = caps.autoEmptyModes;
  const dockedAndIdle = isDockedAndIdle(snap.status);
  return (
    <div className="setting-list">
      <SettingRow title="Mop wash frequency" sub={washFrequencyLabel(d.smartWash)}>
        <Select
          label="Mop wash frequency"
          options={freqOptions.map((o, i): [number, string] => [i, o.label])}
          value={freqIndex}
          disabled={busy || !dockKnown || d.smartWash === null}
          onChange={(i) => { const o = freqOptions[i]; if (o) void run('setWashFrequency', { mode: o.mode, intervalMinutes: o.intervalMinutes }); }}
        />
      </SettingRow>
      <SettingRow title="Washing mode" sub={caps.washModeLabel(d.washMode, dockType)}>
        <Select label="Washing mode" options={washModes} value={washCode} disabled={busy || !dockKnown || d.washMode === null} onChange={(v) => void run('setWashMode', { mode: v })} />
      </SettingRow>
      {d.washWaterTemperature !== null && (
        <SettingRow title="Washing water temperature" sub={labelFor(WASH_WATER_TEMPERATURES, d.washWaterTemperature)}>
          <Select label="Washing water temperature" options={WASH_WATER_TEMPERATURES} value={d.washWaterTemperature} disabled={busy} onChange={(v) => void run('setWashWaterTemperature', { value: v })} />
        </SettingRow>
      )}
      {d.mopDrying !== null && (
        <SettingRow title="Mop drying" sub={d.mopDrying ? 'Dries the mops on the dock after cleaning.' : 'Mops are left wet on the dock.'}>
          <Switch label="Mop drying" checked={d.mopDrying} disabled={busy} onChange={(v) => void run('setMopDrying', { enabled: v })} />
        </SettingRow>
      )}
      {d.mopDrying !== null && d.dryTimeSeconds !== null && (
        <SettingRow title="Drying time" sub={dryTimeLabel(d.dryTimeSeconds)}>
          <Select label="Drying time" options={caps.dryTimeOptions(d.dryTimeSeconds)} value={d.dryTimeSeconds} disabled={busy} onChange={(v) => void run('setDryTime', { seconds: v })} />
        </SettingRow>
      )}
      <SettingRow title="Auto-empty mode" sub={emptyModes.length ? caps.autoEmptyModeLabel(d.autoEmptyMode) : 'Not offered on this robot.'}>
        <Select label="Auto-empty mode" options={emptyModes} value={d.autoEmptyMode} disabled={busy || d.autoEmptyMode === null || emptyModes.length === 0} onChange={(v) => void run('setAutoEmptyMode', { mode: v })} />
      </SettingRow>
      {snap.valley && (
        <TimeWindow
          title="Off-peak electricity"
          on={(a, b) => `The robot charges and dries only between ${a} and ${b}.`}
          off="The robot charges whenever it needs to."
          value={snap.valley}
          busy={busy}
          onEnable={(w) => void run('setValley', w)}
          onDisable={() => void run('disableValley')}
        />
      )}
      <SettingRow title="Internal water tank" sub={dockedAndIdle ? 'Empty the robot\'s built-in water tank through the dock.' : 'Dock the robot and let it finish its task to empty its water tank.'}>
        <button type="button" className="btn secondary sm" disabled={busy || !dockedAndIdle} onClick={() => setConfirmEmpty(true)}>Empty</button>
      </SettingRow>
      <FeatureRows snap={snap} actions={actions} section="DOCK" />
      {confirmEmpty && (
        <ConfirmDialog
          title="Empty the water tank?"
          text="The dock pumps the water out of the robot's built-in tank. The robot stays on the dock while it does."
          confirm="Empty"
          onConfirm={() => void run('emptyInbuiltWaterTank', {}, 'Emptying the water tank')}
          onClose={() => setConfirmEmpty(false)}
        />
      )}
    </div>
  );
}

interface Window { enabled: boolean; startHour: number; startMinute: number; endHour: number; endMinute: number }

const clock = (h: number, m: number) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;

function parseClock(v: string): [number, number] | null {
  const m = /^(\d{2}):(\d{2})$/.exec(v);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/** A switch and a from/until pair, for Do Not Disturb and the off-peak window. */
function TimeWindow({ title, on, off, value, busy, onEnable, onDisable }: {
  title: string;
  on: (from: string, until: string) => string;
  off: string;
  value: Window;
  busy: boolean;
  onEnable: (w: Omit<Window, 'enabled'>) => void;
  onDisable: () => void;
}) {
  const [draft, setDraft] = useState(value);
  const key = JSON.stringify(value);
  useEffect(() => setDraft(value), [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const commit = (next: Window) => {
    setDraft(next);
    if (next.enabled) onEnable({ startHour: next.startHour, startMinute: next.startMinute, endHour: next.endHour, endMinute: next.endMinute });
    else onDisable();
  };
  return (
    <>
      <SettingRow title={title} sub={draft.enabled ? on(clock(draft.startHour, draft.startMinute), clock(draft.endHour, draft.endMinute)) : off}>
        <Switch label={title} checked={draft.enabled} disabled={busy} onChange={(v) => commit({ ...draft, enabled: v })} />
      </SettingRow>
      {draft.enabled && (
        <SettingRow title="From / until">
          <span className="row">
            <input className="input" type="time" aria-label={`${title} start`} value={clock(draft.startHour, draft.startMinute)} onChange={(e) => {
              const t = parseClock(e.target.value);
              if (t) commit({ ...draft, startHour: t[0], startMinute: t[1] });
            }} />
            <span className="muted">to</span>
            <input className="input" type="time" aria-label={`${title} end`} value={clock(draft.endHour, draft.endMinute)} onChange={(e) => {
              const t = parseClock(e.target.value);
              if (t) commit({ ...draft, endHour: t[0], endMinute: t[1] });
            }} />
          </span>
        </SettingRow>
      )}
    </>
  );
}

function DndSettings({ snap, actions }: { snap: VacuumSnapshot; actions: Actions }) {
  const d = snap.dnd ?? { enabled: false, startHour: 22, startMinute: 0, endHour: 8, endMinute: 0 };
  return (
    <div className="setting-list">
      <TimeWindow
        title="Quiet hours"
        on={(a, b) => `The robot won't start cleaning between ${a} and ${b}.`}
        off="The robot cleans at any time."
        value={d}
        busy={actions.busy}
        onEnable={(w) => void actions.run('setDnd', w)}
        onDisable={() => void actions.run('disableDnd')}
      />
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
