import type { ConnectionConfig, SavedConnection } from '../types';
import { t } from '../i18n';

export type ConnectionImportKind = 'app-managed-package' | 'encrypted-package' | 'legacy-json' | 'mysql-workbench-xml' | 'navicat-ncx' | 'invalid';
export type ConnectionPackageDialogSnapshot = {
  open: boolean;
  mode: 'export' | 'import';
  includeSecrets: boolean;
  useFilePassword: boolean;
  password: string;
  error: string;
  confirmLoading: boolean;
  /** 导出时必选；导入弹窗可为空数组。始终为 string[]，避免 setState 类型不兼容。 */
  selectedConnectionIds: string[];
};
export type ConnectionPackageDialogUpdater = (
  current: ConnectionPackageDialogSnapshot,
) => ConnectionPackageDialogSnapshot;

export type ConnectionPackageExportResult =
  | { kind: 'canceled'; nextDialog: ConnectionPackageDialogUpdater }
  | { kind: 'succeeded' }
  | { kind: 'failed'; error: string };

type JsonObject = Record<string, unknown>;

const CONNECTION_PACKAGE_KIND = 'gonavi_connection_package';
const CONNECTION_PACKAGE_SCHEMA_VERSION_V2 = 2;
const CONNECTION_PACKAGE_PROTECTION_APP_MANAGED = 1;
const CONNECTION_PACKAGE_PROTECTION_FILE_PASSWORD = 2;
export const BACKEND_CANCELLED_MESSAGE = '已取消';
const CONNECTION_PACKAGE_PASSWORD_REQUIRED_MESSAGE = t(
  'file.backend.error.connection_package_password_required',
  undefined,
  'zh-CN',
);

const isJsonObject = (value: unknown): value is JsonObject => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const isConnectionPackageKDF = (value: unknown): value is JsonObject => (
  isJsonObject(value)
  && typeof value.name === 'string'
  && typeof value.memoryKiB === 'number'
  && typeof value.timeCost === 'number'
  && typeof value.parallelism === 'number'
  && typeof value.salt === 'string'
);

const isConnectionPackageEnvelope = (value: unknown): value is JsonObject => (
  isJsonObject(value)
  && typeof value.schemaVersion === 'number'
  && value.kind === CONNECTION_PACKAGE_KIND
  && typeof value.cipher === 'string'
  && isConnectionPackageKDF(value.kdf)
  && typeof value.nonce === 'string'
  && typeof value.payload === 'string'
);

const isConnectionPackageV2Envelope = (value: unknown): value is JsonObject => (
  isJsonObject(value)
  && value.kind === CONNECTION_PACKAGE_KIND
  && value.v === CONNECTION_PACKAGE_SCHEMA_VERSION_V2
  && typeof value.p === 'number'
);

const isConnectionPackageKDFV2 = (value: unknown): value is JsonObject => (
  isJsonObject(value)
  && typeof value.n === 'string'
  && typeof value.m === 'number'
  && typeof value.t === 'number'
  && typeof value.l === 'number'
  && typeof value.s === 'string'
);

const isConnectionPackageV2AppManagedEnvelope = (value: unknown): value is JsonObject => (
  isConnectionPackageV2Envelope(value)
  && value.p === CONNECTION_PACKAGE_PROTECTION_APP_MANAGED
  && Array.isArray(value.connections)
);

const isConnectionPackageV2ProtectedEnvelope = (value: unknown): value is JsonObject => (
  isConnectionPackageV2Envelope(value)
  && value.p === CONNECTION_PACKAGE_PROTECTION_FILE_PASSWORD
  && isConnectionPackageKDFV2(value.kdf)
  && typeof value.nc === 'string'
  && typeof value.d === 'string'
);

const isLegacyConnectionConfig = (value: unknown): value is JsonObject => (
  isJsonObject(value)
  && typeof value.type === 'string'
);

