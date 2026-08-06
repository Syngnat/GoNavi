import { useStore } from '../store';
import { useCustomThemeStore } from '../customThemeStore';
import type { TabData } from '../types';
import {
  DEFAULT_DETACHED_WINDOW_HEIGHT,
  DEFAULT_DETACHED_WINDOW_MIN_HEIGHT,
  DEFAULT_DETACHED_WINDOW_MIN_WIDTH,
  DEFAULT_DETACHED_WINDOW_WIDTH,
  DEFAULT_DETACHED_AI_CHAT_HEIGHT,
  DEFAULT_DETACHED_AI_CHAT_MIN_HEIGHT,
  DEFAULT_DETACHED_AI_CHAT_MIN_WIDTH,
  DEFAULT_DETACHED_AI_CHAT_WIDTH,
  type DetachedQueryResultWindow,
  type DetachedWindowBounds,
} from './detachedWindow';
import {
  buildNativeDetachedQueryResultPayload,
  buildNativeDetachedAIHostStoreSnapshot,
  buildNativeDetachedStoreSnapshot,
  buildNativeDetachedWorkbenchPayload,
  NATIVE_DETACHED_CUSTOM_THEME_CONTEXT_KEY,
  NATIVE_DETACHED_HOST_EVENTS_KEY,
  type NativeDetachedThemeContext,
  type NativeDetachedHostEvent,
  type NativeDetachedHostEventName,
  type NativeDetachedWindowKind,
  type NativeDetachedWindowPayload,
} from './nativeDetachedWindowClient';
import { peekQueryEditorResultSession } from './queryEditorResultSessionCache';
import { resolveLiveQueryTabs } from './liveQueryTabs';
import { resolveAvailableCustomTheme } from './customThemePresets';

export type NativeDetachedWindowOperationResult = {
  success: boolean;
  message?: string;
  id?: string;
  visibilityRevision?: number;
  bounds?: Pick<DetachedWindowBounds, 'x' | 'y' | 'width' | 'height'>;
};

export type NativeDetachedWindowOpenRequest = {
  id: string;
  kind: NativeDetachedWindowKind;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  payload: NativeDetachedWindowPayload;
};

export type NativeDetachedWindowManager = {
  Open: (request: NativeDetachedWindowOpenRequest) => Promise<NativeDetachedWindowOperationResult>;
  Focus: (id: string) => Promise<NativeDetachedWindowOperationResult>;
  Hide?: (id: string) => Promise<NativeDetachedWindowOperationResult>;
  Close: (id: string) => Promise<NativeDetachedWindowOperationResult>;
  CloseAll: () => Promise<NativeDetachedWindowOperationResult>;
  SyncHostState?: (request: NativeDetachedHostStateRequest) => Promise<NativeDetachedWindowOperationResult>;
};

export type NativeDetachedHostStateRequest = {
  id: string;
  revision: number;
  storeState: Record<string, unknown>;
};

export const getActiveNativeDetachedThemeContext = (): NativeDetachedThemeContext => {
  const state = useCustomThemeStore.getState();
  return resolveAvailableCustomTheme(state.themes, state.activeThemeId);
};

export type NativeQueryResultWindowInput = Omit<
  DetachedQueryResultWindow,
  keyof DetachedWindowBounds
> & Partial<DetachedWindowBounds>;

const openingWindows = new Map<string, Promise<boolean>>();
const nativeHostStateRevisions = new Map<string, number>();
const nativeHostStateQueues = new Map<string, Promise<boolean>>();
const retainedNativeHostEvents = new Map<string, NativeDetachedHostEvent[]>();
const nativeVisibilityRevisions = new Map<string, number>();
let nativeHostEventSequence = 0;
const NATIVE_HOST_EVENT_RETENTION_LIMIT = 64;

// Keep cold AI startup bounded: detached AI only needs presentation settings,
// live chat/session state, workspace context and the data exposed by its local
// inspection tools. Provider/model/prompt configuration is loaded directly
// from aiservice and refreshed through the retained config/provider events.
const NATIVE_AI_CHAT_BOOTSTRAP_KEYS = [
  'languagePreference',
  'theme',
  'appearance',
  'fontSize',
  'uiScale',
  'shortcutOptions',
  'activeContext',
  'activeTabId',
  'connections',
  'tabs',
  'sqlLogs',
  'aiChatHistory',
  'aiChatSessions',
  'aiActiveSessionId',
  'aiContexts',
  'savedQueries',
  'sqlSnippets',
  'externalSQLDirectories',
  'sqlEditorTransactionOptions',
] as const;

