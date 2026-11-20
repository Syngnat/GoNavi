import { describe, expect, it, vi } from 'vitest';

import {
  cancelRunningWorkbenchTabGuards,
  getDirtyWorkbenchTabCloseGuards,
  getWorkbenchTabCloseGuardStates,
  hasRunningWorkbenchTabGuards,
  persistWorkbenchTabCloseGuards,
  registerWorkbenchTabCloseGuard,
} from './workbenchTabCloseProtection';

describe('workbenchTabCloseProtection', () => {
  it('保留同一工作台标签中的多个脏状态保护器，并在注销后移除对应保护器', () => {
    const firstGuard = {
      isDirty: vi.fn(() => true),
      save: vi.fn(async () => true),
      discard: vi.fn(),
    };
    const secondGuard = {
      isDirty: vi.fn(() => false),
      save: vi.fn(async () => true),
      discard: vi.fn(),
    };
    const unregisterFirst = registerWorkbenchTabCloseGuard('tab-1', firstGuard);
    const unregisterSecond = registerWorkbenchTabCloseGuard('tab-1', secondGuard);

    expect(getDirtyWorkbenchTabCloseGuards(['tab-1'])).toEqual([
      { tabId: 'tab-1', guard: firstGuard },
    ]);

    unregisterFirst();
    expect(getDirtyWorkbenchTabCloseGuards(['tab-1'])).toEqual([]);
    unregisterSecond();
  });

  it('只返回被请求关闭的标签的脏状态保护器', () => {
    const guard = {
      isDirty: () => true,
      save: async () => true,
      discard: () => undefined,
    };
    const unregister = registerWorkbenchTabCloseGuard('tab-2', guard);

    expect(getDirtyWorkbenchTabCloseGuards(['tab-1'])).toEqual([]);
    expect(getDirtyWorkbenchTabCloseGuards(['tab-2', 'tab-2'])).toEqual([
      { tabId: 'tab-2', guard },
    ]);
    unregister();
  });

  it('在分离窗口前只持久化脏状态保护器', async () => {
    const persist = vi.fn();
    const dirtyUnregister = registerWorkbenchTabCloseGuard('tab-detach-dirty', {
      isDirty: () => true,
      save: async () => true,
      discard: () => undefined,
      persist,
    });
    const cleanUnregister = registerWorkbenchTabCloseGuard('tab-detach-clean', {
      isDirty: () => false,
      save: async () => true,
      discard: () => undefined,
      persist: vi.fn(),
    });

    await persistWorkbenchTabCloseGuards(['tab-detach-dirty', 'tab-detach-clean']);
    expect(persist).toHaveBeenCalledTimes(1);
    dirtyUnregister();
    cleanUnregister();
  });

  it('识别并显式取消运行中的工作台保护器', async () => {
    const cancelRun = vi.fn(async () => undefined);
    const unregister = registerWorkbenchTabCloseGuard('tab-running', {
      isDirty: () => false,
      isRunning: () => true,
      save: async () => true,
      discard: () => undefined,
      cancelRun,
    });

    expect(hasRunningWorkbenchTabGuards(['tab-running'])).toBe(true);
    expect(getWorkbenchTabCloseGuardStates(['tab-running'])).toEqual([
      expect.objectContaining({ tabId: 'tab-running', dirty: false, running: true }),
    ]);
    await cancelRunningWorkbenchTabGuards(['tab-running']);
    expect(cancelRun).toHaveBeenCalledTimes(1);
    unregister();
  });
});
