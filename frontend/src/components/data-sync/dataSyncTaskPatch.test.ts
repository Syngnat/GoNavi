import { describe, expect, it } from 'vitest';

import { dataSyncTaskPatchHasChanges } from './dataSyncTaskPatch';
import { createDataSyncTaskDraft, reviseDataSyncTask } from './model';

const baseTask = () =>
  reviseDataSyncTask(createDataSyncTaskDraft({ id: 'task-1', kind: 'migration' }), {
    mappings: [
      {
        id: 'mapping-1',
        sourceObject: 'public.orders',
        targetObject: 'public.orders',
        targetMode: 'create_or_reuse',
        enabled: true,
        keyColumns: ['id'],
        fields: [],
      },
    ],
  });

describe('dataSyncTaskPatchHasChanges', () => {
  it('ignores a rebuilt but semantically identical background probe patch', () => {
    const task = baseTask();
    expect(
      dataSyncTaskPatchHasChanges(task, {
        mappings: task.mappings.map((mapping) => ({
          ...mapping,
          keyColumns: [...mapping.keyColumns],
          fields: mapping.fields.map((field) => ({ ...field })),
        })),
      }),
    ).toBe(false);
  });

  it('detects a real mapping change without depending on object identity', () => {
    const task = baseTask();
    expect(
      dataSyncTaskPatchHasChanges(task, {
        mappings: task.mappings.map((mapping) => ({
          ...mapping,
          targetObject: 'public.orders_archive',
        })),
      }),
    ).toBe(true);
  });

  it('detects a shallow semantic change', () => {
    const task = baseTask();
    expect(dataSyncTaskPatchHasChanges(task, { lifecycle: 'ready' })).toBe(true);
    expect(dataSyncTaskPatchHasChanges(task, { lifecycle: task.lifecycle })).toBe(false);
  });
});
