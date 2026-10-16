/*
 * Compact JSON writer for robot commands. JSON.stringify cannot write a Kotlin-style double such
 * as 0.0, which the app sends for app_rc_move; JsonDouble carries that, everything else is written
 * exactly as JSON.stringify would (insertion order, no spaces).
 */

export class JsonDouble {
  constructor(readonly value: number) {}

  /** Kotlin's Double.toString for the values the app sends: 0.3 -> "0.3", 0 -> "0.0". */
  literal(): string {
    if (!Number.isFinite(this.value)) throw new Error('Non-finite number in robot command');
    return Number.isInteger(this.value) ? this.value.toFixed(1) : String(this.value);
  }
}

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonDouble
  | JsonValue[]
  | { [key: string]: JsonValue };

export function writeJson(value: JsonValue): string {
  if (value === null) return 'null';
  if (value instanceof JsonDouble) return value.literal();
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new Error('Non-finite number in robot command');
      return JSON.stringify(value);
    case 'string':
      return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(writeJson).join(',')}]`;
  const parts: string[] = [];
  for (const [k, v] of Object.entries(value)) {
    if (v === undefined) continue;
    parts.push(`${JSON.stringify(k)}:${writeJson(v)}`);
  }
  return `{${parts.join(',')}}`;
}
