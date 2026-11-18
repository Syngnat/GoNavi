import { describe, expect, it, vi } from 'vitest';
import * as WailsApp from '../../../wailsjs/go/app/App';

import { buildDataSyncPasteWorkbenchTab } from '../../utils/dataSyncTab';
import { buildDataSyncWorkbenchInitialTasks } from './dataSyncWorkbenchInitialTasks';
import { reviseDataSyncTask } from './model';
import { encodeDataSyncJobDefinition, isLocalDataSyncTaskId } from './wailsDto';
import { createWailsDataSyncWorkbenchGateway, type WailsDataSyncApi } from './wailsGateway';

const buildPasteDraft = (targetConnectionId: string, tables: string[], withFocus = true) => {
  const tab = buildDataSyncPasteWorkbenchTab({
    entryMode: 'sync',
    requestId: 100,
    pastePrefill: {
      source: { connectionId: 'source', database: 'shop', schema: 'public', tables },
      target: { connectionId: targetConnectionId, database: 'archive', schema: 'backup' },
    },
  });
  return buildDataSyncWorkbenchInitialTasks({
    tabId: tab.id,
    tabTitle: tab.title,
    connectionId: tab.connectionId,
    workbenchFamily: 'sync',
    pastePrefill: tab.dataSyncPastePrefill,
    focusTaskId: withFocus ? tab.dataSyncFocusTaskId : undefined,
    connections: [],
  })[0];
};

describe('saving pasted table drafts', () => {
  it.each([
    ['another database', 'source', ['orders'], true],
    ['another host', 'target', ['orders'], true],
    ['multiple tables', 'target', ['orders', 'customers'], true],
    ['a restored paste tab without a focus id', 'target', ['orders'], false],
  ] as const)('creates a new job for %s and then updates its server identity', async (_label, connectionId, tables, withFocus) => {
    const draft = buildPasteDraft(connectionId, [...tables], withFocus);
    const save = vi.fn<WailsDataSyncApi['DataSyncJobSave']>(async (definition) => {
      if (definition.id && definition.id !== 'sync-job-created') {
        return { success: false, message: 'data sync job record not found' };
      }
      return {
        success: true,
        data: {
          ...definition,
          id: 'sync-job-created',
          revision: definition.id ? definition.revision + 1 : 1,
          createdAt: 1_800_000_000_000,
          updatedAt: 1_800_000_000_100,
        },
      };
    });
    const gateway = createWailsDataSyncWorkbenchGateway({ api: { ...WailsApp, DataSyncJobSave: save } });

    const saved = await gateway.saveTask(draft);

    expect(save).toHaveBeenNthCalledWith(1, expect.objectContaining({ id: '', revision: 0, createdAt: 0, updatedAt: 0 }), '');
    expect(saved).toMatchObject({ id: 'sync-job-created', revision: 1, lifecycle: 'draft', content: 'both' });
    expect(saved.source).toMatchObject(draft.source);
    expect(saved.target).toMatchObject(draft.target);
    expect(saved.mappings.map((mapping) => mapping.sourceObject)).toEqual(tables.map((table) => `public.${table}`));

    const updated = await gateway.saveTask(reviseDataSyncTask(saved, { name: 'Updated draft' }));

    expect(save).toHaveBeenNthCalledWith(2, expect.objectContaining({ id: saved.id, revision: 1 }), '');
    expect(updated).toMatchObject({ id: saved.id, revision: 2, name: 'Updated draft' });
  });

  it('does not turn a missing persisted task into a new job', async () => {
    const draft = { ...buildPasteDraft('target', ['orders']), id: 'sync-job-deleted', revision: 3 };
    const save = vi.fn<WailsDataSyncApi['DataSyncJobSave']>(async () => ({
      success: false,
      message: 'data sync job record not found',
    }));
    const gateway = createWailsDataSyncWorkbenchGateway({ api: { ...WailsApp, DataSyncJobSave: save } });

    expect(isLocalDataSyncTaskId(draft.id)).toBe(false);
    expect(encodeDataSyncJobDefinition(draft)).toMatchObject({ id: draft.id, revision: 3 });
    await expect(gateway.saveTask(draft)).rejects.toThrow('data sync job record not found');
    expect(save).toHaveBeenCalledTimes(1);
  });
});
