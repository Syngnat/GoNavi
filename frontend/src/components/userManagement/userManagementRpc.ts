import type { RpcConnectionConfig } from '../../utils/connectionRpcConfig';
import type {
  PrincipalRef,
  UMChangeRequest,
} from './userManagementTypes';

export interface UserManagementRpcResult<T = unknown> {
  success?: boolean;
  data?: T;
  message?: string;
  executedCount?: number;
  failedIndex?: number;
  partial?: boolean;
}

type Config = RpcConnectionConfig;

export interface UserManagementBackend {
  UserMgmtOverview?: (config: Config, query: { database?: string }) => Promise<UserManagementRpcResult>;
  UserMgmtDescribePrincipal?: (config: Config, query: { ref: PrincipalRef; database?: string }) => Promise<UserManagementRpcResult>;
  UserMgmtDropImpact?: (config: Config, ref: PrincipalRef) => Promise<UserManagementRpcResult>;
  UserMgmtExportDDL?: (config: Config, ref: PrincipalRef) => Promise<UserManagementRpcResult>;
  UserMgmtPreview?: (config: Config, request: UMChangeRequest) => Promise<UserManagementRpcResult>;
  UserMgmtApply?: (config: Config, request: UMChangeRequest, fingerprint: string) => Promise<UserManagementRpcResult>;
  UserMgmtSyncConnectionPassword?: (connectionId: string, password: string) => Promise<UserManagementRpcResult>;
  DBGetDatabases?: (config: Config) => Promise<UserManagementRpcResult>;
  DBGetTables?: (config: Config, dbName: string) => Promise<UserManagementRpcResult>;
  DBGetColumns?: (config: Config, dbName: string, tableName: string) => Promise<UserManagementRpcResult>;
}

// 只有后端 message 才允许直接展示 —— 它已由 appText 本地化；其余异常换兜底文案。
export class UserManagementBackendMessage extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserManagementBackendMessage';
  }
}

// 与 dmlSnapshotRpc 同一可注入模式：组件不直接 import wailsjs，测试注入假后端。
export const resolveUserManagementBackend = (): UserManagementBackend => {
  if (typeof window === 'undefined') return {};
  const go = (window as unknown as { go?: { app?: { App?: UserManagementBackend } } }).go;
  return go?.app?.App || {};
};

export const requireUserManagementMethod = <T extends keyof UserManagementBackend>(
  backend: UserManagementBackend,
  method: T,
): NonNullable<UserManagementBackend[T]> => {
  const candidate = backend[method];
  if (typeof candidate !== 'function') {
    throw new Error(`user management backend method unavailable: ${String(method)}`);
  }
  return candidate as NonNullable<UserManagementBackend[T]>;
};

export const unwrapUserManagementResult = <T>(result: UserManagementRpcResult<T> | undefined): T => {
  if (result?.success === false) {
    const message = String(result.message || '').trim();
    if (message) throw new UserManagementBackendMessage(message);
    throw new Error('user management request failed');
  }
  return result?.data as T;
};

export const resolveUserManagementErrorMessage = (error: unknown, fallback: string): string => (
  error instanceof UserManagementBackendMessage ? error.message : fallback
);
