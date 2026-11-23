import { describe, expect, it } from 'vitest';
import { DockCapabilities, dryTimeLabel, washFrequencyLabel, withWashFrequency } from '../shared/dock.js';
import { FanPower, MopRoute, WaterBoxMode, isDockedAndIdle } from '../shared/codes.js';
import {
  dryerSettingBody, encodeCleanMotorModeParams, ledStatusParams, motorModesForFallback, parseSmartWashSettings,
} from '../server/vacuum/commands.js';
import { writeJson, type JsonValue } from '../server/protocol/json.js';
import { answerInt } from '../server/util.js';

/* Cases copied from LocalRock's DockCapabilitiesTest, DryerSettingBodyTest, MotorModeFallbackTest, AnswerShapeTest and SmartWashSettingsTest. */

/** A hex newFeatureSet with the given bits set. */
function flags(...bits: number[]): string {
  const digits = new Array(38).fill(0);
  for (const b of bits) digits[digits.length - 1 - Math.floor(b / 4)] |= 1 << (b % 4);
  return digits.map((d) => d.toString(16)).join('');
}

describe('DockCapabilities', () => {
  it('uses the long interval list only on the legacy models', () => {
    for (const m of ['a26', 'a70', 'a76']) expect(new DockCapabilities(`roborock.vacuum.${m}`, null, null).washIntervals).toEqual([10, 15, 20, 25, 30, 35, 40, 45, 50]);
    for (const m of ['roborock.vacuum.a187', 'a187', null]) expect(new DockCapabilities(m, null, null).washIntervals).toEqual([10, 15, 20, 25]);
  });

  it('offers Smart frequency only with its own flag', () => {
    const ordinary = new DockCapabilities('a187', null, flags(34)).washFrequencyOptions;
    expect(ordinary.filter((o) => o.mode === 0).map((o) => o.intervalMinutes)).toEqual([10, 15, 20, 25]);
    expect(ordinary.at(-1)).toEqual({ label: 'By room', mode: 1, intervalMinutes: null });
    expect(new DockCapabilities('a187', null, flags(109)).washFrequencyOptions.at(-1)).toEqual({ label: 'Smart', mode: 2, intervalMinutes: null });
  });

  it('offers wash modes by dock type, flags and the plumbing bits', () => {
    const modes = (dock: number | undefined, dss: number | undefined, ...bits: number[]) =>
      new DockCapabilities('a187', null, flags(...bits)).washModes(dock, dss).map((m) => m[0]);
    expect(modes(17, undefined)).toEqual([0, 1, 2]);
    for (const d of [41, 42, 43, 46]) expect(modes(d, undefined)).toEqual([0]);
    for (const d of [undefined, 4, 12, 25, 36, 999]) expect(modes(d, 2, 15, 34, 107, 144)).toEqual([0]);
    expect(modes(17, undefined, 34)).toEqual([10, 0, 1, 2]);
    expect(modes(41, undefined, 150)).toEqual([10, 0]);
    expect(modes(41, undefined, 144)).toEqual([0, 1]);
    expect(modes(17, 1, 15)).toEqual([0, 1, 2]);
    expect(modes(17, 2, 15)).toEqual([0, 1, 2, 8]);
    expect(modes(17, 2, 15, 34)).toEqual([10, 0, 1, 2]);
    expect(modes(41, undefined, 15, 107, 150)).toEqual([10, 0, 8]);
  });

  it('reads simple docks\' wash codes as the official app does', () => {
    const ordinary = new DockCapabilities('a187', null, null);
    for (const d of [41, 42, 43, 46]) {
      expect(ordinary.washModeCode(2, d)).toBe(8);
      expect(ordinary.washModeCode(1, d)).toBe(10);
    }
    expect(new DockCapabilities('a187', null, flags(144)).washModeCode(1, 41)).toBe(1);
    expect(ordinary.washModeCode(2, 17)).toBe(2);
    expect(ordinary.washModeLabel(2, 41)).toBe('Super Deep');
    expect(new DockCapabilities('a187', null, flags(107)).washModeLabel(8, 17)).toBe('Soak');
    expect(ordinary.washModeLabel(99, 17)).toBe('Unknown (99)');
    expect(ordinary.washModeLabel(null, 17)).toBe('Unavailable');
  });

  it('takes auto-empty support from bit 25 of the decimal featureSet', () => {
    const supported = new DockCapabilities('a187', '33554432', null);
    expect(supported.autoEmptyModes.map((m) => m[0])).toEqual([0, 1, 2, 4]);
    for (const fs of [null, 'invalid', '67108864']) expect(new DockCapabilities('a187', fs, flags(25, 53)).autoEmptyModes).toEqual([]);
    expect(supported.autoEmptyModeLabel(3)).toBe('Strong');
    expect(supported.autoEmptyModeLabel(99)).toBe('Unknown (99)');
  });

  it('offers 3-5 h of drying on the deep-dry models and keeps an unlisted current time', () => {
    expect(new DockCapabilities('roborock.vacuum.a245', null, null).dryTimeOptions(null).map((c) => c[0])).toEqual([10_800, 14_400, 18_000]);
    expect(new DockCapabilities('a187', null, null).dryTimeOptions(5400).map((c) => c[1])).toEqual(['2 h', '3 h', '4 h', '90 min']);
    expect(dryTimeLabel(45)).toBe('45 s');
  });
});

