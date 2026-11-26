import {
  DRIVE_DIRECTIONS, DRIVE_IDLE_STATES, DRIVE_MANUAL_STATES, cameraCleaningCommand, cameraCommandLabel, isAck,
  type CameraCleaningAction, type DriveDirection,
} from '../../../shared/camera';
import { State, describeState } from '../../../shared/codes';
import { call } from '../api';

/*
 * The live view's robot controls, ported from LocalRock's CameraMotionController.kt: hold a direction
 * to drive, Go to a point on the map, dock, pause and resume. One viewer owns the manual session and
 * runs one operation at a time. A failed motion command is never replayed automatically.
 */

class MotionFailure extends Error {}
class MotionRefused extends MotionFailure {}

type Status = Record<string, unknown>;
const num = (s: Status, k: string) => (typeof s[k] === 'number' ? (s[k] as number) : null);

export interface MotionState { busy: boolean; progress: string | null; error: string | null; manual: boolean; startedActivity: boolean }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class MotionController {
  state: MotionState = { busy: false, progress: null, error: null, manual: false, startedActivity: false };
  private holding = false;
  private releaseRequested = false;
  private navigationRequested = false;
  private sequence = 0;
  private op: Promise<void> | null = null;
  private disposed = false;

  constructor(private readonly duid: string, private readonly ready: () => boolean, private readonly onChange: () => void, private readonly allowed: boolean) {}

  private set(patch: Partial<MotionState>) { this.state = { ...this.state, ...patch }; this.onChange(); }

  private report(e: unknown) {
    const message = e instanceof MotionFailure ? e.message : 'Robot control was not confirmed. Check the robot before trying again.';
    const prev = this.state.error;
    this.set({ error: prev && !prev.includes(message) ? `${prev} ${message}` : prev ?? message });
  }

  private async command(method: string, params: unknown[] = []): Promise<unknown> {
    const label = cameraCommandLabel(method);
    let resp: { result: unknown; error: { code?: number } | null };
    try {
      resp = await call(this.duid, 'cameraControl', { method, params });
    } catch {
      throw new MotionFailure(`${label} could not be sent or confirmed. Check the connection and try again.`);
    }
    if (resp.error) {
      // No raw replies or parameters are shown.
      throw new MotionRefused(`${label} was refused by the robot${typeof resp.error.code === 'number' ? ` (code ${resp.error.code})` : ''}.`);
    }
    return resp.result;
  }

  private async ack(method: string, params: unknown[] = []): Promise<void> {
    if (!isAck(await this.command(method, params))) throw new MotionFailure(`${cameraCommandLabel(method)} returned an unrecognized reply. Check the robot before trying again.`);
  }

  private async readStatus(): Promise<Status> {
    const r = await this.command('get_status');
    const v = Array.isArray(r) ? (r.length === 1 ? r[0] : null) : r;
    if (typeof v !== 'object' || v === null) throw new MotionFailure('Robot status is unavailable (get_status). Try again once status updates.');
    return v as Status;
  }

  private requireReady() { if (!this.ready()) throw new MotionFailure('Video disconnected. Reconnect before driving.'); }

  private requireNoTask(s: Status) {
    const err = num(s, 'error_code');
    if (err === null) throw new MotionFailure('Robot error status is unavailable (get_status). Try again once status updates.');
    if (err !== 0) throw new MotionFailure(`Robot reports error ${err}. Resolve it before driving.`);
    const cleaning = num(s, 'in_cleaning');
    if (cleaning === null) throw new MotionFailure('Robot task status is unavailable (get_status). Try again once status updates.');
    if (cleaning !== 0) throw new MotionFailure(`A cleaning task is still active (${describeState(num(s, 'state') ?? -1)}). Finish it before driving.`);
  }

  private stateFailure(s: Status): MotionFailure {
    const st = num(s, 'state');
    if (st !== null && DRIVE_MANUAL_STATES.has(st)) return new MotionFailure('Another manual-control session is active. Close it and wait for the robot to become idle.');
    if (st === State.GOING_TO_TARGET) return new MotionFailure("The robot is going to a target outside this viewer's control. Let it finish before driving.");
    return new MotionFailure(`The robot is ${describeState(st ?? -1).toLowerCase()}. Wait for it to become idle before driving.`);
  }

