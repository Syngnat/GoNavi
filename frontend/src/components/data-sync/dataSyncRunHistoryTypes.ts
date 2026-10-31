import type { DataSyncCheckpointSummary, DataSyncCompareMode, DataSyncCompareResult, DataSyncErrorRow, DataSyncRunEvent, DataSyncRunPageSize, DataSyncRunRecord, DataSyncWorkbenchFamily } from './model';
import type { DataSyncWorkbenchTranslate } from './text';
export type DataSyncRunHistoryProps = {
  runs: DataSyncRunRecord[];
  runPage: number;
  runPageSize: DataSyncRunPageSize;
  runTotal: number;
  hasPreviousRunPage: boolean;
  hasNextRunPage: boolean;
  selectedRunId: string;
  selectedRunMessage?: string;
  runEvents: DataSyncRunEvent[];
  errorRows: DataSyncErrorRow[];
  compareResult: DataSyncCompareResult | null;
  compareMode?: DataSyncCompareMode;
  family?: DataSyncWorkbenchFamily;
  t: DataSyncWorkbenchTranslate;
  onSelectRun: (runId: string) => void;
  checkpoint: DataSyncCheckpointSummary | null;
  busyAction: string;
  onRefresh: () => void;
  onPreviousRunPage: () => void;
  onNextRunPage: () => void;
  onRunPageSizeChange: (pageSize: DataSyncRunPageSize) => void;
  onDeleteRun: (runId: string) => void;
  onRollback?: (runId: string) => void;
  onClearTerminalRuns: () => void;
  onCancel: (runId: string) => void;
  onResume: (runId: string) => void;
  onRetry: (runId: string) => void;
  onDiscardErrorRow: (errorRowId: string) => void;
  errorRowRetryAvailable: boolean;
  onRetryErrorRow: (errorRowId: string) => void;
  checkpointResetEnabled: boolean;
  onResetCheckpoint: () => void;
  onGenerateRepairSql?: () => void;
  onAskAiAboutDiffs?: () => void;
  onSyncDiffs?: () => void;
  /** Renders the compare result as a standalone HTML report and saves it. */
  onExportCompareHtml?: () => Promise<CompareHtmlExportOutcome>;
  /** Opens an already-exported report with the OS default program. */
  onOpenExportedFile?: (path: string) => Promise<boolean>;
};

export type CompareHtmlExportOutcome =
  /** The user cancelled the save dialog; no message is shown. */
  | { kind: 'cancelled' }
  | { kind: 'saved'; path: string }
  | { kind: 'failed'; error: string };