describe('mop wash frequency', () => {
  it('parses the robot answer and keeps the interval for room and smart modes', () => {
    const s = parseSmartWashSettings({ smart_wash: 1, wash_interval: 1200 })!;
    expect(s).toEqual({ mode: 1, intervalSeconds: 1200 });
    expect(parseSmartWashSettings({ smart_wash: 0, wash_interval: 0 })).toBeNull();
    expect(withWashFrequency(s, 2, null)).toEqual({ mode: 2, intervalSeconds: 1200 });
    expect(withWashFrequency(s, 0, 25)).toEqual({ mode: 0, intervalSeconds: 1500 });
    expect(() => withWashFrequency(s, 0, null)).toThrow();
    expect(() => withWashFrequency(s, 0, 12)).toThrow();
    expect(washFrequencyLabel({ mode: 0, intervalSeconds: 900 })).toBe('15 min');
    expect(washFrequencyLabel({ mode: 1, intervalSeconds: 900 })).toBe('After each room');
  });
});

describe('dryer setting body', () => {
  // The answer a Qrevo Pro, an S8 Pro Ultra and a Qrevo Curv 2 Flow were all seen to give.
  const reported = {
    status: 1,
    on: { cliff_on: 1000, cliff_off: 1000, count: 10, dry_time: 14400, dry_heating_film_time: 3600 },
    off: { cliff_on: 500, cliff_off: 500, count: 10 },
  };

  it('changes only the status for the switch', () => {
    const body = dryerSettingBody(reported, false, null);
    expect(body).toEqual({ ...reported, status: 0 });
  });

  it('changes only dry_time inside the on block', () => {
    const body = dryerSettingBody(reported, true, 7200);
    expect(body).toEqual({ ...reported, on: { ...reported.on, dry_time: 7200 } });
    expect(reported.on.dry_time).toBe(14400);
  });

  it('sends only what is known without an answer', () => {
    expect(dryerSettingBody(null, true, 7200)).toEqual({ status: 1, on: { dry_time: 7200 } });
  });
});

describe('single mode change fallback', () => {
  // Values from a Saros 20 Neo (a296, firmware 02.29.56).
  it('resends the robot\'s own raw codes after a param refusal', () => {
    expect(motorModesForFallback(-10005, 102, 235, 300)).toEqual({ fan: 102, water: 235, mop: 300 });
  });
  it('does not retry other refusals or guess unknown values', () => {
    expect(motorModesForFallback(-10007, 102, 235, 300)).toBeNull();
    expect(motorModesForFallback(null, 102, 235, 300)).toBeNull();
    expect(motorModesForFallback(-10005, undefined, 235, 300)).toBeNull();
    expect(motorModesForFallback(-10005, 102, 235, null)).toBeNull();
  });
  it('leaves SmartPlan and per-room settings alone', () => {
    expect(motorModesForFallback(-10005, FanPower.SMART, WaterBoxMode.SMART, MopRoute.SMART)).toBeNull();
    expect(motorModesForFallback(-10005, FanPower.CUSTOM, WaterBoxMode.CUSTOM, MopRoute.CUSTOM)).toBeNull();
  });
  it('carries the codes unchanged', () => {
    expect(writeJson(encodeCleanMotorModeParams(103, 235, 300) as JsonValue)).toBe('[{"fan_power":103,"water_box_mode":235,"mop_mode":300}]');
  });
});

