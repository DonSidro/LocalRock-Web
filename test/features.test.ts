import { describe, expect, it } from 'vitest';
import {
  BETA_SHAPE_REFUSAL_CODES, FEATURE_DEFS, betaSetParamCandidates, betaSetTryOrder, choiceLabelFor, featureDef, featureEnabled,
  featureReadOrder, featureSetFromInitStatus, featureSetParamCandidates, featureToggleable, newFeatureInfoFromInitStatus,
  parseBetaReply, parseFeatureReply, supportedFeatures, unlistedAdvertisedFeatures, withoutReplaced,
} from '../shared/features.js';

/* Cases copied from LocalRock's BetaFeaturesTest, FeatureSetFromInitStatusTest and RobotFeatureFlagsTest. */

function flags(...bits: number[]): string {
  const digits = new Array(40).fill(0);
  for (const b of bits) digits[digits.length - 1 - Math.floor(b / 4)] |= 1 << (b % 4);
  return digits.map((d) => d.toString(16)).join('');
}
const gated = (set: string | null) => supportedFeatures(set).filter((d) => d.bit !== null).map((d) => d.id);

describe('robot options', () => {
  it('follow the feature bits', () => {
    expect(gated(flags(3))).toEqual(['carpet_deep_clean']);
    expect(gated(flags(112))).toEqual(['clean_fluid_delivery']);
    expect(gated('0')).toEqual([]);
    expect(gated(flags(154))).toContain('uncleaned_area_reminder');
    expect(gated(flags(154))).not.toContain('climbing_arms_high_sill');
    expect(gated(flags(105))).toEqual(['avoid_carpet_wires']);
    expect(gated(flags(70))).toEqual(['cleaning_pattern']);
  });

  it('always offer the options without a known bit, and read them last', () => {
    expect(supportedFeatures('0').map((d) => d.id)).toEqual(FEATURE_DEFS.filter((d) => d.bit === null).map((d) => d.id));
    const defs = supportedFeatures(flags(3, 54, 70));
    const order = featureReadOrder(defs);
    const firstUngated = order.findIndex((d) => d.bit === null);
    expect(firstUngated).toBeGreaterThan(0);
    expect(order.slice(firstUngated).every((d) => d.bit === null)).toBe(true);
    expect(order.slice(firstUngated).map((d) => d.id)).toContain('carpet_boost');
  });

  it('only read named robot settings from robots that advertise them', () => {
    expect(FEATURE_DEFS.filter((d) => d.settingName).every((d) => d.bit !== null)).toBe(true);
  });

  it('parse the usual reply shapes', () => {
    expect(parseBetaReply([{ status: 1 }])).toEqual({ key: 'status', value: 1 });
    expect(parseBetaReply({ status: 0 })).toEqual({ key: 'status', value: 0 });
    expect(parseBetaReply([1])).toEqual({ key: null, value: 1 });
    expect(parseBetaReply(0)).toEqual({ key: null, value: 0 });
    for (const bad of [null, ['ok'], { a: 1, b: 2 }, []]) expect(parseBetaReply(bad)).toBeNull();
  });

  it('read a field of a larger reply, and a bit mask for carpet first', () => {
    const first = featureDef('carpet_first')!;
    const r = parseFeatureReply(first, [{ state: 8, switch_status: 9 }])!;
    expect(r.value).toBe(9);
    expect(featureEnabled(first, 9)).toBe(true);
    expect(featureEnabled(first, 1)).toBe(false);
    expect(featureToggleable(first, 0)).toBe(true);
  });

  it('try the reply shape first, then the other forms', () => {
    expect(betaSetParamCandidates('status', 1)).toEqual([[{ status: 1 }], { status: 1 }, [1]]);
    expect(betaSetParamCandidates(null, 0)).toEqual([[0]]);
    const boost = featureDef('carpet_boost')!;
    const reply = { enable: 1, stall_time: 10 };
    expect(featureSetParamCandidates(boost, { id: 'carpet_boost', value: 1, key: 'enable', reply }, 0)).toEqual([[{ enable: 0, stall_time: 10 }], { enable: 0, stall_time: 10 }]);
    expect(featureSetParamCandidates(boost, { id: 'carpet_boost', value: 1, key: 'enable', reply: null }, 0)).toEqual([]);
    expect(featureSetParamCandidates(featureDef('collision_mode')!, { id: 'collision_mode', value: 1, key: null, reply: null }, 2)).toEqual([{ status: 2 }, [{ status: 2 }]]);
  });

  it('try the accepted shape first, and move on after either param refusal', () => {
    expect(betaSetTryOrder(3, undefined)).toEqual([0, 1, 2]);
    expect(betaSetTryOrder(3, 1)).toEqual([1, 0, 2]);
    expect(betaSetTryOrder(3, 2)).toEqual([2, 0, 1]);
    expect(betaSetTryOrder(1, 2)).toEqual([0]);
    expect(BETA_SHAPE_REFUSAL_CODES.has(-10007) && BETA_SHAPE_REFUSAL_CODES.has(-10005) && !BETA_SHAPE_REFUSAL_CODES.has(-10004)).toBe(true);
  });

  it('drop the option a newer one replaces only once the newer one answered', () => {
    expect(withoutReplaced([{ id: 'follow_ground_material' }, { id: 'cleaning_pattern' }]).map((s) => s.id)).toEqual(['cleaning_pattern']);
    expect(withoutReplaced([{ id: 'follow_ground_material' }]).map((s) => s.id)).toEqual(['follow_ground_material']);
    expect(withoutReplaced([{ id: 'avoid_collision' }, { id: 'collision_mode' }]).map((s) => s.id)).toEqual(['collision_mode']);
  });

  it('name the choices, and show an unknown value', () => {
    const pattern = featureDef('cleaning_pattern')!;
    expect(choiceLabelFor(pattern.choices!, 0)).toBe('Smart');
    expect(choiceLabelFor(pattern.choices!, 1)).toBe('Along floor direction');
    expect(choiceLabelFor(pattern.choices!, 7)).toBe('Other (7)');
    expect(featureToggleable(pattern, 2)).toBe(true);
    expect(featureToggleable(featureDef('gap_deep_clean')!, 2)).toBe(false);
  });

  it('list advertised features without a switch by name', () => {
    expect(unlistedAdvertisedFeatures(flags(44))).toEqual([{ bit: 44, name: null }]);
    expect(unlistedAdvertisedFeatures(flags(89))).toEqual([{ bit: 89, name: 'Mechanical arm mode' }]);
    expect(unlistedAdvertisedFeatures(flags(67, 63, 37))).toEqual([]);
    expect(unlistedAdvertisedFeatures(null)).toEqual([]);
    expect(unlistedAdvertisedFeatures('')).toEqual([]);
  });
});

