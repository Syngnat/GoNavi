import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearQueryTabDraft,
  clearSQLFileTabDraft,
  flushQueryTabDraftSnapshots,
  getQueryTabDraft,
  getSQLFileTabDraft,
  hasQueryTabDraft,
  hasSQLFileTabDraft,
  persistQueryTabDraftSnapshot,
  setQueryTabDraft,
  setSQLFileTabDraft,
  subscribeQueryTabDraftChanges,
} from './sqlFileTabDrafts';

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

const createBrowserSchedulingHarness = () => {
  let nextIdleId = 1;
  const idleCallbacks = new Map<number, IdleRequestCallback>();
  const eventListeners = new Map<string, EventListenerOrEventListenerObject[]>();
  const windowStub = {
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    addEventListener: vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
      eventListeners.set(type, [...(eventListeners.get(type) || []), listener]);
    }),
    requestIdleCallback: vi.fn((callback: IdleRequestCallback) => {
      const id = nextIdleId;
      nextIdleId += 1;
      idleCallbacks.set(id, callback);
      return id;
    }),
    cancelIdleCallback: vi.fn((id: number) => {
      idleCallbacks.delete(id);
    }),
  };
  const dispatch = (type: string) => {
    const event = { type } as Event;
    (eventListeners.get(type) || []).forEach((listener) => {
      if (typeof listener === 'function') {
        listener(event);
      } else {
        listener.handleEvent(event);
      }
    });
  };
  const runNextIdleCallback = () => {
    const next = idleCallbacks.entries().next().value as [number, IdleRequestCallback] | undefined;
    if (!next) {
      throw new Error('No idle callback is pending');
    }
    idleCallbacks.delete(next[0]);
    next[1]({
      didTimeout: false,
      timeRemaining: () => 50,
    });
  };
  return {
    dispatch,
    idleCallbacks,
    runNextIdleCallback,
    windowStub,
  };
};

