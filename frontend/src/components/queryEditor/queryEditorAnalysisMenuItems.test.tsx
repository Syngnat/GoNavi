import { describe, expect, it, vi } from 'vitest';

import { t } from '../../i18n';
import { buildQueryEditorAnalysisMenuItems } from './queryEditorAnalysisMenuItems';

const buildItems = (overrides: Partial<Parameters<typeof buildQueryEditorAnalysisMenuItems>[0]> = {}) => {
  const handlers = {
    onOpenQueryHistory: vi.fn(),
    onDiagnoseQuery: vi.fn(),
    onOpenSlowQueries: vi.fn(),
  };
  const items = buildQueryEditorAnalysisMenuItems({
    translate: t,
    activeShortcutPlatform: 'windows',
    supportsExplainDiagnosis: true,
    ...handlers,
    ...overrides,
  }) as Array<{ key: string; disabled?: boolean; onClick?: () => void }>;
  return { items, handlers };
};

describe('buildQueryEditorAnalysisMenuItems', () => {
  it('exposes history, diagnosis and slow-query entries in a stable order', () => {
    const { items } = buildItems();
    expect(items.map((item) => item.key)).toEqual([
      'show-query-history',
      'diagnose-query',
      'show-slow-queries',
    ]);
  });

  it('routes each entry to its own handler', () => {
    const { items, handlers } = buildItems();
    items.forEach((item) => item.onClick?.());
    expect(handlers.onOpenQueryHistory).toHaveBeenCalledTimes(1);
    expect(handlers.onDiagnoseQuery).toHaveBeenCalledTimes(1);
    expect(handlers.onOpenSlowQueries).toHaveBeenCalledTimes(1);
  });

  it('disables diagnosis only when the connection cannot explain queries', () => {
    const { items } = buildItems({ supportsExplainDiagnosis: false });
    expect(items.find((item) => item.key === 'diagnose-query')?.disabled).toBe(true);
    expect(items.find((item) => item.key === 'show-query-history')?.disabled).toBeUndefined();
    expect(items.find((item) => item.key === 'show-slow-queries')?.disabled).toBeUndefined();
  });
});
