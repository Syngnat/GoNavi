import React from 'react';

import { getAIRunHarnessService, listAgentSessions } from '../components/ai/aiRunHarnessClient';
import { restoreWorkbenchSession, startWorkbenchSessionRecording } from '../utils/workbenchSessionPersistence';

/** The listing the AI panel itself shows: a conversation in it is one the panel can open. */
const AI_SESSION_LOOKUP_LIMIT = 500;

const isLiveAISession = async (sessionId: string): Promise<boolean> => {
  const service = getAIRunHarnessService();
  if (!service?.AIListAgentSessions) return false;
  const result = await listAgentSessions({ limit: AI_SESSION_LOOKUP_LIMIT }, service);
  return (Array.isArray(result.sessions) ? result.sessions : []).some((session) => (
    String(session.sessionId || session.id || '').trim() === sessionId && !session.archived
  ));
};

/**
 * Brings back the tabs, the AI panel and its conversation from the last run once the app
 * is ready (the store is loaded and so are the saved connections), then keeps remembering
 * them. Remembering starts only after the restore: started earlier it would overwrite what
 * there is to restore with the bare state of the first moments.
 */
export const useWorkbenchSessionRestore = (ready: boolean): void => {
  React.useEffect(() => {
    if (!ready) return undefined;
    let stopRecording: (() => void) | undefined;
    let cancelled = false;
    void restoreWorkbenchSession({ isLiveAISession }).finally(() => {
      if (!cancelled) stopRecording = startWorkbenchSessionRecording();
    });
    return () => {
      cancelled = true;
      stopRecording?.();
    };
  }, [ready]);
};
