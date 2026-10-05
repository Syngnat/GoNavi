import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SavedConnection, TabData } from '../types';
import { WORKBENCH_SESSION_STORAGE_KEY } from './workbenchSessionSnapshot';

class MemoryStorage implements Storage {
  private data = new Map<string, string>();
  get length(): number { return this.data.size; }
  clear(): void { this.data.clear(); }
  getItem(key: string): string | null { return this.data.has(key) ? this.data.get(key)! : null; }
  key(index: number): string | null { return Array.from(this.data.keys())[index] ?? null; }
  removeItem(key: string): void { this.data.delete(key); }
  setItem(key: string, value: string): void { this.data.set(key, String(value)); }
}

const connection = (id: string): SavedConnection => ({
  id, name: id, config: { type: 'mysql', host: 'localhost', port: 3306, user: 'root' },
} as SavedConnection);

const table = (id: string, connectionId = 'conn-1'): TabData => ({
  id, title: id, type: 'table', connectionId, dbName: 'main', tableName: id,
});

describe('workbench session across a restart', () => {
  let storage: MemoryStorage;

  beforeEach(() => {
    storage = new MemoryStorage();
    vi.stubGlobal('localStorage', storage);
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  const startApp = async () => {
    const { useStore } = await import('../store');
    await useStore.persist.rehydrate();
    const persistence = await import('./workbenchSessionPersistence');
    return { useStore, ...persistence };
  };

  it('brings back every kind of tab and the AI panel after the app is closed and opened again', async () => {
    // First run: the person opens a table, an SQL editor, a settings tab and the AI panel.
    const first = await startApp();
    first.useStore.setState({ connections: [connection('conn-1')] });
    const stop = first.startWorkbenchSessionRecording();
    const { addTab, setAIPanelVisible } = first.useStore.getState();
    addTab(table('users'));
    addTab({ id: 'query-1', title: 'q', type: 'query', connectionId: 'conn-1', dbName: 'main', query: 'select 1' });
    addTab({ id: 'settings', title: 'Settings', type: 'settings-center', connectionId: '' });
    addTab({ id: 'redis-1', title: 'redis', type: 'redis-keys', connectionId: 'conn-1', redisDB: 2 });
    first.useStore.getState().setActiveTab('users');
    first.useStore.getState().setAIActiveSessionId('agent-session-7');
    setAIPanelVisible(true);
    stop();

    // Second run: only SQL editors come back by themselves; the rest waits for the connections.
    vi.resetModules();
    const second = await startApp();
    expect(second.useStore.getState().tabs.map((tab) => tab.id)).toEqual(['query-1']);
    expect(second.useStore.getState().aiPanelVisible).toBe(false);

    second.useStore.setState({ connections: [connection('conn-1')] });
    const panelOpenedOn: Array<string | null> = [];
    second.useStore.subscribe((state, previous) => {
      if (state.aiPanelVisible && !previous.aiPanelVisible) panelOpenedOn.push(state.aiActiveSessionId);
    });
    await second.restoreWorkbenchSession({ isLiveAISession: async (id) => id === 'agent-session-7' });

    const restored = second.useStore.getState();
    expect(restored.tabs.map((tab) => tab.id)).toEqual(['users', 'query-1', 'settings', 'redis-1']);
    expect(restored.tabs[1].query).toBe('select 1');
    expect(restored.tabs[3]).toMatchObject({ type: 'redis-keys', redisDB: 2, connectionId: 'conn-1' });
    expect(restored.activeTabId).toBe('users');
    expect(restored.activeContext).toMatchObject({ connectionId: 'conn-1', tableName: 'users' });
    expect(restored.aiPanelVisible).toBe(true);
    expect(restored.detachedAIChatWindow).toBeNull();
    // The conversation is back, and the panel opened on it rather than on a fresh one it would create first.
    expect(restored.aiActiveSessionId).toBe('agent-session-7');
    expect(panelOpenedOn).toEqual(['agent-session-7']);
    // The first import of the whole store is slow on a cold run; give it room so a slow machine cannot leak into the next test.
  }, 30_000);

  it('brings the remembered front tab forward even over a tab the app opened by itself at start', async () => {
    const first = await startApp();
    first.useStore.setState({ connections: [connection('conn-1')] });
    const stop = first.startWorkbenchSessionRecording();
    first.useStore.getState().addTab(table('users'));
    first.useStore.getState().addTab({ id: 'query-1', title: 'q', type: 'query', connectionId: 'conn-1', query: 'select 1' });
    first.useStore.getState().setActiveTab('users');
    stop();

    vi.resetModules();
    const second = await startApp();
    second.useStore.setState({ connections: [connection('conn-1')] });
    // The app opens its own tab at start and it is the one in front.
    second.useStore.getState().addTab({ id: 'settings-center', title: 'Settings', type: 'settings-center', connectionId: '' });
    expect(second.useStore.getState().activeTabId).toBe('settings-center');
    await second.restoreWorkbenchSession();
    expect(second.useStore.getState().tabs.map((tab) => tab.id)).toEqual(['users', 'query-1', 'settings-center']);
    expect(second.useStore.getState().activeTabId).toBe('users');
  });

  it('does nothing twice and does not touch the store when nothing was remembered', async () => {
    const app = await startApp();
    app.useStore.setState({ connections: [connection('conn-1')] });
    const before = app.useStore.getState().tabs;
    await app.restoreWorkbenchSession();
    expect(app.useStore.getState().tabs).toBe(before);

    storage.setItem(WORKBENCH_SESSION_STORAGE_KEY, JSON.stringify({
      version: 1, activeTabId: null, aiPanelDocked: false, aiSessionId: null,
      entries: [{ kind: 'tab', tab: { id: 'users', type: 'table', connectionId: 'conn-1', title: 'users', tableName: 'users' } }],
    }));
    await app.restoreWorkbenchSession();
    const once = app.useStore.getState().tabs;
    expect(once.map((tab) => tab.id)).toEqual(['users']);
    await app.restoreWorkbenchSession();
    expect(app.useStore.getState().tabs).toBe(once);
  });

  it('writes only when what is remembered changes, not on every keystroke in an editor', async () => {
    const app = await startApp();
    app.useStore.setState({ connections: [connection('conn-1')] });
    app.useStore.getState().addTab({ id: 'query-1', title: 'q', type: 'query', connectionId: 'conn-1', query: '' });
    const setItem = vi.spyOn(storage, 'setItem');
    const writes = () => setItem.mock.calls.filter(([key]) => key === WORKBENCH_SESSION_STORAGE_KEY).length;
    const stop = app.startWorkbenchSessionRecording();
    expect(writes()).toBe(1);

    const before = app.useStore.getState().tabs;
    app.useStore.getState().updateQueryTabDraft('query-1', { query: 'select 1' });
    app.useStore.getState().updateQueryTabDraft('query-1', { query: 'select 12' });
    expect(app.useStore.getState().tabs).not.toBe(before); // the store did see the typing
    expect(writes()).toBe(1);

    app.useStore.getState().addTab(table('users'));
    expect(writes()).toBe(2);
    stop();
    app.useStore.getState().addTab(table('orders'));
    expect(writes()).toBe(2); // stopped
  });

  it('carries on when storage is unavailable or full', async () => {
    const app = await startApp();
    await expect(app.restoreWorkbenchSession({ storage: null })).resolves.toBeUndefined();
    expect(app.startWorkbenchSessionRecording(null)()).toBeUndefined();

    const full = new MemoryStorage();
    vi.spyOn(full, 'setItem').mockImplementation(() => { throw new Error('QuotaExceededError'); });
    const stop = app.startWorkbenchSessionRecording(full);
    expect(() => app.useStore.getState().addTab(table('users'))).not.toThrow();
    stop();
  });
});

describe('AI conversation across a restart', () => {
  let storage: MemoryStorage;

  beforeEach(() => {
    storage = new MemoryStorage();
    vi.stubGlobal('localStorage', storage);
    vi.resetModules();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  const remember = (aiPanelDocked: boolean, aiSessionId: string | null) => storage.setItem(
    WORKBENCH_SESSION_STORAGE_KEY,
    JSON.stringify({ version: 1, entries: [], activeTabId: null, aiPanelDocked, aiSessionId }),
  );
  const startApp = async () => {
    const { useStore } = await import('../store');
    await useStore.persist.rehydrate();
    return { useStore, ...(await import('./workbenchSessionPersistence')) };
  };

  it('opens the panel on the remembered conversation', async () => {
    remember(true, 'agent-session-7');
    const app = await startApp();
    await app.restoreWorkbenchSession({ isLiveAISession: async () => true });
    expect(app.useStore.getState()).toMatchObject({ aiPanelVisible: true, aiActiveSessionId: 'agent-session-7' });
  });

  it('picks the conversation back up even when the panel was closed, without opening it', async () => {
    remember(false, 'agent-session-7');
    const app = await startApp();
    await app.restoreWorkbenchSession({ isLiveAISession: async () => true });
    expect(app.useStore.getState()).toMatchObject({ aiPanelVisible: false, aiActiveSessionId: 'agent-session-7' });
  });

  it('opens a fresh conversation when the old one is gone, archived, or was never used', async () => {
    remember(true, 'session-1719655200000');
    const app = await startApp();
    await app.restoreWorkbenchSession({ isLiveAISession: async () => false });
    expect(app.useStore.getState()).toMatchObject({ aiPanelVisible: true, aiActiveSessionId: null });
  });

  it('does not wait on an agent that cannot answer', async () => {
    remember(true, 'agent-session-7');
    const app = await startApp();
    await expect(app.restoreWorkbenchSession({ isLiveAISession: async () => { throw new Error('ledger unavailable'); } }))
      .resolves.toBeUndefined();
    expect(app.useStore.getState()).toMatchObject({ aiPanelVisible: true, aiActiveSessionId: null });

    vi.useFakeTimers();
    app.useStore.setState({ aiPanelVisible: false, aiActiveSessionId: null });
    const restoring = app.restoreWorkbenchSession({ isLiveAISession: () => new Promise<boolean>(() => undefined) });
    await vi.advanceTimersByTimeAsync(app.AI_SESSION_LOOKUP_TIMEOUT_MS);
    await restoring;
    expect(app.useStore.getState()).toMatchObject({ aiPanelVisible: true, aiActiveSessionId: null });
  });

  it('does not take over a conversation the person started in the meantime', async () => {
    remember(true, 'agent-session-7');
    const app = await startApp();
    let answer!: (live: boolean) => void;
    const restoring = app.restoreWorkbenchSession({ isLiveAISession: () => new Promise<boolean>((resolve) => { answer = resolve; }) });
    app.useStore.getState().setAIActiveSessionId('session-just-started');
    answer(true);
    await restoring;
    expect(app.useStore.getState().aiActiveSessionId).toBe('session-just-started');
  });

  it('remembers the conversation as the person moves between them', async () => {
    const app = await startApp();
    const stop = app.startWorkbenchSessionRecording();
    const remembered = () => JSON.parse(storage.getItem(WORKBENCH_SESSION_STORAGE_KEY) || '{}').aiSessionId;
    expect(remembered()).toBeNull();
    app.useStore.getState().setAIActiveSessionId('agent-session-7');
    expect(remembered()).toBe('agent-session-7');
    app.useStore.getState().setAIActiveSessionId('agent-session-9');
    expect(remembered()).toBe('agent-session-9');
    app.useStore.getState().deleteAISession('agent-session-9');
    expect(remembered()).toBeNull();
    stop();
  });
});

