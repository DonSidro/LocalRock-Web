import { describe, expect, it } from 'vitest';
import {
  cleanSequenceFor, customizeCleanModeData, encodeCarpetAreaParams, encodeGroundMaterialParams, encodeNameMultiMapParams,
  encodeThresholdParams, labStatusData, mergeSegmentData, nameSegmentData, parseCleanSequence, parseCustomizeCleanMode,
  parseSegmentRenumbering, roomCleanModesStored, saveMapData, sendDataCommand, splitLineAttempts, splitSegmentData,
  withRetry, SPLIT_FAILED_CODE, PARAM_FORMAT_REFUSED_CODE,
} from '../server/vacuum/commands.js';
import { MapEditError, RobotSilentError } from '../server/vacuum/errors.js';
import { writeJson, type JsonValue } from '../server/protocol/json.js';
import type { V1Response } from '../server/protocol/envelope.js';
import { rectZone, thresholdStrip, type MapZone, type VirtualWall } from '../shared/map.js';
import { mapNameBlocker, loadedMapFlag, unsavedMapPresent, UNSAVED_MAP_FLAG, isSmartPlanSupported, isWaterSlideSupported } from '../shared/codes.js';
import { saveMapIndex, mapIndexBlocker } from '../shared/mapEdit.js';
import { sameZones } from '../shared/verification.js';

/* Expected strings copied from LocalRock's MapEditCommandsTest, CleanSequenceTest and RoomCleanModesTest (captures of the official app). */

const j = (v: JsonValue) => writeJson(v);
const wallA: VirtualWall = { x0: 24433, y0: 18882, x1: 22220, y1: 16918 };
const wallB: VirtualWall = { x0: 29245, y0: 23791, x1: 29256, y1: 22326 };
const zone = (c: number[], kind: MapZone['kind'], flags?: number): MapZone => ({
  x0: c[0]!, y0: c[1]!, x1: c[2]!, y1: c[3]!, x2: c[4]!, y2: c[5]!, x3: c[6]!, y3: c[7]!, kind, ...(flags !== undefined ? { flags } : {}),
});
const noGo = zone([30233, 24477, 31623, 24477, 31623, 23066, 30233, 23066], 'NO_GO');

