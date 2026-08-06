import { useEffect } from 'react';

import { EventsOn, Show, WindowShow } from '../../wailsjs/runtime';
import { type SqlLog, useStore } from '../store';
import { useCustomThemeStore } from '../customThemeStore';
import type { TabData } from '../types';
import type { DetachedQueryResultWindow } from '../utils/detachedWindow';
import {
  clearNativeDetachedHostEvents,
  closeNativeDetachedWindowById,
  forwardNativeDetachedHostEvent,
  hasNativeDetachedWindowManager,
  hideNativeDetachedWindowById,
  recordNativeDetachedVisibilityRevision,
  shouldApplyNativeDetachedHideRevision,
  syncNativeAIChatHostState,
  syncNativeDetachedShortcutOptions,
  syncNativeDetachedThemeContext,
  getActiveNativeDetachedThemeContext,
} from '../utils/nativeDetachedWindowHost';
import {
  advanceNativeDetachedStoreSource,
  buildNativeDetachedWorkbenchMutableStoreSnapshot,
  mergeNativeDetachedAIContextsDelta,
  mergeNativeDetachedStoreDelta,
  NATIVE_DETACHED_HOST_EVENT_NAMES,
  NATIVE_DETACHED_QUERY_RESULT_REDETACH_EVENT,
  type NativeDetachedHostEvent,
  type NativeDetachedHostEventName,
  type NativeDetachedStoreSnapshot,
  type NativeDetachedWindowKind,
} from '../utils/nativeDetachedWindowClient';
import {
  saveQueryEditorResultSession,
  type QueryEditorResultSessionSnapshot,
} from '../utils/queryEditorResultSessionCache';
import { setQueryTabDraft, subscribeQueryTabDraftChanges } from '../utils/sqlFileTabDrafts';

export const NATIVE_DETACHED_WINDOW_EVENT = 'gonavi:native-detached-event';

export type NativeDetachedWindowEvent = {
  id: string;
  kind: NativeDetachedWindowKind;
  action:
    | 'opened'
    | 'sync'
    | 'attach'
    | 'focus'
    | 'hide'
    | 'close'
    | 'cancel-close'
    | 'open-ai-settings'
    | 'host-event';
  payload?: {
    revision?: number;
    tab?: TabData;
    storeState?: Record<string, unknown>;
    resultSession?: QueryEditorResultSessionSnapshot | null;
    resultWindow?: DetachedQueryResultWindow;
    ownerWindowId?: string;
    hostEvent?: NativeDetachedHostEvent;
    openedTabs?: TabData[];
    workbenchState?: NativeDetachedStoreSnapshot;
    workbenchStateBase?: NativeDetachedStoreSnapshot;
    clearSqlLogs?: boolean;
    bounds?: { x: number; y: number; width: number; height: number };
    [key: string]: unknown;
  };
};

const replaceSyncedTab = (tab: TabData): void => {
  if (tab.type === 'query' && typeof tab.query === 'string') {
    setQueryTabDraft(tab.id, tab.query);
  }
  useStore.setState((state) => {
    if (!state.tabs.some((item) => item.id === tab.id)) return state;
    return {
      tabs: state.tabs.map((item) => item.id === tab.id ? { ...item, ...tab, id: item.id } : item),
    };
  });
};

const mergeSyncedSqlLogs = (snapshot: Record<string, unknown>): void => {
  const incomingLogs = Array.isArray(snapshot.sqlLogs) ? snapshot.sqlLogs : [];
  if (incomingLogs.length > 0) {
    const existingIds = new Set(useStore.getState().sqlLogs.map((log) => log.id));
    const newLogs = incomingLogs.filter((item): item is SqlLog => {
      if (!item || typeof item !== 'object') return false;
      const id = String((item as { id?: unknown }).id || '').trim();
      if (!id || existingIds.has(id)) return false;
      existingIds.add(id);
      return true;
    });
    for (const log of [...newLogs].reverse()) {
      useStore.getState().addSqlLog(log);
    }
  }
};

