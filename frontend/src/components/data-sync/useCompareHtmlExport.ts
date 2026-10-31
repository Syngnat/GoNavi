import { useCallback, useState } from 'react';

import {
  buildCompareHtmlReport,
  buildCompareReportFileName,
  formatReportTime,
} from './dataSyncCompareHtmlReport';
import type { CompareHtmlExportOutcome } from './dataSyncRunHistoryTypes';
import type { DataSyncCompareMode, DataSyncCompareResult } from './model';
import type { DataSyncWorkbenchTranslate } from './text';

export type CompareHtmlExportRequest = {
  result: DataSyncCompareResult;
  compareMode?: DataSyncCompareMode;
  meta: { taskName: string; sourceLabel: string; targetLabel: string };
  /** Resolves to the saved path, or null when the user cancels. */
  save: (fileName: string, content: string) => Promise<string | null>;
};

/**
 * 报告的渲染与保存分开：渲染是纯函数（可单测），保存由调用方注入，
 * 这样 hook 本身不依赖 Wails，也不吞掉取消语义。
 */
export const useCompareHtmlExport = (t: DataSyncWorkbenchTranslate) => {
  const [exporting, setExporting] = useState(false);

  const exportHtml = useCallback(
    async (request: CompareHtmlExportRequest): Promise<CompareHtmlExportOutcome> => {
      setExporting(true);
      try {
        const now = new Date();
        // 文件名用本地时间，和报告里显示的时间保持一致。
        const generatedAt = formatReportTime(now);
        const html = buildCompareHtmlReport(request.result, {
          compareMode: request.compareMode,
          meta: { ...request.meta, generatedAt },
          t,
        });
        const fileName = buildCompareReportFileName(request.meta.taskName, now);
        const saved = await request.save(fileName, html);
        return saved ? { kind: 'saved', path: saved } : { kind: 'cancelled' };
      } catch (cause) {
        return {
          kind: 'failed',
          error: cause instanceof Error ? cause.message : String(cause),
        };
      } finally {
        setExporting(false);
      }
    },
    [t],
  );

  return { exporting, exportHtml };
};
