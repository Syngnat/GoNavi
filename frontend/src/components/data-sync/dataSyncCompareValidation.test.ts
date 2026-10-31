import { describe, expect, it } from 'vitest';

import {
  mappingReady,
  targetHintKey,
  targetStatus,
} from './mappingTable/dataSyncMappingStatus';
import {
  createDataSyncTableMapping,
  createDataSyncTaskDraft,
  reviseDataSyncTask,
  validateDataSyncTask,
} from './model';
import type { DataSyncMetadataResult } from './useDataSyncMetadata';

const compareTask = () =>
  reviseDataSyncTask(
    createDataSyncTaskDraft({
      id: 'compare-1',
      kind: 'compare',
      compareMode: 'schema',
      now: '2026-08-08T00:00:00.000Z',
    }),
    {
      name: 'schema compare',
      source: {
        connectionId: 'src',
        connectionName: 'src',
        type: 'mysql',
        database: 'dev240',
        schema: '',
      },
      target: {
        connectionId: 'tgt',
        connectionName: 'tgt',
        type: 'mysql',
        database: 'prod1',
        schema: '',
      },
      mappings: [
        { ...createDataSyncTableMapping('compare-1:mapping:1'), sourceObject: 'kf_ai_platform' },
      ],
    },
  );

const emptyTargets = {
  status: 'ready',
  items: [],
  reload: () => {},
} as unknown as DataSyncMetadataResult<{ name: string; kind: string }>;

describe('compare task with a missing target table', () => {
  it('does not block the task on a blank target name', () => {
    const issues = validateDataSyncTask(compareTask());
    const codes = issues.map((issue) => issue.code);

    expect(codes).not.toContain('target_object_required');
  });

  it('treats the missing table as ready to compare and explains it', () => {
    const mapping = { ...createDataSyncTableMapping('m1'), sourceObject: 'kf_ai_platform' };

    expect(targetStatus(mapping, emptyTargets as never)).toBe('missing');
    expect(mappingReady(mapping, 'compare', 'missing')).toBe(true);
    expect(targetHintKey('missing', 'compare')).toBe('mapping.target_hint.missing_compare');
    // 不可建表的写任务缺表仍沿用「只在已有表上写」的提示，不能跟着 compare 一起改。
    expect(targetHintKey('missing', 'cdc')).toBe(
      'mapping.target_hint.missing_requires_existing',
    );
    expect(mappingReady(mapping, 'reconcile', 'missing')).toBe(false);
  });
});
