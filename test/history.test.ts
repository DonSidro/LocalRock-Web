import { describe, expect, it } from 'vitest';
import type { CleanRecord } from '../shared/api.js';
import {
  buildTimeline, cleanAreaLabel, cleanDurationLabel, cleanRecordTags, cruiseTitle, finishReasonLabel, isCruise, parseTimelinePage,
  timelineDetail, timelineTitle, totalAreaLabel,
} from '../shared/history.js';
import { parseCleanRecord } from '../server/vacuum/repository.js';

/* Cases from LocalRock's CleanRecordLabelsTest, CleanTimelineTest and CruiseRecordsTest. */

const rec = (o: Partial<CleanRecord>): CleanRecord => ({
  beginEpoch: 1, endEpoch: 2, durationSeconds: 60, areaMm2: 0, errorCode: 0, complete: 1, startType: 0, cleanType: 0,
  finishReason: 0, dustCollected: false, washCount: 0, cleanedAreaMm2: null, ...o,
});

describe('clean records', () => {
  it('reads every field of an object record, and the old list form', () => {
    const r = parseCleanRecord({ begin: 10, end: 20, duration: 9900, area: 92_900_000, cleaned_area: 123_000_000, error: 0, complete: 1, start_type: 3, clean_type: 1, finish_reason: 56, dust_collection_status: 1, wash_count: 2 }, 10)!;
    expect(r).toMatchObject({ startType: 3, cleanType: 1, finishReason: 56, dustCollected: true, washCount: 2, cleanedAreaMm2: 123_000_000 });
    expect(parseCleanRecord([[10, 20, 30, 40, 0, 1]], 10)).toMatchObject({ beginEpoch: 10, durationSeconds: 30, cleanedAreaMm2: null });
  });

  it('labels a run as the official app does', () => {
    expect(finishReasonLabel(rec({ finishReason: 21 }))).toBe('Cleaning interrupted by user');
    expect(finishReasonLabel(rec({ finishReason: 56 }))).toBe('Finished cleaning');
    expect(finishReasonLabel(rec({ finishReason: 999, complete: 0 }))).toBe('Cleanup Interrupted');
    expect(cleanRecordTags(rec({ startType: 3, cleanType: 1, dustCollected: true, washCount: 2 }))).toEqual(['Schedules', 'Full', 'Dust collected', 'Mop wash x 2']);
    expect(cleanDurationLabel(50)).toBe('50 s');
    expect(cleanDurationLabel(9900)).toBe('165 min');
    expect(cleanAreaLabel(40_000)).toBe('0.0 m²');
    expect(cleanAreaLabel(123_000_000)).toBe('123 m²');
    expect(totalAreaLabel(29_940_000_000)).toBe('29.9k m²');
    expect(totalAreaLabel(412_000_000)).toBe('412 m²');
  });

  it('puts camera runs on the Cruise tab', () => {
    expect(isCruise(rec({ cleanType: 5 })) && isCruise(rec({ cleanType: 6 })) && isCruise(rec({ cleanType: 10 }))).toBe(true);
    expect(isCruise(rec({ cleanType: 1 }))).toBe(false);
    expect(cruiseTitle(rec({ cleanType: 6 }))).toBe('Search for the Pet');
    expect(cruiseTitle(rec({ cleanType: 5 }))).toBe('Cruise');
  });
});

describe('clean timeline', () => {
  const page = parseTimelinePage({ from: 0, num: 6, more: 0, events: [
    { t: 100, i: 25, e: '{\\"252\\":3,\\"3\\":2,\\"4\\":1,\\"5\\":0,\\"6\\":2}' },
    { t: 110, i: 42, e: { 2: 16, 421: 1, 422: 14 } },
    { t: 120, i: 42, e: { 2: 40, 421: 1 } },
    { t: 130, i: 52, e: { 521: 13 } },
    { t: 140, i: 11, e: { 111: 5, 112: 12 } },
    { t: 140, i: 31, e: { 311: 5, 312: 1 } },
  ] })!;

  it('parses string and object payloads', () => {
    expect(page.events.length).toBe(6);
    expect(page.more).toBe(false);
    expect(parseTimelinePage(['ok'])).toBeNull();
    expect(parseTimelinePage({})).toEqual({ from: 0, num: 0, more: false, events: [] });
  });

  it('builds the official steps, with the error after its code', () => {
    const steps = buildTimeline(page.events, 200);
    expect(steps.map((s) => s.kind)).toEqual(['start', 'room', 'washMop', 'error', 'finished']);
    expect(timelineTitle(steps[0]!)).toBe('Start selective room cleaning');
    expect(timelineDetail(steps[0]!)).toBe('Suction Standard · Water Low · Route Standard · 2 passes');
    expect(timelineTitle(steps[1]!)).toBe('Clean Kitchen');
    expect(timelineTitle(steps[1]!, () => 'Galley')).toBe('Clean Galley');
    expect(timelineTitle(steps[2]!)).toBe('Autonomous mop washing at the dock');
    expect(timelineTitle(steps[3]!)).toBe('An error occurs. (5-1)');
    expect(timelineTitle(steps[4]!)).toBe('Cleaning Finished');
  });
});
