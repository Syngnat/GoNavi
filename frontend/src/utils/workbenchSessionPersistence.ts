import { useStore } from '../store';
import {
  WORKBENCH_SESSION_STORAGE_KEY,
  buildWorkbenchSessionSnapshot,
  parseWorkbenchSessionSnapshot,
  planWorkbenchSessionRestore,
} from './workbenchSessionSnapshot';

const defaultStorage = (): Storage | null => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    // Storage can be blocked outright; GoNavi still works, it just forgets.
    return null;
  }
};

/** How long the AI panel waits to learn whether its conversation still exists. */
export const AI_SESSION_LOOKUP_TIMEOUT_MS = 3_000;

export interface RestoreOptions {
  storage?: Storage | null;
  /** Whether the agent still holds this conversation (it exists and is not archived). */
  isLiveAISession?: (sessionId: string) => Promise<boolean>;
}

const lookUpAISession = async (
  isLive: RestoreOptions['isLiveAISession'],
  sessionId: string,
): Promise<boolean> => {
  if (!isLive) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      isLive(sessionId),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), AI_SESSION_LOOKUP_TIMEOUT_MS); }),
    ]);
  } catch {
    // The agent is not reachable yet: the panel opens on a fresh conversation, the old one is in its history.
    return false;
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Puts back the tabs, the AI panel and its conversation the last run ended with. It runs
 * once the saved connections are loaded, because a tab opens by reading its connection: any
 * earlier and a restored table would find nothing to connect with. Running it again changes
 * nothing. It never rejects.
 *
 * The tabs are back by the time the first await is reached; the panel follows once the
 * conversation it was on is known to exist, so it opens on that conversation and not on a
 * fresh one it would create first.
 *
 * The tab that was in front is brought forward whatever is in front now. The app opens a tab
 * of its own at start (the settings center, for one), and the sidebar is covered until the
 * connections are loaded, which is when this runs, so there is no move of the person's to keep.
 */
export const restoreWorkbenchSession = async (
  { storage = defaultStorage(), isLiveAISession }: RestoreOptions = {},
): Promise<void> => {
  const snapshot = parseWorkbenchSessionSnapshot(storage?.getItem(WORKBENCH_SESSION_STORAGE_KEY) ?? null);
  if (!snapshot) return;

  const state = useStore.getState();
  const plan = planWorkbenchSessionRestore(snapshot, state, new Set(state.connections.map((connection) => connection.id)));
  const unchanged = plan.tabs.length === state.tabs.length && plan.tabs.every((tab, index) => tab === state.tabs[index]);
  if (!unchanged) useStore.setState({ tabs: plan.tabs });
  if (plan.activeTabId && plan.activeTabId !== state.activeTabId) {
    useStore.getState().setActiveTab(plan.activeTabId);
  }

  if (!plan.openAIPanel && !snapshot.aiSessionId) return;
  const conversationLives = snapshot.aiSessionId ? await lookUpAISession(isLiveAISession, snapshot.aiSessionId) : false;
  const latest = useStore.getState();
  // The conversation is only taken back if the person has not started another in the meantime.
  const resumeConversation = conversationLives && latest.aiActiveSessionId === null;
  const openPanel = plan.openAIPanel && !latest.aiPanelVisible;
  if (!resumeConversation && !openPanel) return;
  // One update, so the panel mounts already on its conversation.
  useStore.setState({
    ...(resumeConversation ? { aiActiveSessionId: snapshot.aiSessionId } : {}),
    ...(openPanel ? { aiPanelVisible: true, detachedAIChatWindow: null } : {}),
  });
};

/**
 * Keeps the snapshot current from now on. Only called after the restore: started earlier it
 * would overwrite what there is to restore with the bare tabs of the first moments.
 * Returns the function that stops it.
 */
export const startWorkbenchSessionRecording = (storage: Storage | null = defaultStorage()): (() => void) => {
  if (!storage) return () => undefined;
  let lastWritten: string | null = null;
  const save = (state: ReturnType<typeof useStore.getState>) => {
    const serialized = JSON.stringify(buildWorkbenchSessionSnapshot(state));
    if (serialized === lastWritten) return;
    try {
      storage.setItem(WORKBENCH_SESSION_STORAGE_KEY, serialized);
      lastWritten = serialized;
    } catch {
      // Out of room or blocked: remembering the tabs is best effort and must not get in the way.
    }
  };
  save(useStore.getState());
  return useStore.subscribe((state, previous) => {
    // Typing in an SQL editor replaces `tabs` on every key; the snapshot compares the result.
    if (
      state.tabs === previous.tabs
      && state.activeTabId === previous.activeTabId
      && state.aiPanelVisible === previous.aiPanelVisible
      && state.detachedAIChatWindow === previous.detachedAIChatWindow
      && state.aiActiveSessionId === previous.aiActiveSessionId
    ) return;
    save(state);
  });
};
