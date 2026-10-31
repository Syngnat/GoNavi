import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { DataSyncRunHistory } from './DataSyncOperationalViews';
import type { DataSyncCompareResult, DataSyncRunRecord } from './model';
import { createDataSyncWorkbenchTranslate } from './text';
import { formatDataSyncRunEvent } from './textSchedules';

vi.mock('../common/ResizableDraggableModal', () => ({
  default: ({ children }: { children?: React.ReactNode }) => <div role="dialog">{children}</div>,
}));

describe('DataSyncRunHistory compare output', () => {
  it('localizes persisted event types, stages and known messages in either locale', () => {
    const event = { runId: 'run-1', sequence: 1, type: 'progress' as const,
      stage: 'watermark', table: 'orders', message: 'running watermark mapping 2/3', createdAt: '2026-09-23T00:00:00Z' };
    expect(formatDataSyncRunEvent(event, createDataSyncWorkbenchTranslate('zh-CN'))).toEqual({
      type: '运行进度', stage: '水位线增量', message: '正在处理水位线对象 2/3',
    });
    expect(formatDataSyncRunEvent(event, createDataSyncWorkbenchTranslate('en-US'))).toEqual({
      type: 'Progress', stage: 'Watermark sync', message: 'Running watermark object 2/3',
    });
    expect(formatDataSyncRunEvent({ ...event, type: 'failed', stage: 'unknown-stage', message: 'driver timeout at server:3306' },
      createDataSyncWorkbenchTranslate('zh-CN'))).toEqual({ type: '运行失败', stage: 'unknown-stage', message: 'driver timeout at server:3306' });
    expect(formatDataSyncRunEvent({ ...event, message: '__proto__' },
      createDataSyncWorkbenchTranslate('zh-CN')).message).toBe('__proto__');
  });

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
        canSync: true,
        targetTableExists: true,
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
        runEvents={[{ runId: run.id, sequence: 1, type: 'started', stage: 'running', message: 'started', createdAt: run.startedAt }]}
        errorRows={[]}
        compareResult={compareResult}
        compareMode="both"
        family="compare"
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
        onGenerateRepairSql={() => undefined}
        onAskAiAboutDiffs={() => undefined}
        onSyncDiffs={() => undefined}
      />,
    );

    // 明细改成「每条变更一行」后，列差异由表格承载：变更类型标签 + 对象名。
    expect(markup).toContain('data-data-sync-compare-detail="true"');
    expect(markup).toContain('目标缺失');
    expect(markup).toContain('new_column');
    expect(markup).not.toContain('目标表缺失 1 个字段：new_column');
    expect(markup).toContain('返回运行记录');
    expect(markup).toContain('查看每次比对的状态和结果');
    expect(markup).not.toContain('data-data-sync-error-rows');
    expect(markup).not.toContain('data-data-sync-checkpoint');
    expect(markup).not.toContain('写入行数');
    expect(markup).not.toContain('Checkpoint');
    expect(markup).toContain('data-data-sync-compare');
    expect(markup).toContain('data-compare-action="repair-sql"');
    expect(markup).toContain('生成修复 SQL');
    expect(markup).toContain('AI 分析差异');
    expect(markup).toContain('同步差异');
    expect(markup).toContain('运行过程');
    expect(markup).toContain('已开始');
    expect(markup).not.toContain('>started<');
    expect(markup).not.toContain('>running<');
    expect(markup).toContain('data-data-sync-run-events="true"');
    expect(markup).toContain('varchar(255)');
  });

  it('keeps identical tables on one compact row instead of zeroed count tiles', () => {
    const run: DataSyncRunRecord = {
      id: 'compare-same-run',
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
        canSync: true,
        inserts: 0,
        updates: 0,
        deletes: 0,
        same: 1240,
        schemaDiffCount: 0,
        hasSchema: true,
        message: '',
        warnings: [],
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
        family="compare"
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
        onGenerateRepairSql={() => undefined}
        onAskAiAboutDiffs={() => undefined}
        onSyncDiffs={() => undefined}
      />,
    );

    // 相同的表不产生任何变更条目，明细区只出空态，不出现 0/0/0 的假行。
    expect(markup).toContain('data-data-sync-compare-empty-filter="true"');
    expect(markup).not.toContain('data-data-sync-compare-detail="true"');
    expect(markup).not.toContain('gn-data-sync-compare-row__data-counts');
    expect(markup).not.toContain('gn-data-sync-compare-row__endpoints');
  });

  it('does not invent an event error panel from a run message alone', () => {
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

    expect(markup).not.toContain('映射目标表缺少字段：new_column');
    expect(markup).not.toContain('data-data-sync-task-failure');
  });
});
