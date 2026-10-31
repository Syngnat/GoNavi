import { describe, expect, it, vi } from 'vitest';
import TestRenderer, { act } from 'react-test-renderer';

import type { DataSyncCompareResult } from './model';
import { createDataSyncWorkbenchTranslate } from './text';
import { useCompareHtmlExport, type CompareHtmlExportRequest } from './useCompareHtmlExport';

const t = createDataSyncWorkbenchTranslate('zh-CN');

const compareResult: DataSyncCompareResult = {
  success: true,
  message: '',
  content: 'both',
  tables: [{
    table: 'orders',
    canSync: true,
    inserts: 1,
    updates: 0,
    deletes: 0,
    same: 0,
    hasSchema: true,
    schemaDiffCount: 1,
    targetTableExists: true,
    columnDiffs: [{ column: 'code', kind: 'missing_in_target', source: 'text' }],
  }],
};

const meta = { taskName: 'Orders', sourceLabel: 'src', targetLabel: 'dst' };

// 用 renderer 承载 hook：本仓库没有 @testing-library/react。
const renderHook = () => {
  const captured: { current: ReturnType<typeof useCompareHtmlExport> | null } = { current: null };
  const Probe = () => {
    captured.current = useCompareHtmlExport(t);
    return null;
  };
  TestRenderer.create(<Probe />);
  return captured as { current: ReturnType<typeof useCompareHtmlExport> };
};

const request = (
  save: CompareHtmlExportRequest['save'],
): CompareHtmlExportRequest => ({ result: compareResult, meta, save });

describe('useCompareHtmlExport', () => {
  it('renders the report and reports the saved path', async () => {
    const hook = renderHook();
    const save = vi.fn(async () => '/tmp/Orders-compare.html');

    let outcome: Awaited<ReturnType<typeof hook.current.exportHtml>> | undefined;
    await act(async () => {
      outcome = await hook.current.exportHtml(request(save));
    });

    expect(outcome).toEqual({ kind: 'saved', path: '/tmp/Orders-compare.html' });
    const [fileName, content] = save.mock.calls[0]! as unknown as [string, string];
    expect(fileName).toMatch(/^Orders-compare-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}$/);
    expect(content).toContain('<!doctype html>');
    expect(content).toContain('orders');
    expect(content).toContain('data-kind-group=');
    expect(hook.current.exporting).toBe(false);
  });

  it('treats a null path as a cancellation, not an error', async () => {
    const hook = renderHook();
    let outcome: Awaited<ReturnType<typeof hook.current.exportHtml>> | undefined;
    await act(async () => {
      outcome = await hook.current.exportHtml(request(async () => null));
    });

    expect(outcome).toEqual({ kind: 'cancelled' });
    expect(hook.current.exporting).toBe(false);
  });

  it('surfaces save failures without throwing', async () => {
    const hook = renderHook();
    let outcome: Awaited<ReturnType<typeof hook.current.exportHtml>> | undefined;
    await act(async () => {
      outcome = await hook.current.exportHtml(request(async () => {
        throw new Error('disk full');
      }));
    });

    expect(outcome).toEqual({ kind: 'failed', error: 'disk full' });
    expect(hook.current.exporting).toBe(false);
  });
});
