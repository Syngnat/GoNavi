// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useTableOverviewRenderers } from './useTableOverviewRenderers';
import type { TableStatRow } from '../tableOverviewModel';

const table: TableStatRow = {
  name: 'orders',
  comment: '订单表',
  rows: 10,
  dataSize: 1024,
  indexSize: 512,
  engine: 'InnoDB',
  createTime: '',
  updateTime: '',
};

let container: HTMLDivElement;
let root: Root;

const Harness = ({ selected }: { selected: boolean }) => {
  const { renderCardTable, renderListTable, renderCompactTableRow } = useTableOverviewRenderers({
    textMuted: '#888', textSecondary: '#666', textPrimary: '#111', darkMode: false,
    openTableByDefaultAction: () => {},
    openV2OverviewContextMenu: () => {},
    accentColor: '#16a34a', metadataDialect: 'mysql',
    maxCombinedSize: 2048, hasKnownTableSize: () => true, getCombinedTableSize: () => 1536,
    sortField: 'name', toggleSort: () => {}, sortOrder: 'asc',
    isOverviewTableSelected: () => selected,
    renamingTable: null, renameDraft: '', renameEditorRef: React.createRef<HTMLSpanElement>(),
    onRenameDraftChange: () => {}, onRenameCommit: () => {}, onRenameCancel: () => {},
  });
  return (
    <div>
      <div data-testid="card">{renderCardTable(table)}</div>
      <div data-testid="list">{renderListTable(table)}</div>
      <div data-testid="compact">{renderCompactTableRow(table)}</div>
    </div>
  );
};

const renderHarness = (selected: boolean) => {
  act(() => root.render(<Harness selected={selected} />));
};

const rowOf = (mode: 'card' | 'list' | 'compact') => (
  container.querySelector(`[data-testid="${mode}"] [data-table-overview-select]`) as HTMLElement
);

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('useTableOverviewRenderers 选中标记', () => {
  it('三种视图的行都带 data-table-overview-select（拖选按它解析）', () => {
    renderHarness(false);
    (['card', 'list', 'compact'] as const).forEach((mode) => {
      expect(rowOf(mode)?.dataset.tableOverviewSelect).toBe('orders');
      expect(rowOf(mode)?.getAttribute('aria-selected')).toBe('false');
      expect(rowOf(mode)?.className).not.toContain('is-selected');
    });
  });

  it('选中时三种视图都加上 is-selected 且 aria-selected 为 true', () => {
    renderHarness(true);
    (['card', 'list', 'compact'] as const).forEach((mode) => {
      expect(rowOf(mode)?.className).toContain('is-selected');
      expect(rowOf(mode)?.getAttribute('aria-selected')).toBe('true');
    });
  });
});
