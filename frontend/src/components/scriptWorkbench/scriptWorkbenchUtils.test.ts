import { describe, expect, it } from 'vitest';
import type { SavedConnection } from '../../types';
import {
  buildConnectionBindings,
  buildInitialDraft,
  describeConnectionEnvironment,
  fillScriptDraftContext,
  resolveScriptConnectionDatabase,
  resolveRunLimitsForRequest,
  resolveScriptRunLimitValues,
  SCRIPT_STARTER_SOURCE,
  scriptSourceWithPrimaryAlias,
} from './scriptWorkbenchUtils';

const connection = (overrides: Partial<SavedConnection['config']>): SavedConnection => ({
  id: 'conn-1',
  name: 'prod',
  config: {
    type: 'mysql',
    host: 'db.internal',
    port: 3306,
    user: 'reader',
    database: 'orders',
    useSSH: false,
    ssh: { host: '', port: 22, user: '' },
    ...overrides,
  },
});

describe('script workbench connection helpers', () => {
  it('treats Oracle service names as connection targets, not schemas', () => {
    expect(resolveScriptConnectionDatabase(connection({
      type: 'oracle',
      database: 'ORCLPDB1',
    }))).toBe('');
    expect(resolveScriptConnectionDatabase(connection({
      type: 'oceanbase',
      oceanBaseProtocol: 'oracle',
      database: 'OBORCL',
    }))).toBe('');
    expect(resolveScriptConnectionDatabase(connection({
      type: 'postgres',
      database: 'orders',
    }))).toBe('orders');
  });

  it('creates stable aliases for selected connections', () => {
    const prod = connection({});
    const archive = { ...connection({ database: 'archive' }), id: 'conn-2', name: 'archive' };
    expect(buildConnectionBindings([prod.id, archive.id], [prod, archive])).toEqual([
      { alias: 'prod', connectionId: 'conn-1', database: 'orders' },
      { alias: 'archive', connectionId: 'conn-2', database: 'archive' },
    ]);
    const numbered = { ...connection({}), id: 'conn-3', name: '2026 orders' };
    expect(buildConnectionBindings([numbered.id], [numbered])[0].alias).toBe('_2026-orders');
    const duplicateName = { ...connection({}), id: 'conn-4', name: 'prod' };
    expect(buildConnectionBindings([prod.id, duplicateName.id], [prod, duplicateName]).map((item) => item.alias))
      .toEqual(['prod', 'prod2']);
  });

  it('keeps the starter script aligned with the first connection alias', () => {
    const prod = connection({});
    const draft = buildInitialDraft({
      tab: {},
      defaultName: 'script',
      source: SCRIPT_STARTER_SOURCE,
      connectionIds: [prod.id],
      connections: [prod],
    });
    expect(draft.connections[0].alias).toBe('prod');
    expect(draft.source).toContain('gonavi.db.query("prod"');
    expect(scriptSourceWithPrimaryAlias(SCRIPT_STARTER_SOURCE, 'warehouse'))
      .toContain('gonavi.db.query("warehouse"');
  });

  it('uses the tab database for the initial binding and only fills missing restored context', () => {
    const prod = connection({});
    const initial = buildInitialDraft({
      tab: { dbName: 'reporting' },
      defaultName: 'script',
      source: SCRIPT_STARTER_SOURCE,
      connectionIds: [prod.id],
      connections: [prod],
    });
    expect(initial.connections[0].database).toBe('reporting');

    const restored = {
      ...initial,
      connections: [
        { alias: 'prod', connectionId: 'conn-1', database: '' },
        { alias: 'archive', database: 'archive_user' },
      ],
    };
    const filled = fillScriptDraftContext({
      draft: restored,
      connectionId: prod.id,
      dbName: 'reporting',
      connections: [prod],
    });
    expect(filled.connections[0].database).toBe('reporting');
    expect(filled.connections[1].database).toBe('archive_user');
  });

  it('normalizes padded environment labels instead of treating them as local', () => {
    expect(describeConnectionEnvironment({
      ...connection({}),
      environmentType: ' PRODUCTION ',
    } as unknown as SavedConnection)).toBe('production');
  });

  it('treats zero run limits as defaults and clamps custom limits', () => {
    const defaults = resolveScriptRunLimitValues({
      timeoutMs: 0,
      maxDbCalls: 0,
      maxOutputRows: 0,
      memoryLimitBytes: 0,
    });
    expect(defaults).toEqual({
      timeoutMs: 30 * 60_000,
      maxDbCalls: 10_000,
      maxOutputRows: 50_000,
      memoryLimitBytes: 512 * 1024 * 1024,
    });

    expect(resolveScriptRunLimitValues({
      timeoutMs: 1,
      maxDbCalls: 999_999,
      maxOutputRows: 999_999,
      memoryLimitBytes: 1,
    })).toEqual({
      timeoutMs: 60_000,
      maxDbCalls: 100_000,
      maxOutputRows: 200_000,
      memoryLimitBytes: 64 * 1024 * 1024,
    });

    expect(resolveScriptRunLimitValues({
      timeoutMs: 3 * 60 * 60_000,
      maxDbCalls: 20_000,
      maxOutputRows: 80_000,
      memoryLimitBytes: 2 * 1024 * 1024 * 1024,
    }, true)).toEqual({
      timeoutMs: 30 * 60_000,
      maxDbCalls: 20_000,
      maxOutputRows: 80_000,
      memoryLimitBytes: 1024 * 1024 * 1024,
    });
  });

  it('ties the single-query row ceiling to the output row limit', () => {
    const draft = buildInitialDraft({
      tab: {},
      defaultName: 'script',
      source: SCRIPT_STARTER_SOURCE,
      connectionIds: [],
      connections: [],
    });
    const limits = resolveRunLimitsForRequest({
      ...draft,
      runLimits: { maxOutputRows: 120_000 },
    });
    expect(limits.maxQueryRows).toBe(120_000);
    expect(limits.defaultQueryRows).toBe(10_000);
  });
});
