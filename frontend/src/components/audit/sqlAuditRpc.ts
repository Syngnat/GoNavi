import type { SQLAuditHealth, SQLAuditSettings } from './sqlAuditModel';

export interface SQLAuditRpcResult<T = unknown> {
  success?: boolean;
  data?: T;
  message?: string;
}

export interface SQLAuditBackend {
  GetSQLAuditEvents?: (filter: Record<string, string | number | boolean>) => Promise<SQLAuditRpcResult>;
  GetSQLAuditHealth?: () => Promise<SQLAuditRpcResult<SQLAuditHealth>>;
  GetSQLAuditSettings?: () => Promise<SQLAuditRpcResult>;
  UpdateSQLAuditSettings?: (settings: SQLAuditSettings) => Promise<SQLAuditRpcResult>;
  VerifySQLAuditIntegrity?: () => Promise<SQLAuditRpcResult>;
  BuildSQLAuditExport?: (filter: Record<string, string | number | boolean>, format: 'json' | 'csv') => Promise<SQLAuditRpcResult>;
  ExportSQLAuditFile?: (filter: Record<string, string | number | boolean>, format: 'json' | 'csv') => Promise<SQLAuditRpcResult>;
  ClearSQLAuditEvents?: (beforeTimestamp: number) => Promise<SQLAuditRpcResult>;
}

export const resolveSQLAuditBackend = (): SQLAuditBackend => {
  if (typeof window === 'undefined') return {};
  return ((window as any).go?.app?.App || {}) as SQLAuditBackend;
};

export const requireSQLAuditMethod = <T extends keyof SQLAuditBackend>(
  backend: SQLAuditBackend,
  method: T,
): NonNullable<SQLAuditBackend[T]> => {
  const candidate = backend[method];
  if (typeof candidate !== 'function') {
    throw new Error(`SQL audit backend method unavailable: ${String(method)}`);
  }
  return candidate as NonNullable<SQLAuditBackend[T]>;
};

export const unwrapSQLAuditResult = <T>(result: SQLAuditRpcResult<T>): T => {
  if (result?.success === false) {
    throw new Error(String(result.message || '').trim() || 'SQL audit request failed');
  }
  return result?.data as T;
};
