import { describe, expect, it } from 'vitest';
import {
  countdownText, groupedManualCode, matterCodeAgeKnown, matterFailed, matterHasCodes, matterKeyRequestAllowed, matterNeedsKey,
  matterPollIsDone, parseMatterStatus,
} from '../shared/matter.js';
import { encodeQr } from '../shared/qr.js';

/* Cases copied from LocalRock's MatterTest, MatterPollTest, MatterTextTest and QrCodeTest. */

describe('Matter', () => {
  it('never asks a joined robot for a key, even when renewing', () => {
    expect(matterNeedsKey('Joined', 1, true, false)).toBe(false);
    expect(matterKeyRequestAllowed('Joined')).toBe(false);
    expect(matterKeyRequestAllowed('Ready')).toBe(true);
    expect(matterKeyRequestAllowed(null)).toBe(true);
  });

  it('asks a ready robot once when renewing, a missing key at once, and a failure only on a retry', () => {
    expect(matterNeedsKey('Ready', 1, true, false)).toBe(true);
    expect(matterNeedsKey('Ready', 1, true, true)).toBe(false);
    expect(matterNeedsKey('KeyNotExit', 0, false, false)).toBe(true);
    expect(matterNeedsKey('KeyDownloadFailure', 0, false, false)).toBe(false);
    expect(matterNeedsKey('KeyDownloadFailure', 1, false, false)).toBe(true);
    expect(matterNeedsKey('Preparing', 0, false, false)).toBe(false);
  });

  it('waits for a new code when renewing, then takes the old one after four polls', () => {
    expect(matterPollIsDone('Joined', true, false, true, 0)).toBe(true);
    expect(matterPollIsDone('Ready', true, false, false, 0)).toBe(false);
    expect(matterPollIsDone('Ready', true, true, true, 3)).toBe(false);
    expect(matterPollIsDone('Ready', true, true, false, 1)).toBe(true);
    expect(matterPollIsDone('Ready', true, true, true, 4)).toBe(true);
    expect(matterPollIsDone('Ready', false, false, false, 0)).toBe(true);
    expect(matterPollIsDone('Preparing', false, false, false, 0)).toBe(false);
  });

  it('starts the countdown only for a code it saw appear', () => {
    expect(matterCodeAgeKnown('Ready', false, true, true, true)).toBe(false);
    expect(matterCodeAgeKnown('Ready', false, true, true, false)).toBe(true);
    expect(matterCodeAgeKnown('Ready', false, false, false, false)).toBe(false);
    expect(matterCodeAgeKnown('Ready', true, false, false, false)).toBe(true);
    expect(matterCodeAgeKnown('Joined', true, false, true, false)).toBe(false);
  });

  it('reads the status from an object or a one-item list', () => {
    const body = { status: 'Ready', ManualPairingCode: '34970112332', QrCode: 'MT:Y.K9042C00KA0648G00' };
    const expected = { state: 'Ready', manualCode: '34970112332', qrPayload: 'MT:Y.K9042C00KA0648G00' };
    expect(parseMatterStatus(body)).toEqual(expected);
    expect(parseMatterStatus([body])).toEqual(expected);
    expect(parseMatterStatus([{ status: 'KeyNotExit' }])).toEqual({ state: 'KeyNotExit', manualCode: null, qrPayload: null });
    expect(parseMatterStatus({ status: 'SomethingNew' })!.state).toBeNull();
    expect(parseMatterStatus(['ok'])).toBeNull();
    expect(parseMatterStatus([])).toBeNull();
    expect(matterFailed('KeyDownloadFailure') && matterFailed('KeyCorrupt') && !matterFailed('KeyDownloading')).toBe(true);
    expect(matterHasCodes('Ready') && matterHasCodes('Joined')).toBe(true);
  });

  it('prints the code and the countdown the way Matter apps do', () => {
    expect(groupedManualCode('34970112332')).toBe('3497-011-2332');
    expect(groupedManualCode('1234')).toBe('1234');
    expect(countdownText(900)).toBe('15:00');
    expect(countdownText(61)).toBe('1:01');
    expect(countdownText(-5)).toBe('0:00');
  });
});

describe('QR encoder', () => {
  it('fits a Matter payload in version 2 with three finder patterns', () => {
    const qr = encodeQr('MT:Y.K9042C00KA0648G00');
    expect(qr.size).toBe(25);
    for (const [ox, oy] of [[0, 0], [18, 0], [0, 18]] as const) {
      expect(qr.get(ox, oy) && qr.get(ox + 6, oy + 6) && !qr.get(ox + 1, oy + 1) && qr.get(ox + 3, oy + 3)).toBe(true);
    }
  });
  it('gives longer text a higher version', () => {
    expect(encodeQr('x'.repeat(140)).size).toBeGreaterThan(41);
  });
});
