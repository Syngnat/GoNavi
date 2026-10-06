import { useCallback, useEffect, useRef, useState } from 'react';
import type { SavedConnection } from '../../types';
import { normalizeLockWaitPayload, type LockWaitPayload } from './lockWaitModel';
import { listDatabaseLockWaits } from './sessionWorkbenchRpc';

export const LOCK_WAIT_AUTO_REFRESH_MS = 5_000;

export interface UseLockWaitsOptions {
  connection: SavedConnection | null;
  databaseName: string;
  /** The lock view is showing; it loads when it opens and on scope changes. */
  enabled: boolean;
  /** The workbench tab is the active tab; auto-refresh pauses otherwise. */
  active: boolean;
}

export interface LockWaitsState {
  payload: LockWaitPayload | null;
  loading: boolean;
  error: string;
  autoRefresh: boolean;
  setAutoRefresh: (autoRefresh: boolean) => void;
  refresh: () => Promise<boolean>;
}

export const useLockWaits = ({
  connection,
  databaseName,
  enabled,
  active,
}: UseLockWaitsOptions): LockWaitsState => {
  const [payload, setPayload] = useState<LockWaitPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [autoRefresh, setAutoRefresh] = useState(false);

  const scopeKey = `${connection?.id ?? ''}\u0000${databaseName}`;
  // Refs keep the response guard synchronous with the latest selection: a
  // promise can settle before React commits the render that changed it.
  const connectionRef = useRef(connection);
  const databaseNameRef = useRef(databaseName);
  const scopeKeyRef = useRef(scopeKey);
  const requestRef = useRef(0);
  const inFlightRef = useRef(false);
  connectionRef.current = connection;
  databaseNameRef.current = databaseName;
  scopeKeyRef.current = scopeKey;

  const refresh = useCallback(async (): Promise<boolean> => {
    const current = connectionRef.current;
    const requestId = ++requestRef.current;
    const requestScope = scopeKeyRef.current;
    const isCurrent = () => requestRef.current === requestId && scopeKeyRef.current === requestScope;
    if (!current) {
      setPayload(null);
      setLoading(false);
      return false;
    }
    inFlightRef.current = true;
    setLoading(true);
    setError('');
    try {
      const result = await listDatabaseLockWaits(current.config, databaseNameRef.current);
      if (!isCurrent()) return false;
      if (result.success !== true) {
        setPayload(null);
        setError(String(result.message ?? '').trim() || 'list_failed');
        return false;
      }
      setPayload(normalizeLockWaitPayload(result.data));
      return true;
    } catch (cause) {
      if (!isCurrent()) return false;
      setPayload(null);
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      if (requestRef.current === requestId) {
        inFlightRef.current = false;
        setLoading(false);
      }
    }
  }, []);

  // A new connection or database makes the rows on screen meaningless; drop
  // them (and any response still in flight) even while the view is hidden.
  useEffect(() => {
    requestRef.current += 1;
    inFlightRef.current = false;
    setPayload(null);
    setError('');
    setLoading(false);
  }, [scopeKey]);

  useEffect(() => {
    if (enabled) void refresh();
  }, [enabled, scopeKey, refresh]);

  useEffect(() => {
    if (!enabled || !active || !autoRefresh) return undefined;
    const timer = setInterval(() => {
      // Never stack polls behind a slow server.
      if (!inFlightRef.current) void refresh();
    }, LOCK_WAIT_AUTO_REFRESH_MS);
    return () => clearInterval(timer);
  }, [active, autoRefresh, enabled, refresh]);

  return { payload, loading, error, autoRefresh, setAutoRefresh, refresh };
};
