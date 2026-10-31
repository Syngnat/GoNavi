import { describe, expect, it } from 'vitest';
import { decodeInspection, validatePageNodeBudget } from '../plugins/decode';

const inspection = (contributes: Record<string, unknown>, permissions: string[] = ['ui.pages']) => ({
  manifest: {
    schemaVersion: 1,
    apiVersion: 1,
    id: 'example.pages',
    name: 'Pages',
    version: '1.0.0',
    permissions,
    contributes,
  },
  digest: 'a'.repeat(64),
  sourcePath: '/tmp/package',
  sizeBytes: 12,
});

const chain = (depth: number): Record<string, unknown> => (
  depth <= 0 ? { type: 'text', text: 'x' } : { type: 'column', children: [chain(depth - 1)] }
);
const leaf = { type: 'text', text: 'x' } as const;
const columnWith = (leaves: number) => ({ type: 'column', children: Array.from({ length: leaves }, () => leaf) });
const pageWithLeaves = (index: number, leaves: number) => ({
  id: 'p' + index,
  title: 'P' + index,
  body: leaves <= 0 ? leaf : columnWith(leaves),
});
const rejects = (contributes: Record<string, unknown>) =>
  expect(() => decodeInspection(inspection(contributes))).toThrow('plugin.error.invalid_response');

// These thresholds are the frontend half of the frozen contract; the Go host validates the
// same depth and the same cumulative node budget, so a drifting UI would reject valid pages.
describe('page node budget contract', () => {
  it('accepts depth 16 and rejects depth 17 like the host validator', () => {
    expect(() => validatePageNodeBudget(chain(16))).not.toThrow();
    expect(() => validatePageNodeBudget(chain(17))).toThrow('plugin.error.invalid_response');
  });

  it('accepts 512 nodes and rejects 513', () => {
    expect(() => validatePageNodeBudget(columnWith(511))).not.toThrow();
    expect(() => validatePageNodeBudget(columnWith(512))).toThrow('plugin.error.invalid_response');
  });

  it('counts nodes cumulatively across every page and stops at 512', () => {
    const fourPages = Array.from({ length: 4 }, (_, index) => pageWithLeaves(index, 127));
    expect(decodeInspection(inspection({ pages: fourPages })).manifest.contributes?.pages).toHaveLength(4);
    rejects({ pages: [...fourPages, pageWithLeaves(4, 0)] });
  });
});
