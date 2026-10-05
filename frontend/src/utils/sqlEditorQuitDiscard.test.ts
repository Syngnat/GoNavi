import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SavedQuery, TabData } from '../types';

class MemoryStorage implements Storage {
  private data = new Map<string, string>();
  get length(): number { return this.data.size; }
  clear(): void { this.data.clear(); }
  getItem(key: string): string | null { return this.data.has(key) ? this.data.get(key)! : null; }
  key(index: number): string | null { return Array.from(this.data.keys())[index] ?? null; }
  removeItem(key: string): void { this.data.delete(key); }
  setItem(key: string, value: string): void { this.data.set(key, String(value)); }
}

// What the person saved, and what the editor holds after they pressed "format" and never saved.
const SAVED_SQL = 'WITH rfm AS (\r\n  SELECT c.id, c.name FROM lab_customers c\r\n)\r\nSELECT * FROM rfm;\r\n';
const FORMATTED_SQL = 'WITH\r\n  rfm AS (\r\n    SELECT\r\n      c.id,\r\n      c.name\r\n    FROM\r\n      lab_customers c\r\n  )\r\nSELECT\r\n  *\r\nFROM\r\n  rfm;\r\n';

const savedQuery: SavedQuery = {
  id: 'saved-rfm', name: 'RFM', sql: SAVED_SQL, connectionId: 'conn-1', dbName: 'lab', createdAt: 1,
};

const savedQueryTab = (query: string): TabData => ({
  id: 'saved-rfm', title: 'RFM', type: 'query', connectionId: 'conn-1', dbName: 'lab', query, savedQueryId: 'saved-rfm',
});

const noFile = vi.fn(async () => ({ success: false, message: 'no such file or directory' }));

