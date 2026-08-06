export type SourceDatasetMode = 'table' | 'query';

type SyncContent = 'data' | 'schema' | 'both';
type TargetTableStrategy = 'existing_only' | 'auto_create_if_missing' | 'smart';

export type BuildDataSyncRequestParams = {
  sourceConfig: any;
  targetConfig: any;
  sourceDatabase?: string;
  targetDatabase?: string;
  targetSchema?: string;
  selectedTables: string[];
  sourceDatasetMode: SourceDatasetMode;
  sourceQuery: string;
  syncContent: SyncContent;
  syncMode: string;
  autoAddColumns: boolean;
  targetTableStrategy: TargetTableStrategy;
  createIndexes: boolean;
  mongoCollectionName: string;
  jobId?: string;
  tableOptions?: Record<string, any>;
};

export type BuildDataSyncAnalysisFingerprintParams = {
  sourceConnectionId?: string;
  targetConnectionId?: string;
  sourceDatabase?: string;
  targetDatabase?: string;
  targetSchema?: string;
  selectedTables: string[];
  sourceDatasetMode: SourceDatasetMode;
  sourceQuery: string;
  syncContent: SyncContent;
  syncMode: string;
  autoAddColumns: boolean;
  targetTableStrategy: TargetTableStrategy;
  createIndexes: boolean;
  mongoCollectionName: string;
};

type DataSyncAnalysisTable = {
  table?: unknown;
  canSync?: unknown;
  message?: unknown;
  inserts?: unknown;
  updates?: unknown;
  deletes?: unknown;
  schemaDiffCount?: unknown;
  targetTableExists?: unknown;
};

export type DataSyncTableOperationOptions = {
  insert: boolean;
  update: boolean;
  delete: boolean;
  selectedInsertPks?: string[];
  selectedUpdatePks?: string[];
  selectedDeletePks?: string[];
};

type ValidateDataSyncExecutionReadinessParams = {
  requiresAnalysis: boolean;
  syncContent: SyncContent;
  syncMode: string;
  currentFingerprint: string;
  analyzedFingerprint: string;
  selectedTables: string[];
  analyzedTables: DataSyncAnalysisTable[];
  tableOptions: Record<string, DataSyncTableOperationOptions>;
};

export type DataSyncExecutionReadiness =
  | { ready: true }
  | {
      ready: false;
      reason:
        | 'analysis_required'
        | 'table_not_analyzed'
        | 'table_not_syncable'
        | 'insert_required'
        | 'full_overwrite_insert_required'
        | 'no_effective_operations';
      table?: string;
      message?: string;
    };

type ValidateDataSyncSelectionParams = {
  sourceDatasetMode: SourceDatasetMode;
  selectedTables: string[];
  sourceQuery: string;
  syncContent: SyncContent;
};

export type DataSyncSelectionErrorKey =
  | 'data_sync.validation.source_query_required'
  | 'data_sync.validation.single_target_table_required'
  | 'data_sync.validation.query_mode_data_only'
  | 'data_sync.validation.select_at_least_one_table';

export const validateDataSyncSelection = ({
  sourceDatasetMode,
  selectedTables,
  sourceQuery,
  syncContent,
}: ValidateDataSyncSelectionParams): DataSyncSelectionErrorKey | null => {
  if (sourceDatasetMode === 'query') {
    if (!String(sourceQuery || '').trim()) {
      return 'data_sync.validation.source_query_required';
    }
    if (selectedTables.length !== 1) {
      return 'data_sync.validation.single_target_table_required';
    }
    if (syncContent !== 'data') {
      return 'data_sync.validation.query_mode_data_only';
    }
    return null;
  }

  if (selectedTables.length === 0) {
    return 'data_sync.validation.select_at_least_one_table';
  }
  return null;
};

export const buildDataSyncRequest = ({
  sourceConfig,
  targetConfig,
  sourceDatabase,
  targetDatabase,
  targetSchema,
  selectedTables,
  sourceDatasetMode,
  sourceQuery,
  syncContent,
  syncMode,
  autoAddColumns,
  targetTableStrategy,
  createIndexes,
  mongoCollectionName,
  jobId,
  tableOptions,
}: BuildDataSyncRequestParams) => {
  const isQueryMode = sourceDatasetMode === 'query';

  return {
    sourceConfig,
    targetConfig,
    sourceDatabase: String(sourceDatabase || '').trim(),
    targetDatabase: String(targetDatabase || '').trim(),
    targetSchema: String(targetSchema || '').trim(),
    tables: selectedTables,
    sourceQuery: isQueryMode ? String(sourceQuery || '').trim() : undefined,
    content: isQueryMode ? 'data' : syncContent,
    mode: syncMode,
    autoAddColumns: isQueryMode ? false : autoAddColumns,
    targetTableStrategy: isQueryMode ? 'existing_only' : targetTableStrategy,
    createIndexes: isQueryMode ? false : createIndexes,
    mongoCollectionName: String(mongoCollectionName || '').trim(),
    ...(jobId ? { jobId } : {}),
    ...(tableOptions ? { tableOptions } : {}),
  };
};

