import { useEffect, useState } from 'react';
import type { CleanTimer, Routine } from '../../../shared/api';
import { Icon } from '../icons';
import { call } from '../api';
import { toast, useVacuum } from '../store';
import { ConfirmDialog, Dialog, Empty, Field, IconButton, Panel, Spinner, Switch } from '../ui';
import { useRobotActions } from '../useRobot';

/* Recurring cleans, from LocalRock's ScheduleScreen.kt (get_timer / set_timer / upd_timer / del_timer). */

const DAY_SHORT = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** Monday first in the day picker. */
const WEEK = [1, 2, 3, 4, 5, 6, 0];

function formatDays(days: number[]): string {
  if (days.length === 0 || days.length === 7) return 'Every day';
  const key = [...days].sort().join(',');
  if (key === '1,2,3,4,5') return 'Weekdays';
  if (key === '0,6') return 'Weekends';
  return [...days].sort().map((d) => DAY_NAMES[d] ?? String(d)).join(', ');
}

function formatTime(h: number, m: number): string {
  return new Date(2000, 0, 1, h, m).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/** Routines saved with the official app and kept by the server, which runs their steps itself. */
function Routines({ duid }: { duid: string }) {
  const { run, busy } = useRobotActions(duid);
  const [state, setState] = useState<{ loading: boolean; list: Routine[] | null; error: string | null }>({ loading: true, list: null, error: null });
  const load = async () => {
    setState((s) => ({ ...s, loading: true }));
    try {
      setState({ loading: false, list: await call<Routine[]>(duid, 'fetchRoutines'), error: null });
    } catch (e) {
      setState({ loading: false, list: null, error: (e as Error).message });
    }
  };
  useEffect(() => { void load(); }, [duid]); // eslint-disable-line react-hooks/exhaustive-deps
  const runRoutine = async (r: Routine) => {
    const message = await run<string>('runRoutine', { id: r.id, name: r.name });
    if (message) toast(message);
  };
  return (
    <>
      <div className="tab-page-head">
        <h2 className="grow">Routines</h2>
        <button type="button" className="btn secondary sm" disabled={state.loading} onClick={() => void load()}>{state.loading ? <span className="spinner" /> : <Icon name="refresh" />}Refresh</button>
      </div>
      {state.error ? (
        <Empty icon="warning" title="Routines unavailable" text={state.error}>
          <button type="button" className="btn secondary" onClick={() => void load()}>Retry</button>
        </Empty>
      ) : !state.list ? (
        <div className="empty"><Spinner big /></div>
      ) : state.list.length === 0 ? (
        <Empty icon="schedule" title="No routines" text="Routines made in the Roborock app and kept by your server show up here." />
      ) : (
        <Panel>
          <table className="table">
            <tbody>
              {state.list.map((r) => (
                <tr key={r.id} className={r.enabled ? '' : 'muted-row'}>
                  <td className="strong">{r.name}</td>
                  <td style={{ textAlign: 'right' }}>
                    <button type="button" className="btn secondary sm" disabled={busy || !r.enabled} onClick={() => void runRoutine(r)}>
                      <Icon name="play" />Run
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted small">The server runs each step. Run a routine that is going again to stop it.</p>
        </Panel>
      )}
    </>
  );
}

export function ScheduleTab({ duid }: { duid: string }) {
  const { snap } = useVacuum(duid);
  const { run, busy } = useRobotActions(duid);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<CleanTimer | null>(null);

  useEffect(() => {
    void run('fetchTimers').finally(() => setLoading(false));
  }, [run]);

  const timers = [...(snap?.timers ?? [])].sort((a, b) => a.hour * 60 + a.minute - (b.hour * 60 + b.minute));
  return (
    <div className="tab-page">
      <div className="tab-page-head">
        <h2 className="grow">Schedule</h2>
        <button type="button" className="btn" onClick={() => setAdding(true)}><Icon name="add" />Add schedule</button>
      </div>
      {timers.length === 0 ? (
        loading ? <div className="empty"><Spinner big /></div> : <Empty icon="schedule" title="No schedules yet" text="Add a recurring clean and the robot starts it by itself." />
      ) : (
        <Panel>
          <table className="table">
            <thead>
              <tr><th>Time</th><th>Repeats</th><th>On</th><th /></tr>
            </thead>
            <tbody>
              {timers.map((t) => (
                <tr key={t.id} className={t.enabled ? '' : 'muted-row'}>
                  <td className="strong" style={{ fontSize: 15 }}>{formatTime(t.hour, t.minute)}</td>
                  <td>{formatDays(t.weekdays)}</td>
                  <td style={{ width: 80 }}><Switch label={`Schedule at ${formatTime(t.hour, t.minute)} on`} checked={t.enabled} disabled={busy} onChange={() => void run('toggleTimer', { id: t.id })} /></td>
                  <td style={{ width: 56, textAlign: 'right' }}><IconButton icon="delete" label="Delete schedule" disabled={busy} onClick={() => setDeleting(t)} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}
      <Routines duid={duid} />
      {adding && <AddTimerDialog onClose={() => setAdding(false)} onAdd={(hour, minute, weekdays) => void run('createTimer', { hour, minute, weekdays }, 'Schedule added')} />}
      {deleting && (
        <ConfirmDialog
          title="Delete schedule?"
          text={`${formatTime(deleting.hour, deleting.minute)}, ${formatDays(deleting.weekdays)}`}
          confirm="Delete"
          danger
          onConfirm={() => void run('deleteTimer', { id: deleting.id })}
          onClose={() => setDeleting(null)}
        />
      )}
    </div>
  );
}

function AddTimerDialog({ onAdd, onClose }: { onAdd: (h: number, m: number, days: number[]) => void; onClose: () => void }) {
  const [time, setTime] = useState('08:00');
  const [days, setDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const parsed = /^(\d{2}):(\d{2})$/.exec(time);
  const save = () => { if (parsed) { onClose(); onAdd(Number(parsed[1]), Number(parsed[2]), days); } };
  return (
    <Dialog
      title="New schedule"
      onClose={onClose}
      actions={(
        <>
          <button type="button" className="btn secondary" onClick={onClose}>Cancel</button>
          <button type="button" className="btn" disabled={!parsed} onClick={save}>Add</button>
        </>
      )}
    >
      <Field label="Time">
        <input className="input" type="time" autoFocus value={time} onChange={(e) => setTime(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') save(); }} />
      </Field>
      <div className="col tight">
        <span className="field-label">Days <span className="muted">(none picked means every day)</span></span>
        <div className="day-picker" role="group" aria-label="Days">
          {WEEK.map((i) => {
            const on = days.includes(i);
            return (
              <button key={i} type="button" aria-pressed={on} aria-label={DAY_NAMES[i]} onClick={() => setDays((d) => (on ? d.filter((x) => x !== i) : [...d, i]))}>
                {DAY_SHORT[i]}
              </button>
            );
          })}
        </div>
        <div className="row" style={{ gap: 4 }}>
          <button type="button" className="btn ghost sm" onClick={() => setDays([1, 2, 3, 4, 5])}>Weekdays</button>
          <button type="button" className="btn ghost sm" onClick={() => setDays([0, 6])}>Weekends</button>
          <button type="button" className="btn ghost sm" onClick={() => setDays([])}>Every day</button>
        </div>
      </div>
    </Dialog>
  );
}
