import { describe, expect, it } from 'vitest';
import { decodeInspection } from './decode';
import { boundedJSON, JSON_LIMITS } from './jsonBoundary';
const inspection = (description: string) => ({
  manifest: { schemaVersion: 1, apiVersion: 1, id: 'example.identity', name: 'Identity', version: '1.0.0', permissions: [], description },
  digest: 'a'.repeat(64), sourcePath: 'fixture', sizeBytes: 10,
});
describe('manifest depth boundary', () => {
  it('accepts a manifest whose page body nests to the host limit', () => {
    let body: Record<string, unknown> = { type: 'text', text: 'leaf' };
    for (let level = 0; level < 16; level += 1) body = { type: 'column', children: [body] };
    const manifest = {
      schemaVersion: 1, apiVersion: 1, id: 'example.pages', name: 'Pages', version: '1.0.0',
      permissions: ['ui.pages'], contributes: { pages: [{ id: 'deep', title: 'Deep', body }] },
    };
    expect(decodeInspection({ manifest, digest: 'a'.repeat(64), sourcePath: 'fixture', sizeBytes: 10 })
      .manifest.contributes?.pages?.[0].id).toBe('deep');
  });
  it('keeps the 16-level default for values that do not opt in', () => {
    let value: Record<string, unknown> = { leaf: 1 };
    for (let level = 0; level < 17; level += 1) value = { nested: value };
    expect(() => boundedJSON(value)).toThrow(/invalid_data/);
    expect(boundedJSON(value, JSON_LIMITS.bytes, JSON_LIMITS.text, 64)).toBe(value);
  });
});

describe('manifest text boundary', () => {
  it('keeps the general cap and allows a host-sized plugin description', () => {
    expect(() => boundedJSON('a'.repeat(8193))).toThrow(/invalid_data/);
    expect(boundedJSON('a'.repeat(8193), JSON_LIMITS.bytes, 16384)).toBe('a'.repeat(8193));
    expect(decodeInspection(inspection('a'.repeat(8193))).manifest.description).toHaveLength(8193);
    expect(() => decodeInspection(inspection('a'.repeat(16385)))).toThrow();
  });
});
