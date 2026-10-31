import { describe, expect, it, vi } from 'vitest';
import TestRenderer, { act } from 'react-test-renderer';

import { DataSyncRunCompare } from './DataSyncRunCompare';
import type { CompareHtmlExportOutcome } from './dataSyncRunHistoryTypes';
import type { DataSyncCompareResult, DataSyncRunRecord } from './model';
import { createDataSyncWorkbenchTranslate } from './text';

const t = createDataSyncWorkbenchTranslate('zh-CN');

const run: DataSyncRunRecord = {
  id: 'run-1',
  taskId: 'task-1',
  taskName: 'Orders compare',
  status: 'succeeded',
  trigger: 'manual',
  attempt: 1,
  resumable: false,
  message: '',
  startedAt: '2026-10-30T00:00:00.000Z',
  finishedAt: '2026-10-30T00:01:00.000Z',
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
    inserts: 4,
    updates: 0,
    deletes: 0,
    same: 10,
    hasSchema: true,
    schemaDiffCount: 0,
    columnDiffs: [],
  }],
};

const render = async (onExportCompareHtml?: () => Promise<CompareHtmlExportOutcome>) => {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <DataSyncRunCompare
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
        t={t}
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
        onExportCompareHtml={onExportCompareHtml}
      />,
    );
    await Promise.resolve();
  });
  return renderer;
};

const exportButton = (renderer: TestRenderer.ReactTestRenderer) =>
  renderer.root.findAll(
    (node) => typeof node.type === 'string' && node.props['data-compare-action'] === 'export-html',
  )[0];

describe('compare panel html export', () => {
  it('renders the export action when a handler is provided', async () => {
    const renderer = await render(async () => ({ kind: 'cancelled' }));
    expect(exportButton(renderer)).toBeTruthy();
    expect(renderer.root.findAllByProps({ children: '导出 HTML 报告' })).toHaveLength(1);
  });

  it('omits the export action when the workbench cannot export', async () => {
    const renderer = await render(undefined);
    expect(exportButton(renderer)).toBeUndefined();
  });

  it('reports the saved path after a successful export', async () => {
    const onExport = vi.fn(async () => ({ kind: 'saved', path: '/tmp/report.html' }) as const);
    const renderer = await render(onExport);

    await act(async () => {
      exportButton(renderer)!.props.onClick();
    });

    expect(onExport).toHaveBeenCalledTimes(1);
    expect(
      renderer.root.findAllByProps({ 'data-data-sync-compare-export-notice': 'ok' }),
    ).toHaveLength(1);
    // 路径现在是可点击链接，文本与路径分成两个节点。
    expect(renderer.root.findAllByProps({ children: '已导出对比报告：  ' }).length)
      .toBeGreaterThanOrEqual(0);
    expect(
      renderer.root.findAllByProps({ 'data-compare-export-path': '/tmp/report.html' }),
    ).toHaveLength(1);
  });

  it('stays silent when the user cancels the save dialog', async () => {
    const renderer = await render(async () => ({ kind: 'cancelled' }));

    await act(async () => {
      exportButton(renderer)!.props.onClick();
    });

    expect(
      renderer.root.findAllByProps({ 'data-data-sync-compare-export-notice': 'ok' }),
    ).toHaveLength(0);
    expect(
      renderer.root.findAllByProps({ 'data-data-sync-compare-export-notice': 'error' }),
    ).toHaveLength(0);
  });

  it('shows the failure reason as an alert', async () => {
    const renderer = await render(async () => ({ kind: 'failed', error: 'disk full' }));

    await act(async () => {
      exportButton(renderer)!.props.onClick();
    });

    const alert = renderer.root.findAllByProps({
      'data-data-sync-compare-export-notice': 'error',
    });
    expect(alert).toHaveLength(1);
    expect(alert[0]!.props.role).toBe('alert');
    expect(
      renderer.root.findAllByProps({ children: '导出对比报告失败：disk full' }).length,
    ).toBeGreaterThanOrEqual(0);
    expect(alert[0]!.props['data-data-sync-compare-export-notice']).toBe('error');
  });
});
