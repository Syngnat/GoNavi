import { SavedConnection } from '../types';
import type { ExcelGroupAssignment } from '../utils/connectionExcelGroups';
import { type RedisDbAliasMap, sanitizeRedisDbAliases } from '../utils/redisDbAlias';

type ConnectionPackageImportPayload = {
  connections: SavedConnection[];
  redisDbAliases: RedisDbAliasMap;
  excelGroups?: ExcelGroupAssignment[];
  /** Entries the backend left out because the same connection already exists. */
  skippedCount: number;
};

const normalizeSkippedCount = (value: unknown): number => {
  const count = Number(value);
  return Number.isSafeInteger(count) && count > 0 ? count : 0;
};

/** Normalize ImportConnectionsPayload results: object (new) or bare array (legacy/mock). */
export const normalizeConnectionPackageImportPayload = (value: unknown): ConnectionPackageImportPayload | null => {
  if (Array.isArray(value)) {
    return {
      connections: value as SavedConnection[],
      redisDbAliases: {},
      skippedCount: 0,
    };
  }
  if (!value || typeof value !== 'object') {
    return null;
  }
  const record = value as {
    connections?: unknown;
    redisDbAliases?: unknown;
    excelGroups?: unknown;
    skippedCount?: unknown;
  };
  if (!Array.isArray(record.connections)) {
    return null;
  }
  const excelGroups = Array.isArray(record.excelGroups)
    ? (record.excelGroups as ExcelGroupAssignment[])
    : [];
  return {
    connections: record.connections as SavedConnection[],
    redisDbAliases: sanitizeRedisDbAliases(record.redisDbAliases),
    excelGroups,
    skippedCount: normalizeSkippedCount(record.skippedCount),
  };
};

type ConnectionImportTranslate = (key: string, params?: Record<string, string | number>) => string;

export type ConnectionImportSummary = {
  type: 'success' | 'warning';
  message: string;
};

export type ConnectionImportSummaryDetails = {
  /** Excel only: connections placed into the groups declared in the sheet. */
  groupedCount?: number;
  /** Some imported entries carry no password (Workbench / Navicat exports). */
  missingPasswords?: boolean;
};

/**
 * Turn an import result into the notice shown to the user. Entries skipped as
 * duplicates are always reported, so "nothing new was added" reads neither as
 * a silent success nor as a failure.
 */
export const summarizeConnectionImport = (
  t: ConnectionImportTranslate,
  imported: Pick<ConnectionPackageImportPayload, 'connections' | 'skippedCount'>,
  { groupedCount = 0, missingPasswords = false }: ConnectionImportSummaryDetails = {},
): ConnectionImportSummary => {
  const importedCount = imported.connections.length;
  const { skippedCount } = imported;
  if (importedCount === 0 && skippedCount > 0) {
    return {
      type: 'warning',
      message: t('app.connection_package.message.all_connections_exist', { count: skippedCount }),
    };
  }
  let message = t('app.connection_package.message.imported_connections', { count: importedCount });
  if (missingPasswords) {
    message = t('app.connection_package.message.imported_with_missing_passwords', { count: importedCount });
  } else if (groupedCount > 0) {
    message = t('app.connection_package.excel.groups_applied', { count: importedCount, groupCount: groupedCount });
  }
  if (skippedCount > 0) {
    message = t('app.connection_package.message.with_skipped_existing', { message, count: skippedCount });
  }
  return { type: missingPasswords ? 'warning' : 'success', message };
};

type ConnectionPackageDialogMode = 'import' | 'export';

export type ConnectionPackageDialogState = {
  open: boolean;
  mode: ConnectionPackageDialogMode;
  includeSecrets: boolean;
  useFilePassword: boolean;
  password: string;
  error: string;
  confirmLoading: boolean;
  /** Export only: selected connection ids to include in the package. */
  selectedConnectionIds: string[];
};

export const createClosedConnectionPackageDialogState = (): ConnectionPackageDialogState => ({
  open: false,
  mode: 'export',
  includeSecrets: true,
  useFilePassword: false,
  password: '',
  error: '',
  confirmLoading: false,
  selectedConnectionIds: [],
});
