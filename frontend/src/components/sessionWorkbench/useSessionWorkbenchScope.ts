import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SavedConnection } from '../../types';

export interface SessionWorkbenchScopeOptions {
  initialConnectionId?: string;
  initialDbName?: string;
}

export interface SessionWorkbenchScope {
  selectedConnection: SavedConnection | null;
  selectedConnectionId: string;
  setSelectedConnectionIdState: (connectionId: string) => void;
  /** Database the next server request connects with, resolved per connection. */
  databaseName: string;
  setDatabaseName: (databaseName: string) => void;
  /**
   * Select a database and load it. Marking the change as auto-refreshing keeps
   * the revision bump and the request in one step; bumping the revision and
   * then requesting manually invalidates the request twice, so its response is
   * always discarded.
   */
  selectDatabase: (databaseName: string) => void;
  /**
   * Monotonic value for any connection/database scope mutation. Consumers use
   * it to reject responses that belong to an older workbench context.
   */
  scopeRevision: number;
  /** Scope mutations that should load the newly selected scope automatically. */
  autoRefreshRevision: number;
  /** Invalidate the current scope without changing its displayed values. */
  invalidateScope: () => void;
}

const normalized = (value: unknown): string => String(value ?? '').trim();

const connectionDatabase = (
  connections: SavedConnection[],
  connectionId: string,
): string => normalized(
  connections.find((connection) => connection.id === connectionId)?.config.database,
);

const resolveScopeDatabase = (
  connections: SavedConnection[],
  connectionId: string,
  preferred: string,
): string => normalized(preferred) || connectionDatabase(connections, connectionId);