const buildNativeDetachedAIChatBootstrapPayload = (
  state: object,
): NativeDetachedWindowPayload => {
  const source = state as Record<string, unknown>;
  const selected: Record<string, unknown> = {};
  for (const key of NATIVE_AI_CHAT_BOOTSTRAP_KEYS) {
    if (Object.prototype.hasOwnProperty.call(source, key)) selected[key] = source[key];
  }
  if (Array.isArray(source.tabs)) {
    selected.tabs = resolveLiveQueryTabs(source.tabs as TabData[]);
  }
  return {
    storeState: {
      ...buildNativeDetachedStoreSnapshot(selected),
      detachedWorkbenchWindows: [],
      detachedQueryResultWindows: [],
      detachedAIChatWindow: null,
      sqlEditorPendingTransactions: {},
      aiPanelVisible: true,
      aiChatOpenMode: 'detached',
      [NATIVE_DETACHED_CUSTOM_THEME_CONTEXT_KEY]: getActiveNativeDetachedThemeContext(),
    },
  };
};

const normalizeNativeVisibilityRevision = (value: unknown): number => {
  const revision = Math.trunc(Number(value));
  return Number.isFinite(revision) && revision > 0 ? revision : 0;
};

export const recordNativeDetachedVisibilityRevision = (
  windowId: string,
  revisionValue: unknown,
): number => {
  const id = String(windowId || '').trim();
  const revision = normalizeNativeVisibilityRevision(revisionValue);
  if (!id || revision <= 0) return nativeVisibilityRevisions.get(id) || 0;
  const current = nativeVisibilityRevisions.get(id) || 0;
  if (revision > current) nativeVisibilityRevisions.set(id, revision);
  return Math.max(current, revision);
};

export const shouldApplyNativeDetachedHideRevision = (
  windowId: string,
  revisionValue: unknown,
): boolean => {
  const id = String(windowId || '').trim();
  const revision = normalizeNativeVisibilityRevision(revisionValue);
  // Keep backward compatibility with older native runtimes that do not return
  // visibility revisions.
  if (!id || revision <= 0) return true;
  const current = nativeVisibilityRevisions.get(id) || 0;
  if (revision < current) return false;
  nativeVisibilityRevisions.set(id, revision);
  return true;
};

const nextNativeHostStateRevision = (id: string): number => {
  const previous = nativeHostStateRevisions.get(id) || Date.now();
  const next = Math.max(Date.now(), previous + 1);
  nativeHostStateRevisions.set(id, next);
  return next;
};

const createNativeHostEvent = (
  sourceWindowId: string,
  name: NativeDetachedHostEventName,
  detail?: unknown,
): NativeDetachedHostEvent => {
  nativeHostEventSequence += 1;
  return {
    id: `${String(sourceWindowId || 'main')}:${Date.now()}:${nativeHostEventSequence}`,
    name,
    ...(detail === undefined ? {} : { detail }),
  };
};

const retainNativeHostEvent = (
  targetWindowId: string,
  event: NativeDetachedHostEvent,
): NativeDetachedHostEvent[] => {
  const previous = retainedNativeHostEvents.get(targetWindowId) || [];
  const next = [...previous, event].slice(-NATIVE_HOST_EVENT_RETENTION_LIMIT);
  retainedNativeHostEvents.set(targetWindowId, next);
  return next;
};

export const clearNativeDetachedHostEvents = (windowId: string): void => {
  const id = String(windowId || '').trim();
  if (!id) return;
  retainedNativeHostEvents.delete(id);
  nativeVisibilityRevisions.delete(id);
};

const syncNativeDetachedHostState = (
  id: string,
  storeState: Record<string, unknown>,
  manager: NativeDetachedWindowManager,
): Promise<boolean> => {
  if (typeof manager.SyncHostState !== 'function') return Promise.resolve(false);
  const previous = nativeHostStateQueues.get(id) || Promise.resolve(true);
  const operation = previous.catch(() => false).then(async () => {
    const result = await manager.SyncHostState!({
      id,
      revision: nextNativeHostStateRevision(id),
      storeState,
    });
    if (!result?.success) {
      throw new Error(String(result?.message || 'Failed to sync native host context'));
    }
    return true;
  });
  nativeHostStateQueues.set(id, operation);
  void operation.finally(() => {
    if (nativeHostStateQueues.get(id) === operation) nativeHostStateQueues.delete(id);
  }).catch(() => undefined);
  return operation;
};