describe('sqlFileTabDrafts', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', new MemoryStorage());
    localStorage.removeItem('gonavi-query-tab-drafts-v1');
    clearQueryTabDraft('query-tab-1');
    clearQueryTabDraft('query-recovery-1');
    clearSQLFileTabDraft('tab-1');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('keeps the 160ms editor flush path free of large serialization and synchronous storage writes', async () => {
    vi.useFakeTimers();
    vi.resetModules();

    const scheduling = createBrowserSchedulingHarness();
    const storage = new MemoryStorage();
    const setItemSpy = vi.spyOn(storage, 'setItem');
    const stringifySpy = vi.spyOn(JSON, 'stringify');
    vi.stubGlobal('window', scheduling.windowStub);
    vi.stubGlobal('localStorage', storage);

    const { persistQueryTabDraftSnapshot } = await import('./sqlFileTabDrafts');
    const oneMiBDraft = 'x'.repeat(1024 * 1024);
    for (let index = 0; index < 30; index += 1) {
      persistQueryTabDraftSnapshot({
        id: `large-query-${index}`,
        title: `Large query ${index}`,
        connectionId: 'conn-1',
        dbName: 'main',
      }, oneMiBDraft);
    }

    expect(stringifySpy).not.toHaveBeenCalled();
    expect(setItemSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(160);

    expect(stringifySpy).not.toHaveBeenCalled();
    expect(setItemSpy).not.toHaveBeenCalled();
    expect(scheduling.windowStub.requestIdleCallback).toHaveBeenCalledTimes(1);
    expect(scheduling.idleCallbacks.size).toBe(1);

    scheduling.runNextIdleCallback();

    expect(stringifySpy).toHaveBeenCalledTimes(1);
    expect(setItemSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(storage.getItem('gonavi-query-tab-drafts-v1') || '[]')).toHaveLength(30);
  });

  it('keeps at most one idle write pending while edits continue', async () => {
    vi.useFakeTimers();
    vi.resetModules();
    const scheduling = createBrowserSchedulingHarness();
    const storage = new MemoryStorage();
    vi.stubGlobal('window', scheduling.windowStub);
    vi.stubGlobal('localStorage', storage);
    const { persistQueryTabDraftSnapshot } = await import('./sqlFileTabDrafts');
    const tab = {
      id: 'query-bounded',
      title: 'Bounded queue',
      connectionId: 'conn-1',
      dbName: 'main',
    };

    persistQueryTabDraftSnapshot(tab, 'select 1;');
    await vi.advanceTimersByTimeAsync(160);
    expect(scheduling.idleCallbacks.size).toBe(1);

    for (let index = 0; index < 100; index += 1) {
      persistQueryTabDraftSnapshot(tab, `select ${index};`);
    }

    expect(scheduling.idleCallbacks.size).toBe(0);
    expect(scheduling.windowStub.cancelIdleCallback).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(160);
    expect(scheduling.idleCallbacks.size).toBe(1);
    expect(scheduling.windowStub.requestIdleCallback).toHaveBeenCalledTimes(2);
  });

  it('reuses the pending idle callback without losing the latest edit when cancellation is unavailable', async () => {
    vi.useFakeTimers();
    vi.resetModules();
    const scheduling = createBrowserSchedulingHarness();
    const storage = new MemoryStorage();
    vi.stubGlobal('window', {
      ...scheduling.windowStub,
      cancelIdleCallback: undefined,
    });
    vi.stubGlobal('localStorage', storage);
    const { persistQueryTabDraftSnapshot } = await import('./sqlFileTabDrafts');
    const tab = {
      id: 'query-no-idle-cancel',
      title: 'No idle cancellation',
      connectionId: 'conn-1',
      dbName: 'main',
    };

    persistQueryTabDraftSnapshot(tab, 'select 1;');
    await vi.advanceTimersByTimeAsync(160);
    persistQueryTabDraftSnapshot(tab, 'select 2;');
    await vi.advanceTimersByTimeAsync(160);

    expect(scheduling.windowStub.requestIdleCallback).toHaveBeenCalledTimes(1);
    expect(scheduling.idleCallbacks.size).toBe(1);
    scheduling.runNextIdleCallback();
    expect(JSON.parse(storage.getItem('gonavi-query-tab-drafts-v1') || '[]')[0].query).toBe('select 2;');
  });

  it('defers the synchronous fallback write beyond the editor debounce when idle callbacks are unavailable', async () => {
    vi.useFakeTimers();
    vi.resetModules();
    const scheduling = createBrowserSchedulingHarness();
    const storage = new MemoryStorage();
    const setItemSpy = vi.spyOn(storage, 'setItem');
    vi.stubGlobal('window', {
      ...scheduling.windowStub,
      requestIdleCallback: undefined,
      cancelIdleCallback: undefined,
    });
    vi.stubGlobal('localStorage', storage);
    const { persistQueryTabDraftSnapshot } = await import('./sqlFileTabDrafts');

    persistQueryTabDraftSnapshot({
      id: 'query-fallback',
      title: 'Fallback queue',
      connectionId: 'conn-1',
      dbName: 'main',
    }, 'select 1;');

    await vi.advanceTimersByTimeAsync(160);
    expect(setItemSpy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(499);
    expect(setItemSpy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(setItemSpy).toHaveBeenCalledTimes(1);
  });

  it('flushes synchronously for pagehide, beforeunload, and explicit recovery requests', async () => {
    vi.useFakeTimers();
    vi.resetModules();
    const scheduling = createBrowserSchedulingHarness();
    const storage = new MemoryStorage();
    const setItemSpy = vi.spyOn(storage, 'setItem');
    vi.stubGlobal('window', scheduling.windowStub);
    vi.stubGlobal('localStorage', storage);
    const drafts = await import('./sqlFileTabDrafts');
    const tab = {
      id: 'query-recovery-events',
      title: 'Recovery events',
      connectionId: 'conn-1',
      dbName: 'main',
    };

    drafts.persistQueryTabDraftSnapshot(tab, 'select 1;');
    scheduling.dispatch('pagehide');
    expect(setItemSpy).toHaveBeenCalledTimes(1);

    drafts.persistQueryTabDraftSnapshot(tab, 'select 2;');
    scheduling.dispatch('beforeunload');
    expect(setItemSpy).toHaveBeenCalledTimes(2);

    drafts.persistQueryTabDraftSnapshot(tab, 'select 3;');
    await vi.advanceTimersByTimeAsync(160);
    expect(scheduling.idleCallbacks.size).toBe(1);
    drafts.flushQueryTabDraftSnapshots();
    expect(setItemSpy).toHaveBeenCalledTimes(3);
    expect(scheduling.idleCallbacks.size).toBe(0);
    expect(scheduling.windowStub.cancelIdleCallback).toHaveBeenCalledTimes(1);
    expect(JSON.parse(storage.getItem('gonavi-query-tab-drafts-v1') || '[]')[0].query).toBe('select 3;');

    vi.resetModules();
    const reloaded = await import('./sqlFileTabDrafts');
    expect(reloaded.getQueryTabDraft(tab.id)).toBe('select 3;');
  });

  it('preserves v1 ordering, count, and text-size limits when an idle batch is flushed', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-21T00:00:00Z'));
    vi.resetModules();
    const scheduling = createBrowserSchedulingHarness();
    const storage = new MemoryStorage();
    const setItemSpy = vi.spyOn(storage, 'setItem');
    vi.stubGlobal('window', scheduling.windowStub);
    vi.stubGlobal('localStorage', storage);
    const drafts = await import('./sqlFileTabDrafts');

    for (let index = 0; index < 31; index += 1) {
      vi.setSystemTime(new Date(`2026-07-21T00:00:${String(index).padStart(2, '0')}Z`));
      drafts.persistQueryTabDraftSnapshot({
        id: `ordered-query-${index}`,
        title: `Ordered query ${index}`,
        connectionId: 'conn-1',
        dbName: 'main',
      }, `select ${index};`);
    }
    vi.setSystemTime(new Date('2026-07-21T00:01:00Z'));
    drafts.persistQueryTabDraftSnapshot({
      id: 'ordered-query-1',
      title: 'Ordered query 1',
      connectionId: 'conn-1',
      dbName: 'main',
    }, 'x'.repeat(1024 * 1024 + 100));

    await vi.advanceTimersByTimeAsync(160);
    scheduling.runNextIdleCallback();

    expect(setItemSpy).toHaveBeenCalledTimes(1);
    expect(storage.length).toBe(1);
    const payload = JSON.parse(storage.getItem('gonavi-query-tab-drafts-v1') || '[]');
    expect(payload).toHaveLength(30);
    expect(payload[0].tabId).toBe('ordered-query-1');
    expect(payload[0].query).toHaveLength(1024 * 1024);
    expect(payload.some((entry: { tabId: string }) => entry.tabId === 'ordered-query-0')).toBe(false);
  });

  it('stores query editor drafts outside the persisted tab state', () => {
    clearQueryTabDraft('query-tab-1');

    expect(hasQueryTabDraft('query-tab-1')).toBe(false);
    expect(getQueryTabDraft('query-tab-1', 'fallback')).toBe('fallback');

    setQueryTabDraft('query-tab-1', 'select * from large_table;');

    expect(hasQueryTabDraft('query-tab-1')).toBe(true);
    expect(getQueryTabDraft('query-tab-1', 'fallback')).toBe('select * from large_table;');

    clearQueryTabDraft('query-tab-1');

    expect(hasQueryTabDraft('query-tab-1')).toBe(false);
  });

  it('notifies live snapshot consumers only when a draft actually changes', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeQueryTabDraftChanges(listener);

    setQueryTabDraft('query-tab-1', 'select 1;');
    setQueryTabDraft('query-tab-1', 'select 1;');
    clearQueryTabDraft('query-tab-1');

    expect(listener).toHaveBeenNthCalledWith(1, 'query-tab-1');
    expect(listener).toHaveBeenNthCalledWith(2, 'query-tab-1');
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    setQueryTabDraft('query-tab-1', 'select 2;');
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('stores external SQL file editor drafts outside the persisted tab state', () => {
    clearSQLFileTabDraft('tab-1');

    expect(hasSQLFileTabDraft('tab-1')).toBe(false);
    expect(getSQLFileTabDraft('tab-1', 'fallback')).toBe('fallback');

    setSQLFileTabDraft('tab-1', 'select 1;');

    expect(hasSQLFileTabDraft('tab-1')).toBe(true);
    expect(getSQLFileTabDraft('tab-1', 'fallback')).toBe('select 1;');

    clearSQLFileTabDraft('tab-1');

    expect(hasSQLFileTabDraft('tab-1')).toBe(false);
  });

  it('persists crash recovery snapshots and hydrates them after module reload', async () => {
    const drafts = await import('./sqlFileTabDrafts');
    drafts.persistQueryTabDraftSnapshot({
      id: 'query-recovery-1',
      title: '临时 SQL',
      connectionId: 'conn-1',
      dbName: 'main',
    }, 'select * from large_table;');

    vi.resetModules();
    const reloaded = await import('./sqlFileTabDrafts');
    expect(reloaded.getQueryTabDraft('query-recovery-1')).toBe('select * from large_table;');
    expect(reloaded.getPersistedQueryTabDraftEntry('query-recovery-1')).toEqual(
      expect.objectContaining({
        tabId: 'query-recovery-1',
        title: '临时 SQL',
        connectionId: 'conn-1',
        dbName: 'main',
        query: 'select * from large_table;',
      }),
    );
  });

  it('preserves an explicitly cleared database override in crash recovery snapshots', () => {
    persistQueryTabDraftSnapshot({
      id: 'query-empty-db-override',
      title: 'Connection scoped query',
      connectionId: 'conn-1',
      dbName: 'stale-db',
    }, 'select * from users;', {
      connectionId: 'conn-1',
      dbName: '',
    });

    expect(getQueryTabDraft('query-empty-db-override')).toBe('select * from users;');
    flushQueryTabDraftSnapshots();
    const payload = JSON.parse(localStorage.getItem('gonavi-query-tab-drafts-v1') || '[]');
    expect(payload.find((entry: { tabId: string }) => entry.tabId === 'query-empty-db-override')?.dbName).toBe('');
  });
});
