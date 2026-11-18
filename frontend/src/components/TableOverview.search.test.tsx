// @vitest-environment jsdom

import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { Input } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import TableOverview from './TableOverview';
import { TABLE_OVERVIEW_SEARCH_DEBOUNCE_MS } from './tableOverview/TableOverviewSearchInput';

const mocks = vi.hoisted(() => ({ query: vi.fn(), renderRows: vi.fn() }));
const storeState = vi.hoisted(() => ({
  theme: 'light',
  appearance: { tableDoubleClickAction: 'open-data' },
  activeTabId: 'overview',
  connections: [{
    id: 'fixture', name: 'Fixture',
    config: { type: 'mysql', database: 'fixture', host: 'fixture.invalid', port: 3306 },
  }],
  pinnedSidebarTables: [],
  queryOptions: { tableOverviewViewMode: 'card' },
  addTab: vi.fn(), setActiveContext: vi.fn(), setAIPanelVisible: vi.fn(),
  addAIContext: vi.fn(), setSidebarTablePinned: vi.fn(), setQueryOptions: vi.fn(),
}));

vi.mock('../store', () => ({
  useStore: (selector: (state: typeof storeState) => unknown) => selector(storeState),
  buildSidebarTablePinKey: () => '',
}));
vi.mock('../../wailsjs/go/app/App', () => ({
  DBQuery: mocks.query, DBGetTables: vi.fn(), DBRefreshTableStats: vi.fn(),
  DBShowCreateTable: vi.fn(), DropTable: vi.fn(), RenameTable: vi.fn(),
}));
vi.mock('./tableOverview/hooks/useTableOverviewRenderers', async () => {
  const actual = await vi.importActual<typeof import('./tableOverview/hooks/useTableOverviewRenderers')>(
    './tableOverview/hooks/useTableOverviewRenderers',
  );
  return {
    ...actual,
    useTableOverviewRenderers: (input: Parameters<typeof actual.useTableOverviewRenderers>[0]) => {
      mocks.renderRows();
      return actual.useTableOverviewRenderers(input);
    },
  };
});

describe('table overview search rendering', () => {
  let renderer: TestRenderer.ReactTestRenderer;

  beforeEach(async () => {
    vi.stubGlobal('ShadowRoot', class ShadowRoot {});
    vi.clearAllMocks();
    mocks.query.mockResolvedValue({
      success: true,
      data: Array.from({ length: 1586 }, (_, index) => ({
        TABLE_NAME: `table_${String(index).padStart(4, '0')}${index >= 1583 ? '_account' : ''}`,
        TABLE_COMMENT: `comment ${index}`, TABLE_ROWS: index, DATA_LENGTH: 16384, INDEX_LENGTH: 0,
      })),
    });
    await act(async () => {
      renderer = TestRenderer.create(<TableOverview tab={{
        id: 'overview', title: 'Fixture', type: 'table-overview', connectionId: 'fixture', dbName: 'fixture',
      }} />);
    });
  });

  afterEach(() => {
    act(() => renderer.unmount());
    vi.unstubAllGlobals();
  });

  const cards = () => renderer.root.findAll((node) => node.type === 'div' && Boolean(node.props['data-table-overview-card']));
  const search = async (text: string) => {
    await act(async () => {
      renderer.root.findByType(Input).props.onChange({ target: { value: text } });
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(
        resolve,
        TABLE_OVERVIEW_SEARCH_DEBOUNCE_MS + 30,
      ));
    });
  };

  it('updates rows only for the deferred filter and does not query the database again', async () => {
    expect(cards()).toHaveLength(300);
    mocks.renderRows.mockClear();

    await search('account');

    expect(cards().map((node) => node.props['data-table-overview-card'])).toEqual([
      'table_1583_account', 'table_1584_account', 'table_1585_account',
    ]);
    expect(mocks.renderRows).toHaveBeenCalledTimes(1);
    expect(mocks.query).toHaveBeenCalledTimes(1);
  });

  it('restores the original render limit after clearing search', async () => {
    await search('account');
    await search('');

    expect(cards()).toHaveLength(300);
    expect(mocks.query).toHaveBeenCalledTimes(1);
  });

  it('keeps the controlled search value immediate while row filtering is debounced', async () => {
    await act(async () => {
      renderer.root.findByType(Input).props.onChange({ target: { value: 'account' } });
    });
    expect(renderer.root.findByType(Input).props.value).toBe('account');
    expect(cards()).toHaveLength(300);

    await act(async () => {
      await new Promise((resolve) => setTimeout(
        resolve,
        TABLE_OVERVIEW_SEARCH_DEBOUNCE_MS + 30,
      ));
    });
    expect(cards()).toHaveLength(3);
  });

  it('keeps table elements mounted while refreshing so clipboard focus can be restored', async () => {
    const originalCard = cards()[0];

    await act(async () => { await renderer.root.findByType(ReloadOutlined).props.onClick(); });

    expect(mocks.query).toHaveBeenCalledTimes(2);
    expect(cards()[0] === originalCard).toBe(true);
  });
});
