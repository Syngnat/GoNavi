import type { ConnectionConfig } from '../types';
import {
  isConnectionDataImportRestricted,
  isConnectionDataEditRestricted,
  isConnectionStructureEditRestricted,
} from './connectionReadOnly';
import { normalizeOceanBaseProtocol } from './oceanBaseProtocol';

type ConnectionLike = Pick<
  ConnectionConfig,
  'type' | 'driver' | 'oceanBaseProtocol' | 'readOnly' | 'protection'
> | null | undefined;

const normalizeDataSourceToken = (raw: string): string => {
  const normalized = String(raw || '').trim().toLowerCase();
  switch (normalized) {
    case 'doris':
      return 'diros';
    case 'starrocks':
      return 'starrocks';
    case 'postgresql':
    case 'pg':
    case 'pq':
    case 'pgx':
      return 'postgres';
    case 'opengauss':
    case 'open_gauss':
    case 'open-gauss':
      return 'opengauss';
    case 'gaussdb':
    case 'gauss_db':
    case 'gauss-db':
      return 'gaussdb';
    case 'mssql':
    case 'sql_server':
    case 'sql-server':
      return 'sqlserver';
    case 'sqlite3':
      return 'sqlite';
    case 'kingbase8':
    case 'kingbasees':
    case 'kingbasev8':
      return 'kingbase';
    case 'goldendb':
    case 'greatdb':
    case 'gdb':
      return 'goldendb';
    case 'dm':
      return 'dameng';
    case 'elastic':
    case 'elasticsearch':
      return 'elasticsearch';
    case 'chromadb':
    case 'chroma-db':
      return 'chroma';
    case 'qdrantdb':
    case 'qdrant-db':
      return 'qdrant';
    case 'milvusdb':
    case 'milvus-db':
      return 'milvus';
    case 'rocketmq':
    case 'rocket-mq':
    case 'rocket_mq':
    case 'apache-rocketmq':
    case 'apache_rocketmq':
    case 'rmq':
      return 'rocketmq';
    case 'mqtt':
    case 'mqtts':
      return 'mqtt';
    case 'apache-iotdb':
    case 'apache_iotdb':
      return 'iotdb';
    case 'kafka':
    case 'apache-kafka':
    case 'apache_kafka':
      return 'kafka';
    case 'rabbitmq':
    case 'rabbit-mq':
    case 'rabbit_mq':
      return 'rabbitmq';
    case 'intersystems':
    case 'intersystemsiris':
    case 'inter-systems':
    case 'inter-systems-iris':
      return 'iris';
    default:
      return normalized;
  }
};

export const resolveDataSourceType = (config: ConnectionLike): string => {
  if (!config) return '';
  const type = normalizeDataSourceToken(String(config.type || ''));
  if (type === 'custom') {
    const driver = normalizeDataSourceToken(String(config.driver || ''));
    if (driver === 'oceanbase' && normalizeOceanBaseProtocol(config.oceanBaseProtocol) === 'oracle') {
      return 'oracle';
    }
    return driver || 'custom';
  }
  if (type === 'oceanbase' && normalizeOceanBaseProtocol(config.oceanBaseProtocol) === 'oracle') {
    return 'oracle';
  }
  return type;
};

export const shouldShowOceanBaseRowNumberColumn = (config: ConnectionLike): boolean => {
  if (!config) return false;
  const type = normalizeDataSourceToken(String(config.type || ''));
  const driver = normalizeDataSourceToken(String(config.driver || ''));
  return type === 'oceanbase' || driver === 'oceanbase';
};

const SQL_QUERY_EXPORT_TYPES = new Set([
  'mysql',
  'goldendb',
  'mariadb',
  'oceanbase',
  'diros',
  'starrocks',
  'sphinx',
  'postgres',
  'kingbase',
  'highgo',
  'vastbase',
  'opengauss',
  'gaussdb',
  'sqlserver',
  'iris',
  'sqlite',
  'duckdb',
  'oracle',
  'dameng',
  'tdengine',
  'clickhouse',
  'trino',
]);

const COPY_INSERT_TYPES = new Set([
  'mysql',
  'goldendb',
  'mariadb',
  'oceanbase',
  'diros',
  'starrocks',
  'sphinx',
  'postgres',
  'kingbase',
  'highgo',
  'vastbase',
  'opengauss',
  'gaussdb',
  'sqlserver',
  'iris',
  'sqlite',
  'duckdb',
  'oracle',
  'dameng',
  'tdengine',
  'clickhouse',
  'trino',
]);

const COPY_TABLE_TYPES = new Set([
  'mysql',
  'goldendb',
  'mariadb',
  'oceanbase',
  'postgres',
]);