export const useSessionWorkbenchScope = (
  options: SessionWorkbenchScopeOptions,
  connections: SavedConnection[],
): SessionWorkbenchScope => {
  const requestedConnectionId = normalized(options.initialConnectionId);
  const requestedDatabaseName = normalized(options.initialDbName);
  const requestedConnectionAvailable = connections.some(
    (connection) => connection.id === requestedConnectionId,
  );
  const initialSelectedConnectionId = requestedConnectionId && requestedConnectionAvailable
    ? requestedConnectionId
    : connections[0]?.id || '';
  const initialResolvedDatabaseName = resolveScopeDatabase(
    connections,
    initialSelectedConnectionId,
    requestedDatabaseName,
  );
  const [selectedConnectionId, setSelectedConnectionIdState] = useState(
    initialSelectedConnectionId,
  );
  const [dbName, setDbName] = useState(initialResolvedDatabaseName);
  const [databaseName, setDatabaseName] = useState(initialResolvedDatabaseName);
  const [scopeRevision, setScopeRevision] = useState(0);
  const [autoRefreshRevision, setAutoRefreshRevision] = useState(0);
  const initialTabRef = useRef({
    connectionId: requestedConnectionId,
    dbName: initialResolvedDatabaseName,
  });
  const initialConnectionPendingRef = useRef(
    Boolean(requestedConnectionId) && !requestedConnectionAvailable,
  );

  const markScopeChanged = useCallback((autoRefresh: boolean) => {
    setScopeRevision((current) => current + 1);
    if (autoRefresh) setAutoRefreshRevision((current) => current + 1);
  }, []);

  const setTrackedDbName = useCallback((value: string) => {
    const next = normalized(value);
    if (dbName === next) return;
    setDbName(next);
    markScopeChanged(false);
  }, [dbName, markScopeChanged]);

  const setTrackedDatabaseName = useCallback((value: string) => {
    const next = normalized(value);
    if (databaseName === next) return;
    setDatabaseName(next);
    markScopeChanged(false);
  }, [databaseName, markScopeChanged]);

  // Selecting a database both changes the scope and asks for a reload. Doing
  // that through the auto-refresh channel keeps it a single revision bump, so
  // the request that follows is still considered current when it returns.
  const selectTrackedDatabaseName = useCallback((value: string) => {
    const next = normalized(value);
    if (databaseName === next) return;
    setDatabaseName(next);
    markScopeChanged(true);
  }, [databaseName, markScopeChanged]);

  const invalidateScope = useCallback(() => {
    markScopeChanged(false);
  }, [markScopeChanged]);

  useEffect(() => {
    const previous = initialTabRef.current;
    const connectionChanged = previous.connectionId !== requestedConnectionId;
    const nextDbName = resolveScopeDatabase(
      connections,
      requestedConnectionId || selectedConnectionId,
      requestedDatabaseName,
    );
    const dbChanged = previous.dbName !== nextDbName;
    initialTabRef.current = {
      connectionId: requestedConnectionId,
      dbName: nextDbName,
    };
    if (connectionChanged) {
      initialConnectionPendingRef.current = Boolean(requestedConnectionId)
        && !connections.some((connection) => connection.id === requestedConnectionId);
    }

    let scopeChanged = false;
    if (
      (connectionChanged || !selectedConnectionId)
      && requestedConnectionId
      && connections.some((connection) => connection.id === requestedConnectionId)
      && selectedConnectionId !== requestedConnectionId
    ) {
      setSelectedConnectionIdState(requestedConnectionId);
      initialConnectionPendingRef.current = false;
      scopeChanged = true;
    }
    if (dbChanged) {
      if (dbName !== nextDbName) {
        setDbName(nextDbName);
        scopeChanged = true;
      }
      if (databaseName !== nextDbName) {
        setDatabaseName(nextDbName);
        scopeChanged = true;
      }
    }
    if (scopeChanged) markScopeChanged(true);
  }, [
    connections,
    databaseName,
    dbName,
    markScopeChanged,
    requestedConnectionId,
    requestedDatabaseName,
    selectedConnectionId,
  ]);

  const selectedConnection = useMemo(
    () => connections.find((connection) => connection.id === selectedConnectionId) || null,
    [connections, selectedConnectionId],
  );

  useEffect(() => {
    const requestedConnectionIsAvailable = initialConnectionPendingRef.current
      && requestedConnectionId
      && connections.some((connection) => connection.id === requestedConnectionId);
    if (requestedConnectionIsAvailable && selectedConnectionId !== requestedConnectionId) {
      setSelectedConnectionIdState(requestedConnectionId);
      setDbName(resolveScopeDatabase(connections, requestedConnectionId, requestedDatabaseName));
      setDatabaseName(resolveScopeDatabase(connections, requestedConnectionId, requestedDatabaseName));
      initialConnectionPendingRef.current = false;
      markScopeChanged(true);
      return;
    }
    if (selectedConnectionId && selectedConnection) return;

    const fallback = connections[0]?.id || '';
    if (fallback !== selectedConnectionId) {
      const fallbackDatabaseName = connectionDatabase(connections, fallback);
      setSelectedConnectionIdState(fallback);
      setDbName(fallbackDatabaseName);
      setDatabaseName(fallbackDatabaseName);
      markScopeChanged(true);
    }
  }, [
    connections,
    initialConnectionPendingRef,
    markScopeChanged,
    requestedConnectionId,
    requestedDatabaseName,
    selectedConnection,
    selectedConnectionId,
  ]);

  const setSelectedConnectionId = useCallback(
    (connectionId: string) => {
      const next = normalized(connectionId);
      if (selectedConnectionId === next) return;
      initialConnectionPendingRef.current = false;
      setSelectedConnectionIdState(next);
      markScopeChanged(true);
    },
    [markScopeChanged, selectedConnectionId],
  );

  return {
    selectedConnection,
    selectedConnectionId,
    setSelectedConnectionIdState: setSelectedConnectionId,
    databaseName,
    setDatabaseName: setTrackedDatabaseName,
    selectDatabase: selectTrackedDatabaseName,
    scopeRevision,
    autoRefreshRevision,
    invalidateScope,
  };
};