export const forwardNativeDetachedHostEvent = async (
  targetWindowId: string,
  name: NativeDetachedHostEventName,
  detail?: unknown,
  managerOverride?: NativeDetachedWindowManager,
): Promise<boolean> => {
  const id = String(targetWindowId || '').trim();
  if (!id) return false;
  const events = retainNativeHostEvent(id, createNativeHostEvent('main', name, detail));
  const manager = managerOverride ?? resolveNativeDetachedWindowManager();
  if (!manager || typeof manager.SyncHostState !== 'function') return false;
  const storeState = id === 'ai-chat'
    ? buildNativeDetachedAIHostStoreSnapshot(
        useStore.getState(),
        events,
        getActiveNativeDetachedThemeContext(),
      )
    : buildNativeDetachedStoreSnapshot({ [NATIVE_DETACHED_HOST_EVENTS_KEY]: events });
  return syncNativeDetachedHostState(id, storeState, manager);
};

export const resolveNativeDetachedWindowManager = (): NativeDetachedWindowManager | null => {
  if (typeof window === 'undefined') return null;
  const manager = (window as any).go?.nativewindow?.Manager;
  if (
    typeof manager?.Open !== 'function'
    || typeof manager?.Focus !== 'function'
    || typeof manager?.Close !== 'function'
  ) {
    return null;
  }
  return manager as NativeDetachedWindowManager;
};

export const hasNativeDetachedWindowManager = (): boolean =>
  resolveNativeDetachedWindowManager() !== null;

const getNativeWindowBounds = (
  preferred?: Partial<Pick<DetachedWindowBounds, 'x' | 'y' | 'width' | 'height'>>,
  sizePreset: 'workbench' | 'ai-chat' = 'workbench',
): Pick<DetachedWindowBounds, 'x' | 'y' | 'width' | 'height'> => {
  const defaultWidth = sizePreset === 'ai-chat'
    ? DEFAULT_DETACHED_AI_CHAT_WIDTH
    : DEFAULT_DETACHED_WINDOW_WIDTH;
  const defaultHeight = sizePreset === 'ai-chat'
    ? DEFAULT_DETACHED_AI_CHAT_HEIGHT
    : DEFAULT_DETACHED_WINDOW_HEIGHT;
  const minWidth = sizePreset === 'ai-chat'
    ? DEFAULT_DETACHED_AI_CHAT_MIN_WIDTH
    : DEFAULT_DETACHED_WINDOW_MIN_WIDTH;
  const minHeight = sizePreset === 'ai-chat'
    ? DEFAULT_DETACHED_AI_CHAT_MIN_HEIGHT
    : DEFAULT_DETACHED_WINDOW_MIN_HEIGHT;
  const viewportWidth = typeof window === 'undefined' ? defaultWidth : window.innerWidth;
  const viewportHeight = typeof window === 'undefined' ? defaultHeight : window.innerHeight;
  const width = Math.max(
    minWidth,
    Math.round(Number(preferred?.width) || Math.min(defaultWidth, viewportWidth * 0.9)),
  );
  const height = Math.max(
    minHeight,
    Math.round(Number(preferred?.height) || Math.min(defaultHeight, viewportHeight * 0.86)),
  );
  const baseX = typeof window === 'undefined' ? 80 : window.screenX + Math.max(32, Math.round((window.innerWidth - width) / 2));
  const baseY = typeof window === 'undefined' ? 80 : window.screenY + Math.max(32, Math.round((window.innerHeight - height) / 2));
  return {
    x: Number.isFinite(Number(preferred?.x)) ? Math.round(Number(preferred?.x)) : baseX,
    y: Number.isFinite(Number(preferred?.y)) ? Math.round(Number(preferred?.y)) : baseY,
    width,
    height,
  };
};

const assertOpened = (result: NativeDetachedWindowOperationResult | undefined): void => {
  if (result?.success) return;
  throw new Error(String(result?.message || 'Failed to open native detached window'));
};