// Each test loads the whole store fresh (to simulate a restart); the first load is slow.
describe('quitting and discarding unsaved SQL', { timeout: 30_000 }, () => {
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
    const { useStore, flushAppStatePersistence } = await import('../store');
    await useStore.persist.rehydrate();
    const drafts = await import('./sqlFileTabDrafts');
    const quit = await import('./sqlEditorApplicationQuit');
    const discard = await import('./sqlEditorQuitDiscard');
    return { useStore, flushAppStatePersistence, ...drafts, ...quit, ...discard };
  };

  // What quitting does after the prompt: persist the drafts and the tabs, then exit.
  const quitApp = async (app: Awaited<ReturnType<typeof startApp>>) => {
    app.flushQueryTabDraftSnapshots();
    await app.flushAppStatePersistence();
  };

  it('does not ask again on the next quit after the person chose to discard', async () => {
    // First run: a saved query is opened and formatted, and never saved.
    const first = await startApp();
    first.useStore.setState({ tabs: [savedQueryTab(FORMATTED_SQL)], activeTabId: 'saved-rfm', savedQueries: [savedQuery] });
    first.setQueryTabDraft('saved-rfm', FORMATTED_SQL);
    first.persistQueryTabDraftSnapshot(savedQueryTab(FORMATTED_SQL), FORMATTED_SQL);
    expect(await first.collectApplicationQuitUnsavedSQLTargets(first.useStore.getState().tabs, [savedQuery], noFile)).toHaveLength(1);

    // The prompt: "quit and discard unsaved changes".
    expect(await first.discardApplicationQuitUnsavedSQLChanges(noFile)).toBe(1);
    await quitApp(first);

    // Second run: nothing is touched, and quitting asks nothing.
    vi.resetModules();
    const second = await startApp();
    second.useStore.setState({ savedQueries: [savedQuery] });
    const tab = second.useStore.getState().tabs.find((candidate) => candidate.id === 'saved-rfm');
    expect(tab?.query).toBe(SAVED_SQL);
    expect(await second.collectApplicationQuitUnsavedSQLTargets(second.useStore.getState().tabs, [savedQuery], noFile)).toEqual([]);
  });

  it('without the discard the old edit came back and was asked about again (the bug)', async () => {
    const first = await startApp();
    first.useStore.setState({ tabs: [savedQueryTab(FORMATTED_SQL)], activeTabId: 'saved-rfm', savedQueries: [savedQuery] });
    first.setQueryTabDraft('saved-rfm', FORMATTED_SQL);
    first.persistQueryTabDraftSnapshot(savedQueryTab(FORMATTED_SQL), FORMATTED_SQL);
    await quitApp(first); // the old "confirm quit": persisted as is

    vi.resetModules();
    const second = await startApp();
    expect(await second.collectApplicationQuitUnsavedSQLTargets(second.useStore.getState().tabs, [savedQuery], noFile)).toHaveLength(1);
  });

  it('puts back the saved connection and database, and drops the format-undo snapshot', async () => {
    const app = await startApp();
    const moved = { ...savedQueryTab(SAVED_SQL), dbName: 'other_db', formatRestoreSnapshot: { query: 'x', createdAt: 1 } };
    app.useStore.setState({ tabs: [moved], savedQueries: [savedQuery] });
    expect(await app.discardApplicationQuitUnsavedSQLChanges(noFile)).toBe(1);
    const tab = app.useStore.getState().tabs[0];
    expect(tab).toMatchObject({ query: SAVED_SQL, connectionId: 'conn-1', dbName: 'lab' });
    expect(tab.formatRestoreSnapshot).toBeUndefined();
  });

  it('empties a new query that was never saved, so it is not restored', async () => {
    const first = await startApp();
    const scratch: TabData = { id: 'query-new', title: 'New query', type: 'query', connectionId: 'conn-1', dbName: 'lab', query: 'select 42;' };
    first.useStore.setState({ tabs: [scratch], activeTabId: 'query-new', savedQueries: [] });
    first.setQueryTabDraft('query-new', 'select 42;');
    first.persistQueryTabDraftSnapshot(scratch, 'select 42;');
    expect(await first.discardApplicationQuitUnsavedSQLChanges(noFile)).toBe(1);
    await quitApp(first);

    vi.resetModules();
    const second = await startApp();
    expect(second.useStore.getState().tabs.find((tab) => tab.id === 'query-new')).toBeUndefined();
    expect(second.listPersistedQueryTabDraftEntries().find((entry) => entry.tabId === 'query-new')).toBeUndefined();
  });

  it('goes back to the file on disk for an SQL file, and keeps the text when the file cannot be read', async () => {
    const app = await startApp();
    const fileTab: TabData = { id: 'file-1', title: 'a.sql', type: 'query', connectionId: 'conn-1', query: 'select 2;', filePath: 'D:/sql/a.sql' };
    app.useStore.setState({ tabs: [fileTab], savedQueries: [] });
    app.setSQLFileTabDraft('file-1', 'select 2;');
    const onDisk = vi.fn(async () => ({ success: true, data: { content: 'select 1;' } }));
    expect(await app.discardApplicationQuitUnsavedSQLChanges(onDisk)).toBe(1);
    expect(app.useStore.getState().tabs[0].query).toBe('select 1;');

    // Unreadable (not missing): nothing to go back to, so the text stays.
    const kept: TabData = { ...fileTab, id: 'file-2', query: 'select 3;' };
    app.useStore.setState({ tabs: [kept] });
    app.setSQLFileTabDraft('file-2', 'select 3;');
    let reads = 0;
    const flaky = vi.fn(async () => {
      reads += 1;
      if (reads === 1) return { success: true, data: { content: 'select 1;' } }; // the check sees a difference
      throw new Error('disk busy'); // the revert cannot read it
    });
    expect(await app.discardApplicationQuitUnsavedSQLChanges(flaky)).toBe(0);
    expect(app.useStore.getState().tabs[0].query).toBe('select 3;');
  });

  it('leaves tabs without unsaved changes alone and never fails the quit', async () => {
    const app = await startApp();
    const clean = savedQueryTab(SAVED_SQL);
    app.useStore.setState({ tabs: [clean], savedQueries: [savedQuery] });
    expect(await app.discardApplicationQuitUnsavedSQLChanges(noFile)).toBe(0);
    expect(app.useStore.getState().tabs[0]).toBe(clean);

    const broken = vi.fn(async () => { throw new Error('boom'); });
    app.useStore.setState({ tabs: [{ ...clean, id: 'file-x', filePath: 'D:/x.sql', savedQueryId: undefined }] });
    await expect(app.discardApplicationQuitUnsavedSQLChanges(broken)).resolves.toBeTypeOf('number');
  });
});

describe('what counts as an unsaved change', () => {
  it('does not count different line endings as a change', async () => {
    const { collectApplicationQuitUnsavedSQLTargets } = await import('./sqlEditorApplicationQuit');
    const lf = SAVED_SQL.replace(/\r\n/g, '\n');
    expect(await collectApplicationQuitUnsavedSQLTargets([savedQueryTab(lf)], [savedQuery], noFile)).toEqual([]);
    // A real edit still counts.
    expect(await collectApplicationQuitUnsavedSQLTargets([savedQueryTab(lf + '-- note\n')], [savedQuery], noFile)).toHaveLength(1);
  });
});
