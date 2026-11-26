import { State } from './codes.js';

/*
 * Camera rules shared by the browser's live view and the server, ported from LocalRock's
 * CameraModelSupport.kt, CameraCleaning.kt, CameraSdpEnvelope.kt, CameraVideoTest.kt,
 * CameraLiveSession.kt (PIN replies) and the codec ranking in RtcPeer.android.kt / WebRtcOffer.swift.
 */

/** Official remote viewing is separate from LocalRock compatibility. */
export type CameraModelSupport = 'UNAVAILABLE' | 'TESTED' | 'EXPERIMENTAL';

/**
 * Exact model ids only: related names and obstacle-avoidance sensors do not imply remote viewing,
 * and official support does not prove LocalRock's protocol works. S7 MaxV is the tested one.
 */
const EXPERIMENTAL_VIDEO_MODELS: ReadonlySet<string> = new Set([
  'roborock.vacuum.a10', // S6 MaxV
  'roborock.vacuum.a97', // S8 MaxV Ultra
  'roborock.vacuum.a87', // Qrevo MaxV
  'roborock.vacuum.a117', // Qrevo Master
  'roborock.vacuum.a21', // Qrevo Slim
  'roborock.vacuum.a135', // Qrevo Curv
  'roborock.vacuum.a156', // Qrevo Edge
  'roborock.vacuum.a147', // Saros 10
  'roborock.vacuum.a144', // Saros 10R
]);

export function cameraModelSupport(model: string | null | undefined): CameraModelSupport {
  if (model === 'roborock.vacuum.a27') return 'TESTED';
  return model && EXPERIMENTAL_VIDEO_MODELS.has(model) ? 'EXPERIMENTAL' : 'UNAVAILABLE';
}

export const cameraShowsEntry = (s: CameraModelSupport) => s !== 'UNAVAILABLE';
/** Driving, Go, docking and cleaning from the viewer are for the tested model only. */
export const cameraAllowsRobotControls = (s: CameraModelSupport) => s === 'TESTED';
export const cameraCanConnect = (s: CameraModelSupport, testingEnabled: boolean) => s === 'TESTED' || (s === 'EXPERIMENTAL' && testingEnabled);

// ---- Cleaning from the viewer ------------------------------------------------------------------

export type CameraCleaningAction = 'START' | 'RESUME' | 'PAUSE';
export const CAMERA_CLEANING_LABEL: Record<CameraCleaningAction, string> = { START: 'Start cleaning', RESUME: 'Resume cleaning', PAUSE: 'Pause cleaning' };

const CLEANING = new Set<number>([State.CLEANING, State.ZONED_CLEANING, State.SEGMENT_CLEANING, State.SPOT_CLEANING]);
const RESTING = new Set<number>([State.IDLE, State.CHARGER_DISCONNECTED, State.NOT_CHARGING, State.CHARGING, State.CHARGING_COMPLETE]);

/** The viewer's Play button for this status, or null when it offers none. */
export function cameraCleaningAction(state: number | null | undefined, inCleaning: number | null | undefined, errorCode: number | null | undefined): CameraCleaningAction | null {
  if (errorCode !== 0 || state == null) return null;
  if (CLEANING.has(state)) return 'PAUSE';
  if (state === State.PAUSED) return inCleaning === 1 || inCleaning === 2 || inCleaning === 3 ? 'RESUME' : inCleaning === 0 ? 'START' : null;
  if (RESTING.has(state)) return inCleaning === 0 ? 'START' : inCleaning === 1 || inCleaning === 2 || inCleaning === 3 ? 'RESUME' : null;
  return null;
}

/** The command for a requested action against a fresh status: a stale Play must never become Pause. */
export function cameraCleaningCommand(requested: CameraCleaningAction, state: number | null | undefined, inCleaning: number | null | undefined, errorCode: number | null | undefined): string | null {
  if (cameraCleaningAction(state, inCleaning, errorCode) !== requested) return null;
  switch (requested) {
    case 'START': return 'app_start';
    case 'PAUSE': return 'app_pause';
    case 'RESUME': return inCleaning === 1 ? 'app_start' : inCleaning === 2 ? 'resume_zoned_clean' : inCleaning === 3 ? 'resume_segment_clean' : null;
  }
}

// ---- Signalling -------------------------------------------------------------------------------