const focusExistingWindow = async (
  manager: NativeDetachedWindowManager,
  id: string,
): Promise<boolean> => {
  const result = await manager.Focus(id);
  if (!result?.success) {
    throw new Error(String(result?.message || 'Failed to focus native detached window'));
  }
  return true;
};

const openOnce = (
  manager: NativeDetachedWindowManager,
  request: NativeDetachedWindowOpenRequest,
  afterOpen: (bounds: Pick<DetachedWindowBounds, 'x' | 'y' | 'width' | 'height'>) => boolean,
  rollbackAfterExit: () => void,
): Promise<boolean> => {
  const existing = openingWindows.get(request.id);
  if (existing) {
    return existing.then(async (opened) => {
      if (opened) await focusExistingWindow(manager, request.id);
      return opened;
    });
  }
  const opening = (async () => {
    const result = await manager.Open(request);
    assertOpened(result);
    const returnedBounds = result?.bounds;
    const bounds = returnedBounds
      && [returnedBounds.x, returnedBounds.y, returnedBounds.width, returnedBounds.height]
        .every(Number.isFinite)
      && returnedBounds.width > 0
      && returnedBounds.height > 0
      ? returnedBounds
      : {
          x: request.x,
          y: request.y,
          width: request.width,
          height: request.height,
        };
    const opened = afterOpen(bounds);
    if (!opened) return false;

    // A child can acknowledge ready and exit before the Wails Open promise is
    // delivered to JavaScript. Verify it after committing detached state so
    // either this rollback or the process-exit event restores the source.
    try {
      await focusExistingWindow(manager, request.id);
    } catch (error) {
      rollbackAfterExit();
      throw error;
    }
    return true;
  })();
  openingWindows.set(request.id, opening);
  void opening.finally(() => {
    if (openingWindows.get(request.id) === opening) {
      openingWindows.delete(request.id);
    }
  }).catch(() => undefined);
  return opening;
};

const resolveWorkbenchTitle = (tab: TabData): string =>
  String(tab.title || tab.tableName || tab.viewName || tab.id).trim() || tab.id;

export const openNativeWorkbenchTabWindow = async (
  tabId: string,
  preferred?: Partial<Pick<DetachedWindowBounds, 'x' | 'y' | 'width' | 'height'>>,
  managerOverride?: NativeDetachedWindowManager,
): Promise<boolean> => {
  const id = String(tabId || '').trim();
  const state = useStore.getState();
  const tab = state.tabs.find((item) => item.id === id);
  if (!tab) return false;

  const manager = managerOverride ?? resolveNativeDetachedWindowManager();
  if (!manager) {
    state.detachWorkbenchTab(id, preferred);
    return true;
  }
  const windowId = `workbench:${id}`;
  if (state.isWorkbenchTabDetached(id)) {
    return focusExistingWindow(manager, windowId);
  }

  const bounds = getNativeWindowBounds(preferred);
  if (tab.type === 'query' && typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('gonavi:capture-query-result-session', {
      detail: { tabId: tab.id },
    }));
  }
  const request: NativeDetachedWindowOpenRequest = {
    id: windowId,
    kind: 'workbench',
    title: resolveWorkbenchTitle(tab),
    ...bounds,
    payload: buildNativeDetachedWorkbenchPayload(
      state,
      tab,
      tab.type === 'query' ? peekQueryEditorResultSession(tab.id) : null,
      getActiveNativeDetachedThemeContext(),
    ),
  };
  const opened = await openOnce(manager, request, (openedBounds) => {
    const latest = useStore.getState();
    if (!latest.tabs.some((item) => item.id === id)) {
      void manager.Close(windowId);
      return false;
    }
    latest.detachWorkbenchTab(id, openedBounds);
    return true;
  }, () => {
    useStore.getState().attachWorkbenchTab(id);
  });
  const retainedEvents = retainedNativeHostEvents.get(windowId) || [];
  if (opened && retainedEvents.length > 0 && typeof manager.SyncHostState === 'function') {
    await syncNativeDetachedHostState(
      windowId,
      buildNativeDetachedStoreSnapshot({ [NATIVE_DETACHED_HOST_EVENTS_KEY]: retainedEvents }),
      manager,
    );
  }
  return opened;
};

