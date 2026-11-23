import { describe, expect, it } from 'vitest';
import { firmwareInstallBlocker, firmwareOutcome, firmwareStartRefusal, nextFirmwareStep, type FirmwareProgress } from '../shared/firmware.js';
import { parseOtaProgress, parseOtaState } from '../server/vacuum/commands.js';

/* Cases copied from LocalRock's FirmwareTest. */

/** Runs a sequence of OTA answers (null = no answer) through the watch, as the server does. */
function watch(...states: Array<string | null>) {
  let progress: FirmwareProgress = { kind: 'starting' };
  let seen = false;
  let idle = 0;
  let step = nextFirmwareStep(progress, seen, true, 'idle', null, 0);
  for (const s of states) {
    step = nextFirmwareStep(progress, seen, s !== null, s, s === 'downloading' ? 40 : null, idle);
    progress = step.progress;
    seen = step.seenWorking;
    idle = step.idleStreak;
    if (step.finished) break;
  }
  return step;
}

describe('firmware', () => {
  it('reads the OTA answers', () => {
    expect(parseOtaState({ ota_state: 'downloading' })).toBe('downloading');
    expect(parseOtaState([{ ota_state: 'idle' }])).toBe('idle');
    expect(parseOtaProgress({ ota_progress: 42 })).toBe(42);
    expect(parseOtaState(null)).toBeNull();
  });

  it('needs the robot docked, idle, without an error and with 20% battery', () => {
    expect(firmwareInstallBlocker(2, 100, 1, 0, 0)).toBeNull();
    expect(firmwareInstallBlocker(8, 90, 1, 0, 0)).toBeNull();
    expect(firmwareInstallBlocker(2, 100, 0, 0, 0)).not.toBeNull();
    expect(firmwareInstallBlocker(5, 100, 0, 1, 0)).not.toBeNull();
    expect(firmwareInstallBlocker(8, 19, 1, 0, 0)).toContain('20%');
    expect(firmwareInstallBlocker(8, 20, 1, 0, 0)).toBeNull();
    expect(firmwareInstallBlocker(8, 100, 1, 0, 12)).not.toBeNull();
    expect(firmwareInstallBlocker()).not.toBeNull();
  });

  it('follows download, install and the reboot, and needs a run of idles to finish', () => {
    const first = nextFirmwareStep({ kind: 'starting' }, false, true, 'idle', null);
    expect(first.progress).toEqual({ kind: 'starting' });
    expect(first.finished).toBe(false);
    expect(nextFirmwareStep({ kind: 'starting' }, false, true, 'downloading', 40).progress).toEqual({ kind: 'downloading', percent: 40 });
    expect(nextFirmwareStep({ kind: 'starting' }, true, true, 'installing', null).progress).toEqual({ kind: 'installing' });
    expect(nextFirmwareStep({ kind: 'installing' }, true, false, null, null).progress).toEqual({ kind: 'restarting' });
    expect(watch('downloading', 'idle', 'installing').finished).toBe(false);
    expect(watch('downloading', 'idle', 'installing').progress).toEqual({ kind: 'installing' });
    expect(watch('downloading', 'idle', 'idle', 'installing', 'idle').finished).toBe(false);
    expect(watch('installing', null, 'idle', null, 'idle').finished).toBe(false);
    expect(watch('installing', null, 'idle', 'idle', 'idle').finished).toBe(true);
    expect(watch('downloading', 'installing', null, null, 'idle', 'idle', 'idle').finished).toBe(true);
    const failed = watch('downloading', 'failed');
    expect(failed.finished && failed.progress.kind === 'failed').toBe(true);
  });

  it('is done only when the robot reports the new version', () => {
    expect(firmwareOutcome('02.33.48', '02.35.52', '02.35.52')).toEqual({ kind: 'done', version: '02.35.52' });
    const rolledBack = firmwareOutcome('02.33.48', '02.35.52', '02.33.48');
    expect(rolledBack.kind === 'failed' && rolledBack.reason.includes('rolled back or did not apply')).toBe(true);
    expect(firmwareOutcome('02.33.48', '02.35.52', '02.34.00').kind).toBe('failed');
    expect(firmwareOutcome('02.33.48', null, '02.35.52')).toEqual({ kind: 'done', version: '02.35.52' });
    expect(firmwareOutcome('02.33.48', null, '02.33.48').kind).toBe('failed');
    expect(firmwareOutcome(null, null, '02.35.52').kind).toBe('failed');
    expect(firmwareOutcome('02.35.52', '02.33.48', '02.33.48')).toEqual({ kind: 'done', version: '02.33.48' });
    expect(firmwareOutcome('02.33.48', '02.35.52', null).kind).toBe('failed');
    expect(firmwareStartRefusal(404)).toContain('enable_install');
    expect(firmwareStartRefusal(501)).toContain('enable_install');
  });
});
