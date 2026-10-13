import { describe, expect, it, vi } from 'vitest';

import {
  buildObjectOverviewTab,
  buildObjectOverviewTabId,
  openObjectOverview,
} from './objectOverviewActions';

vi.mock('../../i18n', () => ({
  t: (key: string, vars?: Record<string, string | number>) => (
    key === 'sidebar.tab.table_overview'
      ? `表概览 - ${vars?.database || ''}${vars?.schema || ''}`
      : `${key} - ${vars?.database || ''}${vars?.schema || ''}`
  ),
}));

const context = { connectionId: 'conn-1', dbName: 'shop', schemaName: 'public' };

describe('objectOverviewActions', () => {
  it('keeps the legacy table-overview tab identity for tables', () => {
    expect(buildObjectOverviewTabId('tables', context)).toBe('table-overview-conn-1-shop-public');
    const tab = buildObjectOverviewTab('tables', context) as any;
    expect(tab.type).toBe('table-overview');
    expect(tab.title).toBe('表概览 - shop (public)');
  });

  it('builds object-overview tabs with a kind for views and routines', () => {
    const views = buildObjectOverviewTab('views', context) as any;
    expect(views.type).toBe('object-overview');
    expect(views.overviewKind).toBe('views');
    expect(views.id).toBe('object-overview-views-conn-1-shop-public');

    const routines = buildObjectOverviewTab('routines', { connectionId: 'conn-1', dbName: 'shop' }) as any;
    expect(routines.overviewKind).toBe('routines');
    expect(routines.id).toBe('object-overview-routines-conn-1-shop');
    expect(routines.schemaName).toBeUndefined();
  });

  it('ignores open requests without a connection or database', () => {
    const addTab = vi.fn();
    openObjectOverview(addTab, 'views', { connectionId: '', dbName: 'shop' });
    openObjectOverview(addTab, 'views', { connectionId: 'conn-1', dbName: '' });
    expect(addTab).not.toHaveBeenCalled();
  });

  it('forwards the built tab to addTab', () => {
    const addTab = vi.fn();
    openObjectOverview(addTab, 'routines', context);
    expect(addTab).toHaveBeenCalledTimes(1);
    expect((addTab.mock.calls[0][0] as any).overviewKind).toBe('routines');
  });
});
