import { describe, expect, it, vi } from 'vitest';

import {
  getDirtyWorkbenchTabCloseGuards,
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
});
