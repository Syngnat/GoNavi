import {
  SIDEBAR_DATABASE_REFRESH_EVENT,
  normalizeSidebarDatabaseRefreshRequest,
} from '../../../utils/sidebarDatabaseRefresh';
import { BoundedQueryEditorMetadataCache, type QueryEditorMetadataCacheScope } from '../queryEditorMetadataCache';
import { fingerprintQueryEditorMetadataConfig } from '../queryEditorMetadataRequests';
import type {
  CompletionColumnMeta,
  CompletionPackageMeta,
  CompletionRoutineMeta,
  CompletionSequenceMeta,
  CompletionSynonymMeta,
  CompletionTableMeta,
  CompletionTriggerMeta,
  CompletionViewMeta,
} from '../QueryEditorHelpers';

// Query editors used to load the object catalog and the schema list on their
// own, so every new query tab repeated a dozen serial requests before
// Ctrl/Cmd+click could resolve anything. This store keeps what one editor
// loaded for the whole session so the next editor on the same connection and
// database starts from it.

/** After this long an entry is still served, but the reader refreshes it in the background. */
export const QUERY_EDITOR_SESSION_METADATA_STALE_MS = 2 * 60 * 1_000;
const QUERY_EDITOR_SESSION_METADATA_EXPIRE_MS = 8 * 60 * 60 * 1_000;
const KEY_SEPARATOR = '\n';

export type QueryEditorDatabaseMetadata = {
  tables: CompletionTableMeta[];
  columns: CompletionColumnMeta[];
  /** undefined until a column response arrived; true when the backend reported a partial catalog. */
  columnsIncomplete?: boolean;
  views: CompletionViewMeta[];
  materializedViews: CompletionViewMeta[];
  triggers: CompletionTriggerMeta[];
  routines: CompletionRoutineMeta[];
  sequences: CompletionSequenceMeta[];
  packages: CompletionPackageMeta[];
};

export type QueryEditorSchemaContext = {
  schemaNames: string[];
  defaultSchema: string;
};

export type QueryEditorSessionLoadResult<T> = {
  value: T;
  /** false when part of the load failed: usable now, but the next reader must load again. */
  cacheable: boolean;
};

export type QueryEditorSessionFetcher<T> = (
  report: (partial: T) => void,
  shouldStop: () => boolean,
) => Promise<QueryEditorSessionLoadResult<T> | null>;

type SessionEntry<T> = {
  value: T;
  checkedAt: number;
};

const KEEP_ALIVE_CONSUMER = Symbol('keep-alive');

type SessionLoad<T> = QueryEditorMetadataCacheScope & {
  consumers: Set<symbol>;
  listeners: Map<symbol, (partial: T) => void>;
  latest?: T;
  abandoned: boolean;
  promise: Promise<QueryEditorSessionLoadResult<T> | null>;
};

const normalizeScope = (scope: QueryEditorMetadataCacheScope): QueryEditorMetadataCacheScope => ({
  connectionId: String(scope.connectionId || '').trim(),
  databaseKey: String(scope.databaseKey || '').trim(),
});

export class QueryEditorSessionResource<T> {
  private readonly cache: BoundedQueryEditorMetadataCache<SessionEntry<T>>;
  private readonly loads = new Map<string, SessionLoad<T>>();

  private readonly stopWhenUnused: boolean;
  private readonly now: () => number;

  constructor(options: {
    maxEntries: number;
    maxEntriesPerConnection: number;
    maxBytes: number;
    /** Stop a running load once no editor waits for it. Short loads finish anyway so the next editor finds them. */
    stopWhenUnused?: boolean;
    now?: () => number;
  }) {
    this.stopWhenUnused = options.stopWhenUnused !== false;
    this.now = options.now || (() => Date.now());
    this.cache = new BoundedQueryEditorMetadataCache<SessionEntry<T>>({
      maxEntries: options.maxEntries,
      maxEntriesPerConnection: options.maxEntriesPerConnection,
      maxBytes: options.maxBytes,
      ttlMs: QUERY_EDITOR_SESSION_METADATA_EXPIRE_MS,
      now: this.now,
    });
  }

