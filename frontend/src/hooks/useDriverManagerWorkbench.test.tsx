/** @vitest-environment jsdom */

import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const openNativeWorkbenchTabWindow = vi.fn(async (_tabId: string) => undefined);
vi.mock('../utils/nativeDetachedWindowHost', () => ({
  openNativeWorkbenchTabWindow: (tabId: string) => openNativeWorkbenchTabWindow(tabId),
}));

import { useStore } from '../store';
import {
  isDriverManagerVisible,
  useDriverManagerSidebarAutoCollapse,
  useOpenDriverManagerWorkbench,
} from './useDriverManagerWorkbench';

let setCollapsedFromOutside: (collapsed: boolean) => void = () => undefined;

/** 模拟 App：左侧树折叠状态由 useState 持有，驱动管理是否显示由外部控制。 */
const Harness: React.FC<{ visible: boolean; initialCollapsed?: boolean }> = ({ visible, initialCollapsed = false }) => {
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  setCollapsedFromOutside = setCollapsed;
  useDriverManagerSidebarAutoCollapse(visible, collapsed, setCollapsed);
  return (
    <div data-collapsed={String(collapsed)}>
      <div data-sidebar-content="true"><button type="button" data-testid="tree-node">orders</button></div>
    </div>
  );
};

let openDriverManager: () => void = () => undefined;
const OpenHarness: React.FC = () => {
  openDriverManager = useOpenDriverManagerWorkbench();
  return null;
};

describe('useDriverManagerWorkbench', () => {
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
    openNativeWorkbenchTabWindow.mockClear();
    delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
  });

  const render = async (node: React.ReactNode) => {
    await act(async () => { root.render(node); });
  };
  const collapsed = () => container.querySelector('[data-collapsed]')?.getAttribute('data-collapsed');

  it('treats the driver manager tab and the settings center drivers pane as visible', () => {
    expect(isDriverManagerVisible({ type: 'driver-manager' }, undefined)).toBe(true);
    expect(isDriverManagerVisible({ type: 'settings-center' }, 'drivers')).toBe(true);
    expect(isDriverManagerVisible({ type: 'settings-center' }, 'language')).toBe(false);
    expect(isDriverManagerVisible({ type: 'query' }, 'drivers')).toBe(false);
    expect(isDriverManagerVisible(undefined, 'drivers')).toBe(false);
  });

  it('collapses the tree when the driver manager shows up and restores it when it goes away', async () => {
    await render(<Harness visible={false} />);
    expect(collapsed()).toBe('false');

    await render(<Harness visible />);
    expect(collapsed()).toBe('true');

    await render(<Harness visible={false} />);
    expect(collapsed()).toBe('false');

    // 切回驱动管理会再次折叠。
    await render(<Harness visible />);
    expect(collapsed()).toBe('true');
  });

  it('leaves a tree that was already collapsed collapsed after leaving', async () => {
    await render(<Harness visible={false} initialCollapsed />);
    await render(<Harness visible />);
    expect(collapsed()).toBe('true');
    await render(<Harness visible={false} />);
    expect(collapsed()).toBe('true');
  });

  it('respects a manual expand while the driver manager is visible', async () => {
    await render(<Harness visible={false} />);
    await render(<Harness visible />);
    expect(collapsed()).toBe('true');

    await act(async () => { setCollapsedFromOutside(false); });
    expect(collapsed()).toBe('false');
    await act(async () => { setCollapsedFromOutside(true); });
    await render(<Harness visible={false} />);
    // 用户手动操作过，离开时保持用户最后的选择。
    expect(collapsed()).toBe('true');
  });

  it('does not collapse on mount when the driver manager is already visible', async () => {
    await render(<Harness visible />);
    expect(collapsed()).toBe('false');
  });

  it('moves focus out of the tree before collapsing it', async () => {
    await render(<Harness visible={false} />);
    const node = container.querySelector('[data-testid="tree-node"]') as HTMLButtonElement;
    node.focus();
    expect(document.activeElement).toBe(node);

    await render(<Harness visible />);
    expect(document.activeElement).not.toBe(node);
  });

  it('opens the driver manager tab and wakes its detached window', async () => {
    const addTab = vi.fn();
    const isWorkbenchTabDetached = vi.fn(() => false);
    useStore.setState({ addTab, isWorkbenchTabDetached } as any);
    await render(<OpenHarness />);

    await act(async () => { openDriverManager(); });
    expect(addTab).toHaveBeenCalledWith(expect.objectContaining({ id: 'driver-manager', type: 'driver-manager' }));
    expect(openNativeWorkbenchTabWindow).not.toHaveBeenCalled();

    isWorkbenchTabDetached.mockReturnValue(true);
    await act(async () => { openDriverManager(); });
    expect(openNativeWorkbenchTabWindow).toHaveBeenCalledWith('driver-manager');
  });
});
