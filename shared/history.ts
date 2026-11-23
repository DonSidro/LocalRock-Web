import type { CleanRecord } from './api.js';
import { ROOM_TYPES, describeError } from './codes.js';

/*
 * Cleaning history the way the official app shows it, ported from LocalRock's CleanRecordLabels.kt,
 * CleanTimeline.kt and CruiseRecords.kt.
 */

// ---- Record labels ----------------------------------------------------------------------------

const START_TYPES: Record<number, string> = {
  1: 'Button', 2: 'App', 3: 'Schedules', 4: 'Mi home', 5: 'Quick start', 13: 'Voice Control', 19: 'Hatch',
  101: 'Routines', 121: 'Matter', 801: 'Alexa', 802: 'Google', 803: 'IFTTT',
};

const INTERRUPTED_BY_USER = 'Cleaning interrupted by user';
const CLEANUP_INTERRUPTED = 'Cleanup Interrupted';
const FINISHED = 'Finished cleaning';
const COULD_NOT_CONTINUE = 'Could not continue cleaning';

/** The official app's table from finish_reason to the result line; reasons it has no text for are absent. */
const FINISH_REASONS: Record<number, string> = {};
for (const r of [21, 29, 35, 36, 37, 43, 48, 49, 50, 60, 103]) FINISH_REASONS[r] = INTERRUPTED_BY_USER;
for (const r of [52, 54, 55, 56, 57]) FINISH_REASONS[r] = FINISHED;
for (const r of [24, 34, 51, 64, 101, 104, 105, 106, 107, 109, 110]) FINISH_REASONS[r] = CLEANUP_INTERRUPTED;
for (const r of [32, 33, 102]) FINISH_REASONS[r] = COULD_NOT_CONTINUE;
for (const r of [45, 65]) FINISH_REASONS[r] = 'Positioning Failed';
for (const r of [61, 62]) FINISH_REASONS[r] = 'Area unreachable';
FINISH_REASONS[67] = 'Washing Error';
FINISH_REASONS[68] = 'Failed to return to the dock';

export const startTypeLabel = (t: number): string | null => START_TYPES[t] ?? null;
/** Only the full clean (1) is named; the other clean_type values are not mapped. */
export const cleanTypeLabel = (t: number): string | null => (t === 1 ? 'Full' : null);

/** The result line for a run, falling back to what complete says when the reason has no text. */
export function finishReasonLabel(r: CleanRecord): string {
  return FINISH_REASONS[r.finishReason] ?? (r.complete === 1 ? FINISHED : CLEANUP_INTERRUPTED);
}

/** The tags under the result line, in the official app's order: start, mode, dust, mop washes. */
export function cleanRecordTags(r: CleanRecord): string[] {
  const out: string[] = [];
  const start = startTypeLabel(r.startType);
  if (start) out.push(start);
  const type = cleanTypeLabel(r.cleanType);
  if (type) out.push(type);
  if (r.dustCollected) out.push('Dust collected');
  if (r.washCount > 0) out.push(`Mop wash x ${r.washCount}`);
  return out;
}

/** The area the official app shows for a run: cleaned_area when the robot reports it, else area. */
export const shownAreaMm2 = (r: CleanRecord) => r.cleanedAreaMm2 ?? r.areaMm2;

/** Seconds under a minute ("50 s"), minutes rounded to the nearest otherwise ("165 min"). */
export const cleanDurationLabel = (s: number) => (s < 60 ? `${s} s` : `${Math.round(s / 60)} min`);

/** A run's area: one decimal under 1 m² ("0.0 m²"), whole square metres otherwise ("123 m²"). */
export function cleanAreaLabel(mm2: number): string {
  const m2 = mm2 / 1_000_000;
  if (m2 < 1) { const t = Math.round(m2 * 10); return `${Math.floor(t / 10)}.${t % 10} m²`; }
  return `${Math.round(m2)} m²`;
}

/** The lifetime total area: "29.9k m²" from 1000 m² up. */
export function totalAreaLabel(mm2: number): string {
  const m2 = mm2 / 1_000_000;
  if (m2 < 1000) return `${Math.round(m2)} m²`;
  const tenths = Math.round(m2 / 100);
  return `${Math.floor(tenths / 10)}.${tenths % 10}k m²`;
}

// ---- Cruise ------------------------------------------------------------------------------------

/** CleanRecord.clean_type values for the camera runs listed on the Cruise tab. */
export const CLEAN_TYPE_VIDEO_PATROL = 5;
export const CLEAN_TYPE_PET_PATROL = 6;
export const CLEAN_TYPE_OBJECT_PATROL = 10;