  /**
   * Returns the cached value. `stale` is reported to one reader per stale
   * window; that reader is expected to call `load` to refresh the entry.
   */
  read(key: string): { value: T; stale: boolean } | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    const now = this.now();
    const stale = now - entry.checkedAt >= QUERY_EDITOR_SESSION_METADATA_STALE_MS;
    if (stale) entry.checkedAt = now;
    return { value: entry.value, stale };
  }

  /** Stores a value the caller loaded on its own. */
  write(key: string, scope: QueryEditorMetadataCacheScope, value: T): void {
    this.cache.set(key, normalizeScope(scope), { value, checkedAt: this.now() });
  }

  /**
   * Loads the value, joining a load another editor already started. Call
   * `release` when the result is no longer wanted. A `keepAlive` load runs to
   * the end regardless: it refreshes the entry for whoever reads it next.
   */
  load(options: {
    key: string;
    scope: QueryEditorMetadataCacheScope;
    fetch: QueryEditorSessionFetcher<T>;
    onProgress?: (partial: T) => void;
    keepAlive?: boolean;
  }): { promise: Promise<QueryEditorSessionLoadResult<T> | null>; release: () => void } {
    const { key } = options;
    const running = this.loads.get(key);
    const load: SessionLoad<T> = running || {
      ...normalizeScope(options.scope),
      consumers: new Set<symbol>(),
      listeners: new Map<symbol, (partial: T) => void>(),
      abandoned: false,
      promise: Promise.resolve(null),
    };
    const consumer = Symbol(key);
    load.consumers.add(consumer);
    if (options.keepAlive) load.consumers.add(KEEP_ALIVE_CONSUMER);
    if (options.onProgress) load.listeners.set(consumer, options.onProgress);
    if (running) {
      // A late joiner starts from what the running load already has.
      if (options.onProgress && running.latest !== undefined) options.onProgress(running.latest);
    } else {
      this.loads.set(key, load);
      load.promise = this.start(key, load, options.fetch);
    }
    return {
      promise: load.promise,
      release: () => {
        load.consumers.delete(consumer);
        load.listeners.delete(consumer);
        if (load.consumers.size > 0 || !this.stopWhenUnused || this.loads.get(key) !== load) return;
        load.abandoned = true;
        this.loads.delete(key);
      },
    };
  }

  private start(
    key: string,
    load: SessionLoad<T>,
    fetch: QueryEditorSessionFetcher<T>,
  ): Promise<QueryEditorSessionLoadResult<T> | null> {
    const report = (partial: T) => {
      load.latest = partial;
      load.listeners.forEach((listener) => listener(partial));
    };
    // Only the load still registered under the key may write the cache: one
    // that was abandoned or detached by an invalidation read an older catalog.
    const settle = (): boolean => {
      if (this.loads.get(key) !== load) return false;
      this.loads.delete(key);
      return true;
    };
    let fetched: Promise<QueryEditorSessionLoadResult<T> | null>;
    try {
      fetched = fetch(report, () => load.abandoned);
    } catch (error) {
      fetched = Promise.reject(error);
    }
    return fetched.then((result) => {
      if (settle() && result?.cacheable) {
        this.cache.set(key, load, { value: result.value, checkedAt: this.now() });
      }
      return result;
    }, (error) => {
      settle();
      throw error;
    });
  }

  /** Drops cached values and detaches running loads so results read before the change are not kept. */
  invalidate(connectionId: string, databaseKey?: string): void {
    const scope = normalizeScope({ connectionId, databaseKey: databaseKey || '' });
    if (!scope.connectionId) return;
    this.cache.invalidate(scope.connectionId, scope.databaseKey);
    for (const [key, load] of this.loads) {
      if (load.connectionId !== scope.connectionId) continue;
      if (scope.databaseKey && load.databaseKey !== scope.databaseKey) continue;
      this.loads.delete(key);
    }
  }

  clear(): void {
    this.cache.clear();
    this.loads.clear();
  }
}