describe('the robot\'s own feature flags', () => {
  it('come from app_get_init_status', () => {
    const answer = [{ new_feature_info: 636084721975295, new_feature_info_str: '0000000000000000000000400000003000C02FFF' }];
    expect(featureSetFromInitStatus(answer)).toBe('0000000000000000000000400000003000C02FFF');
    expect(newFeatureInfoFromInitStatus(answer)).toBe('636084721975295');
    expect(featureSetFromInitStatus([{ new_feature_info_str: '' }])).toBeNull();
    expect(featureSetFromInitStatus([{ new_feature_info_str: 'xyz' }])).toBeNull();
    expect(featureSetFromInitStatus('ok')).toBeNull();
  });
});

describe('map edits the robot cannot store', () => {
  it('grey out carpets and thresholds from the robot\'s own flags', async () => {
    const { advertisedUnsupportedMapEdits, unsupportedMapEditMessage, unsupportedMapEditNote } = await import('../shared/mapEdit.js');
    // An S7 on 02.16.12: new_feature_info 636084721975295 has bit 30 clear; the str's last 8 chars have neither sill mask.
    expect(advertisedUnsupportedMapEdits('636084721975295', '0000000000000000000000400000003000C0001F', false, false)).toEqual(['CARPET', 'THRESHOLD']);
    expect(advertisedUnsupportedMapEdits(String(2 ** 30), '00000420', false, false)).toEqual([]);
    expect(advertisedUnsupportedMapEdits('636084721975295', '0000001F', true, true)).toEqual([]);
    expect(advertisedUnsupportedMapEdits(null, null, false, false)).toEqual([]);
    expect(unsupportedMapEditMessage(['CARPET'], true)).toBe("This robot doesn't support carpet areas, so they were not saved. Your other changes were saved.");
    expect(unsupportedMapEditNote(['CARPET', 'THRESHOLD'])).toBe("This robot doesn't support carpet areas or thresholds.");
    expect(unsupportedMapEditNote([])).toBeNull();
  });
});

describe('vacuum then mop', () => {
  it('sends repeat only for type 1', async () => {
    const { cleanSequenceTypeParams } = await import('../server/vacuum/commands.js');
    expect(cleanSequenceTypeParams(1, 102, 202, 300, 1)).toEqual({ type: 1, fan_power: 102, water_box_mode: 202, mop_mode: 300, repeat: 1 });
    expect(cleanSequenceTypeParams(0, 102, 202, 300, 1)).toEqual({ type: 0, fan_power: 102, water_box_mode: 202, mop_mode: 300 });
    expect(cleanSequenceTypeParams(1, 105, 202, 300)).toEqual({ type: 1, fan_power: 105, water_box_mode: 202, mop_mode: 300 });
  });
});
