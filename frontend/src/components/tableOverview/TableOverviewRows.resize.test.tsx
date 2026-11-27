// @vitest-environment jsdom
import React, { act, useState } from 'react';
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

const StatefulRows = () => {
  const [widths, setWidths] = useState<Record<string, number>>({});
  return (
    <TableOverviewRows
      sections={[{ key: 'all', kind: 'all', rows: [table] }]}
      showSectionTitles={false}
      viewMode="table"
      compactColumns={['name', 'rows']}
      compactColumnWidths={widths}
      onCompactColumnWidthsChange={(nextWidths) => {
        onWidthsChange(nextWidths);
        setWidths(nextWidths);
      }}
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
    />
  );
};

const resizer = (key = 'name') => (
  container.querySelector(`[data-table-overview-column-resizer="${key}"]`) as HTMLElement
);

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(performance.now());
    return 1;
  });
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

  it('moves a lightweight guide while dragging and commits on release', () => {
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
    const initialColumns = scroller.style.getPropertyValue('--gn-table-overview-compact-columns');

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

    const guide = document.querySelector<HTMLElement>('[data-table-overview-column-resize-guide]');
    expect(guide).not.toBeNull();
    expect(guide?.style.transform).toBe('translate3d(360px, 0, 0)');
    expect(scroller.style.getPropertyValue('--gn-table-overview-compact-columns'))
      .toBe(initialColumns);
    expect(document.body.style.cursor).toBe('col-resize');

    act(() => {
      document.dispatchEvent(new MouseEvent('pointerup', {
        bubbles: true,
        cancelable: true,
        clientX: 360,
      }));
    });

    expect(document.querySelector('[data-table-overview-column-resize-guide]')).toBeNull();
    expect(onWidthsChange).toHaveBeenCalledWith({ name: 360 });
    expect(document.body.style.cursor).toBe('');
  });

  it('commits the drag delta instead of the pointer page coordinate', () => {
    renderRows();
    const headerCells = Array.from(
      container.querySelectorAll<HTMLElement>('[role="columnheader"]'),
    );
    headerCells.forEach((cell, index) => {
      Object.defineProperty(cell, 'getBoundingClientRect', {
        configurable: true,
        value: () => ({ width: [260, 88][index] ?? 0 }),
      });
    });
    const handle = resizer('rows');

    act(() => {
      handle.dispatchEvent(new MouseEvent('pointerdown', {
        bubbles: true,
        cancelable: true,
        button: 0,
        buttons: 1,
        clientX: 348,
      }));
      document.dispatchEvent(new MouseEvent('pointermove', {
        bubbles: true,
        cancelable: true,
        buttons: 1,
        clientX: 428,
      }));
      document.dispatchEvent(new MouseEvent('pointerup', {
        bubbles: true,
        cancelable: true,
        clientX: 428,
      }));
    });

    expect(onWidthsChange).toHaveBeenCalledWith({ rows: 168 });
  });

  it('applies the released width immediately while persistence waits for paint', () => {
    vi.stubGlobal('requestAnimationFrame', () => 1);
    renderRows();
    const headerCells = Array.from(
      container.querySelectorAll<HTMLElement>('[role="columnheader"]'),
    );
    headerCells.forEach((cell, index) => {
      Object.defineProperty(cell, 'getBoundingClientRect', {
        configurable: true,
        value: () => ({ width: [260, 88][index] ?? 0 }),
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
      document.dispatchEvent(new MouseEvent('pointerup', {
        bubbles: true,
        cancelable: true,
        clientX: 360,
      }));
    });

    expect(scroller.style.getPropertyValue('--gn-table-overview-compact-columns'))
      .toBe('360px minmax(88px, 0.65fr)');
    expect(onWidthsChange).not.toHaveBeenCalled();
  });

  it('keeps the released width after the parent applies it on rerender', () => {
    act(() => root.render(<StatefulRows />));
    const headerCells = Array.from(
      container.querySelectorAll<HTMLElement>('[role="columnheader"]'),
    );
    headerCells.forEach((cell, index) => {
      Object.defineProperty(cell, 'getBoundingClientRect', {
        configurable: true,
        value: () => ({ width: [260, 88][index] ?? 0 }),
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
      document.dispatchEvent(new MouseEvent('pointerup', {
        bubbles: true,
        cancelable: true,
        clientX: 360,
      }));
    });

    expect(onWidthsChange).toHaveBeenCalledWith({ name: 360 });
    expect(scroller.style.getPropertyValue('--gn-table-overview-compact-columns'))
      .toBe('360px minmax(88px, 0.65fr)');
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
