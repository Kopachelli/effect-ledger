import { createHash } from 'node:crypto';

/** Deterministic JSON serialization: object keys sorted recursively. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new TypeError('Cannot fingerprint non-finite numbers.');
    }
    if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
      throw new TypeError(`Cannot fingerprint value of type ${typeof value}.`);
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

/** SHA-256 fingerprint of an operation input. */
export function fingerprintOf(input: unknown): string {
  return createHash('sha256').update(stableStringify(input)).digest('hex');
}
