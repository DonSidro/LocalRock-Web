import { newFeatureBit } from './codes.js';
import { MATTER_FEATURE_BIT, PET_SNAPSHOT_FEATURE_BIT, VIDEO_PATROL_FEATURE_BIT } from './features.js';

/* Matter setup codes and Find my pet, ported from LocalRock's Matter.kt and MatterScreen.kt. */

export const isMatterSupported = (nfs: string | null | undefined) => newFeatureBit(nfs, MATTER_FEATURE_BIT);
export const isPetSearchSupported = (nfs: string | null | undefined) =>
  newFeatureBit(nfs, VIDEO_PATROL_FEATURE_BIT) || newFeatureBit(nfs, PET_SNAPSHOT_FEATURE_BIT);

/** The status values the official app reads from matter.get_status. */
export const MATTER_STATES = [
  'KeyNotExit', 'KeyCorrupt', 'KeyDownloading', 'KeyDownloadSuccess', 'KeyDownloadFailure', 'Preparing', 'Ready', 'Joined', 'RPCError',
] as const;
export type MatterState = (typeof MATTER_STATES)[number];

/** The robot cannot hand out a setup code until the key is fetched again. */
export const matterFailed = (s: MatterState) => s === 'KeyCorrupt' || s === 'KeyDownloadFailure' || s === 'RPCError';
/** A setup code and QR payload are on offer. */
export const matterHasCodes = (s: MatterState) => s === 'Ready' || s === 'Joined';
/** Joined shows no code and no renew action in the official app; re-sending the key may drop the pairing. */
export const matterCanRenewCode = (s: MatterState) => s === 'Ready';
/** Asking for a key while joined may drop the pairing, so only a robot that has not joined is asked. */
export const matterKeyRequestAllowed = (s: MatterState | null) => s !== 'Joined';

export const MATTER_OLD_CODE_POLLS = 4;

/** Whether the page should send matter.dnld_key after reading `state`. */
export function matterNeedsKey(state: MatterState, attempt: number, renewing: boolean, asked: boolean): boolean {
  return matterKeyRequestAllowed(state) && (state === 'KeyNotExit' || (attempt > 0 && matterFailed(state)) || (renewing && !asked));
}

/** A renewing page keeps polling while the robot still shows the code it had, for a few polls. */
export function matterCodeStillOld(renewing: boolean, state: MatterState, unchangedCode: boolean, pollsSinceAsk: number): boolean {
  return renewing && matterHasCodes(state) && unchangedCode && pollsSinceAsk < MATTER_OLD_CODE_POLLS;
}

/** True when the page can stop polling and show what it read. */
export function matterPollIsDone(state: MatterState, renewing: boolean, asked: boolean, unchangedCode: boolean, pollsSinceAsk: number): boolean {
  return state === 'Joined' || (matterHasCodes(state) && !(renewing && !asked) && !matterCodeStillOld(renewing, state, unchangedCode, pollsSinceAsk));
}

/** The countdown starts only for a code the page saw appear, and never for one that did not change on a renewal. */
export function matterCodeAgeKnown(state: MatterState, sawWorking: boolean, renewing: boolean, asked: boolean, unchangedCode: boolean): boolean {
  return state !== 'Joined' && (sawWorking || renewing || asked) && !(renewing && unchangedCode);
}

export interface MatterInfo {
  state: MatterState | null;
  manualCode: string | null;
  qrPayload: string | null;
}

/** Reads the matter.get_status reply: an object, or a one-item list holding it. */
export function parseMatterStatus(result: unknown): MatterInfo | null {
  const o = Array.isArray(result) ? result[0] : result;
  if (typeof o !== 'object' || o === null || Array.isArray(o)) return null;
  const rec = o as Record<string, unknown>;
  const text = (k: string) => (typeof rec[k] === 'string' && (rec[k] as string).trim() ? rec[k] as string : null);
  const status = text('status');
  return {
    state: status && (MATTER_STATES as readonly string[]).includes(status) ? status as MatterState : null,
    manualCode: text('ManualPairingCode'),
    qrPayload: text('QrCode'),
  };
}

/** What went wrong, in terms of what the robot actually reported. */
export function matterFailureText(state: MatterState | null): string {
  if (state === 'KeyCorrupt') return 'The robot downloaded its Matter key but could not use it. If your server provides the key, it may have answered with something else. Try again, and check the server log if it keeps happening.';
  if (state === 'RPCError') return 'The robot reported a Matter error. Try again in a moment.';
  return 'The robot could not download its Matter key. It usually means it could not reach the server that provides it. Check that the robot is online and that your server is set up to provide Matter keys, then try again.';
}

/** Time left on a setup code, as m:ss. */
export function countdownText(remainingSeconds: number): string {
  const s = Math.max(0, Math.floor(remainingSeconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** The 11-digit manual code is shown as 4-3-4, the way Matter apps print it. */
export function groupedManualCode(code: string): string {
  return /^\d{11}$/.test(code) ? `${code.slice(0, 4)}-${code.slice(4, 7)}-${code.slice(7)}` : code;
}