describe('map edit payloads', () => {
  it('save_map matches the capture', () => {
    expect(j(withRetry(saveMapData([], [wallA, wallB], 0))))
      .toBe('{"data":[[1,24433,18882,22220,16918],[1,29245,23791,29256,22326],[100,0]],"need_retry":1}');
    expect(j(withRetry(saveMapData([noGo], [wallA, wallB], 0))))
      .toBe('{"data":[[1,24433,18882,22220,16918],[1,29245,23791,29256,22326],[0,30233,24477,31623,24477,31623,23066,30233,23066],[100,0]],"need_retry":1}');
  });

  it('editor rectangles use the captured corner order', () => {
    expect(rectZone(31623, 23066, 30233, 24477, 'NO_GO')).toEqual(noGo);
  });

  it('save_map enforces map index, vertex limit and bounds', () => {
    // A robot whose only map is map 1 (a Qrevo S Pro) took [100, 1].
    expect(j(saveMapData([noGo], [], 1))).toBe(j([[0, 30233, 24477, 31623, 24477, 31623, 23066, 30233, 23066], [100, 1]]));
    const zones = Array.from({ length: 17 }, () => noGo);
    expect(() => saveMapData(zones, [], 0)).not.toThrow();
    expect(() => saveMapData(zones, [wallA], 0)).toThrow(MapEditError);
    expect(() => saveMapData([], [{ x0: -1, y0: 0, x1: 10, y1: 10 }], 0)).toThrow(MapEditError);
    expect(() => saveMapData([], [{ x0: 0, y0: 0, x1: 51_201, y1: 10 }], 0)).toThrow(MapEditError);
  });

  it('split, merge, material and name_segment match the captures', () => {
    expect(j(withRetry(splitSegmentData(23, 24950, 21350, 24950, 20500)))).toBe('{"data":[23,24950,21350,24950,20500],"need_retry":1}');
    expect(j(withRetry(mergeSegmentData(18, 27)))).toBe('{"data":[18,27],"need_retry":1}');
    expect(j(encodeGroundMaterialParams(21, 4, null))).toBe('{"data":[[21,4,-1]]}');
    expect(j(encodeGroundMaterialParams(24, 3, 90))).toBe('{"data":[[24,3,90]]}');
    const table = [
      { segment: 26, roomId: '12916427', tagId: 6 },
      { segment: 16, roomId: '12916445', tagId: 2 },
      { segment: 17, roomId: '12916459', tagId: 14 },
    ];
    expect(j(withRetry(nameSegmentData(table)))).toBe(
      '{"data":[{"iotRoomId":"12916445","robotRoomId":16,"robotTagId":2},{"iotRoomId":"12916459","robotRoomId":17,"robotTagId":14},{"iotRoomId":"12916427","robotRoomId":26,"robotTagId":6}],"need_retry":1}',
    );
    expect([...parseSegmentRenumbering([{ oldId: 16, newId: 16 }, { oldId: 24, newId: 27 }])]).toEqual([[16, 16], [24, 27]]);
    expect(parseSegmentRenumbering(['ok']).size).toBe(0);
  });

  it('split lines go lower-Y first, then reversed', () => {
    const [first, second] = splitLineAttempts([25000, 26450], [25000, 24050]);
    expect(j(withRetry(splitSegmentData(1, first![0]![0]!, first![0]![1]!, first![1]![0]!, first![1]![1]!))))
      .toBe('{"data":[1,25000,24050,25000,26450],"need_retry":1}');
    expect(second).toEqual([[25000, 26450], [25000, 24050]]);
  });

  const carpetA = zone([30660, 24711, 32317, 24711, 32317, 23109, 30660, 23109], 'CARPET');
  const carpetB = zone([25603, 21237, 28555, 21237, 28555, 18284, 25603, 18284], 'CARPET');
  const thresholdA = zone([30294, 26592, 30281, 25684, 30167, 25685, 30180, 26593], 'THRESHOLD');
  const thresholdB = zone([26240, 17598, 27347, 16642, 27273, 16556, 26165, 17512], 'THRESHOLD');

  it('carpets and thresholds match the captures', () => {
    expect(j(encodeCarpetAreaParams([carpetA, carpetB], 0, false)))
      .toBe('{"map_index":0,"type":1,"zone_data":[[30660,24711,32317,24711,32317,23109,30660,23109],[25603,21237,28555,21237,28555,18284,25603,18284]]}');
    // Any single map's index is sent, not only map 0.
    expect(JSON.parse(j(encodeCarpetAreaParams([carpetA], 1, false))).map_index).toBe(1);
    expect(j(encodeThresholdParams([thresholdA, thresholdB], 0)))
      .toBe('{"map_index":0,"sides_infos":[[0,0,0,0],[0,0,0,0]],"zones":[[2,30294,26592,30281,25684,30167,25685,30180,26593],[2,26240,17598,27347,16642,27273,16556,26165,17512]]}');
    const round = zone([25744, 26784, 26536, 26784, 26536, 25992, 25744, 25992], 'CARPET', 0x0633e700);
    const rect = zone([24837, 26196, 25629, 26196, 25629, 25404, 24837, 25404], 'CARPET');
    expect(j(encodeCarpetAreaParams([round, rect], 0, true)))
      .toBe('{"flags":[104064768,36929536],"map_index":0,"type":1,"zone_data":[[25744,26784,26536,26784,26536,25992,25744,25992],[24837,26196,25629,26196,25629,25404,24837,25404]]}');
  });

  it('threshold strips rebuild the official app thresholds within 1 mm', () => {
    for (const t of [thresholdA, thresholdB]) {
      const r = thresholdStrip([Math.trunc((t.x0 + t.x3) / 2), Math.trunc((t.y0 + t.y3) / 2)], [Math.trunc((t.x1 + t.x2) / 2), Math.trunc((t.y1 + t.y2) / 2)]);
      const e = [t.x0, t.y0, t.x1, t.y1, t.x2, t.y2, t.x3, t.y3];
      const a = [r.x0, r.y0, r.x1, r.y1, r.x2, r.y2, r.x3, r.y3];
      e.forEach((v, i) => expect(Math.abs(v - a[i]!)).toBeLessThanOrEqual(1));
    }
    expect(() => thresholdStrip([100, 100], [100, 100])).toThrow();
    expect(sameZones([carpetA], [{ ...carpetA, x0: carpetA.x0 + 40 }])).toBe(true);
    expect(sameZones([carpetA], [{ ...carpetA, x0: carpetA.x0 + 60 }])).toBe(false);
  });

  it('map management payloads match the captures', () => {
    expect(j(encodeNameMultiMapParams(0, 'Test'))).toBe('[{"length":4,"multi_map":0,"name":"Test"}]');
    expect(() => encodeNameMultiMapParams(0, 'Første sal')).toThrow(MapEditError);
    expect(mapNameBlocker('Hus')).toBeNull();
    expect(mapNameBlocker('1st floor - East')).toBeNull();
    expect(mapNameBlocker('   ')).not.toBeNull();
    expect(mapNameBlocker('Kælder')).not.toBeNull();
    expect(j(withRetry([1]))).toBe('{"data":[1],"need_retry":1}');
    expect(j(withRetry(labStatusData(1, 0)))).toBe('{"data":[{"lab_status":1,"reserve_map":0}],"need_retry":1}');
    expect(j(withRetry(labStatusData(3, null)))).toBe('{"data":[{"lab_status":3}],"need_retry":1}');
    expect(j(labStatusData(1, null))).toBe('[{"lab_status":1}]');
  });

  it('knows the save map index and loaded map', () => {
    expect(saveMapIndex([{ mapFlag: 0 }])).toBe(0);
    expect(saveMapIndex([])).toBeNull();
    expect(saveMapIndex([{ mapFlag: 0 }, { mapFlag: 1 }])).toBeNull();
    expect(mapIndexBlocker(0)).toBeNull();
    expect(mapIndexBlocker(1)).toBeNull();
    expect(mapIndexBlocker(null)).not.toBeNull();
    expect(loadedMapFlag({ mapStatus: 7 })).toBe(1);
    expect(loadedMapFlag({ mapStatus: 11 })).toBe(2);
    expect(loadedMapFlag({ mapStatus: 253 })).toBe(UNSAVED_MAP_FLAG);
    expect(unsavedMapPresent({ mapStatus: 253 })).toBe(true);
    expect(unsavedMapPresent({ mapStatus: 252 })).toBe(false);
    expect(unsavedMapPresent({ mapStatus: 7 })).toBe(false);
  });
});