export const queryEditorDatabaseMetadataSession = new QueryEditorSessionResource<QueryEditorDatabaseMetadata>({
  maxEntries: 32,
  maxEntriesPerConnection: 12,
  maxBytes: 48 * 1024 * 1024,
});

export const queryEditorSynonymSession = new QueryEditorSessionResource<CompletionSynonymMeta[]>({
  maxEntries: 32,
  maxEntriesPerConnection: 12,
  maxBytes: 4 * 1024 * 1024,
  stopWhenUnused: false,
});

export const queryEditorSchemaContextSession = new QueryEditorSessionResource<QueryEditorSchemaContext>({
  maxEntries: 128,
  maxEntriesPerConnection: 32,
  maxBytes: 2 * 1024 * 1024,
  stopWhenUnused: false,
});

/** Backend responses describing one table (columns, indexes, ...), kept for the table designer. */
export const tableStructureSession = new QueryEditorSessionResource<unknown>({
  maxEntries: 512,
  maxEntriesPerConnection: 256,
  maxBytes: 16 * 1024 * 1024,
});

/** Database names compare case-insensitively here: invalidating too much only costs one reload. */
export const buildQueryEditorSessionMetadataScope = (
  connectionId: string,
  dbName: string,
): QueryEditorMetadataCacheScope => ({
  connectionId: String(connectionId || '').trim(),
  databaseKey: String(dbName || '').trim().toLowerCase(),
});

/**
 * Entries are bound to the connection settings they were loaded with, so an
 * edited connection (another host, another account) never reuses them.
 */
export const buildQueryEditorSessionMetadataKey = (
  connectionId: string,
  connectionConfig: unknown,
  ...parts: string[]
): string => [
  String(connectionId || '').trim(),
  fingerprintQueryEditorMetadataConfig(connectionConfig),
  ...parts.map((part) => String(part ?? '')),
].join(KEY_SEPARATOR);

export const invalidateQueryEditorSessionMetadata = (connectionId: string, dbName?: string): void => {
  const scope = buildQueryEditorSessionMetadataScope(connectionId, dbName || '');
  queryEditorDatabaseMetadataSession.invalidate(scope.connectionId, scope.databaseKey);
  queryEditorSynonymSession.invalidate(scope.connectionId, scope.databaseKey);
  queryEditorSchemaContextSession.invalidate(scope.connectionId, scope.databaseKey);
  tableStructureSession.invalidate(scope.connectionId, scope.databaseKey);
};

export const clearQueryEditorSessionMetadata = (): void => {
  queryEditorDatabaseMetadataSession.clear();
  queryEditorSynonymSession.clear();
  queryEditorSchemaContextSession.clear();
  tableStructureSession.clear();
};

let invalidationListenerTarget: Window | null = null;

const handleSidebarDatabaseRefresh = (event: Event) => {
  const request = normalizeSidebarDatabaseRefreshRequest((event as CustomEvent).detail);
  if (!request) return;
  invalidateQueryEditorSessionMetadata(request.connectionId, request.dbName);
};

/**
 * The store outlives every editor, so it listens for structure changes on its
 * own: a change made while no query tab is open must still drop the entry.
 */
export const ensureQueryEditorSessionMetadataInvalidationListener = (): void => {
  if (typeof window === 'undefined' || invalidationListenerTarget === window) return;
  invalidationListenerTarget?.removeEventListener?.(SIDEBAR_DATABASE_REFRESH_EVENT, handleSidebarDatabaseRefresh);
  window.addEventListener(SIDEBAR_DATABASE_REFRESH_EVENT, handleSidebarDatabaseRefresh);
  invalidationListenerTarget = window;
};
