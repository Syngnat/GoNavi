export type ResultDiffDatasetMode = 'sql' | 'rows';

export type ResultDiffKind = 'added' | 'removed' | 'changed' | 'same' | 'unmatched';

export type ResultDiffCompareOptions = {
  trimStrings?: boolean;
  ignoreCase?: boolean;
  nullEqualsEmpty?: boolean;
};

export type ResultDiffDatasetSpec = {
  mode: ResultDiffDatasetMode;
  sql?: string;
  columns?: string[];
  rows?: Record<string, unknown>[];
};

export type ResultDiffStartRequest = {
  jobId?: string;
  config: unknown;
  database: string;
  left: ResultDiffDatasetSpec;
  right: ResultDiffDatasetSpec;
  keyColumns: string[];
  compareColumns?: string[];
  ignoreColumns?: string[];
  options?: ResultDiffCompareOptions;
  maxRowsPerSide?: number;
  includeSameRows?: boolean;
};

export type ResultDiffSummary = {
  added: number;
  removed: number;
  changed: number;
  same: number;
  unmatched: number;
  leftRowCount: number;
  rightRowCount: number;
  commonColumns: string[];
  leftOnlyColumns: string[];
  rightOnlyColumns: string[];
  changedColumnFreq: Record<string, number>;
  truncated?: boolean;
  warnings?: string[];
  keyColumns: string[];
  comparedColumns: string[];
  includeSameRows?: boolean;
};

export type ResultDiffStartResult = {
  jobId: string;
  summary?: ResultDiffSummary;
};

export type ResultDiffFieldChange = {
  name: string;
  left: unknown;
  right: unknown;
};

export type ResultDiffRow = {
  kind: ResultDiffKind;
  keys: Record<string, unknown>;
  left?: Record<string, unknown>;
  right?: Record<string, unknown>;
  changedFields?: ResultDiffFieldChange[];
  side?: string;
};

export type ResultDiffPageResult = {
  jobId: string;
  total: number;
  offset: number;
  limit: number;
  rows: ResultDiffRow[];
};

/** 列元数据（类型 / 注释），用于预览表头展示 */
export type ResultDiffColumnMeta = {
  type?: string;
  comment?: string;
};

export type ResultDiffComparableResult = {
  key: string;
  label: string;
  sql: string;
  columns: string[];
  rows: Record<string, unknown>[];
  pkColumns?: string[];
  truncated?: boolean;
  /** Query execution context snapshot. SQL replay is safe only when both sides match. */
  executionConnectionId?: string;
  executionDbName?: string;
  executionConnectionParams?: string;
  /** 列元数据所属库（跨库 SELECT 时可能与当前库不同） */
  metadataDbName?: string;
  /** 列元数据查询用表名 */
  metadataTableName?: string;
  /** 可选：已解析的列类型映射 name -> meta */
  columnMeta?: Record<string, ResultDiffColumnMeta>;
};

export type ResultDiffSessionPayload = {
  jobId: string;
  summary: ResultDiffSummary;
  leftLabel: string;
  rightLabel: string;
  /** 合并后的列类型/注释，供并排预览表头 */
  columnMeta?: Record<string, ResultDiffColumnMeta>;
};