export const isCruise = (r: CleanRecord) => r.cleanType === CLEAN_TYPE_VIDEO_PATROL || r.cleanType === CLEAN_TYPE_PET_PATROL || r.cleanType === CLEAN_TYPE_OBJECT_PATROL;
/** The official app's Cruise tab titles; object patrol has no captured title, so it reads "Cruise". */
export const cruiseTitle = (r: CleanRecord) => (r.cleanType === CLEAN_TYPE_PET_PATROL ? 'Search for the Pet' : 'Cruise');

// ---- Timeline (get_clean_detail) ---------------------------------------------------------------

/** One raw event: time in epoch seconds, type the event id (i), fields the payload keyed by field id. */
export interface CleanTimelineEvent { time: number; type: number; fields: Record<number, unknown> }
export interface CleanTimelinePage { from: number; num: number; more: boolean; events: CleanTimelineEvent[] }

export interface CleanStartSettings { suction: number; water: number; route: number; repeat: number }

export type CleanTimelineStep =
  /** scope: 1 whole home, 2 drawn zone, 3 selected rooms. */
  | { kind: 'start'; time: number; scope: number; settings: CleanStartSettings | null }
  | { kind: 'room'; time: number; segmentId: number; roomTypeTag: number | null }
  | { kind: 'washMop'; time: number; mode: number }
  | { kind: 'autoEmptying'; time: number; mode: number }
  | { kind: 'mopLifted'; time: number }
  | { kind: 'pause'; time: number }
  | { kind: 'resume'; time: number }
  /** code is 0 when no error event came before the switch to the error state. */
  | { kind: 'error'; time: number; code: number; subCode: number }
  | { kind: 'extraClean'; time: number; reason: number }
  | { kind: 'finished'; time: number };

const intOf = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) ? v : null);

/** Returns null when result is not the get_clean_detail envelope (an empty {} is an empty page). */
export function parseTimelinePage(result: unknown): CleanTimelinePage | null {
  if (typeof result !== 'object' || result === null || Array.isArray(result)) return null;
  const o = result as Record<string, unknown>;
  const events = Array.isArray(o['events']) ? o['events'].flatMap((e) => { const p = parseEvent(e); return p ? [p] : []; }) : [];
  return { from: intOf(o['from']) ?? 0, num: intOf(o['num']) ?? events.length, more: intOf(o['more']) === 1, events };
}

function parseEvent(e: unknown): CleanTimelineEvent | null {
  if (typeof e !== 'object' || e === null) return null;
  const o = e as Record<string, unknown>;
  const time = intOf(o['t']);
  const type = intOf(o['i']);
  if (time === null || type === null) return null;
  let payload: unknown = o['e'];
  // The robot sends the payload as a JSON string; the official app strips backslashes first.
  if (typeof payload === 'string') { try { payload = JSON.parse(payload.replace(/\\/g, '')); } catch { return null; } }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
  const fields: Record<number, unknown> = {};
  for (const [k, v] of Object.entries(payload as Record<string, unknown>)) if (/^\d+$/.test(k)) fields[Number(k)] = v;
  return { time, type, fields };
}

// Official app: a pause node only shows when the robot was in one of these states.
const PAUSABLE_STATES = new Set([5, 17, 18, 6, 15, 22, 25, 26, 33, 34, 35, 38, 39]);
const RESUME_REASONS = new Set([1, 2, 7, 16]);

/** Builds the steps the official app shows from the raw events; endEpoch adds the finish node when positive. */
export function buildTimeline(events: CleanTimelineEvent[], endEpoch = 0): CleanTimelineStep[] {
  // Same order as the official app: by time, state switches (11) last among equal times.
  const sorted = [...events].sort((a, b) => a.time - b.time || (a.type === 11 ? 1 : 0) - (b.type === 11 ? 1 : 0));
  const steps: CleanTimelineStep[] = [];
  let lastError: [number, number] | null = null;
  const f = (e: CleanTimelineEvent, k: number) => intOf(e.fields[k]);
  for (const e of sorted) {
    switch (e.type) {
      case 25: {
        const scope = f(e, 252);
        if (scope === null) break;
        const settings = f(e, 3) !== null ? { suction: f(e, 3) ?? 0, water: f(e, 4) ?? 0, route: f(e, 5) ?? 0, repeat: f(e, 6) ?? 1 } : null;
        steps.push({ kind: 'start', time: e.time, scope, settings });
        break;
      }
      // 42 with a clean preference (421) opens a room; ids from 35 up are extra passes shown through event 61.
      case 42: {
        const seg = f(e, 2);
        if (seg !== null && seg >= 1 && seg <= 30 && f(e, 421) !== null) steps.push({ kind: 'room', time: e.time, segmentId: seg, roomTypeTag: f(e, 422) });
        break;
      }
      case 52: { const m = f(e, 521); if (m !== null) steps.push({ kind: 'washMop', time: e.time, mode: m }); break; }
      case 54: steps.push({ kind: 'autoEmptying', time: e.time, mode: f(e, 541) ?? -1 }); break;
      case 45: if (f(e, 451) === 1) steps.push({ kind: 'mopLifted', time: e.time }); break;
      case 61: steps.push({ kind: 'extraClean', time: e.time, reason: f(e, 611) ?? 0 }); break;
      case 31: lastError = [f(e, 311) ?? 0, f(e, 312) ?? 0]; break;
      case 13: if (RESUME_REASONS.has(f(e, 131) ?? -1)) steps.push({ kind: 'resume', time: e.time }); break;
      case 11:
        if (f(e, 112) === 12) steps.push({ kind: 'error', time: e.time, code: lastError?.[0] ?? 0, subCode: lastError?.[1] ?? 0 });
        else if (f(e, 112) === 10 && PAUSABLE_STATES.has(f(e, 111) ?? -1)) steps.push({ kind: 'pause', time: e.time });
        break;
    }
  }
  if (endEpoch > 0) steps.push({ kind: 'finished', time: endEpoch });
  return steps;
}

