import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../../store';
import type { SavedConnection } from '../../types';
import {
  readSessionPayload,
  sessionConnections,
  type DatabaseSession,
  type SessionActionRequest,
  type SessionListPayload,
  type SessionQueryResult,
} from './sessionWorkbenchModel';
import {
  executeDatabaseSessionAction,
  listDatabaseSessions,
  listSessionDatabases,
} from './sessionWorkbenchRpc';
import { useSessionWorkbenchScope } from './useSessionWorkbenchScope';

export interface UseSessionWorkbenchOptions {
  initialConnectionId?: string;
  initialDbName?: string;
}

export interface SessionWorkbenchState {
  connections: SavedConnection[];
  selectedConnection: SavedConnection | null;
  selectedConnectionId: string;
  setSelectedConnectionId: (connectionId: string) => void;
  /**
   * The connection's own database, kept in sync with the selected connection.
   * It is only the initial scope for engines that need a database to connect;
   * the listed sessions are instance-wide and are narrowed with
   * the running-only shortcut instead.
   */
  databaseName: string;
  /**
   * Switch the server-side database scope. PostgreSQL-lineage servers only
   * expose the connected database's sessions, so this reconnects and reloads
   * instead of narrowing the rows already on screen. An empty name means "the
   * connection's own default database".
   */
  selectDatabase: (databaseName: string) => void;
  filter: string;
  setFilter: (filter: string) => void;
  /** Client-side "only executing sessions" shortcut over the loaded sessions. */
  runningOnly: boolean;
  setRunningOnly: (runningOnly: boolean) => void;
  /**
   * Databases the connection can read sessions from. Loaded on demand, because
   * reading the catalog is a second server round trip that only the picker
   * needs. Empty until `loadDatabases` is called.
   */
  databases: string[];
  /** Fetch the catalog for the current scope. Safe to call repeatedly. */
  loadDatabases: () => Promise<void>;
  /** The catalog request for the current connection is still running. */
  databasesLoading: boolean;
  payload: SessionListPayload | null;
  loading: boolean;
  error: string;
  /** Monotonic context revision used to invalidate dialogs and old actions. */
  scopeRevision: number;
  refresh: (databaseOverride?: string) => Promise<boolean>;
  executeAction: (request: SessionActionRequest) => Promise<SessionQueryResult>;
}

interface SessionScopeSnapshot {
  connectionId: string;
  databaseName: string;
  revision: number;
}

const normalized = (value: unknown): string => String(value ?? '').trim();

