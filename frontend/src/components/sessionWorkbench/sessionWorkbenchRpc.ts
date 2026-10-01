import type { ConnectionConfig } from '../../types';
import { buildRpcConnectionConfig } from '../../utils/connectionRpcConfig';
import { invokeAppMethodDynamic } from '../../utils/webRpc';
import { normalizeSessionDatabaseNames } from './sessionWorkbenchModel';
import type {
  SessionActionRequest,
  SessionQueryResult,
} from './sessionWorkbenchModel';

interface SessionWailsApp {
  DBListSessions: (config: unknown, dbName: string) => Promise<SessionQueryResult>;
  DBListSessionDatabases: (
    config: unknown,
    dbName: string,
  ) => Promise<SessionQueryResult>;
  DBExecuteSessionAction: (
    config: unknown,
    dbName: string,
    request: SessionActionRequest,
  ) => Promise<SessionQueryResult>;
}

interface SessionWailsRuntime {
  go?: {
    app?: {
      App?: Partial<SessionWailsApp>;
    };
  };
}

export const SESSION_WORKBENCH_RPC_UNAVAILABLE = 'session_workbench.error.rpc_unavailable';

const getSessionApp = (): SessionWailsApp => {
  const runtime = globalThis as typeof globalThis & SessionWailsRuntime;
  const app = runtime.go?.app?.App;
  if (!app?.DBListSessions || !app.DBExecuteSessionAction) {
    throw new Error(SESSION_WORKBENCH_RPC_UNAVAILABLE);
  }
  return app as SessionWailsApp;
};

const invokeSessionMethod = <T>(
  method: string,
  args: unknown[],
  fallback: (app: SessionWailsApp) => Promise<T>,
): Promise<T> => {
  const webResult = invokeAppMethodDynamic<T>(method, args);
  if (webResult) return webResult;
  return fallback(getSessionApp());
};

export const listSessionDatabases = async (
  config: ConnectionConfig,
  dbName: string,
): Promise<string[]> => {
  const rpcConfig = buildRpcConnectionConfig(config);
  const result = await invokeSessionMethod(
    'DBListSessionDatabases',
    [rpcConfig, dbName],
    (app) => app.DBListSessionDatabases(rpcConfig, dbName),
  );
  if (result?.success !== true) return [];
  return normalizeSessionDatabaseNames(result.data);
};

export const listDatabaseSessions = async (
  config: ConnectionConfig,
  dbName: string,
): Promise<SessionQueryResult> => {
  const rpcConfig = buildRpcConnectionConfig(config);
  return invokeSessionMethod(
    'DBListSessions',
    [rpcConfig, dbName],
    (app) => app.DBListSessions(rpcConfig, dbName),
  );
};

export const executeDatabaseSessionAction = async (
  config: ConnectionConfig,
  dbName: string,
  request: SessionActionRequest,
): Promise<SessionQueryResult> => {
  const rpcConfig = buildRpcConnectionConfig(config);
  return invokeSessionMethod(
    'DBExecuteSessionAction',
    [rpcConfig, dbName, request],
    (app) => app.DBExecuteSessionAction(rpcConfig, dbName, request),
  );
};
