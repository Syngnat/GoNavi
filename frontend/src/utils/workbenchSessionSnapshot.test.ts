import { describe, expect, it } from 'vitest';

import type { WorkbenchTabType } from '../tabTypes';
import type { TabData } from '../types';
import {
  buildWorkbenchSessionSnapshot,
  parseWorkbenchSessionSnapshot,
  planWorkbenchSessionRestore,
  toSnapshotTab,
} from './workbenchSessionSnapshot';

const tab = (overrides: Partial<TabData> & { id: string; type: WorkbenchTabType }): TabData => ({
  title: overrides.id,
  connectionId: 'conn-1',
  ...overrides,
});

const state = (tabs: TabData[], activeTabId: string | null = null, aiPanelVisible = false, aiActiveSessionId: string | null = null) => ({
  tabs, activeTabId, aiPanelVisible, detachedAIChatWindow: null as unknown, aiActiveSessionId,
});

const roundTrip = (snapshotState: ReturnType<typeof state>) => (
  parseWorkbenchSessionSnapshot(JSON.stringify(buildWorkbenchSessionSnapshot(snapshotState)))
);

describe('workbench session snapshot', () => {
  it('keeps what identifies a tab and drops what only carried the request that opened it', () => {
    const opened = tab({
      id: 'table-conn-1-main-users', type: 'table', dbName: 'main', tableName: 'users', schemaName: 'public',
      objectType: 'view', readOnly: true,
      initialViewMode: 'ddl', initialViewModeRequestId: 'req-1', query: 'select 1', dataImportRunning: true,
      tableExportQueryByScope: { all: 'select * from big' }, triggerRollbackSql: 'create trigger ...',
    } as Partial<TabData> & { id: string; type: WorkbenchTabType });

    expect(toSnapshotTab(opened)).toEqual({
      id: 'table-conn-1-main-users', type: 'table', title: 'table-conn-1-main-users', connectionId: 'conn-1',
      dbName: 'main', tableName: 'users', schemaName: 'public', objectType: 'view', readOnly: true,
    });
  });

  it('remembers a redis database index, including the first one', () => {
    expect(toSnapshotTab(tab({ id: 'redis-1', type: 'redis-keys', redisDB: 0 }))?.redisDB).toBe(0);
    expect(toSnapshotTab(tab({ id: 'redis-2', type: 'redis-keys', redisDB: 7 }))?.redisDB).toBe(7);
    expect(toSnapshotTab(tab({ id: 'redis-3', type: 'redis-keys', redisDB: -1 }))?.redisDB).toBeUndefined();
    expect(toSnapshotTab(tab({ id: 'redis-4', type: 'redis-keys' }))?.redisDB).toBeUndefined();
  });

  it('does not bring back tabs that exist to carry out one request', () => {
    (['table-export', 'data-import', 'sql-file-execution', 'sql-analysis'] as WorkbenchTabType[]).forEach((type) => {
      expect(toSnapshotTab(tab({ id: `${type}-1`, type }))).toBeNull();
    });
    const written = buildWorkbenchSessionSnapshot(state([
      tab({ id: 'export-1', type: 'table-export' }), tab({ id: 'table-1', type: 'table', tableName: 't' }),
    ]));
    expect(written.entries.map((entry) => (entry.kind === 'tab' ? entry.tab.id : entry.id))).toEqual(['table-1']);
  });

  it('keeps SQL editors as places in the strip, not as copies of their text', () => {
    const written = buildWorkbenchSessionSnapshot(state([
      tab({ id: 'query-1', type: 'query', query: 'select secret from t' }), tab({ id: 'settings', type: 'settings-center', connectionId: '' }),
    ], 'settings'));
    expect(written.entries[0]).toEqual({ kind: 'query-slot', id: 'query-1' });
    expect(JSON.stringify(written)).not.toContain('secret');
    expect(written.activeTabId).toBe('settings');
  });

  it('reads stored data without trusting it', () => {
    expect(parseWorkbenchSessionSnapshot(null)).toBeNull();
    expect(parseWorkbenchSessionSnapshot('not json')).toBeNull();
    expect(parseWorkbenchSessionSnapshot(JSON.stringify({ version: 2, entries: [] }))).toBeNull();

    const parsed = parseWorkbenchSessionSnapshot(JSON.stringify({
      version: 1,
      activeTabId: 'gone',
      aiPanelDocked: 'yes',
      entries: [
        null, 7, { kind: 'tab', tab: { id: 't1', type: 'table', connectionId: 'c', tableName: 'x'.repeat(5000), providerMode: 'nope' } },
        { kind: 'tab', tab: { id: 't1', type: 'table' } },
        { kind: 'tab', tab: { id: 'x1', type: 'table-export' } },
        { kind: 'tab', tab: { type: 'table' } },
        { kind: 'query-slot', id: 'q1' },
        { kind: 'surprise' },
      ],
    }));
    expect(parsed?.entries.map((entry) => (entry.kind === 'tab' ? entry.tab.id : entry.id))).toEqual(['t1', 'q1']);
    expect(parsed?.entries[0].kind === 'tab' && parsed.entries[0].tab.tableName?.length).toBe(512);
    expect(parsed?.entries[0].kind === 'tab' && parsed.entries[0].tab.providerMode).toBeUndefined();
    expect(parsed?.activeTabId).toBeNull();
    expect(parsed?.aiPanelDocked).toBe(false);
    expect(parsed?.aiSessionId).toBeNull();
  });

  it('remembers which AI conversation the panel was on, open or not, and tolerates its absence', () => {
    expect(roundTrip(state([], null, true, 'agent-session-7'))?.aiSessionId).toBe('agent-session-7');
    expect(roundTrip(state([], null, false, 'agent-session-7'))?.aiSessionId).toBe('agent-session-7');
    expect(roundTrip(state([], null, true, null))?.aiSessionId).toBeNull();
    expect(roundTrip(state([], null, true, '  '))?.aiSessionId).toBeNull();
    // A snapshot written before the conversation was remembered still reads.
    const older = parseWorkbenchSessionSnapshot(JSON.stringify({ version: 1, entries: [], activeTabId: null, aiPanelDocked: true }));
    expect(older).toMatchObject({ aiPanelDocked: true, aiSessionId: null });
  });

  it('does not let a long strip grow the snapshot without bound', () => {
    const many = Array.from({ length: 200 }, (_, index) => tab({ id: `table-${index}`, type: 'table', tableName: `t${index}` }));
    expect(buildWorkbenchSessionSnapshot(state(many)).entries).toHaveLength(60);
  });

  it('remembers an open AI panel only when it was docked', () => {
    expect(roundTrip(state([], null, true))?.aiPanelDocked).toBe(true);
    expect(roundTrip(state([], null, false))?.aiPanelDocked).toBe(false);
    const detached = { ...state([], null, true, 'agent-session-7'), detachedAIChatWindow: { x: 1 } };
    expect(roundTrip(detached)).toMatchObject({ aiPanelDocked: false, aiSessionId: 'agent-session-7' });
  });
});

