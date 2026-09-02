import { useEffect, useMemo, useRef } from 'react';

import { useStore } from '../../store';
import type { AIChatMessage } from '../../types';
import {
  getAIRunHarnessService,
  listAgentSessions,
  mergeAIChatSessionMessages,
  readAgentSession,
  toAIChatMessages,
} from './aiRunHarnessClient';

interface UseAIChatSessionStateOptions {
  aiActiveSessionId: string | null;
  aiPanelVisible: boolean;
  createNewAISession: () => void;
}

const EMPTY_AI_CHAT_MESSAGES: AIChatMessage[] = [];

// Session projections are intentionally refreshed with a timer chain rather
// than setInterval: a slow Wails call must never overlap the next read, and a
// temporarily unavailable Ledger gets a bounded exponential retry delay.
export const AI_SESSION_REFRESH_INTERVAL_MS = 5_000;
export const AI_SESSION_REFRESH_RETRY_BASE_MS = 1_000;
export const AI_SESSION_REFRESH_RETRY_MAX_MS = 30_000;

export const useAIChatSessionState = ({
  aiActiveSessionId,
  aiPanelVisible,
  createNewAISession,
}: UseAIChatSessionStateOptions) => {
  const aiChatSessions = useStore((state) => state.aiChatSessions);
  const sid = aiActiveSessionId || 'session-fallback';
  const messages = useStore((state) => state.aiChatHistory[sid] || EMPTY_AI_CHAT_MESSAGES);

  useEffect(() => {
    if (!aiActiveSessionId) {
      createNewAISession();
    }
  }, [aiActiveSessionId, createNewAISession]);

  const sessionsLoadedRef = useRef(false);
  const sessionsRetryAttemptRef = useRef(0);
  const sessionsRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!aiPanelVisible) {
      if (sessionsRefreshTimerRef.current !== null) {
        clearTimeout(sessionsRefreshTimerRef.current);
        sessionsRefreshTimerRef.current = null;
      }
      sessionsLoadedRef.current = false;
      sessionsRetryAttemptRef.current = 0;
      return undefined;
    }

    let disposed = false;
    const clearRefreshTimer = () => {
      if (sessionsRefreshTimerRef.current !== null) {
        clearTimeout(sessionsRefreshTimerRef.current);
        sessionsRefreshTimerRef.current = null;
      }
    };
    const scheduleRefresh = (delay: number) => {
      if (disposed) return;
      clearRefreshTimer();
      sessionsRefreshTimerRef.current = setTimeout(() => {
        sessionsRefreshTimerRef.current = null;
        void refreshSessions();
      }, Math.max(0, delay));
    };
    const refreshSessions = async (): Promise<void> => {
      if (disposed) return;
      const service = getAIRunHarnessService();
      if (!service?.AIListAgentSessions) {
        sessionsLoadedRef.current = false;
        const attempt = sessionsRetryAttemptRef.current;
        sessionsRetryAttemptRef.current = attempt + 1;
        const delay = Math.min(
          AI_SESSION_REFRESH_RETRY_MAX_MS,
          AI_SESSION_REFRESH_RETRY_BASE_MS * (2 ** Math.min(attempt, 10)),
        );
        scheduleRefresh(delay);
        return;
      }

      sessionsLoadedRef.current = false;
      try {
        const result = await listAgentSessions({ limit: 500 }, service);
        if (disposed) return;
        const sessions = (Array.isArray(result.sessions) ? result.sessions : []).map((session) => {
          const rawUpdatedAt = session.updatedAt;
          const parsedUpdatedAt = typeof rawUpdatedAt === 'number'
            ? rawUpdatedAt
            : Date.parse(String(rawUpdatedAt || ''));
          return {
            id: String(session.sessionId || session.id || '').trim(),
            title: String(session.title || '').trim(),
            updatedAt: Number.isFinite(parsedUpdatedAt) ? parsedUpdatedAt : Date.now(),
            revision: Number(session.revision) || undefined,
            generation: Number(session.generation) || undefined,
            archived: Boolean(session.archived),
          };
        }).filter((session) => Boolean(session.id) && !session.archived)
          .map(({ archived: _archived, ...session }) => session);
        useStore.setState({ aiChatSessions: sessions });
        sessionsLoadedRef.current = true;
        sessionsRetryAttemptRef.current = 0;
        scheduleRefresh(AI_SESSION_REFRESH_INTERVAL_MS);
      } catch (error) {
        if (disposed) return;
        sessionsLoadedRef.current = false;
        const attempt = sessionsRetryAttemptRef.current;
        sessionsRetryAttemptRef.current = attempt + 1;
        const delay = Math.min(
          AI_SESSION_REFRESH_RETRY_MAX_MS,
          AI_SESSION_REFRESH_RETRY_BASE_MS * (2 ** Math.min(attempt, 10)),
        );
        console.warn('Failed to list AI agent sessions; retrying', error);
        scheduleRefresh(delay);
      }
    };

    // Opening the panel always refreshes immediately, even when an earlier
    // visibility cycle already loaded a projection.
    void refreshSessions();
    return () => {
      disposed = true;
      clearRefreshTimer();
    };
  }, [aiPanelVisible]);

  useEffect(() => {
    if (!sid || sid === 'session-fallback') return;
    const service = getAIRunHarnessService();
    if (!service?.AIReadAgentSession) return;
    let disposed = false;
    void readAgentSession({ sessionId: sid, limit: 10_000 }, service).then((projection) => {
      if (disposed) return;
      const durable = toAIChatMessages(projection);
      useStore.setState((state) => ({
        aiChatHistory: {
          ...state.aiChatHistory,
          [sid]: mergeAIChatSessionMessages(durable, state.aiChatHistory[sid] || []),
        },
      }));
    }).catch(() => {
      // A local placeholder does not exist in the Ledger until its first input.
    });
    return () => {
      disposed = true;
    };
  }, [sid]);

  const orderedAISessions = useMemo(
    () => [...aiChatSessions].sort((left, right) => right.updatedAt - left.updatedAt),
    [aiChatSessions],
  );

  return {
    sid,
    messages,
    orderedAISessions,
  };
};
