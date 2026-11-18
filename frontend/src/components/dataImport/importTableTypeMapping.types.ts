export type ImportLogicalType =
  | 'integer'
  | 'decimal'
  | 'boolean'
  | 'date'
  | 'datetime'
  | 'time'
  | 'uuid'
  | 'json'
  | 'text'
  | 'longtext'
  | 'binary'
  | (string & {});

export interface ImportInferredColumn {
  name: string;
  sourceName: string;
  logicalType: ImportLogicalType;
  declaredType?: string;
  comment?: string;
  nullable: boolean;
  maxLength?: number;
  precision?: number;
  scale?: number;
}

export interface ImportTableSchemaInference {
  tableName: string;
  columns: ImportInferredColumn[];
  warnings: string[];
  sampledRows: number;
  sampleLimit: number;
}

export interface ImportAutoCreateTableDraft {
  tableName: string;
  sql: string;
  columns: string[];
  typeRow: number;
  commentRow: number;
  /** 本次导入是否已经成功建过表；成功后的再次导入走普通路径，避免“表已存在”。 */
  created?: boolean;
  /** 原始表头 -> 建表列名。单行内嵌/多行表头解析后两者可能不同。 */
  columnMappings: Record<string, string>;
}

export type ImportTableCreatePayload = Pick<
  ImportAutoCreateTableDraft,
  'tableName' | 'sql' | 'columns' | 'columnMappings'
>;

export interface ImportTableColumnDraft {
  key: string;
  name: string;
  sourceName: string;
  logicalType: ImportLogicalType;
  type: string;
  nullable: boolean;
  primaryKey: boolean;
  comment: string;
  maxLength?: number;
  precision?: number;
  scale?: number;
  timestampRequired?: boolean;
}

export type ImportTableTypeFamily =
  | 'mysql'
  | 'postgres'
  | 'oracle'
  | 'sqlserver'
  | 'sqlite'
  | 'firebird'
  | 'gbase8s'
  | 'hive'
  | 'clickhouse'
  | 'questdb'
  | 'greptimedb'
  | 'tdengine'
  | 'duckdb'
  | 'standard';

export type SqlDialectOptions = {
  oceanBaseProtocol?: unknown;
};

export const IMPORT_LOGICAL_TYPES: ImportLogicalType[] = [
  'integer',
  'decimal',
  'boolean',
  'date',
  'datetime',
  'time',
  'uuid',
  'json',
  'text',
  'longtext',
  'binary',
];
