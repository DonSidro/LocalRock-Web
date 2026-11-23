import { newFeatureBit } from './codes.js';
import { VOICE_ASSISTANT_BIT, parseBetaReply } from './features.js';

/* The Voice Assistant page, ported from LocalRock's Voice.kt, VoicePacks.kt and VoiceCommandStrings. */

export const isVoiceAssistantSupported = (nfs: string | null | undefined) => newFeatureBit(nfs, VOICE_ASSISTANT_BIT);

/** The switch as get_voice_service_switch reports it, e.g. {"data":1}. */
export interface VoiceSwitch { key: string | null; enabled: boolean }

export function parseVoiceSwitch(result: unknown): VoiceSwitch | null {
  const r = parseBetaReply(result);
  return r && (r.value === 0 || r.value === 1) ? { key: r.key, enabled: r.value === 1 } : null;
}

/** set_voice_service_switch takes only the bare object {"data":1}; other shapes time out instead of being refused. */
export const voiceSwitchParams = (key: string, on: boolean) => ({ [key]: on ? 1 : 0 });

export interface VoiceHistorySummary { minId: number; maxId: number; count: number }
/** One chat line; the official chat page draws speaker 1 as the user and every other value as the robot. */
export interface VoiceMessage { id: number; ts: number; text: string; speaker: number }

/** The official chat page asks for ids in windows of 100 (min_id to min_id + 100). */
export const VOICE_HISTORY_WINDOW = 100;

const obj = (r: unknown): Record<string, unknown> | null => {
  const o = Array.isArray(r) ? r[0] : r;
  return typeof o === 'object' && o !== null && !Array.isArray(o) ? o as Record<string, unknown> : null;
};
const int = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : null);
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

export function parseVoiceHistorySummary(result: unknown): VoiceHistorySummary | null {
  const o = obj(result);
  const count = o ? int(o['count']) : null;
  return o && count !== null ? { minId: int(o['min_id']) ?? 0, maxId: int(o['max_id']) ?? 0, count } : null;
}

export function parseVoiceHistory(result: unknown): VoiceMessage[] | null {
  const h = obj(result)?.['history'];
  if (!Array.isArray(h)) return null;
  return h.flatMap((item) => {
    const o = obj(item);
    const id = o ? int(o['id']) : null;
    return o && id !== null ? [{ id, ts: int(o['ts']) ?? 0, text: typeof o['text'] === 'string' ? o['text'] : '', speaker: int(o['speaker']) ?? 0 }] : [];
  });
}

/** The (min_id, max_id) pairs to read every message, oldest first. */
export function voiceHistoryWindows(s: VoiceHistorySummary): Array<[number, number]> {
  if (s.count <= 0 || s.maxId < s.minId) return [];
  const out: Array<[number, number]> = [];
  for (let id = s.minId; id <= s.maxId; id += VOICE_HISTORY_WINDOW) out.push([id, id + VOICE_HISTORY_WINDOW]);
  return out;
}

/** The language code from get_current_sound, e.g. [{"sid_in_use":3,...,"language":"en"}]. */
export function parseCurrentSoundLanguage(result: unknown): string | null {
  return text(obj(result)?.['language']);
}

// Names as the official Language page titles its voice packs.
const VOICE_LANGUAGE_NAMES: Record<string, string> = {
  prc: '标准普通话版', tw: '臺灣普通話版', en: 'English', it: 'Italiano', ja: '日本語', ko: '한국어 버전', de: 'Deutsch', es: 'Español',
  fr: 'Français', uk: 'Українська', he: 'עברית', iw: 'עברית', pl: 'Polski', ro: 'Română', ru: 'Русский', tr: 'Türkçe', th: 'ไทย',
  pt: 'Português', nl: 'Nederlands',
};

/** The display name for a voice language code, or the code itself when it is not known. */
export function voiceLanguageName(code: string): string {
  const key = code.toLowerCase();
  return VOICE_LANGUAGE_NAMES[key] ?? VOICE_LANGUAGE_NAMES[key.split(/[-_]/)[0]!] ?? code;
}

