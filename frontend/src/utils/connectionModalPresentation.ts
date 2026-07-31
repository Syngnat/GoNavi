import { t } from '../i18n';

type StoredSecretPlaceholderOptions = {
  hasStoredSecret?: boolean;
  emptyPlaceholder: string;
  retainedLabel: string;
};

type ConnectionTestFailureKind =
  | 'validation'
  | 'runtime'
  | 'driver_unavailable'
  | 'secret_blocked';

type ConnectionTestFailureFeedback = {
  message: string;
  shouldToast: boolean;
};

export type ConnectionConfigSectionKey =
  | 'identity'
  | 'uri'
  | 'target'
  | 'fileTarget'
  | 'readOnly'
  | 'connectionMode'
  | 'oceanBaseProtocol'
  | 'mongoDiscovery'
  | 'replica'
  | 'service'
  | 'mongoPolicy'
  | 'credentials'
  | 'databaseScope'
  | 'customDriver'
  | 'customDsn'
  | 'jvmRuntime';

export type ConnectionConfigLayoutKind =
  | 'mysql-compatible'
  | 'mongodb'
  | 'redis'
  | 'postgres-compatible'
  | 'oracle'
  | 'file'
  | 'search'
  | 'vector'
  | 'timeseries'
  | 'custom'
  | 'jvm'
  | 'nacos'
  | 'generic-sql';

export type ConnectionConfigLayout = {
  kind: ConnectionConfigLayoutKind;
  sections: ConnectionConfigSectionKey[];
};

type ConnectionConfigSectionCopy = {
  title: string;
  description: string;
};

const mysqlCompatibleTypes = new Set([
  'mysql',
  'goldendb',
  'mariadb',
  'oceanbase',
  'doris',
  'diros',
  'starrocks',
  'sphinx',
]);
const postgresCompatibleTypes = new Set([
  'postgres',
  'kingbase',
  'highgo',
  'vastbase',
  'opengauss',
  'gaussdb',
]);
const fileDatabaseTypes = new Set(['sqlite', 'duckdb']);

const connectionConfigSectionKeyMap: Record<
  ConnectionConfigSectionKey,
  string
> = {
  identity: 'identity',
  uri: 'uri',
  target: 'target',
  fileTarget: 'fileTarget',
  readOnly: 'readOnly',
  connectionMode: 'connectionMode',
  oceanBaseProtocol: 'oceanBaseProtocol',
  mongoDiscovery: 'mongoDiscovery',
  replica: 'replica',
  service: 'service',
  mongoPolicy: 'mongoPolicy',
  credentials: 'credentials',
  databaseScope: 'databaseScope',
  customDriver: 'customDriver',
  customDsn: 'customDsn',
  jvmRuntime: 'jvmRuntime',
};

export const getConnectionConfigSectionCopy = (
  key: ConnectionConfigSectionKey,
): ConnectionConfigSectionCopy => ({
  title: t(`connection.modal.section.${connectionConfigSectionKeyMap[key]}.title`),
  description: t(
    `connection.modal.section.${connectionConfigSectionKeyMap[key]}.description`,
  ),
});

export const getConnectionConfigLayoutKindLabel = (
  kind: ConnectionConfigLayoutKind,
): string => {
  switch (kind) {
    case 'mysql-compatible':
      return t('connection.modal.layoutKind.mysqlCompatible');
    case 'mongodb':
      return t('connection.modal.layoutKind.mongodb');
    case 'redis':
      return t('connection.modal.layoutKind.redis');
    case 'postgres-compatible':
      return t('connection.modal.layoutKind.postgresCompatible');
    case 'oracle':
      return t('connection.modal.layoutKind.oracle');
    case 'file':
      return t('connection.modal.layoutKind.file');
    case 'search':
      return t('connection.modal.layoutKind.search');
    case 'vector':
      return t('connection.modal.layoutKind.vector');
    case 'timeseries':
      return t('connection.modal.layoutKind.timeseries');
    case 'custom':
      return t('connection.modal.layoutKind.custom');
    case 'jvm':
      return t('connection.modal.layoutKind.jvm');
    case 'nacos':
      return t('connection.modal.layoutKind.nacos');
    case 'generic-sql':
    default:
      return t('connection.modal.layoutKind.genericSql');
  }
};