/** Connection test variants: B, C and D each change one detail relative to A. All request SD. */
export interface CameraVideoTest { code: 'A' | 'B' | 'C' | 'D'; label: string; description: string; compactCodecs: boolean; literalSdpLineBreaks: boolean; earlyRemoteIce: boolean }
export const CAMERA_VIDEO_TESTS: readonly CameraVideoTest[] = [
  { code: 'A', label: 'OEM match', description: 'Closest match to the captured OEM request.', compactCodecs: false, literalSdpLineBreaks: true, earlyRemoteIce: true },
  { code: 'B', label: 'Escaped JSON', description: 'A with standard JSON line breaks.', compactCodecs: false, literalSdpLineBreaks: false, earlyRemoteIce: true },
  { code: 'C', label: 'Compact offer', description: 'A with Opus and H.264 codecs only.', compactCodecs: true, literalSdpLineBreaks: true, earlyRemoteIce: true },
  { code: 'D', label: 'Answer first', description: 'A waits for the answer before requesting ICE.', compactCodecs: false, literalSdpLineBreaks: true, earlyRemoteIce: false },
];
export const OEM_MATCH = CAMERA_VIDEO_TESTS[0]!;
export type CameraVideoQuality = 'HD' | 'SD';

function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function fromBase64(text: string): string {
  const bin = atob(text);
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

/**
 * The offer as the robot takes it: {"sdp":...,"type":"offer"} in that order, base64. The OEM
 * variant leaves the SDP's CRLF line breaks literal inside the JSON string, escaping each line
 * on its own so a literal backslash-r stays escaped.
 */
export function encodeCameraOffer(sdp: string, literalLineBreaks: boolean): string {
  const quoted = literalLineBreaks
    ? `"${sdp.split('\r\n').map((line) => JSON.stringify(line).slice(1, -1)).join('\r\n')}"`
    : JSON.stringify(sdp);
  return toBase64(`{"sdp":${quoted},"type":"offer"}`);
}

export class CameraFailure extends Error {}

/** Accepts normal JSON and the OEM's literal-CRLF string; the SDP is not rewritten. */
export function decodeCameraAnswer(encoded: string): string {
  try {
    const text = fromBase64(encoded);
    let out = '';
    let inString = false, escaped = false;
    for (const ch of text) {
      if (inString && ch < ' ' && !(!escaped && (ch === '\r' || ch === '\n'))) throw new Error('control character');
      if (escaped) { out += ch; escaped = false; }
      else if (ch === '\\' && inString) { out += ch; escaped = true; }
      else if (ch === '"') { out += ch; inString = !inString; }
      else if (inString && ch === '\r') out += '\\r';
      else if (inString && ch === '\n') out += '\\n';
      else out += ch;
    }
    const obj = JSON.parse(out) as unknown;
    if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) throw new Error('not an object');
    const o = obj as Record<string, unknown>;
    if (o['type'] !== 'answer' || typeof o['sdp'] !== 'string' || !o['sdp'].trim()) throw new Error('not an answer');
    return o['sdp'];
  } catch {
    throw new CameraFailure('The robot returned an invalid video answer.');
  }
}

const single = (r: unknown) => (Array.isArray(r) ? (r.length === 1 ? r[0] : undefined) : r);

/** S7 MaxV acknowledges a valid credential with exactly ["ok"]; other strings and odd replies fail closed. */
export function cameraPinAccepted(result: unknown): boolean {
  const v = single(result);
  if (Array.isArray(result) && v === 'ok') return true;
  return v === true || v === 1;
}

export function cameraPinRejected(result: unknown): boolean {
  const v = single(result);
  return v === false || v === 0;
}

/** The ["ok"] (or "ok") acknowledgement the camera and motion commands answer with. */
export const isAck = (result: unknown) => single(result) === 'ok';

/** The camera's current viewer from get_homesec_connect_status; "none" when free. */
export function cameraOwner(result: unknown): string | null {
  const v = single(result);
  if (typeof v !== 'object' || v === null) return null;
  const id = (v as Record<string, unknown>)['client_id'];
  return typeof id === 'string' && id.trim() ? id : null;
}

/** The hint for a camera command's error code. */
export function cameraErrorHint(method: string, code: number | null): string {
  switch (code) {
    case -1007: return 'This robot reports its camera PIN feature is disabled. Enable remote viewing for it once in the official app, then try again.';
    case -10012: return "This robot denied camera preview. Remote viewing has to be switched on in the official app while the robot is on Roborock's servers.";
    case -10014: return "The robot could not get a video relay (TURN) from the server. The camera needs a local server with camera support, and the robot paired so it can reach it.";
    default: return `${method} was refused by the robot (code ${code ?? 'unavailable'}).`;
  }
}

// ---- Codecs -----------------------------------------------------------------------------------

export interface CodecCapability { mimeType: string; clockRate: number; channels?: number; sdpFmtpLine?: string }

