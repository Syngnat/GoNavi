import type { ConnectionConfig } from '../types';
import dataSourceCapabilityContractDocument from '../../../internal/db/data_source_capability_contract.json';
import {
  isConnectionDataImportRestricted,
  isConnectionDataEditRestricted,
  isConnectionStructureEditRestricted,
} from './connectionReadOnly';
import { normalizeOceanBaseProtocol } from './oceanBaseProtocol';

type ConnectionLike = Pick<
  ConnectionConfig,
  'type' | 'driver' | 'oceanBaseProtocol' | 'readOnly' | 'protection' | 'database'
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
    case 'dm8':
      return 'dameng';
    case 'sphinxql':
      return 'sphinx';
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

const MESSAGE_QUEUE_DATA_SOURCE_TYPES = new Set([
  'mqtt',
  'kafka',
  'rocketmq',
  'rabbitmq',
]);

/**
 * Message queues still expose a query command grammar for advanced users, but
 * their primary workbench is message-oriented rather than a SQL editor.
 */
export const isMessageQueueDataSource = (config: ConnectionLike): boolean => (
  MESSAGE_QUEUE_DATA_SOURCE_TYPES.has(resolveDataSourceType(config))
);

/**
 * Resolve the synthetic namespace used to identify and execute an MQ
 * workbench. Topic defaults belong to the consume/publish forms, not to the
 * workbench identity. RabbitMQ is the exception because its vhost is a real
 * execution boundary.
 */
export const resolveMessageQueueExecutionDbName = (
  config: ConnectionLike,
  explicitDbName?: unknown,
): string => {
  const type = resolveDataSourceType(config);
  const explicit = String(explicitDbName || '').trim();
  const configured = String(config?.database || '').trim();
  if (type === 'rabbitmq') return explicit || configured || '/';
  if (MESSAGE_QUEUE_DATA_SOURCE_TYPES.has(type)) return 'topics';
  return explicit || configured;
};

export const shouldShowOceanBaseRowNumberColumn = (config: ConnectionLike): boolean => {
  if (!config) return false;
  const type = normalizeDataSourceToken(String(config.type || ''));
  const driver = normalizeDataSourceToken(String(config.driver || ''));
  return type === 'oceanbase' || driver === 'oceanbase';
};

export const DATA_SOURCE_CAPABILITY_OPERATIONS = [
  'query',
  'metadata',
  'transaction',
  'pagination',
  'cancel',
  'schema',
  'sampling',
  'streaming',
  'dangerousOperations',
] as const;

export type DataSourceCapabilityOperation = typeof DATA_SOURCE_CAPABILITY_OPERATIONS[number];

export type DataSourceOperationCapability = {
  supported: boolean;
  runtimeProbe?: boolean;
  reason?: string;
  alternative?: string;
  messageKey?: string;
};

export type DataSourceNavigationPrimaryKind =
  | 'none'
  | 'database'
  | 'catalog'
  | 'owner'
  | 'namespace'
  | 'index'
  | 'vhost'
  | 'catalog_schema'
  | 'redis_db';

export type DataSourceNavigationCapabilities = {
  primaryVisibilitySupported: boolean;
  primaryKind: DataSourceNavigationPrimaryKind;
  secondarySchemaVisibilitySupported: boolean;
  schemaIdentifierCaseSensitive: boolean;
};

export type DataSourceUICapabilityFlags = {
  explainDiagnosis?: boolean;
  sqlQueryExport?: boolean;
  copyInsert?: boolean;
  copyTable?: boolean;
  createDatabase?: boolean;
  createDatabaseCharset?: boolean;
  renameDatabase?: boolean;
  dropDatabase?: boolean;
  messagePublish?: boolean;
  forceReadOnlyQueryResult?: boolean;
  forceReadOnlyStructureDesigner?: boolean;
  preferManualTotalCount?: boolean;
  supportsApproximateTableCount?: boolean;
  supportsApproximateTotalPages?: boolean;
};

export type DataSourceCapabilityContract = {
  type: string;
  query: DataSourceOperationCapability;
  metadata: DataSourceOperationCapability;
  transaction: DataSourceOperationCapability;
  pagination: DataSourceOperationCapability;
  cancel: DataSourceOperationCapability;
  schema: DataSourceOperationCapability;
  sampling: DataSourceOperationCapability;
  streaming: DataSourceOperationCapability;
  dangerousOperations: DataSourceOperationCapability;
  ui: DataSourceUICapabilityFlags;
  navigation: DataSourceNavigationCapabilities;
};

type DataSourceCapabilityProfile = Omit<DataSourceCapabilityContract, 'type'>;
type DataSourceCapabilityRegistryDocument = {
  version: number;
  profiles: Record<string, DataSourceCapabilityProfile>;
  drivers: Record<string, string>;
};

// This JSON file is embedded by Go and imported by Vite, making the profile
// selected here the exact same source table used by backend entry gates.
const DATA_SOURCE_CAPABILITY_REGISTRY = dataSourceCapabilityContractDocument as unknown as DataSourceCapabilityRegistryDocument;

const cloneOperationCapability = (operation: DataSourceOperationCapability): DataSourceOperationCapability => ({ ...operation });

