import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SavedConnection } from './types';

class MemoryStorage implements Storage {
  private data = new Map<string, string>();

  get length(): number {
    return this.data.size;
  }

  clear(): void {
    this.data.clear();
  }

  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
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

const connection = (id: string, type: string): SavedConnection => ({
  id,
  name: id,
  config: { type, host: 'localhost', port: 3306 },
} as SavedConnection);

describe('new query tab baseline', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', new MemoryStorage());
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('records the generated starter SQL as the clean baseline', async () => {
    const { useStore } = await importStore();
    useStore.setState({
      connections: [connection('conn-1', 'mysql')],
      appearance: { ...useStore.getState().appearance, newQuerySqlTemplate: null },
    });

    useStore.getState().addTab({
      id: 'query-1',
      title: 'New query',
      type: 'query',
      connectionId: 'conn-1',
    });

    expect(useStore.getState().tabs[0].queryBaseline).toBe('SELECT * FROM ');
  });

  it('uses the custom template and an empty Elasticsearch template as the baseline', async () => {
    const { useStore } = await importStore();
    useStore.setState({
      connections: [
        connection('conn-1', 'postgres'),
        connection('conn-2', 'elasticsearch'),
      ],
      appearance: { ...useStore.getState().appearance, newQuerySqlTemplate: 'SELECT id, name\nFROM ' },
    });

    useStore.getState().addTab({
      id: 'query-1',
      title: 'New query',
      type: 'query',
      connectionId: 'conn-1',
    });
    useStore.getState().addTab({
      id: 'query-2',
      title: 'New query',
      type: 'query',
      connectionId: 'conn-2',
    });

    expect(useStore.getState().tabs.find((tab) => tab.id === 'query-1')?.queryBaseline)
      .toBe('SELECT id, name\nFROM ');
    expect(useStore.getState().tabs.find((tab) => tab.id === 'query-2')?.queryBaseline)
      .toBe('');
  });

  it('keeps the baseline when the editor updates the query or the tab is updated', async () => {
    const { useStore } = await importStore();
    useStore.setState({
      connections: [connection('conn-1', 'mysql')],
      appearance: { ...useStore.getState().appearance, newQuerySqlTemplate: null },
    });
    useStore.getState().addTab({
      id: 'query-1',
      title: 'New query',
      type: 'query',
      connectionId: 'conn-1',
    });

    useStore.getState().updateQueryTabDraft('query-1', { query: 'SELECT * FROM users' });
    useStore.getState().addTab({
      id: 'query-1',
      title: 'Renamed query',
      type: 'query',
      connectionId: 'conn-1',
    });

    expect(useStore.getState().tabs[0]).toMatchObject({
      title: 'Renamed query',
      query: 'SELECT * FROM users',
      queryBaseline: 'SELECT * FROM ',
    });
  });

  it('stays clean after the editor syncs the generated starter SQL into the draft', async () => {
    const { useStore } = await importStore();
    const { setQueryTabDraft } = await import('./utils/sqlFileTabDrafts');
    useStore.setState({
      connections: [connection('conn-1', 'mysql')],
      appearance: { ...useStore.getState().appearance, newQuerySqlTemplate: null },
    });
    useStore.getState().addTab({
      id: 'query-1',
      title: 'New query',
      type: 'query',
      connectionId: 'conn-1',
    });
    setQueryTabDraft('query-1', 'SELECT * FROM ');
    useStore.getState().updateQueryTabDraft('query-1', { query: 'SELECT * FROM ' });

    const { collectApplicationQuitUnsavedSQLTargets } = await import('./utils/sqlEditorApplicationQuit');
    const targets = await collectApplicationQuitUnsavedSQLTargets(
      useStore.getState().tabs,
      useStore.getState().savedQueries,
      vi.fn(),
    );

    expect(targets).toEqual([]);
  });
});