describe('restoring the remembered strip', () => {
  const connections = new Set(['conn-1']);
  const snapshotOf = (tabs: TabData[], activeTabId: string | null, aiPanelVisible = false) => (
    roundTrip(state(tabs, activeTabId, aiPanelVisible))!
  );

  it('puts the tabs back in their old order around the SQL editors that came back on their own', () => {
    const remembered = [
      tab({ id: 'table-1', type: 'table', tableName: 'a' }),
      tab({ id: 'query-1', type: 'query' }),
      tab({ id: 'redis-1', type: 'redis-keys', redisDB: 3 }),
      tab({ id: 'query-2', type: 'query' }),
    ];
    const comeBack = [tab({ id: 'query-1', type: 'query', query: 'select 1' }), tab({ id: 'query-2', type: 'query', query: 'select 2' })];
    const plan = planWorkbenchSessionRestore(snapshotOf(remembered, 'redis-1'), { tabs: comeBack, aiPanelVisible: false }, connections);

    expect(plan.tabs.map((item) => item.id)).toEqual(['table-1', 'query-1', 'redis-1', 'query-2']);
    expect(plan.tabs[1]).toBe(comeBack[0]); // the live editor, text and all
    expect(plan.activeTabId).toBe('redis-1');
  });

  it('drops a tab whose connection is gone, but not one that never had a connection', () => {
    const remembered = [
      tab({ id: 'table-1', type: 'table', connectionId: 'conn-gone', tableName: 'a' }),
      tab({ id: 'settings', type: 'settings-center', connectionId: '' }),
      tab({ id: 'orphan-ok', type: 'table', connectionId: 'conn-gone', preserveUnboundConnection: true }),
      tab({ id: 'table-2', type: 'table', tableName: 'b' }),
    ];
    const plan = planWorkbenchSessionRestore(snapshotOf(remembered, 'table-1'), { tabs: [], aiPanelVisible: false }, connections);
    expect(plan.tabs.map((item) => item.id)).toEqual(['settings', 'orphan-ok', 'table-2']);
    expect(plan.activeTabId).toBeNull(); // the front tab did not come back: leave the current one
  });

  it('keeps tabs opened since, after the remembered ones, and does not open one twice', () => {
    const remembered = [tab({ id: 'table-1', type: 'table', tableName: 'a' })];
    const openNow = tab({ id: 'table-1', type: 'table', tableName: 'a', title: 'already open' });
    const extra = tab({ id: 'query-9', type: 'query' });
    const plan = planWorkbenchSessionRestore(snapshotOf(remembered, null), { tabs: [extra, openNow], aiPanelVisible: false }, connections);
    expect(plan.tabs).toEqual([openNow, extra]);
  });

  it('opens the AI panel only if it was open and is not already', () => {
    expect(planWorkbenchSessionRestore(snapshotOf([], null, true), { tabs: [], aiPanelVisible: false }, connections).openAIPanel).toBe(true);
    expect(planWorkbenchSessionRestore(snapshotOf([], null, true), { tabs: [], aiPanelVisible: true }, connections).openAIPanel).toBe(false);
    expect(planWorkbenchSessionRestore(snapshotOf([], null, false), { tabs: [], aiPanelVisible: false }, connections).openAIPanel).toBe(false);
  });
});
