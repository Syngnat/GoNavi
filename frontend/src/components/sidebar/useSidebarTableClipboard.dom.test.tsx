// @vitest-environment jsdom
import React, { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  success: vi.fn(),
  warning: vi.fn(),
}));

vi.mock('antd', () => ({
  message: {
    success: mocks.success,
    warning: mocks.warning,
  },
}));

import { useSidebarTableClipboard } from './useSidebarTableClipboard';

const sourceNode = {
  key: 'conn-a-shop-table-orders',
  title: 'orders',
  type: 'table',
  dataRef: {
    id: 'conn-a',
    dbName: 'shop',
    schemaName: '',
    tableName: 'orders',
    config: { type: 'mysql' },
  },
};

const targetNode = {
  key: 'conn-a-shop',
  title: 'shop',
  type: 'database',
  dataRef: {
    id: 'conn-a',
    dbName: 'shop',
    schemaName: '',
    config: { type: 'mysql' },
  },
};

const customersNode = {
  key: 'conn-a-shop-table-customers',
  title: 'customers',
  type: 'table',
  dataRef: {
    id: 'conn-a',
    dbName: 'shop',
    schemaName: '',
    tableName: 'customers',
    config: { type: 'mysql' },
  },
};

describe('useSidebarTableClipboard DOM events', () => {
  let container: HTMLDivElement;
  let root: Root;
  let selectedNodesRef: { current: any[] };
  const onCopyTables = vi.fn();
  const onOpenDataSyncWorkbench = vi.fn();

  const mount = () => {
    const Harness = () => {
      const rootRef = useRef<HTMLDivElement | null>(null);
      useSidebarTableClipboard({
        rootRef,
        selectedNodesRef,
        connectionIds: ['conn-a', 'conn-b'],
        activeShortcutPlatform: 'mac',
        onCopyTables,
        onOpenDataSyncWorkbench,
      });
      return (
        <div ref={rootRef}>
          <div data-sidebar-tree-panel="true">
            <span data-testid="tree-row">orders</span>
            <input data-testid="tree-input" />
          </div>
        </div>
      );
    };
    act(() => {
      root.render(<Harness />);
    });
  };

  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    selectedNodesRef = { current: [sourceNode] };
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mount();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('handles the native copy event and then pastes the queued table into the target database', () => {
    const row = container.querySelector('[data-testid="tree-row"]') as HTMLElement;

    act(() => {
      row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    const copyEvent = new Event('copy', { bubbles: true, cancelable: true });
    act(() => {
      row.dispatchEvent(copyEvent);
    });

    expect(copyEvent.defaultPrevented).toBe(true);
    expect(mocks.success).toHaveBeenCalledWith(expect.stringContaining('orders'));

    selectedNodesRef.current = [targetNode];
    const pasteEvent = new Event('paste', { bubbles: true, cancelable: true });
    act(() => {
      row.dispatchEvent(pasteEvent);
    });

    expect(pasteEvent.defaultPrevented).toBe(true);
    expect(onCopyTables).toHaveBeenCalledWith([sourceNode]);
  });

  it('copies and pastes multiple selected tables as one batch', () => {
    const row = container.querySelector('[data-testid="tree-row"]') as HTMLElement;
    selectedNodesRef.current = [sourceNode, customersNode];

    act(() => {
      row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    const copyEvent = new Event('copy', { bubbles: true, cancelable: true });
    act(() => {
      row.dispatchEvent(copyEvent);
    });

    expect(copyEvent.defaultPrevented).toBe(true);
    expect(mocks.success).toHaveBeenCalledWith(expect.stringContaining('2'));

    selectedNodesRef.current = [targetNode];
    const pasteEvent = new Event('paste', { bubbles: true, cancelable: true });
    act(() => {
      row.dispatchEvent(pasteEvent);
    });

    expect(pasteEvent.defaultPrevented).toBe(true);
    expect(onCopyTables).toHaveBeenCalledWith([sourceNode, customersNode]);
  });

  it('does not hijack native copy or paste from an input inside the sidebar', () => {
    const input = container.querySelector('[data-testid="tree-input"]') as HTMLInputElement;

    act(() => {
      input.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    const copyEvent = new Event('copy', { bubbles: true, cancelable: true });
    act(() => {
      input.dispatchEvent(copyEvent);
    });
    const pasteEvent = new Event('paste', { bubbles: true, cancelable: true });
    act(() => {
      input.dispatchEvent(pasteEvent);
    });

    expect(copyEvent.defaultPrevented).toBe(false);
    expect(pasteEvent.defaultPrevented).toBe(false);
    expect(mocks.success).not.toHaveBeenCalled();
    expect(onCopyTables).not.toHaveBeenCalled();
  });
});
