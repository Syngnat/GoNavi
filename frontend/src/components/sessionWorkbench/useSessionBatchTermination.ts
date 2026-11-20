import { useCallback, useEffect, useRef, useState } from 'react';
import {
  buildSessionActionRequest,
  type DatabaseSession,
  type SessionCapability,
} from './sessionWorkbenchModel';
import type { SessionWorkbenchState } from './useSessionWorkbench';

type Translate = (
  key: string,
  params?: Record<string, string | number | boolean | null | undefined>,
) => string;

interface MessageApi {
  warning: (content: string) => void;
  error: (content: string) => void;
  success: (content: string) => void;
}

export interface SessionBatchTerminationTarget {
  sessions: DatabaseSession[];
  skippedCount: number;
  totalVisible: number;
}

export interface SessionBatchTerminationState {
  target: SessionBatchTerminationTarget | null;
  loading: boolean;
  open: (target: SessionBatchTerminationTarget) => void;
  close: () => void;
  confirm: () => Promise<void>;
}

export const useSessionBatchTermination = ({
  capability,
  workbench,
  contextKey,
  t,
  messageApi,
}: {
  capability: SessionCapability;
  workbench: Pick<SessionWorkbenchState, 'executeActionBatch'>;
  contextKey: string;
  t: Translate;
  messageApi: MessageApi;
}): SessionBatchTerminationState => {
  const [target, setTarget] = useState<SessionBatchTerminationTarget | null>(null);
  const [loading, setLoading] = useState(false);
  const targetRef = useRef<SessionBatchTerminationTarget | null>(null);
  const loadingRef = useRef(false);
  const contextKeyRef = useRef(contextKey);
  contextKeyRef.current = contextKey;

  targetRef.current = target;

  useEffect(() => {
    if (loadingRef.current) return;
    setTarget(null);
  }, [contextKey]);

  const close = useCallback(() => {
    if (loadingRef.current) return;
    setTarget(null);
  }, []);

  const open = useCallback((next: SessionBatchTerminationTarget) => {
    if (loadingRef.current) return;
    setTarget(next);
  }, []);

  const confirm = useCallback(async () => {
    const snapshot = targetRef.current;
    if (!snapshot || loadingRef.current) return;
    const requests = snapshot.sessions
      .map((session) => buildSessionActionRequest(capability, 'terminateSession', session))
      .filter((request): request is NonNullable<typeof request> => Boolean(request));
    if (requests.length === 0) {
      messageApi.warning(t('session_workbench.batch.no_targets'));
      return;
    }

    loadingRef.current = true;
    setLoading(true);
    const requestContextKey = contextKeyRef.current;
    try {
      const result = await workbench.executeActionBatch(requests);
      if (result.stale || contextKeyRef.current !== requestContextKey) {
        messageApi.warning(t('session_workbench.batch.stale'));
        setTarget(null);
        return;
      }
      if (result.succeeded === result.total) {
        messageApi.success(t('session_workbench.batch.success', {
          count: result.succeeded,
        }));
        setTarget(null);
        return;
      }
      if (result.succeeded > 0) {
        messageApi.warning(t('session_workbench.batch.partial', {
          success: result.succeeded,
          failed: result.failed,
        }));
        setTarget(null);
        return;
      }
      if (result.failureMessage) {
        messageApi.error(t('session_workbench.batch.failed', {
          detail: result.failureMessage,
        }));
        return;
      }
      const firstFailure = result.results.find((entry) => !entry.success)?.message;
      messageApi.error(t('session_workbench.batch.failed', {
        detail: firstFailure || '',
      }));
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, [capability, messageApi, t, workbench]);

  return {
    target,
    loading,
    open,
    close,
    confirm,
  };
};
