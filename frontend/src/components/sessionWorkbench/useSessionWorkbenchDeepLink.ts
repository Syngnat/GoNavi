import { useEffect, useRef, useState } from 'react';
import type { TabData } from '../../types';
import type { SessionWorkbenchState } from './useSessionWorkbench';

export type SessionWorkbenchView = 'sessions' | 'lockWaits' | 'alertHistory';

type DeepLinkTab = Pick<TabData, 'connectionId' | 'sessionWorkbenchView' | 'sessionWorkbenchFilter' | 'sessionWorkbenchRequestKey'>;

interface PendingFilter {
  connectionId: string;
  filter: string;
  /** The session list on screen when the link arrived; the filter waits for a newer one. */
  staleSessions: unknown;
}

/**
 * Apply a deep link (e.g. "查看" on an alert): switch the view, then filter the
 * session list to the session in question. The list on screen may predate the
 * session, so it is reloaded; switching connection clears the filter while the
 * new list loads, so there the filter waits for that list.
 */
export const useSessionWorkbenchDeepLink = ({
  tab,
  workbench,
  setView,
}: {
  tab: DeepLinkTab;
  workbench: Pick<
    SessionWorkbenchState,
    | 'selectedConnectionId' | 'setSelectedConnectionId' | 'payload' | 'loading'
    | 'setFilter' | 'setRunningOnly' | 'refresh'
  >;
  setView: (view: SessionWorkbenchView) => void;
}): void => {
  const appliedKeyRef = useRef<string | undefined>(undefined);
  const [pending, setPending] = useState<PendingFilter | null>(null);
  const requestKey = tab.sessionWorkbenchRequestKey;
  const latest = useRef({ tab, workbench });
  latest.current = { tab, workbench };

  useEffect(() => {
    if (!requestKey || appliedKeyRef.current === requestKey) return;
    appliedKeyRef.current = requestKey;
    const { tab: current, workbench: state } = latest.current;
    if (current.sessionWorkbenchView) setView(current.sessionWorkbenchView);
    const filter = String(current.sessionWorkbenchFilter ?? '').trim();
    if (!filter) return;
    const connectionId = String(current.connectionId ?? '').trim();
    const settled = state.selectedConnectionId === connectionId && !state.loading && state.payload;
    if (settled) {
      state.setRunningOnly(false);
      state.setFilter(filter);
      void state.refresh();
      return;
    }
    setPending({ connectionId, filter, staleSessions: state.payload });
  }, [requestKey, setView]);

  const {
    selectedConnectionId, setSelectedConnectionId, payload, loading, setFilter, setRunningOnly,
  } = workbench;
  useEffect(() => {
    if (!pending || loading) return;
    if (selectedConnectionId !== pending.connectionId) {
      // A tab already on this connection does not switch back by itself when
      // the picker was moved to another one.
      setSelectedConnectionId(pending.connectionId);
      return;
    }
    if (!payload || payload === pending.staleSessions) return;
    setPending(null);
    setRunningOnly(false);
    setFilter(pending.filter);
  }, [loading, payload, pending, selectedConnectionId, setFilter, setRunningOnly, setSelectedConnectionId]);
};