const QUERY_EDITOR_DISABLED_TYPES = new Set(['redis']);
const EXPLAIN_DIAGNOSIS_TYPES = new Set([
  'mysql',
  'goldendb',
  'mariadb',
  'oceanbase',
  'diros',
  'starrocks',
  'postgres',
  'kingbase',
  'highgo',
  'vastbase',
  'opengauss',
  'gaussdb',
  'sqlserver',
  'sqlite',
  'oracle',
  'clickhouse',
]);
const FORCE_READ_ONLY_QUERY_TYPES = new Set(['tdengine', 'iotdb', 'clickhouse', 'rocketmq', 'mqtt', 'kafka', 'rabbitmq']);
const FORCE_READ_ONLY_STRUCTURE_DESIGNER_TYPES = new Set(['elasticsearch', 'mongodb', 'redis', 'iotdb']);
const MESSAGE_PUBLISH_TYPES = new Set(['rocketmq', 'mqtt', 'kafka', 'rabbitmq']);
const MANUAL_TOTAL_COUNT_TYPES = new Set(['duckdb', 'oracle', 'rocketmq', 'mqtt']);
const APPROXIMATE_TABLE_COUNT_TYPES = new Set(['duckdb', 'oracle']);
const APPROXIMATE_TOTAL_PAGE_TYPES = new Set(['duckdb']);

export type DataSourceCapabilities = {
  type: string;
  supportsQueryEditor: boolean;
  supportsExplainDiagnosis: boolean;
  supportsSqlQueryExport: boolean;
  supportsCopyInsert: boolean;
  supportsCopyTable: boolean;
  supportsCreateDatabase: boolean;
  supportsCreateDatabaseCharset: boolean;
  supportsRenameDatabase: boolean;
  supportsDropDatabase: boolean;
  supportsMessagePublish: boolean;
  forceReadOnlyQueryResult: boolean;
  forceReadOnlyStructureDesigner: boolean;
  preferManualTotalCount: boolean;
  supportsApproximateTableCount: boolean;
  supportsApproximateTotalPages: boolean;
};

const CREATE_DATABASE_TYPES = new Set([
  'mysql',
  'goldendb',
  'mariadb',
  'oceanbase',
  'diros',
  'starrocks',
  'postgres',
  'kingbase',
  'highgo',
  'vastbase',
  'opengauss',
  'gaussdb',
  'sqlserver',
  'tdengine',
  'clickhouse',
]);

// MySQL 系方言支持在建库时指定字符集与排序规则。
const CREATE_DATABASE_CHARSET_TYPES = new Set([
  'mysql',
  'goldendb',
  'mariadb',
  'oceanbase',
  'diros',
]);

const RENAME_DATABASE_TYPES = new Set([
  'diros',
  'postgres',
  'kingbase',
  'highgo',
  'vastbase',
  'opengauss',
  'gaussdb',
]);

const DROP_DATABASE_TYPES = new Set([
  'mysql',
  'goldendb',
  'mariadb',
  'oceanbase',
  'diros',
  'starrocks',
  'postgres',
  'kingbase',
  'highgo',
  'vastbase',
  'opengauss',
  'gaussdb',
  'tdengine',
  'clickhouse',
]);

export const getDataSourceCapabilities = (config: ConnectionLike): DataSourceCapabilities => {
  const type = resolveDataSourceType(config);
  const customConnection = normalizeDataSourceToken(String(config?.type || '')) === 'custom';
  const dataEditRestricted = isConnectionDataEditRestricted(config);
  const dataImportRestricted = isConnectionDataImportRestricted(config);
  const structureEditRestricted = isConnectionStructureEditRestricted(config);
  return {
    type,
    supportsQueryEditor: !QUERY_EDITOR_DISABLED_TYPES.has(type),
    supportsExplainDiagnosis: EXPLAIN_DIAGNOSIS_TYPES.has(type),
    supportsSqlQueryExport: SQL_QUERY_EXPORT_TYPES.has(type),
    supportsCopyInsert: COPY_INSERT_TYPES.has(type),
    supportsCopyTable:
      !customConnection &&
      !dataImportRestricted &&
      !structureEditRestricted &&
      COPY_TABLE_TYPES.has(type),
    supportsCreateDatabase: !structureEditRestricted && CREATE_DATABASE_TYPES.has(type),
    supportsCreateDatabaseCharset:
      !structureEditRestricted && CREATE_DATABASE_CHARSET_TYPES.has(type),
    supportsRenameDatabase: !structureEditRestricted && RENAME_DATABASE_TYPES.has(type),
    supportsDropDatabase: !structureEditRestricted && DROP_DATABASE_TYPES.has(type),
    supportsMessagePublish: !dataEditRestricted && MESSAGE_PUBLISH_TYPES.has(type),
    forceReadOnlyQueryResult: dataEditRestricted || FORCE_READ_ONLY_QUERY_TYPES.has(type),
    forceReadOnlyStructureDesigner:
      structureEditRestricted || FORCE_READ_ONLY_STRUCTURE_DESIGNER_TYPES.has(type),
    preferManualTotalCount: MANUAL_TOTAL_COUNT_TYPES.has(type),
    supportsApproximateTableCount: APPROXIMATE_TABLE_COUNT_TYPES.has(type),
    supportsApproximateTotalPages: APPROXIMATE_TOTAL_PAGE_TYPES.has(type),
  };
};
