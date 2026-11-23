import { newFeatureBit } from './codes.js';

/*
 * What a robot's dock offers, ported from LocalRock's DockCapabilities.kt and DockOptions.kt
 * (which follow the official app's plugin). Shared so the page shows the same choices the server
 * accepts.
 */

/** One value a dock setting can have: the code the robot uses, and what to call it. */
export type DockChoice = [code: number, label: string];

export interface WashFrequencyOption {
  label: string;
  /** smart_wash: 0 by time, 1 after each room, 2 smart. */
  mode: number;
  intervalMinutes: number | null;
}

export interface SmartWashSettings {
  mode: number;
  intervalSeconds: number;
}

// Official plugin: FM.Dock.isOldWashFrequency, DockConfigs and getWashModes.
const LEGACY_WASH_MODELS = new Set(['a26', 'a27', 'a29', 'a30', 'a46', 'a47', 'a62', 'a64', 'a65', 'a66', 'a68', 'a69', 'a70', 'a76']);
// The a244/a245 (BerylLite) config sets isDeepDry: drying choices 3, 4 and 5 hours.
const DEEP_DRY_MODELS = new Set(['a244', 'a245']);
const SIMPLE_WASH_DOCK_TYPES = new Set([41, 42, 43, 46]);
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
// a187 plugin DockConfigs; charging and collection-only types excluded.
const KNOWN_WASH_DOCK_TYPES = new Set([2, 3, ...range(6, 11), ...range(13, 24), ...range(26, 35), ...range(37, 46)]);

/** Only 2 = hot water is confirmed on a robot; the other codes follow the official app's order. */
export const WASH_WATER_TEMPERATURES: DockChoice[] = [[0, 'Room temperature'], [1, 'Warm water'], [2, 'Hot water']];

export const AUTO_EMPTY_LABELS: Record<number, string> = { 0: 'Smart', 1: 'Light', 2: 'Balanced', 3: 'Strong', 4: 'Max' };

/** The label for `code`, or "Other (code)" so a value without a name is still shown. */
export function labelFor(choices: DockChoice[], code: number): string {
  return choices.find((c) => c[0] === code)?.[1] ?? `Other (${code})`;
}

/** How long a drying run lasts, from the robot's seconds: "2 h", "90 min". */
export function dryTimeLabel(seconds: number): string {
  if (seconds % 3600 === 0) return `${seconds / 3600} h`;
  if (seconds % 60 === 0) return `${seconds / 60} min`;
  return `${seconds} s`;
}

export function washFrequencyLabel(s: SmartWashSettings | null): string {
  if (!s) return 'Unavailable';
  switch (s.mode) {
    case 0: return s.intervalSeconds % 60 === 0 ? `${s.intervalSeconds / 60} min` : `${s.intervalSeconds} sec`;
    case 1: return 'After each room';
    case 2: return 'Smart';
    default: return `Unknown (${s.mode})`;
  }
}

/** The settings with a new frequency; room and smart modes keep the robot's interval. */
export function withWashFrequency(s: SmartWashSettings, mode: number, intervalMinutes: number | null): SmartWashSettings {
  if (mode < 0 || mode > 2) throw new Error('Unsupported mop washing frequency');
  if ((mode === 0) !== (intervalMinutes !== null)) throw new Error('Choose an interval for time-based washing');
  if (intervalMinutes !== null && (intervalMinutes < 10 || intervalMinutes > 50 || intervalMinutes % 5 !== 0)) {
    throw new Error('Invalid mop washing interval');
  }
  return { mode, intervalSeconds: intervalMinutes !== null ? intervalMinutes * 60 : s.intervalSeconds };
}

function modelSuffix(model: string | null | undefined): string | undefined {
  if (!model) return undefined;
  const i = model.lastIndexOf('.');
  return i >= 0 ? model.slice(i + 1) : model;
}

/** Bit `bit` of the decimal featureSet string. */
export function featureBit(featureSet: string | null | undefined, bit: number): boolean {
  if (!featureSet || !/^\d+$/.test(featureSet)) return false;
  return ((BigInt(featureSet) >> BigInt(bit)) & 1n) === 1n;
}

