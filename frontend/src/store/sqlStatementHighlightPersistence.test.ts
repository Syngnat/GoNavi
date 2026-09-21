import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  const store = await import('../store');
  await store.useStore.persist.rehydrate();
  return store;
};

describe('SQL statement highlight persistence', () => {
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

  it('migrates legacy appearance settings and persists the independent slice', async () => {
    storage.setItem('lite-db-storage', JSON.stringify({
      state: {
        appearance: {
          highlightCurrentSqlStatement: false,
        },
      },
      version: 21,
    }));

    const { useStore } = await importStore();
    expect(useStore.getState().sqlStatementHighlight).toEqual({
      highlightCurrentSqlStatement: false,
      confirmSqlStatementRun: false,
    });

    useStore.getState().setSqlStatementHighlightSettings({
      highlightCurrentSqlStatement: true,
      confirmSqlStatementRun: true,
    });

    const persisted = JSON.parse(storage.getItem('lite-db-storage') || '{}');
    expect(persisted.state.sqlStatementHighlight).toEqual({
      highlightCurrentSqlStatement: true,
      confirmSqlStatementRun: true,
    });

    vi.resetModules();
    const reloaded = await importStore();
    expect(reloaded.useStore.getState().sqlStatementHighlight).toEqual({
      highlightCurrentSqlStatement: true,
      confirmSqlStatementRun: true,
    });
  });
});
