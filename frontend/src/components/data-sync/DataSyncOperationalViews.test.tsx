import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { DataSyncRunHistory } from './DataSyncOperationalViews';
import type { DataSyncCompareResult, DataSyncRunRecord } from './model';
import { createDataSyncWorkbenchTranslate } from './text';

describe('DataSyncRunHistory compare output', () => {
  it('uses structured column differences instead of repeating schema summary text', () => {
    const run: DataSyncRunRecord = {
      id: 'compare-run',
      taskId: 'compare-task',
      taskName: 'Orders compare',
      status: 'succeeded',
      trigger: 'manual',
      attempt: 1,
      resumable: false,
      message: '',
      startedAt: '2026-08-24T00:00:00.000Z',
      finishedAt: '2026-08-24T00:01:00.000Z',
      rowsRead: 0,
      rowsWritten: 0,
      rowsFailed: 0,
      throughput: 0,
      checkpoint: '',
    };
    const compareResult: DataSyncCompareResult = {
      success: true,
      message: '',
      content: 'both',
      tables: [{
        table: 'orders',
        canSync: false,
        inserts: 0,
        updates: 0,
        deletes: 0,
        same: 0,
        schemaDiffCount: 1,
        hasSchema: true,
        message: '目标表缺失 1 个字段：new_column；数据对比仅比较两端共有字段，同步执行前需先补齐目标表结构',
        warnings: ['目标表缺失 1 个字段：new_column'],
        columnDiffs: [{
          column: 'new_column',
          kind: 'missing_in_target',
          source: 'varchar(255)',
        }],
      }],
    };

    const markup = renderToStaticMarkup(
      <DataSyncRunHistory
        runs={[run]}
        runPage={1}
        runPageSize={10}
        runTotal={1}
        hasPreviousRunPage={false}
        hasNextRunPage={false}
        selectedRunId={run.id}
        runEvents={[]}
        errorRows={[]}
        compareResult={compareResult}
        compareMode="both"
        t={createDataSyncWorkbenchTranslate('zh-CN')}
        checkpoint={null}
        busyAction=""
        onRefresh={() => undefined}
        onPreviousRunPage={() => undefined}
        onNextRunPage={() => undefined}
        onRunPageSizeChange={() => undefined}
        onDeleteRun={() => undefined}
        onClearTerminalRuns={() => undefined}
        onSelectRun={() => undefined}
        onCancel={() => undefined}
        onResume={() => undefined}
        onRetry={() => undefined}
        onDiscardErrorRow={() => undefined}
        errorRowRetryAvailable={false}
        onRetryErrorRow={() => undefined}
        checkpointResetEnabled={false}
        onResetCheckpoint={() => undefined}
      />,
    );

    expect(markup).toContain('目标缺失');
    expect(markup).not.toContain('目标表缺失 1 个字段：new_column');
    expect(markup).toContain('gn-data-sync-compare-row__schema-counts');
    expect(markup).toContain('gn-data-sync-compare-row__data-counts');
    expect(markup).toContain('data-data-sync-compare-field="true"');
    expect(markup).toContain('删除记录');
    expect(markup).toContain('第 1 页');
    expect(markup).toContain('共 1 条');
    expect(markup.match(/varchar\(255\)/g)).toHaveLength(1);
  });

  it('explains task-level failures when a run has no isolated error rows', () => {
    const run: DataSyncRunRecord = {
      id: 'failed-run',
      taskId: 'task-1',
      taskName: 'Batch sync',
      status: 'failed',
      trigger: 'manual',
      attempt: 1,
      resumable: false,
      message: '映射目标表缺少字段：new_column',
      startedAt: '2026-08-24T00:00:00.000Z',
      finishedAt: '2026-08-24T00:01:00.000Z',
      rowsRead: 0,
      rowsWritten: 0,
      rowsFailed: 0,
      throughput: 0,
      checkpoint: '',
    };
    const markup = renderToStaticMarkup(
      <DataSyncRunHistory
        runs={[run]}
        runPage={1}
        runPageSize={10}
        runTotal={1}
        hasPreviousRunPage={false}
        hasNextRunPage={false}
        selectedRunId={run.id}
        selectedRunMessage={run.message}
        runEvents={[]}
        errorRows={[]}
        compareResult={null}
        t={createDataSyncWorkbenchTranslate('zh-CN')}
        checkpoint={null}
        busyAction=""
        onRefresh={() => undefined}
        onPreviousRunPage={() => undefined}
        onNextRunPage={() => undefined}
        onRunPageSizeChange={() => undefined}
        onDeleteRun={() => undefined}
        onClearTerminalRuns={() => undefined}
        onSelectRun={() => undefined}
        onCancel={() => undefined}
        onResume={() => undefined}
        onRetry={() => undefined}
        onDiscardErrorRow={() => undefined}
        errorRowRetryAvailable={false}
        onRetryErrorRow={() => undefined}
        checkpointResetEnabled={false}
        onResetCheckpoint={() => undefined}
      />,
    );

    expect(markup).toContain('映射目标表缺少字段：new_column');
    expect(markup).toContain('data-data-sync-task-failure');
  });
});
