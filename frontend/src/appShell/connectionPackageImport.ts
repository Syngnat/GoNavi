import { SavedConnection } from '../types';
import type { ExcelGroupAssignment } from '../utils/connectionExcelGroups';
import { type RedisDbAliasMap, sanitizeRedisDbAliases } from '../utils/redisDbAlias';

type ConnectionPackageImportPayload = {
  connections: SavedConnection[];
  redisDbAliases: RedisDbAliasMap;
  excelGroups?: ExcelGroupAssignment[];
};

/** Normalize ImportConnectionsPayload results: object (new) or bare array (legacy/mock). */
export const normalizeConnectionPackageImportPayload = (value: unknown): ConnectionPackageImportPayload | null => {
  if (Array.isArray(value)) {
    return {
      connections: value as SavedConnection[],
      redisDbAliases: {},
    };
  }
  if (!value || typeof value !== 'object') {
    return null;
  }
  const record = value as { connections?: unknown; redisDbAliases?: unknown; excelGroups?: unknown };
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
  };
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
