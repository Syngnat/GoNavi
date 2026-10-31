import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TabData } from './types';

/**
 * 智能体会话工作台页签绑在智能体上：智能体被移除后页签要跟着关掉，
 * 留着只会是一个「暂无会话记录」的空页面。
 */
class MemoryStorage implements Storage {
  private data = new Map<string, string>();

  get length(): number {
    return this.data.size;
  }

  clear(): void {
    this.data.clear();
  }

  getItem(key: string): string | null {
    return this.data.has(key) ? this.data.get(key)! : null;
  }

  key(index: number): string | null {
    return Array.from(this.data.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.data.delete(key);
  }

  setItem(key: string, value: string): void {
    this.data.set(key, String(value));
  }
}

const importStore = async () => {
  const store = await import('./store');
  await store.useStore.persist.rehydrate();
  return store;
};

const agentTab = (kind: string): TabData => ({
  id: `agent-assets:${kind}`,
  title: 'ChatGPT · 会话管理',
  type: 'agent-assets',
  connectionId: '',
  agentIntegrationId: kind,
});

const queryTab = (id: string): TabData => ({
  id,
  title: '查询',
  type: 'query',
  connectionId: 'conn-1',
});

describe('closeStaleAgentAssetsTabs', () => {
  let storage: MemoryStorage;

  beforeAll(async () => {
    vi.stubGlobal('localStorage', new MemoryStorage());
    await import('./store');
    vi.unstubAllGlobals();
    vi.resetModules();
  }, 30_000);

  beforeEach(() => {
    storage = new MemoryStorage();
    vi.stubGlobal('localStorage', storage);
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('closes the tab of an agent that no longer exists', async () => {
    const store = await importStore();
    const { useStore } = store;
    useStore.getState().addTab(agentTab('codex'));
    useStore.getState().addTab(queryTab('q-1'));
    expect(useStore.getState().tabs.some((tab) => tab.id === 'agent-assets:codex')).toBe(true);

    useStore.getState().closeStaleAgentAssetsTabs([]);

    const tabs = useStore.getState().tabs;
    expect(tabs.some((tab) => tab.id === 'agent-assets:codex')).toBe(false);
    // 普通查询页签不受影响。
    expect(tabs.some((tab) => tab.id === 'q-1')).toBe(true);
  });

  it('keeps the tab of an agent that still exists', async () => {
    const store = await importStore();
    const { useStore } = store;
    useStore.getState().addTab(agentTab('codex'));

    useStore.getState().closeStaleAgentAssetsTabs(['codex']);

    expect(useStore.getState().tabs.some((tab) => tab.id === 'agent-assets:codex')).toBe(true);
  });

  it('moves the active tab when the closed agent tab was active', async () => {
    const store = await importStore();
    const { useStore } = store;
    useStore.getState().addTab(queryTab('q-1'));
    useStore.getState().addTab(agentTab('codex'));
    useStore.getState().setActiveTab('agent-assets:codex');
    expect(useStore.getState().activeTabId).toBe('agent-assets:codex');

    useStore.getState().closeStaleAgentAssetsTabs([]);

    const state = useStore.getState();
    expect(state.tabs.some((tab) => tab.id === 'agent-assets:codex')).toBe(false);
    // 活动页签不能悬空在被关掉的页签上。
    expect(state.activeTabId).not.toBe('agent-assets:codex');
    expect(state.activeTabId).toBeTruthy();
  });
});