describe('robot settings', () => {
  it('reads a number whatever shape the answer has', () => {
    expect(answerInt(45)).toBe(45);
    expect(answerInt([45])).toBe(45);
    expect(answerInt({ led_status: 1 }, 'led_status')).toBe(1);
    expect(answerInt([{ carpet_clean_mode: 2 }], 'carpet_clean_mode')).toBe(2);
    expect(answerInt({ led_status: 1 })).toBeNull();
    expect(answerInt([])).toBeNull();
  });
  it('sends the status light as a bare value', () => {
    expect(writeJson(ledStatusParams(true))).toBe('[1]');
    expect(writeJson(ledStatusParams(false))).toBe('[0]');
  });
  it('counts a docked robot as idle only once the job is over', () => {
    expect(isDockedAndIdle({ state: 8, inCleaning: 0 })).toBe(true);
    expect(isDockedAndIdle({ state: 100, inCleaning: 0 })).toBe(true);
    expect(isDockedAndIdle({ state: 8, inCleaning: 1 })).toBe(false);
    expect(isDockedAndIdle({ state: 3, inCleaning: 0 })).toBe(false);
    expect(isDockedAndIdle({ state: 8 })).toBe(false);
  });
});

describe('robot list order', () => {
  it('sorts by name with numbers compared as numbers, then by device id', async () => {
    const { sortedForList } = await import('../server/app.js');
    const names = sortedForList([
      { name: 'Robot 10', duid: 'a' }, { name: 'robot 2', duid: 'b' }, { name: 'Kitchen', duid: 'c' }, { name: 'Robot 02', duid: 'd' }, { name: 'Kitchen', duid: 'b' },
    ]).map((d) => `${d.name}/${d.duid}`);
    expect(names).toEqual(['Kitchen/b', 'Kitchen/c', 'robot 2/b', 'Robot 02/d', 'Robot 10/a']);
  });
});

describe('room table', () => {
  it('reads tagged and untagged tables, and refuses mixed or broken ones', async () => {
    const { parseSegmentTable, nameSegmentData } = await import('../server/vacuum/commands.js');
    expect(parseSegmentTable([[16, '1001', 6], [17, 1002, 14]])).toEqual([{ segment: 16, roomId: '1001', tagId: 6 }, { segment: 17, roomId: '1002', tagId: 14 }]);
    expect(parseSegmentTable([[16, '1001'], [17, '1002']])).toEqual([{ segment: 16, roomId: '1001', tagId: null }, { segment: 17, roomId: '1002', tagId: null }]);
    expect(parseSegmentTable([])).toEqual([]);
    expect(parseSegmentTable([[16, '1001', 6], [17, '1002']])).toBeNull();
    expect(parseSegmentTable([[16]])).toBeNull();
    expect(parseSegmentTable({})).toBeNull();
    // An untagged row is written back with tag 12, as the official app did on such firmware.
    expect(writeJson(nameSegmentData([{ segment: 17, roomId: '1002', tagId: null }, { segment: 16, roomId: '1001', tagId: 6 }])))
      .toBe('[{"iotRoomId":"1001","robotRoomId":16,"robotTagId":6},{"iotRoomId":"1002","robotRoomId":17,"robotTagId":12}]');
  });
});

describe('routines', () => {
  it('says what happened, and throws when the server refused', async () => {
    const { routineRunMessage } = await import('../server/net/serverApi.js');
    expect(routineRunMessage('Evening', { accepted: true, status: 'started', activeSceneName: null })).toBe('"Evening" started');
    expect(routineRunMessage('Evening', { accepted: true, status: 'cancel_requested', activeSceneName: null })).toBe('Stopping "Evening"');
    expect(() => routineRunMessage('Evening', { accepted: false, status: 'routine_in_progress', activeSceneName: 'Morning' })).toThrow('"Morning" is still running. Run it again to stop it first.');
    expect(() => routineRunMessage('Evening', { accepted: false, status: 'offline', activeSceneName: null })).toThrow('The server did not start "Evening" (offline)');
  });
});

describe('maintenance', () => {
  it('rounds the life left up, as the official app does', async () => {
    const { percentLeft } = await import('../shared/codes.js');
    expect(percentLeft(0, 300)).toBe(100);
    expect(percentLeft(1, 300)).toBe(100);
    expect(percentLeft(150, 300)).toBe(50);
    expect(percentLeft(299, 300)).toBe(1);
    expect(percentLeft(400, 300)).toBe(0);
  });
});
