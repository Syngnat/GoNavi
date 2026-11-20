import { describe, expect, it } from 'vitest';
import type { ScriptDraft } from './scriptWorkbenchTypes';
import {
  SCRIPT_WORKBENCH_DRAFT_STORAGE_KEY,
  MAX_SCRIPT_DRAFT_SOURCE_BYTES,
  clearScriptWorkbenchDraft,
  loadScriptWorkbenchDraft,
  saveScriptWorkbenchDraft,
  type ScriptWorkbenchDraftStorage,
} from './scriptWorkbenchDraftStorage';

const createStorage = (): ScriptWorkbenchDraftStorage & { values: Map<string, string> } => {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  };
};

const draft: ScriptDraft = {
  draftInstanceId: 'draft:test-storage',
  id: 'script-1',
  name: 'Nightly reconciliation',
  description: 'Keeps the draft description.',
  source: 'const 名称 = "订单";\ngonavi.output("rows", [{ 名称, emoji: "✅" }]);\n',
  visibility: 'private',
  folderId: 'folder-1',
  revision: 7,
  connections: [{ alias: 'prod', connectionId: 'conn-1', database: 'orders' }],
  inputs: [{
    alias: 'orders',
    path: '/tmp/orders.xlsx',
    name: 'orders.xlsx',
    sheetName: 'Sheet1',
    encoding: 'utf-8',
    delimiter: ',',
    headerRow: 1,
  }],
  allowWrite: true,
  batchSize: 2_000,
  inListLimit: 800,
  runLimits: {
    timeoutMs: 45 * 60_000,
    maxDbCalls: 20_000,
    maxOutputRows: 80_000,
    memoryLimitBytes: 768 << 20,
  },
};

describe('script workbench draft storage', () => {
  it('round-trips the draft source and rejects a different script identity', () => {
    const storage = createStorage();

    expect(saveScriptWorkbenchDraft('script-workbench:script-1', draft, storage)).toMatchObject({
      ok: true,
    });
    expect(storage.values.has(SCRIPT_WORKBENCH_DRAFT_STORAGE_KEY)).toBe(true);
    expect(loadScriptWorkbenchDraft('script-workbench:script-1', 'script-1', storage)).toEqual(draft);
    expect(loadScriptWorkbenchDraft('script-workbench:script-1', 'script-2', storage)).toBeNull();
  });

  it('stores zero run limits as unset so runtime defaults keep applying', () => {
    const storage = createStorage();
    saveScriptWorkbenchDraft('tab-zero-limits', {
      ...draft,
      id: 'script-zero-limits',
      runLimits: {
        timeoutMs: 0,
        maxDbCalls: 0,
        maxOutputRows: 0,
        memoryLimitBytes: 0,
      },
    }, storage);

    const restored = loadScriptWorkbenchDraft('tab-zero-limits', 'script-zero-limits', storage);
    expect(restored?.runLimits).toBeUndefined();
  });

  it('clears the persisted entry without touching other tabs', () => {
    const storage = createStorage();
    saveScriptWorkbenchDraft('tab-1', draft, storage);
    saveScriptWorkbenchDraft('tab-2', { ...draft, id: 'script-2', source: 'gonavi.log("two");' }, storage);

    expect(clearScriptWorkbenchDraft('tab-1', storage)).toBe(true);
    expect(loadScriptWorkbenchDraft('tab-1', 'script-1', storage)).toBeNull();
    expect(loadScriptWorkbenchDraft('tab-2', 'script-2', storage)).toMatchObject({
      description: draft.description,
      source: 'gonavi.log("two");',
    });
  });

  it('rejects an oversized source instead of silently truncating it', () => {
    const storage = createStorage();
    const result = saveScriptWorkbenchDraft('tab-large', {
      ...draft,
      source: 'x'.repeat(MAX_SCRIPT_DRAFT_SOURCE_BYTES + 1),
    }, storage);

    expect(result).toMatchObject({ ok: false, reason: 'source_too_large' });
    expect(storage.values.size).toBe(0);
  });

  it('reports quota failures so the workbench can surface them', () => {
    const storage: ScriptWorkbenchDraftStorage = {
      getItem: () => null,
      setItem: () => { throw new Error('quota'); },
      removeItem: () => undefined,
    };

    expect(saveScriptWorkbenchDraft('tab-quota', draft, storage)).toMatchObject({
      ok: false,
      reason: 'quota',
    });
  });

  it('enforces the total draft budget by evicting oldest entries, not source content', () => {
    const storage = createStorage();
    const source = 'x'.repeat(220_000);
    for (let index = 0; index < 24; index += 1) {
      expect(saveScriptWorkbenchDraft(`tab-${index}`, {
        ...draft,
        id: `script-${index}`,
        source,
      }, storage)).toMatchObject({ ok: true });
    }

    const envelope = JSON.parse(
      storage.values.get(SCRIPT_WORKBENCH_DRAFT_STORAGE_KEY) || '{}',
    ) as { entries?: Array<{ tabId: string }> };
    expect(envelope.entries?.length).toBeLessThan(24);
    expect(envelope.entries?.some((entry) => entry.tabId === 'tab-23')).toBe(true);
    expect(loadScriptWorkbenchDraft('tab-23', 'script-23', storage)?.source).toBe(source);
  });
});