export const resolveConnectionConfigLayout = (
  rawType: string,
): ConnectionConfigLayout => {
  const type = String(rawType || '').trim().toLowerCase();

  if (type === 'jvm') {
    return {
      kind: 'jvm',
      sections: ['identity', 'jvmRuntime'],
    };
  }
  if (type === 'custom') {
    return {
      kind: 'custom',
      sections: ['identity', 'customDriver', 'customDsn'],
    };
  }
  if (fileDatabaseTypes.has(type)) {
    return {
      kind: 'file',
      sections: ['identity', 'uri', 'fileTarget'],
    };
  }
  if (mysqlCompatibleTypes.has(type)) {
    return {
      kind: 'mysql-compatible',
      sections: [
        'identity',
        'uri',
        'target',
        'connectionMode',
        'replica',
        'credentials',
        'databaseScope',
      ],
    };
  }
  if (type === 'mongodb') {
    return {
      kind: 'mongodb',
      sections: [
        'identity',
        'uri',
        'target',
        'connectionMode',
        'mongoDiscovery',
        'replica',
        'mongoPolicy',
        'credentials',
        'databaseScope',
      ],
    };
  }
  if (type === 'redis') {
    return {
      kind: 'redis',
      sections: [
        'identity',
        'uri',
        'target',
        'connectionMode',
        'credentials',
        'databaseScope',
      ],
    };
  }
  if (type === 'nacos') {
    return {
      kind: 'nacos',
      sections: [
        'identity',
        'uri',
        'target',
        'credentials',
      ],
    };
  }
  if (type === 'elasticsearch') {
    return {
      kind: 'search',
      sections: [
        'identity',
        'uri',
        'target',
        'service',
        'credentials',
        'databaseScope',
      ],
    };
  }
  if (type === 'chroma' || type === 'qdrant' || type === 'milvus') {
    return {
      kind: 'vector',
      sections: [
        'identity',
        'uri',
        'target',
        'service',
        'credentials',
        'databaseScope',
      ],
    };
  }
  if (type === 'iotdb') {
    return {
      kind: 'timeseries',
      sections: [
        'identity',
        'uri',
        'target',
        'service',
        'credentials',
        'databaseScope',
      ],
    };
  }
  if (type === 'mqtt') {
    return {
      kind: 'generic-sql',
      sections: [
        'identity',
        'uri',
        'target',
        'connectionMode',
        'replica',
        'service',
        'credentials',
      ],
    };
  }
  if (type === 'rocketmq') {
    return {
      kind: 'generic-sql',
      sections: [
        'identity',
        'uri',
        'target',
        'connectionMode',
        'replica',
        'service',
        'credentials',
      ],
    };
  }
  if (type === 'kafka') {
    return {
      kind: 'generic-sql',
      sections: [
        'identity',
        'uri',
        'target',
        'connectionMode',
        'replica',
        'service',
        'credentials',
      ],
    };
  }
  if (type === 'rabbitmq') {
    return {
      kind: 'generic-sql',
      sections: [
        'identity',
        'uri',
        'target',
        'service',
        'credentials',
        'databaseScope',
      ],
    };
  }
  if (type === 'trino') {
    return {
      kind: 'generic-sql',
      sections: [
        'identity',
        'uri',
        'target',
        'service',
        'credentials',
        'databaseScope',
      ],
    };
  }
  if (postgresCompatibleTypes.has(type)) {
    return {
      kind: 'postgres-compatible',
      sections: [
        'identity',
        'uri',
        'target',
        'service',
        'credentials',
        'databaseScope',
      ],
    };
  }
  if (type === 'oracle') {
    return {
      kind: 'oracle',
      sections: [
        'identity',
        'uri',
        'target',
        'service',
        'credentials',
        'databaseScope',
      ],
    };
  }

  return {
    kind: 'generic-sql',
    sections: ['identity', 'uri', 'target', 'credentials', 'databaseScope'],
  };
};

const normalizeText = (value: unknown, fallback = ''): string => {
  const text = String(value ?? '').trim();
  if (!text || text === 'undefined' || text === 'null') {
    return fallback;
  }
  return text;
};

export const getStoredSecretPlaceholder = ({
  hasStoredSecret,
  emptyPlaceholder,
  retainedLabel,
}: StoredSecretPlaceholderOptions): string => (
  hasStoredSecret
    ? t('connection.modal.secret.placeholder.retained', { retainedLabel })
    : emptyPlaceholder
);

export const normalizeConnectionSecretErrorMessage = (
  value: unknown,
  fallback = '',
): string => {
  const text = normalizeText(value, fallback);
  const lower = text.toLowerCase();

  if (lower.includes('saved connection not found:')) {
    return t('connection.modal.error.savedConnectionNotFound');
  }
  if (lower.includes('secret store unavailable')) {
    return t('connection.modal.error.secretStoreUnavailable');
  }

  return text;
};

export const summarizeConnectionTestFailureMessage = (
  value: unknown,
  fallback = '',
): string => {
  const text = normalizeConnectionSecretErrorMessage(value, fallback);
  const [firstLine] = text
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter((item) => item !== '');
  return firstLine || text;
};

export const resolveConnectionTestFailureFeedback = ({
  kind,
  reason,
  fallback,
}: {
  kind: ConnectionTestFailureKind;
  reason: unknown;
  fallback: string;
}): ConnectionTestFailureFeedback => {
  if (kind === 'validation') {
    return {
      message: t('connection.modal.test.validation'),
      shouldToast: false,
    };
  }

  return {
    message: t('connection.modal.test.failure', {
      reason: normalizeConnectionSecretErrorMessage(reason, fallback),
    }),
    shouldToast: false,
  };
};

export type {
  ConnectionTestFailureFeedback,
  ConnectionTestFailureKind,
};
