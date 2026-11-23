/*
 * Firmware updates through the local server (local_roborock_server #255), ported from LocalRock's
 * Firmware.kt and the watch in VacuumViewModel. The server asks Roborock's cloud on the robot's behalf;
 * the robot downloads from the server and installs.
 */

/** What the page shows while an install runs. */
export type FirmwareProgress =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | { kind: 'downloading'; percent: number | null }
  | { kind: 'installing' }
  /** The robot dropped off while it reboots; it comes back about a minute later. */
  | { kind: 'restarting' }
  | { kind: 'done'; version: string | null }
  | { kind: 'failed'; reason: string };

export const firmwareRunning = (p: FirmwareProgress) => p.kind === 'starting' || p.kind === 'downloading' || p.kind === 'installing' || p.kind === 'restarting';

/** The result of the last update check. */
export type FirmwareCheck =
  | { kind: 'checking' }
  | { kind: 'upToDate'; current: string | null }
  | { kind: 'available'; current: string | null; latest: string | null; notes: string | null; force: boolean }
  | { kind: 'unavailable'; reason: string };

export const FIRMWARE_MIN_BATTERY = 20;
/** Idle answers in a row, after the robot worked, that end the watch (the server waits the same way). */
export const FIRMWARE_IDLE_POLLS = 3;

/**
 * Why an install should not start now, or null when it may. The same rule the server applies, so the
 * page explains it up front instead of the server refusing afterwards.
 */
export function firmwareInstallBlocker(state?: number, battery?: number, chargeStatus?: number, inCleaning?: number, errorCode?: number): string | null {
  if (state === undefined || battery === undefined) return 'The robot has not reported its status yet.';
  // Charging (8), fully charged (100), or asleep on the charger (state 2 with charge_status 1).
  const docked = state === 8 || state === 100 || (state === 2 && chargeStatus === 1);
  if (!docked) return 'Put the robot on its dock first. It has to be charging or resting on the charger.';
  if ((inCleaning ?? 0) !== 0) return 'The robot is cleaning. Wait until it has finished.';
  if ((errorCode ?? 0) !== 0) return 'The robot reports an error. Clear it before updating.';
  if (battery < FIRMWARE_MIN_BATTERY) return `Charge the robot to at least ${FIRMWARE_MIN_BATTERY}% first (it is at ${battery}%).`;
  return null;
}

/** Done only when the robot reports the target (or, with no target known, a version other than `before`); otherwise a failure. */
export function firmwareOutcome(before: string | null, target: string | null, after: string | null): FirmwareProgress {
  if (after === null) return { kind: 'failed', reason: "The update finished, but the robot's firmware version could not be read to confirm it." };
  const applied = target !== null ? after === target : before !== null && after !== before;
  if (applied) return { kind: 'done', version: after };
  return { kind: 'failed', reason: `The robot still reports firmware ${after}${target !== null ? `, not ${target}` : ''}. The update was rolled back or did not apply.` };
}

export interface FirmwareStep { progress: FirmwareProgress; seenWorking: boolean; finished: boolean; idleStreak: number }

/** One look at the robot's OTA state, turned into what to show next. seenWorking stays true once it has left idle. */
export function nextFirmwareStep(previous: FirmwareProgress, seenWorking: boolean, answered: boolean, otaState: string | null, percent: number | null, idleStreak = 0): FirmwareStep {
  const step = (progress: FirmwareProgress, seen: boolean, finished = false, idle = 0): FirmwareStep => ({ progress, seenWorking: seen, finished, idleStreak: idle });
  // Silence after the robot started working is the reboot; before that it says nothing yet.
  if (!answered) return seenWorking ? step({ kind: 'restarting' }, true) : step(previous, false);
  switch (otaState) {
    case 'downloading': return step({ kind: 'downloading', percent: percent !== null && percent >= 0 && percent <= 100 ? percent : null }, true);
    case 'installing': case 'wait_install': return step({ kind: 'installing' }, true);
    case 'failed': return step({ kind: 'failed', reason: 'The robot reported that the update failed.' }, seenWorking, true);
    // A single idle can sit between download and install, so only a run of them means the robot is done.
    case 'idle': return !seenWorking ? step(previous, false) : step(previous, true, idleStreak + 1 >= FIRMWARE_IDLE_POLLS, idleStreak + 1);
    default: return step(previous, seenWorking);
  }
}

/** The text shown for each stage of an install. */
export function firmwareProgressText(p: FirmwareProgress): string {
  switch (p.kind) {
    case 'idle': return '';
    case 'starting': return 'Asking the server to start the update...';
    case 'downloading': return p.percent !== null ? `Downloading the update: ${p.percent}%` : 'Downloading the update...';
    case 'installing': return 'Installing. This takes a few minutes and the robot will restart.';
    case 'restarting': return 'The robot is restarting. It will be back in about a minute.';
    case 'done': return p.version ? `Updated. The robot now runs ${p.version}.` : 'The update finished.';
    case 'failed': return p.reason;
  }
}

/** A server without install support answers HTTP 404 (older) or code 501 in the body (install option off). */
export function firmwareStartRefusal(status: number): string {
  return status === 404 || status === 501
    ? "This server cannot install firmware. Turn on the server's firmware install option (enable_install), then try again."
    : `The server did not accept the update request (HTTP ${status})`;
}