  private requireIdleStatus(s: Status) {
    const st = num(s, 'state') ?? -1;
    if (!DRIVE_IDLE_STATES.has(st) && !(this.state.manual && DRIVE_MANUAL_STATES.has(st))) throw this.stateFailure(s);
  }

  private async waitFor(label: string, accepted: Set<number>, pending: Set<number>): Promise<Status> {
    const end = Date.now() + 5_000;
    let s = await this.readStatus();
    for (;;) {
      this.requireReady();
      this.requireNoTask(s);
      const st = num(s, 'state') ?? -1;
      if (accepted.has(st)) return s;
      if (!pending.has(st)) throw this.stateFailure(s);
      if (Date.now() > end) throw new MotionFailure(`${label} timed out. Check the robot before trying again.`);
      await sleep(100);
      s = await this.readStatus();
    }
  }

  private run(action: () => Promise<void>): void {
    if (this.disposed || this.op || !this.allowed) return;
    this.set({ busy: true, error: null });
    this.op = (async () => {
      try { await action(); } catch (e) { this.report(e); } finally {
        this.op = null;
        this.holding = false;
        this.set({ busy: false, progress: null });
      }
    })();
  }

  /** Drive while held: checks the robot, takes over only this viewer's own Go, then moves every 200 ms. */
  hold(direction: DriveDirection): void {
    if (this.op) return;
    this.holding = true;
    this.releaseRequested = false;
    this.run(async () => {
      let entered = false, failed = false;
      try {
        this.requireReady();
        this.set({ progress: 'Checking robot...' });
        let s = await this.readStatus();
        this.requireNoTask(s);
        if (num(s, 'state') === State.GOING_TO_TARGET && this.navigationRequested) {
          this.set({ progress: 'Stopping Pin-and-Go...' });
          await this.ack('stop_goto_target');
          this.set({ progress: 'Waiting for the robot to stop...' });
          s = await this.waitFor('Waiting for Pin-and-Go to stop', new Set([...DRIVE_IDLE_STATES, ...(this.state.manual ? DRIVE_MANUAL_STATES : [])]), new Set([State.GOING_TO_TARGET]));
        }
        this.requireIdleStatus(s);
        this.navigationRequested = false;
        if (this.releaseRequested) return;
        if (!this.state.manual || !DRIVE_MANUAL_STATES.has(num(s, 'state') ?? -1)) {
          this.set({ progress: 'Starting manual control...', manual: true });
          this.sequence = 0;
          try { await this.ack('app_rc_start'); } catch (e) { if (e instanceof MotionRefused) this.set({ manual: false }); throw e; }
        }
        if (this.releaseRequested) return;
        this.set({ progress: 'Waiting for manual control...' });
        await this.waitFor('Waiting for manual control', new Set(DRIVE_MANUAL_STATES), new Set(DRIVE_IDLE_STATES));
        entered = true;
        this.set({ progress: null });
        const d = DRIVE_DIRECTIONS[direction];
        while (!this.releaseRequested && !this.disposed) {
          this.requireReady();
          this.set({ startedActivity: true });
          await this.ack('app_rc_move', [{ velocity: d.velocity, omega: d.omega, duration: 1500, seqnum: ++this.sequence }]);
          await sleep(200);
        }
      } catch (e) {
        failed = true;
        throw e;
      } finally {
        if (this.state.manual) {
          let stopped = true;
          try { await this.ack('app_rc_stop'); } catch (e) { stopped = false; this.report(e); }
          // A normal release keeps the manual session and its sequence numbers, as the official app does.
          if (!entered || failed || !stopped || !this.ready()) await this.endManual();
        }
      }
    });
  }

  /** Letting go stops motion; leaving the viewer ends the manual session separately. */
  release(): void { if (this.holding) this.releaseRequested = true; }