// ---- Voice packs ------------------------------------------------------------------------------

/** One entry of the plugin's voice-pkg info list (voice_list), as the server passes it through. */
export interface VoicePack { id: number; version: number; lang: string | null; title: string; subTitle: string | null; url: string; md5: string; priority: number }

/** get_current_sound: the pack in use, its version and the one being installed (0 when none). */
export interface CurrentSound { sidInUse: number; sidVersion: number; sidInProgress: number; location: string | null; language: string | null }

/** get_sound_progress: state 1 downloading, 2 installing, 3 done; other states with a sid set are failures. */
export interface SoundProgress { sidInProgress: number; progress: number; state: number; error: number }

export function parseCurrentSound(result: unknown): CurrentSound | null {
  const o = obj(result);
  const sid = o ? int(o['sid_in_use']) : null;
  if (!o || sid === null) return null;
  return { sidInUse: sid, sidVersion: int(o['sid_version']) ?? 0, sidInProgress: int(o['sid_in_progress']) ?? 0, location: text(o['location']), language: text(o['language']) };
}

export function parseSoundProgress(result: unknown): SoundProgress | null {
  const o = obj(result);
  const state = o ? int(o['state']) : null;
  if (!o || state === null) return null;
  return { sidInProgress: int(o['sid_in_progress']) ?? 0, progress: int(o['progress']) ?? 0, state, error: int(o['error']) ?? 0 };
}

/** The packs the plugin would list: voice_list entries whose applicable names the robot's location (cn is prc there), by voice_pri. */
export function parseVoicePackList(info: unknown, location: string | null): VoicePack[] | null {
  const list = obj(info)?.['voice_list'];
  if (!Array.isArray(list)) return null;
  const raw = location && location.trim() ? location : 'cn';
  const loc = raw.toLowerCase() === 'cn' ? 'prc' : raw;
  return list.flatMap((item): VoicePack[] => {
    const o = obj(item);
    if (!o) return [];
    const applicable = o['applicable'];
    if (Array.isArray(applicable) && !applicable.includes(loc)) return [];
    const id = int(o['voice_id']);
    const title = text(o['voice_title']);
    const url = text(o['voice_pkg_url']);
    const md5 = text(o['voice_pkg_md5']);
    if (id === null || !title || !url || !md5) return [];
    return [{ id, version: int(o['version']) ?? 0, lang: text(o['lang']), title, subTitle: text(o['voice_sub_title']), url, md5, priority: int(o['voice_pri']) ?? Number.MAX_SAFE_INTEGER }];
  }).sort((a, b) => a.priority - b.priority);
}

/** dnld_install_sound params as the plugin builds them; ota_url stays empty without the cloud. */
export const installSoundParams = (p: VoicePack) => ({ sid: p.id, url: p.url, md5: p.md5, sver: p.version, ota_url: '' });

export type VoiceInstallStep = { kind: 'working'; percent: number | null } | { kind: 'done' } | { kind: 'failed'; installFailed: boolean };

/** Consecutive idle polls (nothing in progress, target not in use) after which an install counts as failed. */
export const VOICE_INSTALL_IDLE_POLLS = 5;

/** The idle-poll count after one more poll: grows on an idle read of the robot, resets on anything else. */
export function nextVoiceIdlePolls(step: VoiceInstallStep, current: CurrentSound | null, idlePolls: number): number {
  return step.kind === 'working' && step.percent === null && current !== null ? idlePolls + 1 : 0;
}

/** Mirrors the plugin's getProgess: busy on state 1 or 2, failure on any other state while a sid is set. */
export function voiceInstallStep(progress: SoundProgress | null, current: CurrentSound | null, targetSid: number, idlePolls = 0): VoiceInstallStep {
  if (progress && (progress.state === 1 || progress.state === 2)) return { kind: 'working', percent: Math.min(100, Math.max(0, progress.progress)) };
  // Errors 2 and 13 are the plugin's "download failed"; the rest are "installation failed".
  if (progress && progress.state !== 3 && progress.sidInProgress > 0) return { kind: 'failed', installFailed: progress.error !== 2 && progress.error !== 13 };
  if (current?.sidInUse === targetSid) return { kind: 'done' };
  // The robot never started the download, so there is nothing to wait for.
  if (current && current.sidInProgress === 0 && idlePolls >= VOICE_INSTALL_IDLE_POLLS) return { kind: 'failed', installFailed: false };
  return { kind: 'working', percent: null };
}