const normalizedText = (value: unknown): string => String(value ?? '').trim();

const normalizedCount = (value: unknown): number => {
  const count = Number(value);
  return Number.isFinite(count) && count > 0 ? Math.trunc(count) : 0;
};

const normalizedSyncMode = (value: unknown): 'insert_update' | 'insert_only' | 'full_overwrite' => {
  const mode = normalizedText(value).toLowerCase();
  if (mode === 'insert_only' || mode === 'full_overwrite') {
    return mode;
  }
  return 'insert_update';
};

export const buildInitialDataSyncTableOptions = (
  analysis: DataSyncAnalysisTable,
  syncMode: string,
): DataSyncTableOperationOptions => {
  const canSync = analysis.canSync === true;
  const mode = normalizedSyncMode(syncMode);
  const insert = canSync && (
    mode === 'insert_only'
    || mode === 'full_overwrite'
    || analysis.targetTableExists === false
    || normalizedCount(analysis.inserts) > 0
  );
  const update = canSync
    && mode === 'insert_update'
    && normalizedCount(analysis.updates) > 0;

  return {
    insert,
    update,
    delete: false,
    selectedInsertPks: [],
    selectedUpdatePks: [],
    selectedDeletePks: [],
  };
};

export const buildDataSyncAnalysisFingerprint = ({
  sourceConnectionId,
  targetConnectionId,
  sourceDatabase,
  targetDatabase,
  targetSchema,
  selectedTables,
  sourceDatasetMode,
  sourceQuery,
  syncContent,
  syncMode,
  autoAddColumns,
  targetTableStrategy,
  createIndexes,
  mongoCollectionName,
}: BuildDataSyncAnalysisFingerprintParams): string => JSON.stringify([
  'v1',
  normalizedText(sourceConnectionId),
  normalizedText(targetConnectionId),
  normalizedText(sourceDatabase),
  normalizedText(targetDatabase),
  normalizedText(targetSchema),
  selectedTables.map(normalizedText).filter(Boolean).sort(),
  sourceDatasetMode,
  sourceDatasetMode === 'query' ? normalizedText(sourceQuery) : '',
  syncContent,
  normalizedText(syncMode),
  autoAddColumns,
  targetTableStrategy,
  createIndexes,
  normalizedText(mongoCollectionName),
]);

export const validateDataSyncExecutionReadiness = ({
  requiresAnalysis,
  syncContent,
  syncMode,
  currentFingerprint,
  analyzedFingerprint,
  selectedTables,
  analyzedTables,
  tableOptions,
}: ValidateDataSyncExecutionReadinessParams): DataSyncExecutionReadiness => {
  if (!requiresAnalysis) {
    return { ready: true };
  }
  if (!analyzedFingerprint || analyzedFingerprint !== currentFingerprint) {
    return { ready: false, reason: 'analysis_required' };
  }

  const analyzedByTable = new Map(
    analyzedTables
      .map((table) => [normalizedText(table.table), table] as const)
      .filter(([table]) => table !== ''),
  );
  const mode = normalizedSyncMode(syncMode);
  let hasEffectiveWork = false;
  for (const table of selectedTables.map(normalizedText).filter(Boolean)) {
    const analysis = analyzedByTable.get(table);
    if (!analysis) {
      return { ready: false, reason: 'table_not_analyzed', table };
    }
    if (analysis.canSync !== true) {
      return {
        ready: false,
        reason: 'table_not_syncable',
        table,
        message: normalizedText(analysis.message),
      };
    }

    const options = tableOptions[table];
    if (mode === 'full_overwrite' && options?.insert !== true) {
      return {
        ready: false,
        reason: 'full_overwrite_insert_required',
        table,
      };
    }
    if (mode === 'insert_only' && options?.insert !== true) {
      return {
        ready: false,
        reason: 'insert_required',
        table,
      };
    }

    const targetNeedsCreation = analysis.targetTableExists === false;
    const hasSchemaWork = syncContent !== 'schema'
      && normalizedCount(analysis.schemaDiffCount) > 0;
    let hasDataWork = false;
    if (mode === 'full_overwrite') {
      // 全量覆盖即使源表为空，也需要清空已有目标表。
      hasDataWork = options?.insert === true;
    } else if (mode === 'insert_only') {
      hasDataWork = options?.insert === true
        && normalizedCount(analysis.inserts) > 0;
    } else {
      hasDataWork = (
        options?.insert === true
        && normalizedCount(analysis.inserts) > 0
      ) || (
        options?.update === true
        && normalizedCount(analysis.updates) > 0
      ) || (
        options?.delete === true
        && normalizedCount(analysis.deletes) > 0
      );
    }
    hasEffectiveWork = hasEffectiveWork
      || targetNeedsCreation
      || hasSchemaWork
      || hasDataWork;
  }
  if (!hasEffectiveWork) {
    return { ready: false, reason: 'no_effective_operations' };
  }
  return { ready: true };
};
