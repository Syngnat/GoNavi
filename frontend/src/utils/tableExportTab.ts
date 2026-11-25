import type { TabData, TableExportContentMode, TableExportScope, TableExportScopeOption } from '../types';
import { t } from '../i18n';

export const DEFAULT_TABLE_EXPORT_SCOPE_OPTION: TableExportScopeOption = {
  value: 'all',
  get label() {
    return t('data_export.workbench.scope.all.label');
  },
  get description() {
    return t('data_export.workbench.scope.all.description');
  },
};

export const buildTableExportHistoryKey = (
  connectionId: string,
  dbName: string | undefined,
  tableName: string | undefined,
): string => {
  return [
    String(connectionId || '').trim(),
    String(dbName || '').trim(),
    String(tableName || '').trim(),
  ].join('::');
};

export const buildExportWorkbenchHistoryKey = (
  input: Pick<TabData, 'connectionId' | 'dbName' | 'tableName' | 'schemaName' | 'exportWorkbenchMode'>,
): string => {
  const mode = input.exportWorkbenchMode || 'single';
  const connectionId = String(input.connectionId || '').trim();
  const dbName = String(input.dbName || '').trim();
  if (mode === 'batch-tables') {
    return [connectionId, dbName, '__batch_tables__'].join('::');
  }
  if (mode === 'batch-databases') {
    return [connectionId, '__batch_databases__'].join('::');
  }
  if (mode === 'batch-connections') {
    return '__batch_connections__';
  }
  if (mode === 'database') {
    return [connectionId, dbName, '__database__'].join('::');
  }
  if (mode === 'schema') {
    return [connectionId, dbName, String(input.schemaName || '').trim(), '__schema__'].join('::');
  }
  return buildTableExportHistoryKey(connectionId, dbName, input.tableName);
};

type ExportWorkbenchLaunchOptions = {
  contentMode?: TableExportContentMode;
  includeDropIfExists?: boolean;
  launchKey?: string;
  requestKey?: string;
};

type BuildTableExportTabInput = {
  connectionId: string;
  dbName?: string;
  tableName: string;
  title?: string;
  objectType?: TabData['objectType'];
  schemaName?: string;
  sidebarLocateKey?: string;
  scopeOptions?: TableExportScopeOption[];
  initialScope?: TableExportScope;
  queryByScope?: Partial<Record<TableExportScope, string>>;
  rowCountByScope?: Partial<Record<TableExportScope, number>>;
};

type BuildBatchTableExportWorkbenchTabInput = ExportWorkbenchLaunchOptions & {
  connectionId: string;
  dbName?: string;
  title?: string;
  initialObjectNames?: string[];
  initialFormat?: string;
};

type BuildBatchDatabaseExportWorkbenchTabInput = ExportWorkbenchLaunchOptions & {
  connectionId: string;
  title?: string;
  initialDatabaseNames?: string[];
};

type BuildBatchConnectionWorkbenchTabInput = ExportWorkbenchLaunchOptions & {
  title?: string;
  initialConnectionIds?: string[];
};

type BuildDatabaseExportWorkbenchTabInput = ExportWorkbenchLaunchOptions & {
  connectionId: string;
  dbName: string;
  title?: string;
};

type BuildSchemaExportWorkbenchTabInput = ExportWorkbenchLaunchOptions & {
  connectionId: string;
  dbName: string;
  schemaName: string;
  title?: string;
};

const normalizeNameList = (values: string[] | undefined): string[] | undefined => {
  if (!Array.isArray(values)) return undefined;
  const seen = new Set<string>();
  const result = values
    .map((value) => String(value || '').trim())
    .filter((value) => {
      if (!value || seen.has(value)) return false;
      seen.add(value);
      return true;
    });
  return result.length > 0 ? result : undefined;
};

const buildLaunchMetadata = (input: ExportWorkbenchLaunchOptions): Partial<TabData> => {
  const requestKey = String(input.requestKey || '').trim();
  const launchKey = String(input.launchKey || '').trim() || requestKey;
  return {
    ...(input.contentMode ? { tableExportContentMode: input.contentMode } : {}),
    ...(input.includeDropIfExists !== undefined
      ? { tableExportIncludeDropIfExists: input.includeDropIfExists === true }
      : {}),
    tableExportLaunchKey: launchKey || undefined,
    tableExportRequestKey: requestKey || undefined,
  };
};