  cleaning(action: CameraCleaningAction): void {
    this.run(async () => {
      if (this.state.manual) {
        if (!(await this.endManual())) return;
        const end = Date.now() + 5_000;
        while (DRIVE_MANUAL_STATES.has(num(await this.readStatus(), 'state') ?? -1)) {
          if (Date.now() > end) throw new MotionFailure('Waiting for manual control to end timed out. Check the robot before trying again.');
          await sleep(100);
        }
      }
      const s = await this.readStatus();
      const method = cameraCleaningCommand(action, num(s, 'state'), num(s, 'in_cleaning'), num(s, 'error_code'));
      if (!method) throw new MotionFailure("The robot's cleaning state changed. Check it and try again.");
      if (action === 'START') this.set({ startedActivity: true });
      await this.ack(method);
    });
  }

  /** Pin-and-Go: works before frames arrive, so a docked robot can be sent off the dock. */
  goTo(x: number, y: number, floor: number): void {
    this.run(async () => {
      const s = await this.readStatus();
      this.requireNoTask(s);
      this.requireIdleStatus(s);
      const ms = num(s, 'map_status');
      if (ms === null || ms >> 2 !== floor) throw new MotionFailure("The robot's floor changed. Open its current map and choose the target again.");
      this.navigationRequested = true;
      this.set({ startedActivity: true });
      try { await this.ack('app_goto_target', [Math.round(x), Math.round(y)]); } catch (e) { if (e instanceof MotionRefused) this.navigationRequested = false; throw e; }
    });
  }

  /** Stops driving, this viewer's Go, or a return to dock. */
  stop(includeDock = true): void {
    this.run(async () => {
      await this.stopNavigation(includeDock);
      await this.endManual();
    });
  }

  /** Ends video with the robot returned to its dock, or just stops what this viewer started. */
  async endViewing(returnToDock: boolean): Promise<void> {
    if (!this.allowed) return;
    while (this.op) { this.releaseRequested = true; await this.op; }
    this.set({ busy: true, error: null });
    try {
      if (returnToDock) {
        const s = await this.readStatus();
        if (num(s, 'error_code') !== 0) throw new MotionFailure('The robot reports an error. Resolve it before sending it to the dock.');
        const st = num(s, 'state') ?? -1;
        if (![2, 3, 4, 5, 6, 7, 8, 10, 11, 15, 16, 17, 18, 24, 100].includes(st)) throw this.stateFailure(s);
        if (![6, 8, 15, 100].includes(st)) await this.ack('app_charge');
        this.navigationRequested = false;
      } else if (!(await this.stopNavigation(false))) return;
      if (!(await this.endManual())) return;
      this.set({ startedActivity: false });
    } catch (e) {
      this.report(e);
    } finally {
      this.set({ busy: false, progress: null });
    }
  }

  private async endManual(): Promise<boolean> {
    if (!this.state.manual) return true;
    try {
      await this.ack('app_rc_end');
      this.set({ manual: false });
      return true;
    } catch (e) {
      this.report(e);
      return false;
    }
  }

  private async stopNavigation(includeDock: boolean): Promise<boolean> {
    if (!this.navigationRequested && !includeDock) return true;
    try {
      const s = await this.readStatus();
      // A finished Go must never stop a cleaning task started later.
      const st = num(s, 'state');
      if (num(s, 'in_cleaning') === 0) {
        if (this.navigationRequested && st === State.GOING_TO_TARGET) await this.ack('stop_goto_target');
        else if (includeDock && (st === State.RETURNING_HOME || st === State.DOCKING)) await this.ack('app_stop');
      }
      this.navigationRequested = false;
      return true;
    } catch (e) {
      this.report(e);
      return false;
    }
  }

  /** Leaving the screen: stop a held drive and this viewer's Go and end manual control; a return to dock continues. */
  dispose(): void {
    if (this.disposed) return;
    this.releaseRequested = true;
    const pending = this.op;
    void (async () => {
      await pending;
      this.disposed = true;
      if (!this.allowed) return;
      await this.stopNavigation(false);
      await this.endManual();
    })();
  }
}
