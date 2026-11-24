// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import TableOverviewRows from './TableOverviewRows';
import type { TableStatRow } from './tableOverviewModel';

const table: TableStatRow = {
  name: 'market_theft_alarm_detail',
  comment: '防盗报警明细',
  rows: 10,
  dataSize: 1024,
  indexSize: 512,
  engine: 'InnoDB',
  charset: 'utf8mb4',
  collation: 'utf8mb4_general_ci',
  createTime: '',
  updateTime: '',
};

let container: HTMLDivElement;
let root: Root;
let onWidthsChange: ReturnType<typeof vi.fn>;

const renderRows = () => {
  act(() => root.render(
    <TableOverviewRows
      sections={[{ key: 'all', kind: 'all', rows: [table] }]}
      showSectionTitles={false}
      viewMode="table"
      compactColumns={['name', 'rows']}
      compactColumnWidths={{}}
      onCompactColumnWidthsChange={onWidthsChange}
      textMuted="#888"
      textSecondary="#666"
      textPrimary="#111"
      darkMode={false}
      openTableByDefaultAction={() => {}}
      openV2OverviewContextMenu={() => {}}
      accentColor="#16a34a"
      metadataDialect="mysql"
      maxCombinedSize={2048}
      hasKnownTableSize={() => true}
      getCombinedTableSize={() => 1536}
      sortField="name"
      toggleSort={() => {}}
      sortOrder="asc"
      isOverviewTableSelected={() => false}
    />,
  ));
};

const resizer = () => (
  container.querySelector('[data-table-overview-column-resizer="name"]') as HTMLElement
);

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  onWidthsChange = vi.fn();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('TableOverviewRows compact column resize', () => {
  it('renders a resizer and adjusts a column with the keyboard', () => {
    renderRows();
    const handle = resizer();

    expect(handle.getAttribute('role')).toBe('separator');
    expect(handle.getAttribute('aria-valuemin')).toBe('240');

    act(() => {
      handle.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'ArrowRight',
        bubbles: true,
        cancelable: true,
      }));
    });

    expect(onWidthsChange).toHaveBeenCalledWith({ name: 256 });
  });

  it('previews a dragged width through the grid variable and commits on release', () => {
    renderRows();
    const headerCells = Array.from(
      container.querySelectorAll<HTMLElement>('[role="columnheader"]'),
    );
    const renderedWidths = [260, 88];
    headerCells.forEach((cell, index) => {
      Object.defineProperty(cell, 'getBoundingClientRect', {
        configurable: true,
        value: () => ({ width: renderedWidths[index] ?? 0 }),
      });
    });
    const handle = resizer();
    const scroller = container.querySelector<HTMLElement>('[role="table"]') as HTMLElement;

    act(() => {
      handle.dispatchEvent(new MouseEvent('pointerdown', {
        bubbles: true,
        cancelable: true,
        button: 0,
        buttons: 1,
        clientX: 260,
      }));
      document.dispatchEvent(new MouseEvent('pointermove', {
        bubbles: true,
        cancelable: true,
        buttons: 1,
        clientX: 360,
      }));
    });

    expect(scroller.style.getPropertyValue('--gn-table-overview-compact-columns'))
      .toBe('360px minmax(88px, 0.65fr)');
    expect(document.body.style.cursor).toBe('col-resize');

    act(() => {
      document.dispatchEvent(new MouseEvent('pointerup', {
        bubbles: true,
        cancelable: true,
        clientX: 360,
      }));
    });

    expect(onWidthsChange).toHaveBeenCalledWith({ name: 360 });
    expect(document.body.style.cursor).toBe('');
  });

  it('does not freeze a flexible column when the resizer is only clicked', () => {
    renderRows();
    const handle = resizer();

    act(() => {
      handle.dispatchEvent(new MouseEvent('pointerdown', {
        bubbles: true,
        cancelable: true,
        button: 0,
        buttons: 1,
        clientX: 240,
      }));
      document.dispatchEvent(new MouseEvent('pointerup', {
        bubbles: true,
        cancelable: true,
        clientX: 240,
      }));
    });

    expect(onWidthsChange).not.toHaveBeenCalled();
  });
});