export const openNativeQueryResultWindow = async (
  windowState: NativeQueryResultWindowInput,
  managerOverride?: NativeDetachedWindowManager,
): Promise<boolean> => {
  const id = String(windowState.id || '').trim();
  if (!id) return false;
  const state = useStore.getState();
  const manager = managerOverride ?? resolveNativeDetachedWindowManager();
  if (!manager) {
    state.detachQueryResultWindow(windowState);
    return true;
  }
  if (state.detachedQueryResultWindows.some((item) => item.id === id)) {
    return focusExistingWindow(manager, id);
  }
  const bounds = getNativeWindowBounds(windowState);
  return openOnce(manager, {
    id,
    kind: 'query-result',
    title: windowState.title,
    ...bounds,
    payload: buildNativeDetachedQueryResultPayload(state, {
      ...windowState,
      ...bounds,
      zIndex: Number(windowState.zIndex) || 1201,
    }, getActiveNativeDetachedThemeContext()),
  }, (openedBounds) => {
    const latest = useStore.getState();
    if (!latest.tabs.some((tab) => tab.id === windowState.sourceQueryTabId)) {
      void manager.Close(id);
      return false;
    }
    latest.detachQueryResultWindow({ ...windowState, ...openedBounds });
    return true;
  }, () => {
    useStore.getState().closeDetachedQueryResultWindow(id);
  });
};

export const openNativeAIChatWindow = async (
  preferred?: Partial<Pick<DetachedWindowBounds, 'x' | 'y' | 'width' | 'height'>>,
  managerOverride?: NativeDetachedWindowManager,
): Promise<boolean> => {
  const state = useStore.getState();
  const manager = managerOverride ?? resolveNativeDetachedWindowManager();
  if (!manager) {
    state.detachAIChatPanel(preferred);
    return true;
  }

  const windowId = 'ai-chat';
  const hadDetachedIntent = Boolean(state.detachedAIChatWindow);
  if (hadDetachedIntent) {
    const focused = await manager.Focus(windowId);
    if (focused?.success) {
      recordNativeDetachedVisibilityRevision(windowId, focused.visibilityRevision);
      const latest = useStore.getState();
      if (!latest.aiPanelVisible) {
        await hideNativeDetachedWindowById(windowId, manager);
        return false;
      }
      const focusedBounds = focused.bounds;
      if (
        focusedBounds
        && [focusedBounds.x, focusedBounds.y, focusedBounds.width, focusedBounds.height]
          .every(Number.isFinite)
        && focusedBounds.width > 0
        && focusedBounds.height > 0
      ) {
        latest.updateDetachedAIChatBounds({ ...focusedBounds, coordinateSpace: 'screen' });
      }
      try {
        await refreshNativeAIChatWindow(manager);
      } catch (error) {
        console.warn('[Native Detached Window] Failed to refresh reused AI window', error);
      }
      return true;
    }
  }
  const remembered = state.aiChatDetachedBoundsMemory;
  const rememberedBounds = {
    ...(remembered?.coordinateSpace === 'screen'
      ? remembered
      : remembered
        ? { width: remembered.width, height: remembered.height }
        : {}),
    ...(preferred || {}),
  };
  const bounds = getNativeWindowBounds(rememberedBounds, 'ai-chat');
  const opened = await openOnce(manager, {
    id: windowId,
    kind: 'ai-chat',
    title: 'GoNavi AI',
    ...bounds,
    payload: buildNativeDetachedAIChatBootstrapPayload(state),
  }, (openedBounds) => {
    const latest = useStore.getState();
    if (!latest.aiPanelVisible || (hadDetachedIntent && !latest.detachedAIChatWindow)) {
      void manager.Close(windowId);
      return false;
    }
    if (!latest.detachedAIChatWindow) {
      latest.detachAIChatPanel();
    }
    latest.updateDetachedAIChatBounds({ ...openedBounds, coordinateSpace: 'screen' });
    return true;
  }, () => {
    const latest = useStore.getState();
    if (latest.detachedAIChatWindow) {
      latest.attachAIChatPanel();
    }
  });
  if (opened && typeof manager.SyncHostState === 'function') {
    try {
      await refreshNativeAIChatWindow(manager);
    } catch (error) {
      console.warn('[Native Detached Window] Failed to send initial AI host context', error);
    }
  }
  return opened;
};

