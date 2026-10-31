import type { JSONValue } from './types';

export const JSON_LIMITS = { depth: 16, values: 6000, bytes: 128 * 1024, text: 8192 } as const;
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Visit before serializing: hostile depth, cycles and giant collections cannot monopolize the UI thread.
// maxDepth and maxValues stay explicit opt-ins: manifests need room for a 16-level declarative page
// body below their own envelope and a host-sized table panel holds far more than 6000 values, while
// every other call keeps the defaults.
export function boundedJSON(value: unknown, maxBytes: number = JSON_LIMITS.bytes, maxText: number = JSON_LIMITS.text, maxDepth: number = JSON_LIMITS.depth, maxValues: number = JSON_LIMITS.values): JSONValue {
  let count = 0;
  // Token bytes are a safe lower bound; the final check also counts container punctuation.
  let bytes = 0;
  const seen = new Set<object>();
  const charge = (text: string) => {
    if (text.length > maxText) throw new Error('plugin.ui.invalid_data');
    bytes += new TextEncoder().encode(JSON.stringify(text)).length;
    if (bytes > maxBytes) throw new Error('plugin.ui.invalid_data');
  };
  const visit = (item: unknown, depth: number): void => {
    if (++count > maxValues || depth > maxDepth) throw new Error('plugin.ui.invalid_data');
    if (item === null || typeof item === 'boolean') { bytes += JSON.stringify(item).length; return; }
    if (typeof item === 'number' && Number.isFinite(item)) { bytes += JSON.stringify(item).length; return; }
    if (typeof item === 'string') { charge(item); return; }
    if (typeof item !== 'object' || item === null || seen.has(item)) throw new Error('plugin.ui.invalid_data');
    seen.add(item);
    if (Array.isArray(item)) {
      if (item.length > maxValues) throw new Error('plugin.ui.invalid_data');
      item.forEach((child) => visit(child, depth + 1));
    } else {
      const keys = Object.keys(item);
      if (keys.length > maxValues) throw new Error('plugin.ui.invalid_data');
      for (const key of keys) {
        if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('plugin.ui.invalid_data');
        charge(key);
        visit((item as Record<string, unknown>)[key], depth + 1);
      }
    }
    seen.delete(item);
  };
  visit(value, 0);
  if (bytes > maxBytes || new TextEncoder().encode(JSON.stringify(value)).length > maxBytes) {
    throw new Error('plugin.ui.invalid_data');
  }
  return value as JSONValue;
}
