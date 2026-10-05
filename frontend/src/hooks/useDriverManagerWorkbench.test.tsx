/** @vitest-environment jsdom */

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const openNativeWorkbenchTabWindow = vi.fn(async (_tabId: string) => undefined);
vi.mock('../utils/nativeDetachedWindowHost', () => ({
  openNativeWorkbenchTabWindow: (tabId: string) => openNativeWorkbenchTabWindow(tabId),
}));

import { useStore } from '../store';
import { useOpenDriverManagerWorkbench } from './useDriverManagerWorkbench';

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

  it('opens the driver manager tab and wakes its detached window', async () => {
    const addTab = vi.fn();
    const isWorkbenchTabDetached = vi.fn(() => false);
    useStore.setState({ addTab, isWorkbenchTabDetached } as any);
    await act(async () => { root.render(<OpenHarness />); });

    await act(async () => { openDriverManager(); });
    expect(addTab).toHaveBeenCalledWith(expect.objectContaining({ id: 'driver-manager', type: 'driver-manager' }));
    expect(openNativeWorkbenchTabWindow).not.toHaveBeenCalled();

    isWorkbenchTabDetached.mockReturnValue(true);
    await act(async () => { openDriverManager(); });
    expect(openNativeWorkbenchTabWindow).toHaveBeenCalledWith('driver-manager');
  });
});