export class DockCapabilities {
  private readonly smartWash: boolean;
  private readonly superDeepWash: boolean;
  private readonly soakWash: boolean;
  private readonly aiWash: boolean;
  private readonly dryHours: number[];
  readonly washIntervals: number[];
  readonly washFrequencyOptions: WashFrequencyOption[];
  readonly autoEmptyModes: DockChoice[];

  constructor(model: string | null | undefined, featureSet: string | null | undefined, newFeatureSet: string | null | undefined) {
    this.smartWash = newFeatureBit(newFeatureSet, 34) || newFeatureBit(newFeatureSet, 150);
    this.superDeepWash = newFeatureBit(newFeatureSet, 15);
    this.soakWash = newFeatureBit(newFeatureSet, 107);
    this.aiWash = newFeatureBit(newFeatureSet, 144);
    const suffix = modelSuffix(model);
    this.dryHours = suffix && DEEP_DRY_MODELS.has(suffix) ? [3, 4, 5] : [2, 3, 4];
    this.washIntervals = suffix && LEGACY_WASH_MODELS.has(suffix) ? range(2, 10).map((i) => i * 5) : [10, 15, 20, 25];
    this.washFrequencyOptions = [
      ...this.washIntervals.map((m) => ({ label: `${m} min`, mode: 0, intervalMinutes: m })),
      { label: 'By room', mode: 1, intervalMinutes: null },
      ...(newFeatureBit(newFeatureSet, 109) ? [{ label: 'Smart', mode: 2, intervalMinutes: null }] : []),
    ];
    // Dust mode support is bit 25 of the decimal featureSet, not the hex newFeatureSet.
    this.autoEmptyModes = featureBit(featureSet, 25) ? [[0, 'Smart'], [1, 'Light'], [2, 'Balanced'], [4, 'Max']] : [];
  }

  /** The drying times the official app offers this model, plus `current` when the robot reports another. */
  dryTimeOptions(current: number | null): DockChoice[] {
    const offered: DockChoice[] = this.dryHours.map((h) => [h * 3600, `${h} h`]);
    return current === null || offered.some((c) => c[0] === current) ? offered : [...offered, [current, dryTimeLabel(current)]];
  }

  washModes(dockType: number | undefined, dss: number | undefined): DockChoice[] {
    if (dockType === undefined || !KNOWN_WASH_DOCK_TYPES.has(dockType)) return [[0, 'Light']];
    const simple = SIMPLE_WASH_DOCK_TYPES.has(dockType);
    const out: DockChoice[] = [];
    if (this.smartWash) out.push([10, 'Smart']);
    out.push([0, 'Light']);
    if (!simple || this.aiWash) out.push([1, 'Balanced']);
    if (!simple) out.push([2, 'Deep']);
    // dss low bits report the plumbing module; a dock type alone cannot establish it.
    if (this.superDeepWash && (this.soakWash || (dss !== undefined && (dss & 3) === 2 && !this.smartWash))) {
      out.push([8, this.soakWash ? 'Soak' : 'Super Deep']);
    }
    return out;
  }

  /** The code the picker shows for what the robot reports; simple docks report other numbers. */
  washModeCode(raw: number | null, dockType: number | undefined): number | null {
    if (dockType === undefined || !SIMPLE_WASH_DOCK_TYPES.has(dockType)) return raw;
    if (raw === 2) return 8;
    if (raw === 1 && !this.aiWash) return 10;
    return raw;
  }

  washModeLabel(raw: number | null, dockType: number | undefined): string {
    const mode = this.washModeCode(raw, dockType);
    switch (mode) {
      case null: return 'Unavailable';
      case 0: return 'Light';
      case 1: return 'Balanced';
      case 2: return 'Deep';
      case 8: return this.soakWash ? 'Soak' : 'Super Deep';
      case 10: return 'Smart';
      default: return `Unknown (${mode})`;
    }
  }

  autoEmptyModeLabel(mode: number | null): string {
    if (mode === null) return 'Unavailable';
    return AUTO_EMPTY_LABELS[mode] ?? `Unknown (${mode})`;
  }
}