const cloneCapabilityProfile = (
  type: string,
  profile: DataSourceCapabilityProfile,
): DataSourceCapabilityContract => ({
  type,
  query: cloneOperationCapability(profile.query),
  metadata: cloneOperationCapability(profile.metadata),
  transaction: cloneOperationCapability(profile.transaction),
  pagination: cloneOperationCapability(profile.pagination),
  cancel: cloneOperationCapability(profile.cancel),
  schema: cloneOperationCapability(profile.schema),
  sampling: cloneOperationCapability(profile.sampling),
  streaming: cloneOperationCapability(profile.streaming),
  dangerousOperations: cloneOperationCapability(profile.dangerousOperations),
  ui: { ...profile.ui },
  navigation: { ...profile.navigation },
});

export const getDataSourceCapabilityContract = (config: ConnectionLike): DataSourceCapabilityContract => {
  const type = resolveDataSourceType(config) || 'unknown';
  const customConnection = normalizeDataSourceToken(String(config?.type || '')) === 'custom';
  const profileName = DATA_SOURCE_CAPABILITY_REGISTRY.drivers[type]
    || (customConnection ? 'custom' : 'unknown');
  const profile = DATA_SOURCE_CAPABILITY_REGISTRY.profiles[profileName]
    || DATA_SOURCE_CAPABILITY_REGISTRY.profiles.unknown;
  return cloneCapabilityProfile(type, profile);
};

export const getDataSourceOperationCapability = (
  config: ConnectionLike,
  operation: DataSourceCapabilityOperation,
): DataSourceOperationCapability => getDataSourceCapabilityContract(config)[operation];

export type DataSourceCapabilities = {
  type: string;
  contract: DataSourceCapabilityContract;
  query: DataSourceOperationCapability;
  metadata: DataSourceOperationCapability;
  transaction: DataSourceOperationCapability;
  pagination: DataSourceOperationCapability;
  cancel: DataSourceOperationCapability;
  schema: DataSourceOperationCapability;
  sampling: DataSourceOperationCapability;
  streaming: DataSourceOperationCapability;
  dangerousOperations: DataSourceOperationCapability;
  navigation: DataSourceNavigationCapabilities;
  supportsPrimaryVisibility: boolean;
  supportsSecondarySchemaVisibility: boolean;
  schemaIdentifierCaseSensitive: boolean;
  supportsQueryEditor: boolean;
  supportsExplainDiagnosis: boolean;
  supportsSqlQueryExport: boolean;
  supportsCopyInsert: boolean;
  supportsCopyTable: boolean;
  supportsCreateIndex: boolean;
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

export const getDataSourceCapabilities = (config: ConnectionLike): DataSourceCapabilities => {
  const contract = getDataSourceCapabilityContract(config);
  const customConnection = normalizeDataSourceToken(String(config?.type || '')) === 'custom';
  const dataEditRestricted = isConnectionDataEditRestricted(config);
  const dataImportRestricted = isConnectionDataImportRestricted(config);
  const structureEditRestricted = isConnectionStructureEditRestricted(config);
  const ui = contract.ui;
  return {
    type: contract.type,
    contract,
    query: contract.query,
    metadata: contract.metadata,
    transaction: contract.transaction,
    pagination: contract.pagination,
    cancel: contract.cancel,
    schema: contract.schema,
    sampling: contract.sampling,
    streaming: contract.streaming,
    dangerousOperations: contract.dangerousOperations,
    navigation: contract.navigation,
    supportsPrimaryVisibility: contract.navigation.primaryVisibilitySupported,
    supportsSecondarySchemaVisibility: contract.navigation.secondarySchemaVisibilitySupported,
    schemaIdentifierCaseSensitive: contract.navigation.schemaIdentifierCaseSensitive,
    supportsQueryEditor: contract.query.supported,
    supportsExplainDiagnosis: ui.explainDiagnosis === true,
    supportsSqlQueryExport: ui.sqlQueryExport === true,
    supportsCopyInsert: ui.copyInsert === true,
    supportsCopyTable:
      !customConnection
      && !dataImportRestricted
      && !structureEditRestricted
      && ui.copyTable === true,
    supportsCreateIndex: contract.type === 'elasticsearch' && !structureEditRestricted,
    supportsCreateDatabase: !structureEditRestricted && ui.createDatabase === true,
    supportsCreateDatabaseCharset:
      !structureEditRestricted && ui.createDatabaseCharset === true,
    supportsRenameDatabase: !structureEditRestricted && ui.renameDatabase === true,
    supportsDropDatabase: !structureEditRestricted && ui.dropDatabase === true,
    supportsMessagePublish: !dataEditRestricted && ui.messagePublish === true,
    forceReadOnlyQueryResult: dataEditRestricted || ui.forceReadOnlyQueryResult === true,
    forceReadOnlyStructureDesigner:
      structureEditRestricted || ui.forceReadOnlyStructureDesigner === true,
    preferManualTotalCount: ui.preferManualTotalCount === true,
    supportsApproximateTableCount: ui.supportsApproximateTableCount === true,
    supportsApproximateTotalPages: ui.supportsApproximateTotalPages === true,
  };
};
