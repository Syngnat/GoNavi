import { useCallback, useEffect, useRef, useState } from 'react';

import { getAIRunHarnessService, listAgentSessions } from './aiRunHarnessClient';
import { flattenAIRequestEvents, type AIRequestEventRecord } from './aiObservability';

const OBSERVABILITY_SESSION_PAGE_SIZE = 100;

export interface AIObservabilityRunsState {
  records: AIRequestEventRecord[];
  sessionTotal: number;
  loadedSessionCount: number;
  loading: boolean;
  loadingMore: boolean;
  error: string;
  hasMore: boolean;
  refresh: () => Promise<void>;
  loadMore: () => Promise<void>;
}

export const useAIObservabilityRuns = (active: boolean): AIObservabilityRunsState => {
  const [records, setRecords] = useState<AIRequestEventRecord[]>([]);
  const [sessionTotal, setSessionTotal] = useState(0);
  const [loadedSessionCount, setLoadedSessionCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const requestSequenceRef = useRef(0);

  const refresh = useCallback(async () => {
    const requestSequence = ++requestSequenceRef.current;
    setLoadingMore(false);
    const service = getAIRunHarnessService();
    if (typeof service?.AIListAgentSessions !== 'function') {
      setRecords([]);
      setSessionTotal(0);
      setLoadedSessionCount(0);
      setError('service_unavailable');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const result = await listAgentSessions({ limit: OBSERVABILITY_SESSION_PAGE_SIZE, offset: 0 }, service);
      if (requestSequence !== requestSequenceRef.current) return;
      const sessions = Array.isArray(result.sessions) ? result.sessions : [];
      setRecords(flattenAIRequestEvents(result));
      const reportedTotal = Number(result.total);
      setSessionTotal(Math.max(sessions.length, Number.isFinite(reportedTotal) && reportedTotal >= 0 ? reportedTotal : 0));
      setLoadedSessionCount(sessions.length);
    } catch (loadError) {
      if (requestSequence !== requestSequenceRef.current) return;
      setRecords([]);
      setSessionTotal(0);
      setLoadedSessionCount(0);
      setError(loadError instanceof Error ? loadError.message : String(loadError || 'load_failed'));
    } finally {
      if (requestSequence === requestSequenceRef.current) setLoading(false);
    }
  }, []);

  const loadMore = useCallback(async () => {
    const service = getAIRunHarnessService();
    if (typeof service?.AIListAgentSessions !== 'function' || loading || loadingMore || loadedSessionCount >= sessionTotal) return;
    const requestSequence = requestSequenceRef.current;
    setLoadingMore(true);
    setError('');
    try {
      const result = await listAgentSessions({
        limit: OBSERVABILITY_SESSION_PAGE_SIZE,
        offset: loadedSessionCount,
      }, service);
      if (requestSequence !== requestSequenceRef.current) return;
      const sessions = Array.isArray(result.sessions) ? result.sessions : [];
      const nextRecords = flattenAIRequestEvents(result);
      setRecords((current) => {
        const byId = new Map(current.map((record) => [record.id, record]));
        nextRecords.forEach((record) => byId.set(record.id, record));
        return [...byId.values()].sort((left, right) => right.createdAt - left.createdAt || right.updatedAt - left.updatedAt);
      });
      const reportedTotal = Number(result.total);
      setSessionTotal((current) => Math.max(
        current,
        Number.isFinite(reportedTotal) && reportedTotal >= 0 ? reportedTotal : 0,
        loadedSessionCount + sessions.length,
      ));
      setLoadedSessionCount((current) => current + sessions.length);
    } catch (loadError) {
      if (requestSequence !== requestSequenceRef.current) return;
      setError(loadError instanceof Error ? loadError.message : String(loadError || 'load_failed'));
    } finally {
      if (requestSequence === requestSequenceRef.current) setLoadingMore(false);
    }
  }, [loadedSessionCount, loading, loadingMore, sessionTotal]);

  useEffect(() => {
    if (!active) return;
    void refresh();
    return () => {
      requestSequenceRef.current++;
    };
  }, [active, refresh]);

  return {
    records,
    sessionTotal,
    loadedSessionCount,
    loading,
    loadingMore,
    error,
    hasMore: loadedSessionCount < sessionTotal,
    refresh,
    loadMore,
  };
};