const isLegacyConnectionItem = (value: unknown): value is JsonObject => (
  isJsonObject(value)
  && typeof value.id === 'string'
  && typeof value.name === 'string'
  && isLegacyConnectionConfig(value.config)
);

const parseConnectionImportRaw = (raw: unknown): unknown => {
  if (typeof raw !== 'string') {
    return raw;
  }

  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
};

const isMySQLWorkbenchXML = (raw: string): boolean => (
  raw.includes('<data') && raw.includes('grt_format') && raw.includes('db.mgmt.Connection')
);

const isNavicatNCX = (raw: string): boolean => (
  raw.includes('<Connection')
  && raw.includes('ConnType=')
  && raw.includes('ConnectionName=')
);

export const detectConnectionImportKind = (raw: unknown): ConnectionImportKind => {
  if (typeof raw === 'string' && isMySQLWorkbenchXML(raw)) {
    return 'mysql-workbench-xml';
  }
  if (typeof raw === 'string' && isNavicatNCX(raw)) {
    return 'navicat-ncx';
  }

  const parsed = parseConnectionImportRaw(raw);

  if (isConnectionPackageV2AppManagedEnvelope(parsed)) {
    return 'app-managed-package';
  }

  if (isConnectionPackageV2ProtectedEnvelope(parsed)) {
    return 'encrypted-package';
  }

  if (isConnectionPackageV2Envelope(parsed)) {
    return 'invalid';
  }

  if (Array.isArray(parsed) && parsed.every((item) => isLegacyConnectionItem(item))) {
    return 'legacy-json';
  }

  if (isConnectionPackageEnvelope(parsed)) {
    return 'encrypted-package';
  }

  return 'invalid';
};

export const normalizeConnectionPackagePassword = (value: string): string => value.trim();

export const isConnectionPackagePasswordRequiredError = (value: unknown): boolean => {
  if (typeof value === 'string') {
    return value.trim() === CONNECTION_PACKAGE_PASSWORD_REQUIRED_MESSAGE;
  }

  if (value instanceof Error) {
    return value.message.trim() === CONNECTION_PACKAGE_PASSWORD_REQUIRED_MESSAGE;
  }

  return isJsonObject(value)
    && typeof value.message === 'string'
    && value.message.trim() === CONNECTION_PACKAGE_PASSWORD_REQUIRED_MESSAGE;
};

export const isBackendCancelledResult = (result: unknown): boolean => (
  isJsonObject(result)
  && result.success === false
  && result.message === BACKEND_CANCELLED_MESSAGE
);

export const isConnectionPackageExportCanceled = (result: unknown): boolean => (
  isBackendCancelledResult(result)
);

const formatConnectionPackageExportFailure = (detail?: string): string => {
  const normalizedDetail = String(detail || '').trim();
  if (!normalizedDetail) {
    return t('app.connection_package.message.export_failed');
  }
  return `${t('app.connection_package.message.export_failed')}: ${normalizedDetail}`;
};

export const resolveConnectionPackageExportResult = (
  _currentDialog: ConnectionPackageDialogSnapshot,
  result: unknown,
): ConnectionPackageExportResult => {
  if (isConnectionPackageExportCanceled(result)) {
    return {
      kind: 'canceled',
      nextDialog: (current) => ({
        ...current,
        confirmLoading: false,
        error: '',
      }),
    };
  }

  if (isJsonObject(result) && result.success === true) {
    return { kind: 'succeeded' };
  }

  return {
    kind: 'failed',
    error: isJsonObject(result) && typeof result.message === 'string' && result.message.trim()
      ? formatConnectionPackageExportFailure(result.message)
      : formatConnectionPackageExportFailure(),
  };
};

const legacyExportRemovedError = (): never => {
  throw new Error('Legacy connection JSON export has been removed. Use the recovery package flow instead.');
};

export const sanitizeConnectionConfigForExport = (_config: ConnectionConfig): never => legacyExportRemovedError();

export const buildExportableConnections = (_connections: SavedConnection[]): never => legacyExportRemovedError();
