/** @vitest-environment jsdom */

import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { WorkbenchTabType } from '../tabTypes';
import { isSidebarAutoCollapseTabType, useWorkbenchSidebarAutoCollapse } from './useAppSidebarCollapse';

let setCollapsedFromOutside: (collapsed: boolean) => void = () => undefined;

/** 模拟 App：左侧树折叠状态由 useState 持有，当前激活的标签页类型由外部控制。 */
const Harness: React.FC<{ tabType?: WorkbenchTabType; initialCollapsed?: boolean }> = ({
  tabType,
  initialCollapsed = false,
}) => {
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  setCollapsedFromOutside = setCollapsed;
  useWorkbenchSidebarAutoCollapse(tabType, collapsed, setCollapsed);
  return (
    <div data-collapsed={String(collapsed)}>
      <div data-sidebar-content="true"><button type="button" data-testid="tree-node">orders</button></div>
    </div>
  );
};

describe('useWorkbenchSidebarAutoCollapse', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
  });

  const render = async (node: React.ReactNode) => {
    await act(async () => { root.render(node); });
  };
  const collapsed = () => container.querySelector('[data-collapsed]')?.getAttribute('data-collapsed');

  it('recognises the self-contained tool workbench tabs only', () => {
    for (const type of ['settings-center', 'driver-manager', 'data-sync', 'table-export', 'data-import'] as const) {
      expect(isSidebarAutoCollapseTabType(type), type).toBe(true);
    }
    for (const type of ['query', 'table', 'design', 'redis-keys', 'sql-analysis', 'session-workbench'] as const) {
      expect(isSidebarAutoCollapseTabType(type), type).toBe(false);
    }
    expect(isSidebarAutoCollapseTabType(undefined)).toBe(false);
  });

  it.each(['settings-center', 'driver-manager', 'data-sync', 'table-export', 'data-import'] as const)(
    'collapses the tree for %s and restores it when leaving',
    async (tabType) => {
      await render(<Harness tabType="query" />);
      expect(collapsed()).toBe('false');

      await render(<Harness tabType={tabType} />);
      expect(collapsed()).toBe('true');

      await render(<Harness tabType="query" />);
      expect(collapsed()).toBe('false');

      // 再次进入会再次折叠。
      await render(<Harness tabType={tabType} />);
      expect(collapsed()).toBe('true');
    },
  );

  it('restores the tree when the last auto-collapse tab is closed and no tab remains active', async () => {
    await render(<Harness tabType="settings-center" />);
    await render(<Harness tabType="query" />);
    await render(<Harness tabType="data-sync" />);
    expect(collapsed()).toBe('true');
    await render(<Harness tabType={undefined} />);
    expect(collapsed()).toBe('false');
  });

  it('keeps the tree collapsed while switching between auto-collapse tabs', async () => {
    await render(<Harness tabType="query" />);
    await render(<Harness tabType="settings-center" />);
    expect(collapsed()).toBe('true');

    await render(<Harness tabType="data-sync" />);
    expect(collapsed()).toBe('true');
    await render(<Harness tabType="table-export" />);
    expect(collapsed()).toBe('true');

    await render(<Harness tabType="query" />);
    expect(collapsed()).toBe('false');
  });

  it('leaves a tree that was already collapsed collapsed after leaving', async () => {
    await render(<Harness tabType="query" initialCollapsed />);
    await render(<Harness tabType="settings-center" />);
    expect(collapsed()).toBe('true');
    await render(<Harness tabType="query" />);
    expect(collapsed()).toBe('true');
  });

  it('respects a manual expand while an auto-collapse tab is visible', async () => {
    await render(<Harness tabType="query" />);
    await render(<Harness tabType="data-import" />);
    expect(collapsed()).toBe('true');

    await act(async () => { setCollapsedFromOutside(false); });
    expect(collapsed()).toBe('false');
    await act(async () => { setCollapsedFromOutside(true); });
    await render(<Harness tabType="query" />);
    // 用户手动操作过，离开时保持用户最后的选择。
    expect(collapsed()).toBe('true');
  });

  it('does not collapse on mount when an auto-collapse tab is already active', async () => {
    await render(<Harness tabType="settings-center" />);
    expect(collapsed()).toBe('false');
  });

  it('moves focus out of the tree before collapsing it', async () => {
    await render(<Harness tabType="query" />);
    const node = container.querySelector('[data-testid="tree-node"]') as HTMLButtonElement;
    node.focus();
    expect(document.activeElement).toBe(node);

    await render(<Harness tabType="data-sync" />);
    expect(document.activeElement).not.toBe(node);
  });
});
