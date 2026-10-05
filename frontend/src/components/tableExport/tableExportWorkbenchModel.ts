import type { TableExportHistoryEntry } from '../../types';
import { normalizeTableNamesFromMetadataRows } from '../../utils/tableMetadataRows';
import type { SidebarViewMetadataEntry } from '../../utils/sidebarMetadata';
import { formatExportProgressRows, type ExportProgressStatus } from '../../utils/exportProgress';
import { t } from '../../i18n';
import type { ExportProgressState } from '../useExportProgressRunner';
import {
  type BatchWorkbenchObject,
  type BatchTableExportMode,
  createBatchTableExportModeOptions,
  type BatchDatabaseExportMode,
  createBatchDatabaseExportModeOptions,
  type ExportWorkbenchMode,
} from './tableExportWorkbenchOptions';

export const resolveBatchWorkbenchObjects = (
  tableRows: unknown,
  views: SidebarViewMetadataEntry[],
): BatchWorkbenchObject[] => {
  const viewAliases = new Set<string>();
  views.forEach((view) => {
    const viewName = String(view.viewName || '').trim();
    const schemaName = String(view.schemaName || '').trim();
    if (!viewName) return;
    viewAliases.add(viewName);
    if (schemaName && !viewName.includes('.')) {
      viewAliases.add(`${schemaName}.${viewName}`);
    }
  });

  const seen = new Set<string>();
  const objects: BatchWorkbenchObject[] = [];
  normalizeTableNamesFromMetadataRows(tableRows).forEach((name) => {
    const normalizedName = String(name || '').trim();
    const key = normalizedName;
    if (!normalizedName || seen.has(key)) return;
    seen.add(key);
    objects.push({
      name: normalizedName,
      objectType: viewAliases.has(key) ? 'view' : 'table',
    });
  });

  views.forEach((view) => {
    const viewName = String(view.viewName || '').trim();
    const schemaName = String(view.schemaName || '').trim();
    if (!viewName) return;
    const qualifiedName = schemaName && !viewName.includes('.') ? `${schemaName}.${viewName}` : viewName;
    const existingName = [qualifiedName, viewName].find((name) => seen.has(name));
    if (existingName) return;
    const key = qualifiedName;
    seen.add(key);
    objects.push({ name: qualifiedName, objectType: 'view' });
  });

  return objects.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
};

export const filterOptionByLabel = (input: string, option?: { title?: string; value?: string }) =>
  String(option?.title || option?.value || '').toLowerCase().includes(String(input || '').trim().toLowerCase());

export const resolveBatchTableModeMeta = (mode: BatchTableExportMode) =>
  createBatchTableExportModeOptions().find((item) => item.value === mode) || createBatchTableExportModeOptions()[0];

export const resolveBatchDatabaseModeMeta = (mode: BatchDatabaseExportMode) =>
  createBatchDatabaseExportModeOptions().find((item) => item.value === mode) || createBatchDatabaseExportModeOptions()[0];

export const shouldIncludeDatabaseContextByDefault = (mode: BatchDatabaseExportMode): boolean => mode === 'backup';

export const resolveBatchTablesTargetName = (dbName: string, objectCount: number): string => {
  const safeDbName = String(dbName || '').trim() || t('data_export.workbench.target.current_database');
  return t('data_export.workbench.target.batch_tables', { database: safeDbName, count: objectCount });
};

export const resolveBatchDatabasesTargetName = (databaseCount: number): string => (
  t('data_export.workbench.target.batch_databases', { count: databaseCount })
);

export const formatWorkbenchProgressSummary = (
  mode: ExportWorkbenchMode,
  current: number,
  total: number,
  totalRowsKnown: boolean,
): string => {
  if (mode === 'batch-tables') {
    if (!totalRowsKnown) return t('data_export.workbench.summary.batch_tables_running');
    return t('data_export.workbench.summary.batch_tables_done', {
      current: Math.min(current, total).toLocaleString(),
      total: total.toLocaleString(),
    });
  }
  if (mode === 'batch-databases') {
    if (!totalRowsKnown) return t('data_export.workbench.summary.batch_databases_running');
    return t('data_export.workbench.summary.batch_databases_done', {
      current: Math.min(current, total).toLocaleString(),
      total: total.toLocaleString(),
    });
  }
  return formatExportProgressRows(current, total, totalRowsKnown);
};

export const resolveProgressHint = (mode: ExportWorkbenchMode, status: ExportProgressStatus, totalRowsKnown: boolean): string | null => {
  if (totalRowsKnown || status === 'done' || status === 'error' || status === 'cancelled') {
    return null;
  }
  if (mode === 'single') {
    return t('data_export.hint.rows_unknown');
  }
  return t('data_export.hint.batch_stage');
};

export const resolveOutputLabel = (mode: ExportWorkbenchMode): string => (
  mode === 'batch-databases' ? t('data_export.label.directory') : t('data_export.label.file')
);

export const buildTableExportHistoryEntry = ({
  progressState,
  existingEntry,
  fallbackTargetName,
  fallbackFormat,
  scope,
  scopeLabel,
  strategyLabel,
}: {
  progressState: ExportProgressState;
  existingEntry?: TableExportHistoryEntry;
  fallbackTargetName: string;
  fallbackFormat: string;
  scope: string;
  scopeLabel: string;
  strategyLabel: string;
}): TableExportHistoryEntry => ({
  jobId: progressState.jobId,
  targetName: progressState.targetName || fallbackTargetName || t('data_export.progress.value.target_fallback'),
  startedAt: progressState.startedAt || existingEntry?.startedAt || 0,
  finishedAt: progressState.finishedAt || existingEntry?.finishedAt || 0,
  format: progressState.format || existingEntry?.format || fallbackFormat,
  scope,
  scopeLabel: existingEntry?.scopeLabel || scopeLabel,
  strategyLabel: existingEntry?.strategyLabel || strategyLabel,
  status: progressState.status as ExportProgressStatus,
  stage: progressState.stage,
  current: progressState.current,
  total: progressState.total,
  totalRowsKnown: progressState.totalRowsKnown,
  filePath: progressState.filePath,
  message: progressState.message,
});