/** "5-1" for error 5, sub-error 1; just "5" when there is no sub-error. */
export const errorCodeText = (code: number, sub: number) => (sub > 0 ? `${code}-${sub}` : `${code}`);

export function timelineTitle(s: CleanTimelineStep, roomName: (segment: number) => string | null = () => null): string {
  switch (s.kind) {
    case 'start': return s.scope === 2 ? 'Start zone cleaning' : s.scope === 3 ? 'Start selective room cleaning' : 'Start full cleaning';
    case 'room': {
      const name = roomName(s.segmentId) || (s.roomTypeTag !== null ? ROOM_TYPES.find((t) => t.tag === s.roomTypeTag)?.label : undefined) || `Room ${s.segmentId}`;
      return `Clean ${name}`;
    }
    case 'washMop': return s.mode === 12 ? 'On-board dirty water tank draining' : s.mode === 13 ? 'Autonomous mop washing at the dock' : s.mode === 14 ? 'Robot water tank refilling' : 'Wash Mop';
    case 'autoEmptying': return 'Auto Emptying';
    case 'mopLifted': return 'Lift up the mop cloth to clean carpet';
    case 'pause': return 'Pause';
    case 'resume': return 'Resume';
    case 'error': return s.code > 0 ? `An error occurs. (${errorCodeText(s.code, s.subCode)})` : 'An error occurs.';
    case 'extraClean':
      return s.reason === 1 || s.reason === 2 ? 'Add Area' : s.reason === 3 ? 'Automatic Re-Mopping' : s.reason === 4 ? 'Heavy Dirt/Stain Recognition'
        : s.reason === 6 ? 'Clean Areas Blocked by People/Pets' : 'Extra cleaning';
    case 'finished': return 'Cleaning Finished';
  }
}

const AUTO_EMPTY_MODES = ['Smart', 'Light', 'Balanced', 'Turbo', 'Max'];
const SUCTION: Record<number, string> = { 1: 'Quiet', 2: 'Standard', 3: 'Strong', 4: 'MAX', 5: 'Gentle', 6: 'Custom', 7: 'Carpet', 8: 'MAX+', 9: 'Main brush lifted', 10: 'Easy' };
const ROUTE: Record<number, string> = { 0: 'Standard', 1: 'Deep', 2: 'Custom', 3: 'Deep+', 4: 'Fast' };
const WATER: Record<number, string> = { 0: 'Off', 1: 'Low', 2: 'Medium', 3: 'High', 4: 'Custom' };

/** A second line for the steps that carry settings or a cause, or null. */
export function timelineDetail(s: CleanTimelineStep): string | null {
  if (s.kind === 'start' && s.settings) {
    const st = s.settings;
    // Water 21..50 is the 30-step flow (codes 221-250).
    const water = WATER[st.water] ?? (st.water >= 21 && st.water <= 50 ? `Level ${st.water - 20}` : `Water ${st.water}`);
    const parts = [`Suction ${SUCTION[st.suction] ?? st.suction}`, `Water ${water}`, `Route ${ROUTE[st.route] ?? st.route}`];
    if (st.repeat > 1) parts.push(`${st.repeat} passes`);
    return parts.join(' · ');
  }
  if (s.kind === 'autoEmptying') return AUTO_EMPTY_MODES[s.mode] ?? null;
  if (s.kind === 'error') return describeError(s.code) || null;
  return null;
}