function fmtp(c: CodecCapability): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (c.sdpFmtpLine ?? '').split(';')) {
    const [k, v] = part.split('=');
    if (k && v !== undefined) out[k.trim()] = v.trim();
  }
  return out;
}

function audioRank(c: CodecCapability, compact: boolean): number | null {
  if (c.clockRate !== 48000) return null;
  switch (c.mimeType.toLowerCase()) {
    case 'audio/opus': return c.channels === 2 ? 0 : null;
    case 'audio/red': return !compact && c.channels === 2 ? 1 : null;
    case 'audio/telephone-event': return compact ? null : 2;
    default: return null;
  }
}

function videoRank(c: CodecCapability, compact: boolean): number | null {
  if (c.clockRate !== 90000) return null;
  const p = fmtp(c);
  switch (c.mimeType.toLowerCase()) {
    case 'video/h264': {
      if (p['packetization-mode'] !== '1') return null;
      const profile = (p['profile-level-id'] ?? '').toLowerCase();
      if (profile.startsWith('640c')) return compact ? null : 0;
      return profile.startsWith('42e0') ? 1 : null;
    }
    case 'video/vp8': return compact ? null : 2;
    case 'video/vp9': return !compact && (p['profile-id'] ?? '0') === '0' ? 3 : null;
    case 'video/av1': return !compact && (p['profile'] ?? '0') === '0' ? 4 : null;
    case 'video/red': return compact ? null : 5;
    case 'video/ulpfec': return compact ? null : 6;
    // The browser pairs each kept video codec with its own RTX payload.
    case 'video/rtx': return 7;
    default: return null;
  }
}

/**
 * The codecs offered, in the app's order: stereo Opus first; H.264 high then constrained baseline,
 * then VP8, VP9, AV1. Null when the browser lacks Opus or baseline H.264, so its own order is kept.
 */
export function rankedCodecs<T extends CodecCapability>(kind: 'audio' | 'video', codecs: readonly T[], compact: boolean): T[] | null {
  const rank = kind === 'audio' ? audioRank : videoRank;
  const kept = codecs.map((c) => [rank(c, compact), c] as const).filter((x): x is readonly [number, T] => x[0] !== null);
  kept.sort((a, b) => a[0] - b[0]);
  const list = kept.map(([, c]) => c);
  const ok = kind === 'audio'
    ? list.some((c) => c.mimeType.toLowerCase() === 'audio/opus')
    : list.some((c) => c.mimeType.toLowerCase() === 'video/h264' && (fmtp(c)['profile-level-id'] ?? '').toLowerCase().startsWith('42e0'));
  return ok ? list : null;
}

// ---- Robot controls from the viewer (CameraMotionController.kt) ---------------------------------

/** The commands the viewer's controls may send through the server, besides the camera ones. */
export const CAMERA_CONTROL_METHODS: ReadonlySet<string> = new Set([
  'get_status', 'app_rc_start', 'app_rc_move', 'app_rc_stop', 'app_rc_end', 'stop_goto_target', 'app_goto_target',
  'app_charge', 'app_stop', 'app_start', 'app_pause', 'resume_zoned_clean', 'resume_segment_clean',
]);

/** Starting manual control and reading status can be slow; motion and stop keep a short deadline. */
export const cameraControlTimeoutMs = (method: string) => (method === 'get_status' || method === 'app_rc_start' ? 5_000 : 1_500);

export const DRIVE_DIRECTIONS = {
  FORWARD: { velocity: 0.2, omega: 0 },
  BACKWARD: { velocity: -0.2, omega: 0 },
  LEFT: { velocity: 0, omega: 1.05 },
  RIGHT: { velocity: 0, omega: -1.05 },
} as const;
export type DriveDirection = keyof typeof DRIVE_DIRECTIONS;

/** States in which the robot can be driven or sent somewhere, and the manual-control ones. */
export const DRIVE_IDLE_STATES: ReadonlySet<number> = new Set([2, 3, 8, 24, 100]);
export const DRIVE_MANUAL_STATES: ReadonlySet<number> = new Set([4, 7]);

export function cameraCommandLabel(method: string): string {
  const label: Record<string, string> = {
    get_status: 'Reading robot status', app_rc_start: 'Starting manual control', app_rc_move: 'Driving',
    app_rc_stop: 'Stopping driving', app_rc_end: 'Ending manual control', stop_goto_target: 'Stopping Pin-and-Go',
    app_goto_target: 'Starting Pin-and-Go', app_charge: 'Returning to dock',
  };
  return `${label[method] ?? 'Robot control'} (${method})`;
}