const normalizeScopeOptions = (
  scopeOptions: TableExportScopeOption[] | undefined,
): TableExportScopeOption[] => {
  if (!Array.isArray(scopeOptions) || scopeOptions.length === 0) {
    return [{ ...DEFAULT_TABLE_EXPORT_SCOPE_OPTION }];
  }
  const seen = new Set<TableExportScope>();
  const normalized = scopeOptions
    .filter((item): item is TableExportScopeOption => !!item && typeof item.value === 'string')
    .map((item) => ({
      value: item.value,
      label: String(item.label || '').trim() || item.value,
      description: typeof item.description === 'string' ? item.description : undefined,
      disabled: item.disabled === true,
    }))
    .filter((item) => {
      if (seen.has(item.value)) return false;
      seen.add(item.value);
      return true;
    });
  return normalized.length > 0 ? normalized : [{ ...DEFAULT_TABLE_EXPORT_SCOPE_OPTION }];
};

const resolveInitialScope = (
  scopeOptions: TableExportScopeOption[],
  initialScope?: TableExportScope,
): TableExportScope => {
  if (initialScope && scopeOptions.some((item) => item.value === initialScope && !item.disabled)) {
    return initialScope;
  }
  return scopeOptions.find((item) => !item.disabled)?.value || 'all';
};

const normalizeQueryByScope = (
  queryByScope: BuildTableExportTabInput['queryByScope'],
): Partial<Record<TableExportScope, string>> | undefined => {
  if (!queryByScope || typeof queryByScope !== 'object') {
    return undefined;
  }
  const next: Partial<Record<TableExportScope, string>> = {};
  (['selected', 'page', 'all', 'filteredAll'] as TableExportScope[]).forEach((scope) => {
    const value = String(queryByScope[scope] || '').trim();
    if (value) {
      next[scope] = value;
    }
  });
  return Object.keys(next).length > 0 ? next : undefined;
};

const normalizeRowCountByScope = (
  rowCountByScope: BuildTableExportTabInput['rowCountByScope'],
): Partial<Record<TableExportScope, number>> | undefined => {
  if (!rowCountByScope || typeof rowCountByScope !== 'object') {
    return undefined;
  }
  const next: Partial<Record<TableExportScope, number>> = {};
  (['selected', 'page', 'all', 'filteredAll'] as TableExportScope[]).forEach((scope) => {
    const value = Number(rowCountByScope[scope]);
    if (Number.isFinite(value) && value >= 0) {
      next[scope] = Math.trunc(value);
    }
  });
  return Object.keys(next).length > 0 ? next : undefined;
};

export const buildTableExportTab = (input: BuildTableExportTabInput): TabData => {
  const connectionId = String(input.connectionId || '').trim();
  const dbName = String(input.dbName || '').trim();
  const tableName = String(input.tableName || '').trim();
  const scopeOptions = normalizeScopeOptions(input.scopeOptions);
  const initialScope = resolveInitialScope(scopeOptions, input.initialScope);
  const objectLabel = tableName || t('data_export.progress.value.target_fallback');
  return {
    id: `table-export-${connectionId}-${dbName}-${tableName}`,
    title: String(input.title || t('data_export.workbench.task.export_target', { name: objectLabel })).trim()
      || t('data_export.workbench.task.export_target', { name: objectLabel }),
    type: 'table-export',
    exportWorkbenchMode: 'single',
    connectionId,
    dbName,
    tableName,
    objectType: input.objectType,
    schemaName: input.schemaName,
    sidebarLocateKey: input.sidebarLocateKey,
    initialTab: 'config',
    tableExportScopeOptions: scopeOptions,
    tableExportInitialScope: initialScope,
    tableExportQueryByScope: normalizeQueryByScope(input.queryByScope),
    tableExportRowCountByScope: normalizeRowCountByScope(input.rowCountByScope),
  };
};

