import { describe, expect, it } from 'vitest';
import { boundedJSON, JSON_LIMITS } from './jsonBoundary';

describe('boundedJSON serialized token budget', () => {
  it.each([
    ['null', null], ['true', true], ['false', false],
    ['zero', 0], ['negative zero', -0], ['negative integer', -42], ['decimal', -1.25],
    ['negative exponent', 1e-7], ['positive exponent', 1e21], ['largest number', Number.MAX_VALUE],
    ['ASCII', 'a'], ['Chinese', '中文'], ['quote', '"'], ['backslash', '\\'],
    ['short control escapes', '\b\f\n\r\t'], ['unicode control escape', '\u0000'],
    ['lone surrogate', '\ud800'], ['surrogate pair', '😀'],
  ])('uses the actual JSON bytes for %s', (_, value) => {
    const bytes = new TextEncoder().encode(JSON.stringify(value)).length;
    expect(boundedJSON(value, bytes)).toBe(value);
    expect(() => boundedJSON(value, bytes - 1)).toThrow('plugin.ui.invalid_data');
  });
});

describe('boundedJSON serialized container budget', () => {
  it.each([
    ['empty array', []], ['empty object', {}], ['array separators', [0, null, true, false, -1.25, 1e-7, 1e21]],
    ['escaped keys and values', { '"\\\n中文': '\u0000中文', empty: [], nested: {} }],
    ['nested empty containers', [[], {}, { rows: [{ c0: 0, c1: 0 }] }]],
  ])('counts punctuation and escaped keys for %s', (_, value) => {
    const bytes = new TextEncoder().encode(JSON.stringify(value)).length;
    expect(boundedJSON(value, bytes)).toBe(value);
    expect(() => boundedJSON(value, bytes - 1)).toThrow('plugin.ui.invalid_data');
  });
  it('rejects escaped text over the byte budget before visiting later data', () => {
    let reads = 0;
    const value = { text: '\u0000'.repeat(20), get later() { reads += 1; return null; } };
    expect(() => boundedJSON(value, 100)).toThrow('plugin.ui.invalid_data');
    expect(reads).toBe(0);
  });
});

describe('boundedJSON preflight safety', () => {
  it.each([undefined, NaN, Infinity, -Infinity, 1n, Symbol('not JSON'), () => null])('rejects non-JSON value %s', (value) => {
    expect(() => boundedJSON(value)).toThrow('plugin.ui.invalid_data');
    expect(() => boundedJSON({ value })).toThrow('plugin.ui.invalid_data');
  });
  it.each(['__proto__', 'constructor', 'prototype'])('rejects pollution key %s', (key) => {
    expect(() => boundedJSON(JSON.parse(`{"${key}":0}`))).toThrow('plugin.ui.invalid_data');
  });
  it('rejects cycles but accepts shared acyclic references', () => {
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    expect(() => boundedJSON(cyclic)).toThrow('plugin.ui.invalid_data');
    const shared = { value: 0 };
    expect(boundedJSON([shared, shared])).toEqual([shared, shared]);
  });
});

describe('boundedJSON defaults', () => {
  it('keeps every default cap for callers that pass nothing', () => {
    expect(() => boundedJSON('a'.repeat(JSON_LIMITS.text + 1))).toThrow('plugin.ui.invalid_data');
    expect(() => boundedJSON(Array.from({ length: JSON_LIMITS.values + 1 }, () => null))).toThrow('plugin.ui.invalid_data');
    let deep: Record<string, unknown> = { leaf: 1 };
    for (let level = 0; level <= JSON_LIMITS.depth; level += 1) deep = { nested: deep };
    expect(() => boundedJSON(deep)).toThrow('plugin.ui.invalid_data');
  });
});

describe('boundedJSON value budget', () => {
  it('honours an explicit budget instead of the hardcoded default', () => {
    const items = Array.from({ length: JSON_LIMITS.values + 1 }, () => null);
    expect(boundedJSON(items, 1 << 20, 256 << 10, 64, 1 << 20)).toBe(items);
  });
  it('rejects a payload past the explicit budget', () => {
    const items = Array.from({ length: 11 }, () => null);
    expect(() => boundedJSON(items, 1 << 20, 256 << 10, 64, 10)).toThrow('plugin.ui.invalid_data');
    expect(() => boundedJSON({ keys: 1 }, 1 << 20, 256 << 10, 64, 0)).toThrow('plugin.ui.invalid_data');
  });
  it('lets the byte budget bind before the value budget', () => {
    // null 的真实 JSON token 为 4 字节，数组还需逗号和括号；这里由较小的字节预算先触发。
    const items = Array.from({ length: 1000 }, () => null);
    expect(() => boundedJSON(items, 100, JSON_LIMITS.text, 64, 2000)).toThrow('plugin.ui.invalid_data');
    expect(boundedJSON(items, 1 << 20, JSON_LIMITS.text, 64, 2000)).toHaveLength(1000);
  });
});