describe('wrapped / plain fallback', () => {
  const ok: V1Response = { id: 1, result: ['ok'], error: null };
  const refused = (code: number, message: string): V1Response => ({ id: 1, result: null, error: { code, message } });

  async function send(format: { plain: boolean }, sent: string[], answer: (wrapped: boolean) => V1Response) {
    return sendDataCommand(format, [1], async (params, wrapped) => {
      sent.push(j(params));
      return answer(wrapped);
    });
  }

  it('keeps the wrapped form when the robot takes it', async () => {
    const f = { plain: false }, sent: string[] = [];
    expect(await send(f, sent, () => ok)).toEqual(ok);
    expect(sent).toEqual(['{"data":[1],"need_retry":1}']);
    expect(f.plain).toBe(false);
  });

  it('falls back to plain on -10005 and stays there', async () => {
    const f = { plain: false }, sent: string[] = [];
    await send(f, sent, (w) => (w ? refused(-10005, 'Param is not an array') : ok));
    expect(sent).toEqual(['{"data":[1],"need_retry":1}', '[1]']);
    expect(f.plain).toBe(true);
    sent.length = 0;
    await send(f, sent, () => ok);
    expect(sent).toEqual(['[1]']);
  });

  it('falls back to plain on silence', async () => {
    const f = { plain: false }, sent: string[] = [];
    const answer = await sendDataCommand(f, [1], async (params, wrapped) => {
      sent.push(j(params));
      if (wrapped) throw new RobotSilentError('load_multi_map');
      return ok;
    });
    expect(answer).toEqual(ok);
    expect(sent).toEqual(['{"data":[1],"need_retry":1}', '[1]']);
    expect(f.plain).toBe(true);
  });

  it('does not retry other refusals and does not remember a refused plain form', async () => {
    const f = { plain: false }, sent: string[] = [];
    const a = await send(f, sent, () => refused(SPLIT_FAILED_CODE, 'Split map failed'));
    expect(a.error?.['code']).toBe(SPLIT_FAILED_CODE);
    expect(sent.length).toBe(1);
    const f2 = { plain: false }, sent2: string[] = [];
    const b = await send(f2, sent2, () => refused(-10005, 'Invalid parameters'));
    expect(b.error?.['code']).toBe(PARAM_FORMAT_REFUSED_CODE);
    expect(sent2.length).toBe(2);
    expect(f2.plain).toBe(false);
  });
});

describe('cleaning order and per-room settings', () => {
  it('builds the sequence to store', () => {
    expect(cleanSequenceFor([22], [17, 25])).toBeNull();
    expect(cleanSequenceFor([17, 25], [17, 25, 22])).toBeNull();
    expect(cleanSequenceFor([25, 22], [17, 25])).toEqual([25, 22, 17]);
    expect(cleanSequenceFor([25, 17], [17, 25, 22])).toEqual([25, 17, 22]);
    expect(parseCleanSequence([23, 26, 19])).toEqual([23, 26, 19]);
    expect(parseCleanSequence('x')).toEqual([]);
    expect(j(withRetry([23, 26, 19, 16, 22, 25, 17]))).toBe('{"data":[23,26,19,16,22,25,17],"need_retry":1}');
  });

  it('encodes and checks per-room settings', () => {
    const modes = [{ segment: 22, fanPower: 105, waterBoxMode: 201, mopMode: 300 }];
    expect(j(withRetry(customizeCleanModeData(modes))))
      .toBe('{"data":[{"fan_power":105,"mop_mode":300,"segment":22,"water_box_mode":201}],"need_retry":1}');
    expect(() => customizeCleanModeData([])).toThrow(MapEditError);
    expect(() => customizeCleanModeData([{ segment: 1, fanPower: 105, waterBoxMode: 200, mopMode: 300 }])).toThrow(MapEditError);
    const parsed = parseCustomizeCleanMode([{ fan_power: 105, mop_mode: 300, segment: 22, water_box_mode: 225 }, { segment: 3 }]);
    expect(parsed).toEqual([{ segment: 22, fanPower: 105, waterBoxMode: 225, mopMode: 300 }]);
    expect(roomCleanModesStored(modes, parsed)).toBe(true);
  });

  it('reads feature bits', () => {
    expect(isSmartPlanSupported('00000048009EFFFE')).toBe(false);
    expect(isWaterSlideSupported('00000048009EFFFE')).toBe(false);
    expect(isSmartPlanSupported('0080000000000000')).toBe(true);
    expect(isSmartPlanSupported(null)).toBe(false);
  });
});