export const buildBatchTableExportWorkbenchTab = (
  input: BuildBatchTableExportWorkbenchTabInput,
): TabData => {
  const connectionId = String(input.connectionId || '').trim();
  const dbName = String(input.dbName || '').trim();
  const scopeSuffix = dbName || 'all';
  const initialFormat = String(input.initialFormat || '').trim();
  return {
    id: `table-export-batch-tables-${connectionId || 'none'}-${scopeSuffix}`,
    title: String(input.title || t('sidebar.tab.batch_export_objects')).trim() || t('sidebar.tab.batch_export_objects'),
    type: 'table-export',
    exportWorkbenchMode: 'batch-tables',
    connectionId,
    dbName: dbName || undefined,
    initialTab: 'config',
    ...(normalizeNameList(input.initialObjectNames)
      ? { tableExportInitialObjectNames: normalizeNameList(input.initialObjectNames) }
      : {}),
    ...(initialFormat ? { tableExportInitialFormat: initialFormat } : {}),
    ...buildLaunchMetadata(input),
  };
};

export const buildBatchDatabaseExportWorkbenchTab = (
  input: BuildBatchDatabaseExportWorkbenchTabInput,
): TabData => {
  const connectionId = String(input.connectionId || '').trim();
  return {
    id: `table-export-batch-databases-${connectionId || 'none'}`,
    title: String(input.title || t('sidebar.tab.batch_export_databases')).trim() || t('sidebar.tab.batch_export_databases'),
    type: 'table-export',
    exportWorkbenchMode: 'batch-databases',
    connectionId,
    initialTab: 'config',
    ...(normalizeNameList(input.initialDatabaseNames)
      ? { tableExportInitialDatabaseNames: normalizeNameList(input.initialDatabaseNames) }
      : {}),
    ...buildLaunchMetadata(input),
  };
};

export const buildBatchConnectionWorkbenchTab = (
  input: BuildBatchConnectionWorkbenchTabInput = {},
): TabData => ({
  id: 'table-export-batch-connections',
  title: String(input.title || t('sidebar.action.batch_connections')).trim() || t('sidebar.action.batch_connections'),
  type: 'table-export',
  exportWorkbenchMode: 'batch-connections',
  connectionId: '',
  initialTab: 'config',
  ...(normalizeNameList(input.initialConnectionIds)
    ? { tableExportInitialConnectionIds: normalizeNameList(input.initialConnectionIds) }
    : {}),
  ...buildLaunchMetadata(input),
});

export const buildDatabaseExportWorkbenchTab = (
  input: BuildDatabaseExportWorkbenchTabInput,
): TabData => {
  const connectionId = String(input.connectionId || '').trim();
  const dbName = String(input.dbName || '').trim();
  const targetName = dbName || t('data_export.progress.value.target_fallback');
  return {
    id: `table-export-database-${connectionId || 'none'}-${dbName || 'default'}`,
    title: String(input.title || t('data_export.workbench.task.export_target', { name: targetName })).trim()
      || t('data_export.workbench.task.export_target', { name: targetName }),
    type: 'table-export',
    exportWorkbenchMode: 'database',
    connectionId,
    dbName: dbName || undefined,
    initialTab: 'config',
    ...buildLaunchMetadata(input),
  };
};

export const buildSchemaExportWorkbenchTab = (
  input: BuildSchemaExportWorkbenchTabInput,
): TabData => {
  const connectionId = String(input.connectionId || '').trim();
  const dbName = String(input.dbName || '').trim();
  const schemaName = String(input.schemaName || '').trim();
  const targetName = [dbName, schemaName].filter(Boolean).join('.') || t('data_export.progress.value.target_fallback');
  return {
    id: `table-export-schema-${connectionId || 'none'}-${dbName || 'default'}-${schemaName || 'schema'}`,
    title: String(input.title || t('data_export.workbench.task.export_target', { name: targetName })).trim()
      || t('data_export.workbench.task.export_target', { name: targetName }),
    type: 'table-export',
    exportWorkbenchMode: 'schema',
    connectionId,
    dbName: dbName || undefined,
    schemaName: schemaName || undefined,
    initialTab: 'config',
    ...buildLaunchMetadata(input),
  };
};
