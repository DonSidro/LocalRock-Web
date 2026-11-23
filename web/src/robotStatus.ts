import { State, describeError, describeState } from '../../shared/codes';
import type { VacuumSnapshot } from '../../shared/api';

/* How a robot's state reads in the page: one line of text and a colour. */

export const ACTIVE_CLEANING = new Set<number>([State.CLEANING, State.SEGMENT_CLEANING, State.ZONED_CLEANING, State.SPOT_CLEANING]);
const RESTING = new Set<number>([State.IDLE, State.NOT_CHARGING, State.CHARGING, State.CHARGER_DISCONNECTED, State.SHUTTING_DOWN]);

export interface StatusLine {
  text: string;
  color: string;
  /** Doing something right now; the page shows a pulse. */
  active: boolean;
  error: boolean;
}

export function statusLine(snap: VacuumSnapshot): StatusLine {
  const s = snap.status;
  const errorCode = s.errorCode ?? 0;
  const drying = s.dryStatus === 1 || s.state === State.DRYING_MOP;
  const active = drying || (s.state !== undefined && !RESTING.has(s.state));
  if (errorCode !== 0) return { text: describeError(errorCode), color: 'var(--error)', active: false, error: true };
  if (drying) return { text: dryingLabel(s.remainingDryTimeSec), color: 'var(--tertiary)', active: true, error: false };
  if (s.state === undefined) return { text: 'Waiting for status', color: 'var(--on-surface-variant)', active: false, error: false };
  return { text: describeState(s.state), color: active ? stateTint(s.state) : 'var(--on-surface)', active, error: false };
}

function dryingLabel(sec: number | undefined): string {
  if (!sec || sec <= 0) return 'Drying mop';
  const m = Math.floor(sec / 60);
  return `Drying mop · ${m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`} left`;
}

function stateTint(state: number | undefined): string {
  switch (state) {
    case State.WASHING_MOP: case State.WASHING_MOP_ALT: case State.GOING_TO_WASH_MOP: case State.DRYING_MOP:
      return 'var(--tertiary)';
    case State.ERROR: case State.CHARGING_ERROR:
      return 'var(--error)';
    default:
      return 'var(--primary)';
  }
}

export function batteryColor(battery: number | undefined): string {
  return battery === undefined ? 'var(--on-surface-variant)' : battery <= 15 ? 'var(--error)' : battery <= 40 ? 'var(--warn)' : 'var(--good)';
}

export function isCharging(snap: VacuumSnapshot): boolean {
  return snap.status.chargeStatus === 1 || snap.status.state === State.CHARGING;
}

/** What the main button does now: start a full clean, pause, or resume. */
export function primaryAction(snap: VacuumSnapshot): 'clean' | 'pause' | 'resume' {
  const st = snap.status.state;
  if (st !== undefined && ACTIVE_CLEANING.has(st)) return 'pause';
  if (st === State.PAUSED) return 'resume';
  return 'clean';
}