const mergeSyncedTabRuntimeState = (
  tabId: string,
  snapshot: Record<string, unknown>,
): void => {
  const pendingPatch = snapshot.sqlEditorPendingTransactions;
  if (!pendingPatch || typeof pendingPatch !== 'object') return;
  const value = (pendingPatch as Record<string, unknown>)[tabId];
  useStore.setState((state) => {
    const next = { ...state.sqlEditorPendingTransactions };
    if (value === null || value === undefined) {
      delete next[tabId];
    } else {
      next[tabId] = value as (typeof next)[string];
    }
    return { sqlEditorPendingTransactions: next };
  });
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

type AIContextSourceRef = { current: unknown };
type WorkbenchStateSources = Map<string, NativeDetachedStoreSnapshot>;

const mergeSyncedAIChatState = (
  snapshot: Record<string, unknown>,
  aiContextSourceRef?: AIContextSourceRef,
): void => {
  useStore.setState((state) => ({
    aiChatHistory: Object.prototype.hasOwnProperty.call(snapshot, 'aiChatHistory')
      && isRecord(snapshot.aiChatHistory)
      ? snapshot.aiChatHistory as typeof state.aiChatHistory
      : state.aiChatHistory,
    aiChatSessions: Object.prototype.hasOwnProperty.call(snapshot, 'aiChatSessions')
      && Array.isArray(snapshot.aiChatSessions)
      ? snapshot.aiChatSessions as typeof state.aiChatSessions
      : state.aiChatSessions,
    aiActiveSessionId: Object.prototype.hasOwnProperty.call(snapshot, 'aiActiveSessionId')
      && (snapshot.aiActiveSessionId === null || typeof snapshot.aiActiveSessionId === 'string')
      ? snapshot.aiActiveSessionId
      : state.aiActiveSessionId,
    aiContexts: Object.prototype.hasOwnProperty.call(snapshot, 'aiContexts')
      && isRecord(snapshot.aiContexts)
      ? mergeNativeDetachedAIContextsDelta(
          state.aiContexts,
          aiContextSourceRef?.current ?? state.aiContexts,
          snapshot.aiContexts,
        ) as typeof state.aiContexts
      : state.aiContexts,
  }));
  if (Object.prototype.hasOwnProperty.call(snapshot, 'aiContexts')
    && isRecord(snapshot.aiContexts)
    && aiContextSourceRef) {
    aiContextSourceRef.current = snapshot.aiContexts;
  }
};

const mergeSyncedWorkbenchState = (
  windowId: string,
  snapshot: NativeDetachedStoreSnapshot,
  sourceSnapshot?: NativeDetachedStoreSnapshot,
  workbenchStateSources?: WorkbenchStateSources,
): void => {
  const state = useStore.getState();
  const safeSnapshot = buildNativeDetachedWorkbenchMutableStoreSnapshot(snapshot);
  const sourceTabId = windowId.replace(/^workbench:/, '');
  if (
    Object.prototype.hasOwnProperty.call(safeSnapshot, 'activeContext')
    && (!windowId.startsWith('workbench:') || state.activeTabId !== sourceTabId)
  ) {
    delete safeSnapshot.activeContext;
  }
  if (Object.keys(safeSnapshot).length === 0) return;
  const previousSource = sourceSnapshot
    ?? workbenchStateSources?.get(windowId)
    ?? buildNativeDetachedWorkbenchMutableStoreSnapshot(state);
  useStore.setState(mergeNativeDetachedStoreDelta(
    state as unknown as NativeDetachedStoreSnapshot,
    previousSource,
    safeSnapshot,
  ) as unknown as typeof state, true);
  workbenchStateSources?.set(
    windowId,
    advanceNativeDetachedStoreSource(previousSource, safeSnapshot),
  );
};

const restoreQueryResult = (windowId: string): void => {
  const restored = useStore.getState().attachQueryResultWindow(windowId);
  if (!restored || typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('gonavi:restore-query-result', {
    detail: {
      windowId,
      sourceQueryTabId: restored.sourceQueryTabId,
      result: restored.result,
    },
  }));
};

const showMainWindow = (): void => {
  if (typeof window === 'undefined') return;
  const runtime = (window as any).runtime;
  if (typeof runtime?.Show === 'function') Show();
  if (typeof runtime?.WindowShow === 'function') WindowShow();
};

export const applyNativeDetachedWindowEvent = (
  event: NativeDetachedWindowEvent,
  currentWindowId?: string,
  callbacks: {
    onOpenAISettings?: () => void;
    onHostEvent?: (event: NativeDetachedHostEvent) => void;
    aiContextSourceRef?: AIContextSourceRef;
    workbenchStateSources?: WorkbenchStateSources;
  } = {},
): void => {
  const id = String(event?.id || '').trim();
  if (
    !id
    || (event.kind !== 'workbench' && event.kind !== 'query-result' && event.kind !== 'ai-chat')
  ) return;

  const localWindowId = String(currentWindowId || '').trim();
  const ownerWindowId = String(event.payload?.ownerWindowId || '').trim();
  if (localWindowId) {
    // The parent broadcasts lifecycle events to every child. Applying a child's
    // own sync back into its store would schedule another sync indefinitely.
    if (id === localWindowId) return;
    if (event.kind === 'query-result') {
      // Result lifecycle belongs to its source SQL window. The result window
      // process itself receives the same broadcast but must not mutate a copy.
      if (ownerWindowId !== localWindowId) return;
    } else if (id !== localWindowId && ownerWindowId !== localWindowId) {
      return;
    }
  }

  if (event.action === 'opened') {
    const resultWindow = event.payload?.resultWindow;
    if (
      event.kind === 'query-result'
      && resultWindow
      && typeof resultWindow === 'object'
      && String(resultWindow.id || '').trim() === id
    ) {
      useStore.getState().detachQueryResultWindow(resultWindow);
      callbacks.workbenchStateSources?.set(
        id,
        buildNativeDetachedWorkbenchMutableStoreSnapshot(useStore.getState()),
      );
    }
    return;
  }

  if (event.action === 'open-ai-settings') {
    if (event.kind === 'ai-chat') {
      const visibilityRevision = Math.trunc(Number(event.payload?.visibilityRevision));
      const latestVisibilityRevision = recordNativeDetachedVisibilityRevision(
        id,
        visibilityRevision,
      );
      if (
        Number.isFinite(visibilityRevision)
        && visibilityRevision > 0
        && visibilityRevision < latestVisibilityRevision
      ) return;
      const state = useStore.getState();
      if (state.detachedAIChatWindow) {
        state.setAIPanelVisible(false);
      }
      showMainWindow();
      callbacks.onOpenAISettings?.();
    }
    return;
  }

  if (event.action === 'focus') {
    if (event.kind === 'ai-chat') {
      const visibilityRevision = Math.trunc(Number(event.payload?.visibilityRevision));
      const latestVisibilityRevision = recordNativeDetachedVisibilityRevision(
        id,
        visibilityRevision,
      );
      if (
        Number.isFinite(visibilityRevision)
        && visibilityRevision > 0
        && visibilityRevision < latestVisibilityRevision
      ) return;
      if (!useStore.getState().aiPanelVisible) {
        useStore.setState({ aiPanelVisible: true });
      }
    }
    return;
  }

  if (event.action === 'host-event') {
    const hostEvent = event.payload?.hostEvent;
    if (
      hostEvent
      && typeof hostEvent === 'object'
      && String(hostEvent.id || '').trim()
      && NATIVE_DETACHED_HOST_EVENT_NAMES.includes(hostEvent.name as NativeDetachedHostEventName)
    ) {
      if (hostEvent.name === 'gonavi:shortcut:toggle-ai-panel' && !localWindowId) {
        const wasVisible = useStore.getState().aiPanelVisible;
        useStore.getState().toggleAIPanel();
        const next = useStore.getState();
        if (!wasVisible && next.aiPanelVisible && !next.detachedAIChatWindow) {
          showMainWindow();
        }
      } else if (hostEvent.name !== 'gonavi:shortcut:toggle-ai-panel') {
        callbacks.onHostEvent?.(hostEvent);
      }
    }
    return;
  }

  const bounds = event.payload?.bounds;
  if (
    bounds
    && [bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)
    && bounds.width > 0
    && bounds.height > 0
  ) {
    if (event.kind === 'ai-chat') {
      useStore.getState().updateDetachedAIChatBounds({
        ...bounds,
        coordinateSpace: 'screen',
      });
    } else if (event.kind === 'workbench') {
      useStore.getState().updateDetachedWorkbenchBounds(
        event.payload?.tab?.id || id.replace(/^workbench:/, ''),
        bounds,
      );
    } else {
      useStore.getState().updateDetachedQueryResultBounds(id, bounds);
    }
  }

  const tab = event.payload?.tab;
  const eventTabId = tab?.id || id.replace(/^workbench:/, '');
  if (
    event.kind === 'query-result'
    && event.payload?.resultWindow
    && event.payload.resultWindow.id === id
  ) {
    useStore.getState().detachQueryResultWindow(event.payload.resultWindow);
  }
  if (event.payload?.clearSqlLogs === true) {
    useStore.getState().clearSqlLogs();
  }
  if (event.payload?.storeState) {
    mergeSyncedSqlLogs(event.payload.storeState);
    if (event.kind === 'workbench') {
      mergeSyncedTabRuntimeState(eventTabId, event.payload.storeState);
    } else if (event.kind === 'ai-chat') {
      mergeSyncedAIChatState(event.payload.storeState, callbacks.aiContextSourceRef);
    }
  }
  if (event.kind === 'workbench' && tab) {
    replaceSyncedTab(tab);
    if (tab.type === 'query' && event.payload?.resultSession) {
      saveQueryEditorResultSession(tab.id, event.payload.resultSession);
    }
  }
  if (
    (event.kind === 'workbench' || event.kind === 'query-result')
    && event.payload?.workbenchState
  ) {
    mergeSyncedWorkbenchState(
      id,
      event.payload.workbenchState,
      event.payload.workbenchStateBase,
      callbacks.workbenchStateSources,
    );
  }
  if (event.kind === 'workbench' && Array.isArray(event.payload?.openedTabs)) {
    for (const openedTab of event.payload.openedTabs) {
      if (!openedTab || typeof openedTab !== 'object' || !String(openedTab.id || '').trim()) continue;
      if (openedTab.type === 'query' && typeof openedTab.query === 'string') {
        setQueryTabDraft(openedTab.id, openedTab.query);
      }
      if (!useStore.getState().tabs.some((item) => item.id === openedTab.id)) {
        useStore.getState().addTab(openedTab);
      }
    }
    if (event.payload.openedTabs.length > 0) showMainWindow();
  }

  if (event.action === 'cancel-close') {
    if (event.kind === 'ai-chat') {
      if (!useStore.getState().detachedAIChatWindow) {
        useStore.getState().detachAIChatPanel();
      }
    } else if (event.kind === 'workbench') {
      const tabId = tab?.id || id.replace(/^workbench:/, '');
      if (tab && tab.id === tabId && !useStore.getState().tabs.some((item) => item.id === tabId)) {
        useStore.setState((state) => ({ tabs: [...state.tabs, tab] }));
      }
      const latest = useStore.getState();
      if (latest.tabs.some((item) => item.id === tabId) && !latest.isWorkbenchTabDetached(tabId)) {
        latest.detachWorkbenchTab(tabId);
      }
    } else if (
      event.payload?.rollbackAction === 'attach'
      && event.payload.resultWindow
      && typeof window !== 'undefined'
    ) {
      const resultWindow = event.payload.resultWindow;
      const windowId = String(resultWindow.id || '').trim();
      const sourceQueryTabId = String(resultWindow.sourceQueryTabId || '').trim();
      const resultKey = String(resultWindow.result?.key || '').trim();
      if (windowId === id && sourceQueryTabId && resultKey) {
        window.dispatchEvent(new CustomEvent(NATIVE_DETACHED_QUERY_RESULT_REDETACH_EVENT, {
          detail: { windowId, sourceQueryTabId, resultKey },
        }));
      }
    }
    return;
  }

  if (event.action === 'sync') return;
  if (event.action === 'hide') {
    if (event.kind === 'ai-chat') {
      if (!shouldApplyNativeDetachedHideRevision(id, event.payload?.visibilityRevision)) return;
      useStore.getState().setAIPanelVisible(false);
    }
    return;
  }
  if (event.action === 'close') {
    clearNativeDetachedHostEvents(id);
    callbacks.workbenchStateSources?.delete(id);
  }
  if (event.action === 'attach') {
    callbacks.workbenchStateSources?.delete(id);
    if (event.kind === 'workbench') {
      const tabId = tab?.id || id.replace(/^workbench:/, '');
      useStore.getState().attachWorkbenchTab(tabId);
    } else if (event.kind === 'ai-chat') {
      useStore.getState().attachAIChatPanel();
    } else {
      restoreQueryResult(id);
    }
    showMainWindow();
    clearNativeDetachedHostEvents(id);
    return;
  }

  if (event.kind === 'ai-chat') {
    const reason = String(event.payload?.reason || '').trim();
    const stillDetached = Boolean(useStore.getState().detachedAIChatWindow);
    if (reason === 'attached' || reason === 'parent-shutdown' || reason === 'requested') {
      return;
    }
    if (event.payload?.exited === true) {
      if (stillDetached) {
        if (useStore.getState().aiPanelVisible) {
          useStore.getState().attachAIChatPanel();
          showMainWindow();
        } else {
          useStore.setState({ detachedAIChatWindow: null });
        }
      }
      return;
    }
    if (!stillDetached) return;
    useStore.getState().setAIPanelVisible(false);
    if (event.action === 'close') {
      // A real close discards the parked-process identity; only `hide` keeps it
      // for the next warm reopen.
      useStore.setState({ detachedAIChatWindow: null });
    }
  } else if (event.kind === 'workbench') {
    const tabId = tab?.id || id.replace(/^workbench:/, '');
    const reason = String(event.payload?.reason || '').trim();
    const stillDetached = useStore.getState().detachedWorkbenchWindows.some(
      (item) => item.tabId === tabId,
    );
    if (reason === 'attached' || reason === 'parent-shutdown' || reason === 'requested') {
      return;
    }
    if (event.payload?.exited === true) {
      if (stillDetached) {
        useStore.getState().attachWorkbenchTab(tabId);
        showMainWindow();
      }
      return;
    }
    if (!stillDetached) return;
    if (useStore.getState().tabs.some((item) => item.id === tabId)) {
      useStore.getState().closeTab(tabId);
    }
  } else {
    const reason = String(event.payload?.reason || '').trim();
    const stillDetached = useStore.getState().detachedQueryResultWindows.some(
      (item) => item.id === id,
    );
    if (reason === 'attached' || reason === 'parent-shutdown' || reason === 'requested') {
      return;
    }
    if (event.payload?.exited === true) {
      if (stillDetached) {
        restoreQueryResult(id);
        showMainWindow();
      }
      return;
    }
    useStore.getState().closeDetachedQueryResultWindow(id);
  }
  clearNativeDetachedHostEvents(id);
};

const currentNativeWindowIds = (): Set<string> => {
  const state = useStore.getState();
  return new Set([
    ...state.detachedWorkbenchWindows.map((item) => `workbench:${item.tabId}`),
    ...state.detachedQueryResultWindows.map((item) => item.id),
    ...(state.detachedAIChatWindow ? ['ai-chat'] : []),
  ]);
};

export const readAIHostStateRefs = () => {
  const state = useStore.getState();
  return {
    theme: state.theme,
    themePreference: state.themePreference,
    appearance: state.appearance,
    fontSize: state.fontSize,
    uiScale: state.uiScale,
    activeContext: state.activeContext,
    activeTabId: state.activeTabId,
    aiContexts: state.aiContexts,
    connections: state.connections,
    tabs: state.tabs,
  };
};

const areAIHostStateRefsEqual = (
  left: ReturnType<typeof readAIHostStateRefs>,
  right: ReturnType<typeof readAIHostStateRefs>,
): boolean => (
  left.theme === right.theme
  && left.themePreference === right.themePreference
  && left.appearance === right.appearance
  && left.fontSize === right.fontSize
  && left.uiScale === right.uiScale
  && left.activeContext === right.activeContext
  && left.activeTabId === right.activeTabId
  && left.aiContexts === right.aiContexts
  && left.connections === right.connections
  && left.tabs === right.tabs
);

const areNativeDetachedThemeContextsEqual = (
  left: ReturnType<typeof getActiveNativeDetachedThemeContext>,
  right: ReturnType<typeof getActiveNativeDetachedThemeContext>,
): boolean => (
  left === right
  || (
    left !== null
    && right !== null
    && left.id === right.id
    && left.updatedAt === right.updatedAt
    && left.css === right.css
  )
);

export interface NativeDetachedWindowControllerProps {
  currentWindowId?: string;
  onOpenAISettings?: () => void;
}

const NativeDetachedWindowController = ({
  currentWindowId,
  onOpenAISettings,
}: NativeDetachedWindowControllerProps = {}): null => {
  useEffect(() => {
    if (!hasNativeDetachedWindowManager()) return undefined;

    const pendingLocalDispatchTimers = new Set<ReturnType<typeof setTimeout>>();
    const workbenchStateSources: WorkbenchStateSources = new Map();
    const initialWorkbenchSource = buildNativeDetachedWorkbenchMutableStoreSnapshot(
      useStore.getState(),
    );
    for (const id of currentNativeWindowIds()) {
      if (id !== 'ai-chat') workbenchStateSources.set(id, initialWorkbenchSource);
    }
    const aiContextSourceRef: AIContextSourceRef = {
      current: useStore.getState().aiContexts,
    };
    const dispatchHostEventLocally = (hostEvent: NativeDetachedHostEvent) => {
      if (typeof window === 'undefined') return;
      const dispatch = () => window.dispatchEvent(new CustomEvent(hostEvent.name, {
        detail: hostEvent.detail,
      }));
      if (hostEvent.name === 'gonavi:ai:inject-prompt') {
        useStore.getState().setAIPanelVisible(true);
        const timer = setTimeout(() => {
          pendingLocalDispatchTimers.delete(timer);
          dispatch();
        }, 0);
        pendingLocalDispatchTimers.add(timer);
        return;
      }
      dispatch();
    };
    const off = EventsOn(NATIVE_DETACHED_WINDOW_EVENT, (payload: NativeDetachedWindowEvent) => {
      applyNativeDetachedWindowEvent(payload, currentWindowId, {
        onOpenAISettings,
        onHostEvent: dispatchHostEventLocally,
        aiContextSourceRef,
        workbenchStateSources,
      });
    });
    let previousIds = currentNativeWindowIds();
    let previousAIVisible = useStore.getState().aiPanelVisible;
    let previousAIHostStateRefs = readAIHostStateRefs();
    let previousShortcutOptions = useStore.getState().shortcutOptions;
    let previousCustomTheme = getActiveNativeDetachedThemeContext();
    let aiHostSyncTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleAIHostStateSync = (delay = 100) => {
      if (currentWindowId || !useStore.getState().detachedAIChatWindow) return;
      if (aiHostSyncTimer !== null) clearTimeout(aiHostSyncTimer);
      aiHostSyncTimer = setTimeout(() => {
        aiHostSyncTimer = null;
        void syncNativeAIChatHostState().catch((error) => {
          console.warn('[Native Detached Window] Failed to sync AI host context', error);
        });
      }, delay);
    };
    if (!currentWindowId && useStore.getState().detachedAIChatWindow) {
      scheduleAIHostStateSync();
      if (!previousAIVisible) {
        void hideNativeDetachedWindowById('ai-chat').catch(() => undefined);
      }
    }
    const unsubscribeStore = useStore.subscribe(() => {
      const nextState = useStore.getState();
      const nextIds = currentNativeWindowIds();
      const nextShortcutOptions = nextState.shortcutOptions;
      const newlyOpenedIds = new Set<string>();
      const aiWindowJustOpened = !previousIds.has('ai-chat') && nextIds.has('ai-chat');
      for (const id of nextIds) {
        if (id !== 'ai-chat' && !previousIds.has(id)) {
          newlyOpenedIds.add(id);
        }
        if (id !== 'ai-chat' && !previousIds.has(id)) {
          workbenchStateSources.set(
            id,
            buildNativeDetachedWorkbenchMutableStoreSnapshot(useStore.getState()),
          );
        }
      }
      for (const id of previousIds) {
        if (!nextIds.has(id)) {
          void closeNativeDetachedWindowById(id).catch(() => undefined);
          clearNativeDetachedHostEvents(id);
          workbenchStateSources.delete(id);
        }
      }
      previousIds = nextIds;
      if (
        !currentWindowId
        && previousAIVisible
        && !nextState.aiPanelVisible
        && nextState.detachedAIChatWindow
      ) {
        void hideNativeDetachedWindowById('ai-chat').catch(() => undefined);
      }
      previousAIVisible = nextState.aiPanelVisible;
      const shortcutOptionsChanged = nextShortcutOptions !== previousShortcutOptions;
      if (shortcutOptionsChanged) {
        previousShortcutOptions = nextShortcutOptions;
      }
      const shortcutSyncTargets = shortcutOptionsChanged ? nextIds : newlyOpenedIds;
      if (!currentWindowId && shortcutSyncTargets.size > 0) {
        void syncNativeDetachedShortcutOptions(shortcutSyncTargets, nextShortcutOptions).catch((error) => {
          console.warn('[Native Detached Window] Failed to sync shortcut options', error);
        });
      }
      if (aiWindowJustOpened) {
        aiContextSourceRef.current = useStore.getState().aiContexts;
        scheduleAIHostStateSync();
      }
      const nextAIHostStateRefs = readAIHostStateRefs();
      if (!areAIHostStateRefsEqual(previousAIHostStateRefs, nextAIHostStateRefs)) {
        const aiContextsChanged = previousAIHostStateRefs.aiContexts
          !== nextAIHostStateRefs.aiContexts;
        previousAIHostStateRefs = nextAIHostStateRefs;
        scheduleAIHostStateSync(aiContextsChanged ? 0 : 100);
      }
      if (!useStore.getState().detachedAIChatWindow && aiHostSyncTimer !== null) {
        clearTimeout(aiHostSyncTimer);
        aiHostSyncTimer = null;
      }
    });
    const unsubscribeCustomTheme = useCustomThemeStore.subscribe(() => {
      const nextCustomTheme = getActiveNativeDetachedThemeContext();
      if (areNativeDetachedThemeContextsEqual(previousCustomTheme, nextCustomTheme)) return;
      previousCustomTheme = nextCustomTheme;
      if (currentWindowId) return;
      const targetWindowIds = currentNativeWindowIds();
      if (targetWindowIds.size === 0) return;
      void syncNativeDetachedThemeContext(targetWindowIds, nextCustomTheme).catch((error) => {
        console.warn('[Native Detached Window] Failed to sync custom theme', error);
      });
    });
    const unsubscribeQueryDrafts = subscribeQueryTabDraftChanges((tabId) => {
      if (tabId === useStore.getState().activeTabId) scheduleAIHostStateSync();
    });

    const removeWindowEventListeners: Array<() => void> = [];
    if (!currentWindowId && typeof window !== 'undefined') {
      const forwardAIEvent = (event: Event) => {
        if (!useStore.getState().detachedAIChatWindow) return;
        const customEvent = event as CustomEvent<unknown>;
        void forwardNativeDetachedHostEvent(
          'ai-chat',
          event.type as NativeDetachedHostEventName,
          customEvent.detail,
        ).catch((error) => {
          console.warn('[Native Detached Window] Failed to forward event to AI window', error);
        });
      };
      for (const eventName of [
        'gonavi:ai:inject-prompt',
        'gonavi:ai:config-changed',
        'gonavi:ai:provider-changed',
      ] as const) {
        window.addEventListener(eventName, forwardAIEvent);
        removeWindowEventListeners.push(() => window.removeEventListener(eventName, forwardAIEvent));
      }

      const forwardAIConfigurationToWorkbenches = (event: Event) => {
        const detail = (event as CustomEvent<unknown>).detail;
        for (const detachedWindow of useStore.getState().detachedWorkbenchWindows) {
          void forwardNativeDetachedHostEvent(
            `workbench:${detachedWindow.tabId}`,
            event.type as NativeDetachedHostEventName,
            detail,
          ).catch((error) => {
            console.warn(
              '[Native Detached Window] Failed to refresh AI configuration in workbench window',
              error,
            );
          });
        }
      };
      for (const eventName of [
        'gonavi:ai:config-changed',
        'gonavi:ai:provider-changed',
      ] as const) {
        window.addEventListener(eventName, forwardAIConfigurationToWorkbenches);
        removeWindowEventListeners.push(
          () => window.removeEventListener(eventName, forwardAIConfigurationToWorkbenches),
        );
      }

      const forwardTargetedWorkbenchEvent = (event: Event) => {
        const detail = (event as CustomEvent<Record<string, unknown>>).detail;
        const tabId = String(detail?.tabId || detail?.targetTabId || '').trim();
        if (!tabId || !useStore.getState().isWorkbenchTabDetached(tabId)) return;
        void forwardNativeDetachedHostEvent(
          `workbench:${tabId}`,
          event.type as NativeDetachedHostEventName,
          detail,
        ).catch((error) => {
          console.warn('[Native Detached Window] Failed to forward event to workbench window', error);
        });
      };
      for (const eventName of [
        'gonavi:insert-sql-to-tab',
        'gonavi:jvm-apply-ai-plan',
        'gonavi:jvm-apply-diagnostic-plan',
      ] as const) {
        window.addEventListener(eventName, forwardTargetedWorkbenchEvent);
        removeWindowEventListeners.push(
          () => window.removeEventListener(eventName, forwardTargetedWorkbenchEvent),
        );
      }
    }

    return () => {
      off();
      unsubscribeStore();
      unsubscribeCustomTheme();
      unsubscribeQueryDrafts();
      removeWindowEventListeners.forEach((remove) => remove());
      pendingLocalDispatchTimers.forEach((timer) => clearTimeout(timer));
      if (aiHostSyncTimer !== null) clearTimeout(aiHostSyncTimer);
      workbenchStateSources.clear();
    };
  }, [currentWindowId, onOpenAISettings]);

  return null;
};

export default NativeDetachedWindowController;
