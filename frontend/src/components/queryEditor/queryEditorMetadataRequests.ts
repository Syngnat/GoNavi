import { v4 as uuidv4 } from 'uuid';
import {
  CancelQuery,
  DBGetAllColumnsWithCancel,
  DBGetColumnsWithCancel,
  DBGetDatabasesWithCancel,
  DBGetTablesWithCancel,
  DBQueryApplicationWithCancel,
  DBShowCreateTableWithCancel,
} from '../../../wailsjs/go/app/App';
import type { connection } from '../../../wailsjs/go/models';
import { invokeAppWithSignal } from '../../utils/webRpc';

type RequestScope = {
  connectionId: string;
  databaseKey?: string;
};

type RequestOptions<T> = RequestScope & {
  key: string;
  signal?: AbortSignal;
  run: (signal: AbortSignal) => Promise<T>;
};

type QueuedRequest<T> = {
  signal: AbortSignal;
  run: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
  onAbort: () => void;
};

type ConnectionQueue = {
  active: number;
  queued: QueuedRequest<unknown>[];
};

type SharedRequest<T> = RequestScope & {
  controller: AbortController;
  consumers: Set<symbol>;
  promise: Promise<T>;
};

type MetadataConnection = {
  id: string;
  config: unknown;
};

type MetadataConnectionState = {
  config: unknown;
  fingerprint: string;
  present: boolean;
  revision: number;
};

const createAbortError = (): Error => Object.assign(new Error('metadata request aborted'), {
  name: 'AbortError',
});

export const isQueryEditorMetadataAbortError = (error: unknown): boolean => Boolean(
  error
  && typeof error === 'object'
  && ((error as { name?: unknown }).name === 'AbortError'
    || (error as { code?: unknown }).code === 'WEB_RPC_ABORTED'),
);

export const fingerprintQueryEditorMetadataConfig = (value: unknown): string => {
  const seen = new WeakSet<object>();
  let hash = 2166136261;
  let secondaryHash = 0x9e3779b9;
  const write = (text: string) => {
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      hash ^= code;
      hash = Math.imul(hash, 16777619);
      secondaryHash ^= code;
      secondaryHash = Math.imul(secondaryHash, 2246822519) ^ (secondaryHash >>> 13);
    }
  };
  const visit = (current: unknown) => {
    if (current === null || current === undefined || typeof current !== 'object') {
      write(`${typeof current}:${String(current)};`);
      return;
    }
    if (seen.has(current)) {
      write('cycle;');
      return;
    }
    seen.add(current);
    if (Array.isArray(current)) {
      write('array[');
      current.forEach(visit);
      write(']');
      return;
    }
    write('object{');
    Object.keys(current).sort().forEach((key) => {
      write(`${key}:`);
      visit((current as Record<string, unknown>)[key]);
    });
    write('}');
  };
  visit(value);
  return `${(hash >>> 0).toString(16)}:${(secondaryHash >>> 0).toString(16)}`;
};

const waitForSignal = <T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> => {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(createAbortError());
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(createAbortError()));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
};

class QueryEditorMetadataScheduler {
  private readonly queues = new Map<string, ConnectionQueue>();

  constructor(
    private readonly perConnectionLimit: number,
    private readonly maxQueuedPerConnection: number,
  ) {}

  run<T>(connectionId: string, signal: AbortSignal, run: () => Promise<T>): Promise<T> {
    if (signal.aborted) return Promise.reject(createAbortError());
    const normalizedConnectionId = String(connectionId || '').trim();
    const queue = this.queues.get(normalizedConnectionId) || { active: 0, queued: [] };
    this.queues.set(normalizedConnectionId, queue);
    if (queue.active >= this.perConnectionLimit && queue.queued.length >= this.maxQueuedPerConnection) {
      return Promise.reject(createAbortError());
    }

    return new Promise<T>((resolve, reject) => {
      const request: QueuedRequest<T> = {
        signal,
        run,
        resolve,
        reject,
        onAbort: () => {
          const index = queue.queued.indexOf(request as QueuedRequest<unknown>);
          if (index < 0) return;
          queue.queued.splice(index, 1);
          reject(createAbortError());
          this.releaseQueue(normalizedConnectionId, queue);
        },
      };
      signal.addEventListener('abort', request.onAbort, { once: true });
      queue.queued.push(request as QueuedRequest<unknown>);
      this.drain(normalizedConnectionId, queue);
    });
  }

  stats(): { active: number; queued: number } {
    let active = 0;
    let queued = 0;
    this.queues.forEach((queue) => {
      active += queue.active;
      queued += queue.queued.length;
    });
    return { active, queued };
  }