export const useSessionWorkbench = (
  options: UseSessionWorkbenchOptions = {},
): SessionWorkbenchState => {
  const allConnections = useStore((state) => state.connections);
  const connections = useMemo(() => sessionConnections(allConnections), [allConnections]);
  const scope = useSessionWorkbenchScope(options, connections);
  const {
    selectedConnection,
    selectedConnectionId,
    setSelectedConnectionIdState,
    databaseName,
    setDatabaseName,
    selectDatabase: selectScopeDatabase,
    scopeRevision: renderedScopeRevision,
    autoRefreshRevision,
    invalidateScope: invalidateScopeState,
  } = scope;
  const [filter, setFilter] = useState('');
  const [runningOnly, setRunningOnly] = useState(false);
  const [payload, setPayload] = useState<SessionListPayload | null>(null);
  const [databases, setDatabases] = useState<string[]>([]);
  const [databasesLoading, setDatabasesLoading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Refs make the response guard synchronous with a user selection. A
  // promise can settle before React has committed the next render, so relying
  // only on state captured by a callback is not enough here.
  const connectionsRef = useRef(connections);
  const selectedConnectionIdRef = useRef(selectedConnectionId);
  const appliedDatabaseNameRef = useRef(databaseName);
  const requestRevision = useRef(0);
  const scopeRevisionRef = useRef(renderedScopeRevision);
  connectionsRef.current = connections;
  selectedConnectionIdRef.current = selectedConnectionId;
  appliedDatabaseNameRef.current = databaseName;
  // The local invalidation helper can advance this ref before the scope hook
  // state has rendered. Never move it backwards when that state catches up.
  if (renderedScopeRevision > scopeRevisionRef.current) {
    scopeRevisionRef.current = renderedScopeRevision;
  }

  const invalidateCurrentScope = useCallback(() => {
    requestRevision.current += 1;
    scopeRevisionRef.current += 1;
    invalidateScopeState();
    setLoading(false);
  }, [invalidateScopeState]);

  const isScopeCurrent = useCallback((snapshot: SessionScopeSnapshot): boolean => (
    scopeRevisionRef.current === snapshot.revision
      && selectedConnectionIdRef.current === snapshot.connectionId
      && appliedDatabaseNameRef.current === snapshot.databaseName
  ), []);

  const refreshSessions = useCallback(async (
    databaseOverride: string | undefined,
    invalidateContext: boolean,
  ): Promise<boolean> => {
    if (invalidateContext) invalidateCurrentScope();

    const requestId = ++requestRevision.current;
    const requestedConnectionId = selectedConnectionIdRef.current;
    const requestedDatabaseName = normalized(
      databaseOverride === undefined ? appliedDatabaseNameRef.current : databaseOverride,
    );
    const requestScope: SessionScopeSnapshot = {
      connectionId: requestedConnectionId,
      databaseName: requestedDatabaseName,
      revision: scopeRevisionRef.current,
    };
    const isRequestCurrent = (): boolean => (
      requestRevision.current === requestId
        && scopeRevisionRef.current === requestScope.revision
        && selectedConnectionIdRef.current === requestScope.connectionId
    );
    const connection = connectionsRef.current.find(
      (candidate) => candidate.id === requestedConnectionId,
    );
    if (!connection) {
      if (isRequestCurrent()) {
        setPayload(null);
        setError('no_connection');
        setLoading(false);
      }
      return false;
    }

    setLoading(true);
    setError('');
    try {
      const result = await listDatabaseSessions(connection.config, requestedDatabaseName);
      if (!isRequestCurrent()) return false;
      if (result.success !== true) {
        setPayload(null);
        setError(normalized(result.message) || 'list_failed');
        return false;
      }
      setPayload(readSessionPayload(result));
      setDatabaseName(requestedDatabaseName);
      return true;
    } catch (cause) {
      if (!isRequestCurrent()) return false;
      setPayload(null);
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      // A newer request, or a scope invalidation, owns the loading indicator.
      if (requestRevision.current === requestId) setLoading(false);
    }
  }, [invalidateCurrentScope, setDatabaseName]);

  const refresh = useCallback(
    (databaseOverride?: string): Promise<boolean> => refreshSessions(databaseOverride, true),
    [refreshSessions],
  );

  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const lastAutoRefreshRevisionRef = useRef<number | null>(null);
  useEffect(() => {
    if (lastAutoRefreshRevisionRef.current === autoRefreshRevision) return;
    lastAutoRefreshRevisionRef.current = autoRefreshRevision;
    setFilter('');
    setRunningOnly(false);
    void refreshRef.current();
  }, [autoRefreshRevision]);

  // The picker's catalog is deliberately not part of `refreshSessions`: it is
  // a second server round trip that only the picker needs, and re-reading it
  // on every refresh would double the cost of the common case. The rows still
  // contribute their own databases as a fallback, so a failed catalog call
  // degrades to "only databases that currently own a session".
  const loadDatabases = useCallback(async (): Promise<void> => {
    const connectionId = selectedConnectionIdRef.current;
    const connection = connectionsRef.current.find(
      (candidate) => candidate.id === connectionId,
    );
    if (!connection) {
      setDatabases([]);
      return;
    }
    const revision = scopeRevisionRef.current;
    setDatabasesLoading(true);
    try {
      const names = await listSessionDatabases(
        connection.config,
        appliedDatabaseNameRef.current,
      );
      // A catalog for the previous scope must not repopulate the picker.
      if (!isScopeCurrent({ connectionId, databaseName: '', revision })) return;
      setDatabases(names);
    } catch {
      if (!isScopeCurrent({ connectionId, databaseName: '', revision })) return;
      setDatabases([]);
    } finally {
      if (scopeRevisionRef.current === revision) setDatabasesLoading(false);
    }
  }, [isScopeCurrent]);

  // The catalog is fetched per connection scope, not per refresh: it changes
  // only when the connection does, and a refresh must stay a single round trip.
  const loadDatabasesRef = useRef(loadDatabases);
  loadDatabasesRef.current = loadDatabases;
  useEffect(() => {
    if (!selectedConnectionId) return;
    setDatabases([]);
    void loadDatabasesRef.current();
  }, [selectedConnectionId]);

  const setSelectedConnectionId = useCallback((connectionId: string) => {
    const nextConnectionId = normalized(connectionId);
    if (nextConnectionId === selectedConnectionIdRef.current) return;
    invalidateCurrentScope();
    setSelectedConnectionIdState(nextConnectionId);
    // The scope hook re-resolves the database from the new connection; clearing
    // it here only stops the previous connection's database from being reused
    // for a request that has not been re-scoped yet.
    setDatabaseName('');
    setPayload(null);
    setDatabases([]);
    setError('');
    setFilter('');
    setRunningOnly(false);
  }, [invalidateCurrentScope, setDatabaseName, setSelectedConnectionIdState]);

  // Switching the database is a server-side rescope: PostgreSQL-lineage
  // servers expose only the connected database's sessions, so the new scope
  // has to be read from the server. The reload is driven by the scope hook's
  // auto-refresh revision rather than a manual request here: a manual request
  // would bump the revision a second time and discard its own response.
  const selectDatabase = useCallback((value: string) => {
    const next = normalized(value);
    if (next === appliedDatabaseNameRef.current) return;
    // The scope hook may already hold this value (it resolves a connection's
    // default database), in which case selecting it is a no-op.
    selectScopeDatabase(next);
    setPayload(null);
    setError('');
    setFilter('');
    setRunningOnly(false);
  }, [selectScopeDatabase]);

  const executeAction = useCallback(async (
    request: SessionActionRequest,
  ): Promise<SessionQueryResult> => {
    const requestedConnectionId = selectedConnectionIdRef.current;
    const requestedDatabaseName = appliedDatabaseNameRef.current;
    const actionScope: SessionScopeSnapshot = {
      connectionId: requestedConnectionId,
      databaseName: requestedDatabaseName,
      revision: scopeRevisionRef.current,
    };
    const connection = connectionsRef.current.find(
      (candidate) => candidate.id === requestedConnectionId,
    );
    if (!connection) return { success: false, message: 'no_connection' };

    const staleResult = (result: SessionQueryResult): SessionQueryResult => ({
      ...result,
      stale: true,
    });

    try {
      const result = await executeDatabaseSessionAction(
        connection.config,
        requestedDatabaseName,
        request,
      );
      if (!isScopeCurrent(actionScope)) return staleResult(result);
      // Refresh the exact scope the action ran against, so a connection switch
      // while the confirmation modal was open cannot load the wrong server.
      if (result.success === true) {
        await refreshSessions(requestedDatabaseName, false);
        if (!isScopeCurrent(actionScope)) return staleResult(result);
      }
      return result;
    } catch (cause) {
      const result: SessionQueryResult = {
        success: false,
        message: cause instanceof Error ? cause.message : String(cause),
      };
      return isScopeCurrent(actionScope) ? result : staleResult(result);
    }
  }, [isScopeCurrent, refreshSessions]);

  return {
    connections,
    selectedConnection,
    selectedConnectionId,
    setSelectedConnectionId,
    databaseName,
    selectDatabase,
    filter,
    setFilter,
    runningOnly,
    setRunningOnly,
    databases,
    loadDatabases,
    databasesLoading,
    payload,
    loading,
    error,
    scopeRevision: scopeRevisionRef.current,
    refresh,
    executeAction,
  };
};

export const sessionRowByKey = (
  sessions: DatabaseSession[],
  key: string,
): DatabaseSession | null => sessions.find((session) => session.key === key) || null;