export const toggleOrFocusNativeAIChatFromMainWindow = async (
  managerOverride?: NativeDetachedWindowManager,
): Promise<boolean> => {
  const state = useStore.getState();
  const manager = managerOverride ?? resolveNativeDetachedWindowManager();
  if (manager && state.aiPanelVisible && state.detachedAIChatWindow) {
    return openNativeAIChatWindow(undefined, manager);
  }
  state.toggleAIPanel();
  return useStore.getState().aiPanelVisible;
};

const refreshNativeAIChatWindow = async (
  manager: NativeDetachedWindowManager,
): Promise<boolean> => {
  if (typeof manager.SyncHostState !== 'function') return false;
  retainNativeHostEvent('ai-chat', createNativeHostEvent(
    'main',
    'gonavi:ai:config-changed',
  ));
  const events = retainNativeHostEvent('ai-chat', createNativeHostEvent(
    'main',
    'gonavi:ai:provider-changed',
  ));
  return syncNativeDetachedHostState(
    'ai-chat',
    buildNativeDetachedAIHostStoreSnapshot(
      useStore.getState(),
      events,
      getActiveNativeDetachedThemeContext(),
    ),
    manager,
  );
};

export const syncNativeAIChatHostState = async (
  managerOverride?: NativeDetachedWindowManager,
): Promise<boolean> => {
  const manager = managerOverride ?? resolveNativeDetachedWindowManager();
  if (!manager || typeof manager.SyncHostState !== 'function') return false;
  return syncNativeDetachedHostState(
    'ai-chat',
    buildNativeDetachedAIHostStoreSnapshot(
      useStore.getState(),
      retainedNativeHostEvents.get('ai-chat') || [],
      getActiveNativeDetachedThemeContext(),
    ),
    manager,
  );
};

export const syncNativeDetachedShortcutOptions = async (
  targetWindowIds: Iterable<string>,
  shortcutOptions: unknown,
  managerOverride?: NativeDetachedWindowManager,
): Promise<boolean> => {
  const manager = managerOverride ?? resolveNativeDetachedWindowManager();
  if (!manager || typeof manager.SyncHostState !== 'function') return false;
  const ids = Array.from(new Set(
    Array.from(targetWindowIds, (id) => String(id || '').trim()).filter(Boolean),
  ));
  const shortcutStoreState = buildNativeDetachedStoreSnapshot({ shortcutOptions });
  await Promise.all(ids.map((id) => syncNativeDetachedHostState(
    id,
    id === 'ai-chat'
      ? buildNativeDetachedAIHostStoreSnapshot(
          { ...useStore.getState(), shortcutOptions },
          retainedNativeHostEvents.get('ai-chat') || [],
          getActiveNativeDetachedThemeContext(),
        )
      : shortcutStoreState,
    manager,
  )));
  return true;
};

export const syncNativeDetachedThemeContext = async (
  targetWindowIds: Iterable<string>,
  themeContext: NativeDetachedThemeContext = getActiveNativeDetachedThemeContext(),
  managerOverride?: NativeDetachedWindowManager,
): Promise<boolean> => {
  const manager = managerOverride ?? resolveNativeDetachedWindowManager();
  if (!manager || typeof manager.SyncHostState !== 'function') return false;
  const ids = Array.from(new Set(
    Array.from(targetWindowIds, (id) => String(id || '').trim()).filter(Boolean),
  ));
  const storeState = buildNativeDetachedStoreSnapshot({
    [NATIVE_DETACHED_CUSTOM_THEME_CONTEXT_KEY]: themeContext,
  });
  await Promise.all(ids.map((id) => syncNativeDetachedHostState(id, storeState, manager)));
  return true;
};

export const hideNativeDetachedWindowById = async (
  id: string,
  managerOverride?: NativeDetachedWindowManager,
): Promise<void> => {
  const manager = managerOverride ?? resolveNativeDetachedWindowManager();
  if (!manager) return;
  const targetID = String(id || '').trim();
  const result = typeof manager.Hide === 'function'
    ? await manager.Hide(targetID)
    : await manager.Close(targetID);
  recordNativeDetachedVisibilityRevision(targetID, result?.visibilityRevision);
  if (!result?.success && result?.message) {
    throw new Error(result.message);
  }
};

export const closeNativeDetachedWindowById = async (id: string): Promise<void> => {
  const manager = resolveNativeDetachedWindowManager();
  if (!manager) return;
  const result = await manager.Close(String(id || '').trim());
  if (!result?.success && result?.message) {
    throw new Error(result.message);
  }
};