export type VoiceInstallFailure = 'SEND' | 'DOWNLOAD' | 'INSTALL' | 'TIMEOUT';
/** One "Use" press: the pack, its last progress percent, and how it ended when it failed. */
export interface VoiceInstallState { sid: number; percent: number | null; failure: VoiceInstallFailure | null; done: boolean }

export const VOICE_INSTALL_TEXT: Record<VoiceInstallFailure, string> = {
  SEND: 'The robot did not accept the voice pack.',
  DOWNLOAD: 'Download failed. Please try again later.',
  INSTALL: 'Voice Package Installation Failed',
  TIMEOUT: 'The robot did not finish the voice pack in 5 minutes.',
};

/** The official Voice Commands list, grouped as the official page groups it. */
export const VOICE_COMMAND_GROUPS: Array<{ title: string; commands: Array<{ name: string; phrases: string[] }> }> = [
  {
    title: 'Clean',
    commands: [
      { name: 'Start cleaning', phrases: ['Start cleaning'] },
      { name: 'Vac & Mop', phrases: ['Vacuum and mop'] },
      { name: 'Vacuum', phrases: ['just vacuum', 'vacuum only'] },
      { name: 'Mop', phrases: ['just mop', 'mop only'] },
      { name: 'clean here', phrases: ['clean here'] },
      { name: 'skip here', phrases: ["don't clean here", 'skip here'] },
      { name: 'start mapping', phrases: ['create a map', 'start mapping'] },
    ],
  },
  {
    title: 'Dock Control',
    commands: [
      { name: 'go back to dock', phrases: ['go back to dock', 'charge'] },
      { name: 'empty the dustbin', phrases: ['empty the dustbin'] },
      { name: 'wash the mop', phrases: ['wash the mop'] },
      { name: 'dry the mop', phrases: ['dry the mop'] },
      { name: 'stop drying', phrases: ['stop drying'] },
    ],
  },
  { title: 'Pause and resume', commands: [{ name: 'pause', phrases: ['pause'] }, { name: 'resume', phrases: ['resume'] }] },
  {
    title: 'Robot Settings',
    commands: [
      { name: 'increase vacuum intensity', phrases: ['increase vacuum intensity', 'vaccum harder'] },
      { name: 'reduce vacuum intensity', phrases: ['reduce vacuum intensity', 'vaccum softer'] },
      { name: 'increase mopping intensity', phrases: ['increase mopping intensity', 'mop harder'] },
      { name: 'reduce mopping intensity', phrases: ['reduce mopping intensity', 'mop softer'] },
      { name: 'volume up', phrases: ['volume up', 'speak louder'] },
      { name: 'volume down', phrases: ['volume down', 'speak softer'] },
    ],
  },
  {
    title: 'Room Cleaning',
    commands: [
      { name: 'Bedroom', phrases: ['clean the bedroom'] },
      { name: 'Living room', phrases: ['clean the living room'] },
      { name: 'Dining room', phrases: ['clean the dining room'] },
      { name: 'kitchen', phrases: ['clean the kitchen'] },
      { name: 'Bathroom', phrases: ['clean the bathroom'] },
      { name: 'Sunroom', phrases: ['clean the sunroom'] },
      { name: 'Master bedroom', phrases: ['clean the master bedroom'] },
      { name: 'Guest bedroom', phrases: ['clean the guest bedroom'] },
      { name: 'Corridor', phrases: ['clean the corridor'] },
      { name: 'Hall', phrases: ['clean the hall', 'clean the lobby'] },
      { name: 'Study', phrases: ['clean the study'] },
    ],
  },
];