  private drain(connectionId: string, queue: ConnectionQueue): void {
    while (queue.active < this.perConnectionLimit && queue.queued.length > 0) {
      const request = queue.queued.shift()!;
      request.signal.removeEventListener('abort', request.onAbort);
      if (request.signal.aborted) {
        request.reject(createAbortError());
        continue;
      }
      queue.active += 1;
      Promise.resolve()
        .then(request.run)
        .then(request.resolve, request.reject)
        .finally(() => {
          queue.active = Math.max(0, queue.active - 1);
          this.drain(connectionId, queue);
          this.releaseQueue(connectionId, queue);
        });
    }
    this.releaseQueue(connectionId, queue);
  }

  private releaseQueue(connectionId: string, queue: ConnectionQueue): void {
    if (queue.active === 0 && queue.queued.length === 0 && this.queues.get(connectionId) === queue) {
      this.queues.delete(connectionId);
    }
  }
}

export class QueryEditorMetadataRequestPool {
  private readonly scheduler: QueryEditorMetadataScheduler;
  private readonly shared = new Map<string, SharedRequest<unknown>>();

  constructor(perConnectionLimit = 2, maxQueuedPerConnection = 32) {
    this.scheduler = new QueryEditorMetadataScheduler(
      Math.max(1, Math.floor(perConnectionLimit) || 1),
      Math.max(1, Math.floor(maxQueuedPerConnection) || 1),
    );
  }

  request<T>(options: RequestOptions<T>): Promise<T> {
    const connectionId = String(options.connectionId || '').trim();
    const sharedKey = `${connectionId}\u0000${options.key}`;
    let entry = this.shared.get(sharedKey) as SharedRequest<T> | undefined;
    if (!entry) {
      const controller = new AbortController();
      const promise = this.scheduler.run(connectionId, controller.signal, () => options.run(controller.signal));
      entry = {
        connectionId,
        databaseKey: String(options.databaseKey || '').trim(),
        controller,
        consumers: new Set<symbol>(),
        promise,
      };
      this.shared.set(sharedKey, entry as SharedRequest<unknown>);
      promise.then(
        () => this.releaseSharedEntry(sharedKey, entry!),
        () => this.releaseSharedEntry(sharedKey, entry!),
      );
    }

    const consumer = Symbol(sharedKey);
    entry.consumers.add(consumer);
    return waitForSignal(entry.promise, options.signal)
      .finally(() => this.releaseConsumer(sharedKey, entry!, consumer));
  }

  cancel(connectionId?: string, databaseKey?: string): void {
    const normalizedConnectionId = String(connectionId || '').trim();
    const normalizedDatabaseKey = String(databaseKey || '').trim();
    for (const [key, entry] of this.shared) {
      if (normalizedConnectionId && entry.connectionId !== normalizedConnectionId) continue;
      if (normalizedDatabaseKey && entry.databaseKey !== normalizedDatabaseKey) continue;
      this.shared.delete(key);
      entry.controller.abort();
    }
  }

  stats(): { active: number; queued: number; shared: number } {
    return { ...this.scheduler.stats(), shared: this.shared.size };
  }

  private releaseConsumer(key: string, entry: SharedRequest<unknown>, consumer: symbol): void {
    entry.consumers.delete(consumer);
    if (entry.consumers.size > 0 || this.shared.get(key) !== entry) return;
    this.shared.delete(key);
    entry.controller.abort();
  }

  private releaseSharedEntry(key: string, entry: SharedRequest<unknown>): void {
    if (this.shared.get(key) === entry) this.shared.delete(key);
  }
}

const metadataRequests = new QueryEditorMetadataRequestPool(2);
const metadataConnections = new Map<string, MetadataConnectionState>();

const metadataConnectionRevision = (connectionId: string): number => (
  metadataConnections.get(String(connectionId || '').trim())?.revision || 1
);

const invokeWailsWithQueryID = async <T>(
  signal: AbortSignal,
  invoke: (queryID: string) => Promise<T>,
): Promise<T> => {
  if (signal.aborted) throw createAbortError();
  const queryID = `metadata-${uuidv4()}`;
  let dispatched = false;
  const cancel = () => {
    if (!dispatched) return;
    void Promise.resolve(CancelQuery(queryID)).catch(() => undefined);
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    dispatched = true;
    const result = await invoke(queryID);
    if (signal.aborted) throw createAbortError();
    return result;
  } finally {
    signal.removeEventListener('abort', cancel);
  }
};

const requestMetadata = <T>(options: RequestScope & {
  operation: string;
  args: unknown[];
  keyParts: unknown[];
  signal?: AbortSignal;
  wails: (queryID: string) => Promise<T>;
}): Promise<T> => {
  const key = [
    options.operation,
    metadataConnectionRevision(options.connectionId),
    ...options.keyParts,
  ].map((part) => String(part ?? '')).join('\u0000');
  return metadataRequests.request({
    connectionId: options.connectionId,
    databaseKey: options.databaseKey,
    key,
    signal: options.signal,
    run: (internalSignal) => invokeAppWithSignal(
      options.operation,
      options.args,
      internalSignal,
      () => invokeWailsWithQueryID(internalSignal, options.wails),
    ),
  });
};

export const queryEditorMetadataGetDatabases = (
  connectionId: string,
  config: connection.ConnectionConfig,
  signal?: AbortSignal,
): Promise<connection.QueryResult> => requestMetadata({
  connectionId,
  operation: 'DBGetDatabases',
  args: [config],
  keyParts: [],
  signal,
  wails: (queryID) => DBGetDatabasesWithCancel(config, queryID),
});

export const queryEditorMetadataGetTables = (
  connectionId: string,
  config: connection.ConnectionConfig,
  dbName: string,
  signal?: AbortSignal,
  databaseKey = dbName,
): Promise<connection.QueryResult> => requestMetadata({
  connectionId,
  databaseKey,
  operation: 'DBGetTables',
  args: [config, dbName],
  keyParts: [dbName],
  signal,
  wails: (queryID) => DBGetTablesWithCancel(config, dbName, queryID),
});

export const queryEditorMetadataGetAllColumns = (
  connectionId: string,
  config: connection.ConnectionConfig,
  dbName: string,
  signal?: AbortSignal,
  databaseKey = dbName,
): Promise<connection.QueryResult> => requestMetadata({
  connectionId,
  databaseKey,
  operation: 'DBGetAllColumns',
  args: [config, dbName],
  keyParts: [dbName],
  signal,
  wails: (queryID) => DBGetAllColumnsWithCancel(config, dbName, queryID),
});

export const queryEditorMetadataGetColumns = (
  connectionId: string,
  config: connection.ConnectionConfig,
  dbName: string,
  tableName: string,
  signal?: AbortSignal,
  databaseKey = dbName,
): Promise<connection.QueryResult> => requestMetadata({
  connectionId,
  databaseKey,
  operation: 'DBGetColumns',
  args: [config, dbName, tableName],
  keyParts: [dbName, tableName],
  signal,
  wails: (queryID) => DBGetColumnsWithCancel(config, dbName, tableName, queryID),
});

export const queryEditorMetadataShowCreateTable = (
  connectionId: string,
  config: connection.ConnectionConfig,
  dbName: string,
  tableName: string,
  signal?: AbortSignal,
  databaseKey = dbName,
): Promise<connection.QueryResult> => requestMetadata({
  connectionId,
  databaseKey,
  operation: 'DBShowCreateTable',
  args: [config, dbName, tableName],
  keyParts: [dbName, tableName],
  signal,
  wails: (queryID) => DBShowCreateTableWithCancel(config, dbName, tableName, queryID),
});

export const queryEditorMetadataQuery = (
  connectionId: string,
  config: connection.ConnectionConfig,
  dbName: string,
  query: string,
  signal?: AbortSignal,
  databaseKey = dbName,
): Promise<connection.QueryResult> => requestMetadata({
  connectionId,
  databaseKey,
  operation: 'DBQuery',
  args: [config, dbName, query],
  keyParts: [dbName, query],
  signal,
  wails: (queryID) => DBQueryApplicationWithCancel(config, dbName, query, queryID),
});

export const cancelQueryEditorMetadataRequests = (connectionId?: string, databaseKey?: string): void => {
  metadataRequests.cancel(connectionId, databaseKey);
};

export const reconcileQueryEditorMetadataConnections = (connections: MetadataConnection[]): string[] => {
  const next = new Map(connections.map((connection) => [String(connection.id || '').trim(), connection.config]));
  const invalidated = new Set<string>();

  metadataConnections.forEach((state, connectionId) => {
    if (!state.present || next.has(connectionId)) return;
    state.present = false;
    state.config = undefined;
    state.revision += 1;
    metadataRequests.cancel(connectionId);
    invalidated.add(connectionId);
  });
  next.forEach((config, connectionId) => {
    const fingerprint = fingerprintQueryEditorMetadataConfig(config);
    const current = metadataConnections.get(connectionId);
    if (!current) {
      metadataConnections.set(connectionId, { config, fingerprint, present: true, revision: 1 });
      return;
    }
    if (current.present && current.fingerprint === fingerprint) {
      current.config = config;
      return;
    }
    current.config = config;
    current.fingerprint = fingerprint;
    current.present = true;
    current.revision += 1;
    metadataRequests.cancel(connectionId);
    invalidated.add(connectionId);
  });

  return [...invalidated];
};

export const resetQueryEditorMetadataRequests = (): void => {
  metadataRequests.cancel();
  metadataConnections.clear();
};
