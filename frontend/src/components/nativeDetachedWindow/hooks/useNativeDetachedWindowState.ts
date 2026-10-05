import { useState, useCallback, useRef, useLayoutEffect, useEffect } from 'react';
import { useOptionalI18n } from '../../../i18n/provider';
import { t as defaultTranslate } from '../../../i18n';
import {
  type NativeDetachedWindowBootstrap,
  type NativeDetachedStoreSnapshot,
  hydrateNativeDetachedStore,
  readNativeDetachedThemeContext,
  buildNativeDetachedWorkbenchMutableStoreSnapshot,
  NATIVE_DETACHED_WINDOW_COMMAND_EVENT,
  type NativeDetachedHostStateCommand,
  applyNativeDetachedHostStateCommand,
  type NativeDetachedHostEventName,
  type NativeDetachedHostEvent,
  buildNativeDetachedChangedWorkbenchStoreSnapshot,
  buildNativeDetachedStoreSnapshot,
  advanceNativeDetachedStoreSource,
} from '../../../utils/nativeDetachedWindowClient';
import { useAIWorkspaceSnapshot } from '../../ai/useAIWorkspaceSnapshot';
import type { CustomThemeDefinition } from '../../../utils/customTheme';
import {
  type QueryEditorResultSessionSnapshot,
  saveQueryEditorResultSessionForOpenTab,
} from '../../../utils/queryEditorResultSessionCache';
import type { DetachedQueryResultWindow } from '../../../utils/detachedWindow';
import { useStore, type SqlLog } from '../../../store';
import type { CustomThemeAntTokenSnapshot } from '../../theme/CustomThemeStyleHost';
import {
  applyNativeDetachedDocumentAppearance,
  waitForNativeDetachedContentPaint,
} from '../nativeDetachedAppearance';
import {
  installGlobalImeCompositionTracking,
  getShortcutPlatform,
  resolveShortcutBinding,
  isShortcutMatch,
} from '../../../utils/shortcuts';
import { EventsOn } from '../../../../wailsjs/runtime';
import { isMacLikePlatform } from '../../../utils/appearance';
import type { TabData } from '../../../types';
import { resolveLiveQueryTab, resolveLiveQueryTabs } from '../../../utils/liveQueryTabs';
import type { NativeDetachedWindowAppProps } from '../../NativeDetachedWindowApp';

export interface UseNativeDetachedWindowStateInput {
  client: Exclude<NativeDetachedWindowAppProps['client'], undefined>;
}

export const useNativeDetachedWindowState = ({ client }: UseNativeDetachedWindowStateInput) => {
  const i18n = useOptionalI18n();
  const translate = i18n?.t ?? defaultTranslate;
  const [bootstrap, setBootstrap] = useState<NativeDetachedWindowBootstrap | null>(null);
  const [loadError, setLoadError] = useState('');
  const [contentMounted, setContentMounted] = useState(true);
  const [contentReady, setContentReady] = useState(false);
  const [controllerEnabled, setControllerEnabled] = useState(false);
  // A detached AI WebView is its own desktop snapshot source. Keep its lease
  // alive for the lifetime of the detached window, independent of panel UI
  // visibility or terminal actions.
  useAIWorkspaceSnapshot({ enabled: bootstrap?.kind === 'ai-chat' });
  // A detached WebView has an independent custom-theme store. The host sends
  // the resolved definition so it cannot fall back to a different local copy.
  const [customThemeOverride, setCustomThemeOverride] = useState<
    CustomThemeDefinition | null | undefined
  >(undefined);
  const markContentReady = useCallback(() => setContentReady(true), []);
  const [terminalAction, setTerminalAction] = useState<'attach' | 'hide' | 'close' | null>(null);
  const [terminalCloseRecoveryAvailable, setTerminalCloseRecoveryAvailable] = useState(false);
  const [terminalCloseRecoveryPending, setTerminalCloseRecoveryPending] = useState(false);
  const terminalActionStartedRef = useRef(false);
  const terminalActionRequestedRef = useRef(false);
  const terminalActionGenerationRef = useRef(0);
  const terminalCloseRecoveryPendingRef = useRef(false);
  const openAISettingsAfterHideRef = useRef(false);
  const openAISettingsProviderIdRef = useRef('');
  const activeTerminalActionRef = useRef<'attach' | 'hide' | 'close' | null>(null);
  const closePreemptionRequestedRef = useRef(false);
  const hideVisibilityRevisionRef = useRef(0);
  const lastFocusVisibilityRevisionRef = useRef(0);
  const aiTerminalGuardRef = useRef<(() => Promise<boolean>) | null>(null);
  const resultSessionRef = useRef<QueryEditorResultSessionSnapshot | null>(null);
  const queryResultWindowRef = useRef<DetachedQueryResultWindow | null>(null);
  const queryResultDirtyGenerationRef = useRef(0);
  const scheduleSyncRef = useRef<(includeResultSession?: boolean) => void>(() => undefined);
  const syncedSqlLogIdsRef = useRef<Set<string>>(new Set());
  const sqlLogsClearPendingRef = useRef(false);
  const syncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const syncIncludesResultSessionRef = useRef(false);
  const hostStateRevisionRef = useRef(0);
  const actionRevisionRef = useRef(0);
  const actionQueueRef = useRef<Promise<void>>(Promise.resolve());
  const processedHostEventIdsRef = useRef<Set<string>>(new Set());
  const previousHostAIContextsRef = useRef<unknown>({});
  const hostEventSequenceRef = useRef(0);
  const workbenchStateSourceRef = useRef<NativeDetachedStoreSnapshot>({});
  const syncedWorkbenchTabIdsRef = useRef<Set<string>>(new Set());
  const handleQueryResultStateChange = useCallback((patch: Partial<DetachedQueryResultWindow['result']>) => {
    const resultWindow = queryResultWindowRef.current;
    if (!resultWindow) return;
    queryResultWindowRef.current = {
      ...resultWindow,
      result: { ...resultWindow.result, ...patch },
    };
    queryResultDirtyGenerationRef.current += 1;
    scheduleSyncRef.current(false);
  }, []);

  const themeMode = useStore((state) => state.theme);
  const fontSize = useStore((state) => state.fontSize);
  const uiScale = useStore((state) => state.uiScale);
  const shortcutOptions = useStore((state) => state.shortcutOptions);
  const [computedCustomThemeAntTokens, setComputedCustomThemeAntTokens] = useState<CustomThemeAntTokenSnapshot | null>(null);
  const effectiveThemeMode = customThemeOverride?.baseMode === 'dark'
    ? 'dark'
    : customThemeOverride?.baseMode === 'light'
      ? 'light'
      : themeMode;

  useLayoutEffect(() => {
    applyNativeDetachedDocumentAppearance(effectiveThemeMode, fontSize, uiScale);
  }, [effectiveThemeMode, fontSize, uiScale]);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    return installGlobalImeCompositionTracking(
      window,
      typeof document === 'undefined' ? null : document,
    );
  }, []);

  useEffect(() => {
    const persist = (useStore as any).persist;
    if (typeof persist?.setOptions !== 'function') return;
    persist.setOptions({
      storage: {
        getItem: () => null,
        setItem: () => undefined,
        removeItem: () => undefined,
      },
    });
  }, []);

  useEffect(() => {
    let active = true;
    void client.load()
      .then((nextBootstrap) => {
        if (!active) return;
        const bootstrapActionRevision = Math.trunc(Number(nextBootstrap.actionRevision));
        actionRevisionRef.current = Number.isFinite(bootstrapActionRevision) && bootstrapActionRevision > 0
          ? bootstrapActionRevision
          : 0;
        setContentReady(false);
        setControllerEnabled(false);
        hydrateNativeDetachedStore(useStore, nextBootstrap.payload.storeState);
        setCustomThemeOverride(readNativeDetachedThemeContext(nextBootstrap.payload.storeState));
        queryResultWindowRef.current = nextBootstrap.payload.resultWindow ?? null;
        previousHostAIContextsRef.current = useStore.getState().aiContexts;
        workbenchStateSourceRef.current = buildNativeDetachedWorkbenchMutableStoreSnapshot(
          useStore.getState(),
        );
        syncedWorkbenchTabIdsRef.current = new Set(
          (useStore.getState().tabs || []).map((tab) => String(tab.id || '').trim()).filter(Boolean),
        );
        syncedSqlLogIdsRef.current = new Set(
          (useStore.getState().sqlLogs || [])
            .map((log) => String(log.id || '').trim())
            .filter(Boolean),
        );
        if (nextBootstrap.kind === 'workbench' && nextBootstrap.payload.tab) {
          resultSessionRef.current = nextBootstrap.payload.resultSession ?? null;
          if (nextBootstrap.payload.resultSession) {
            saveQueryEditorResultSessionForOpenTab(
              nextBootstrap.payload.tab.id,
              nextBootstrap.payload.resultSession,
              useStore.getState().tabs,
            );
          }
        }
        setBootstrap(nextBootstrap);
      })
      .catch((error) => {
        if (!active) return;
        setLoadError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      active = false;
    };
  }, [client]);

  useEffect(() => {
    if (!bootstrap) return undefined;
    return EventsOn(
      NATIVE_DETACHED_WINDOW_COMMAND_EVENT,
      (command: NativeDetachedHostStateCommand) => {
        const themeContext = readNativeDetachedThemeContext(command?.payload?.storeState);
        if (themeContext !== undefined) {
          setCustomThemeOverride((current) => {
            const currentKey = current ? `${current.id}:${current.updatedAt}:${current.css}` : current;
            const nextKey = themeContext
              ? `${themeContext.id}:${themeContext.updatedAt}:${themeContext.css}`
              : themeContext;
            return currentKey === nextKey ? current : themeContext;
          });
        }
        const isCurrentAIWindow = bootstrap.kind === 'ai-chat'
          && String(command?.id || '') === bootstrap.id;
        const visibilityRevision = Math.trunc(Number(command?.payload?.visibilityRevision));
        if (isCurrentAIWindow && Number.isFinite(visibilityRevision) && visibilityRevision > 0) {
          if (
            command.action === 'hide'
            && visibilityRevision > lastFocusVisibilityRevisionRef.current
          ) {
            hideVisibilityRevisionRef.current = Math.max(
              hideVisibilityRevisionRef.current,
              visibilityRevision,
            );
          } else if (
            command.action === 'focus'
            && visibilityRevision > lastFocusVisibilityRevisionRef.current
          ) {
            lastFocusVisibilityRevisionRef.current = visibilityRevision;
            if (
              activeTerminalActionRef.current !== 'attach'
              && activeTerminalActionRef.current !== 'close'
              && !closePreemptionRequestedRef.current
              && visibilityRevision > hideVisibilityRevisionRef.current
            ) {
              // WindowHide can suspend the WebView before React commits the
              // terminal-action cleanup. A newer native focus is the resume
              // boundary, so invalidate the old hide and unlock the live tree.
              terminalActionGenerationRef.current += 1;
              terminalActionStartedRef.current = false;
              terminalActionRequestedRef.current = false;
              activeTerminalActionRef.current = null;
              openAISettingsAfterHideRef.current = false;
              hideVisibilityRevisionRef.current = 0;
              setTerminalCloseRecoveryAvailable(false);
              setTerminalAction((current) => current === 'hide' ? null : current);
            }
          }
        }
        hostStateRevisionRef.current = applyNativeDetachedHostStateCommand(
          useStore,
          bootstrap.id,
          hostStateRevisionRef.current,
          command,
          {
            processedEventIds: processedHostEventIdsRef.current,
            previousHostAIContextsRef,
            dispatchHostEvent: (hostEvent) => {
              if (typeof window === 'undefined') return;
              window.dispatchEvent(new CustomEvent(hostEvent.name, {
                detail: hostEvent.detail,
              }));
            },
          },
        );
      },
    );
  }, [bootstrap]);

  useEffect(() => {
    if (!bootstrap || typeof window === 'undefined' || !client.hostEvent) return undefined;
    const eventNames: NativeDetachedHostEventName[] = bootstrap.kind === 'ai-chat'
      ? [
          'gonavi:insert-sql',
          'gonavi:jvm-apply-ai-plan',
          'gonavi:jvm-apply-diagnostic-plan',
        ]
      : [
          'gonavi:ai:inject-prompt',
          'gonavi:open-download-source-settings',
          'gonavi:open-global-proxy-settings',
          ...(bootstrap.kind === 'workbench' ? ['gonavi:locate-sidebar-object' as const] : []),
        ];
    const forwardToHost = (event: Event) => {
      hostEventSequenceRef.current += 1;
      const hostEvent: NativeDetachedHostEvent = {
        id: `${bootstrap.id}:${Date.now()}:${hostEventSequenceRef.current}`,
        name: event.type as NativeDetachedHostEventName,
        detail: (event as CustomEvent<unknown>).detail,
      };
      void client.hostEvent?.({
        id: bootstrap.id,
        kind: bootstrap.kind,
        hostEvent,
      }).catch((error) => {
        console.warn('[Native Detached Window] Failed to forward event to host', error);
      });
    };
    eventNames.forEach((eventName) => window.addEventListener(eventName, forwardToHost));
    return () => {
      eventNames.forEach((eventName) => window.removeEventListener(eventName, forwardToHost));
    };
  }, [bootstrap, client]);

  useEffect(() => {
    if (!bootstrap || typeof window === 'undefined' || !client.hostEvent) return undefined;
    const platform = getShortcutPlatform(isMacLikePlatform());
    const binding = resolveShortcutBinding(shortcutOptions, 'toggleAIPanel', platform);
    if (!binding.enabled) return undefined;

    const handleToggleAIShortcut = (event: KeyboardEvent) => {
      if (!isShortcutMatch(event, binding.combo)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.repeat) return;
      hostEventSequenceRef.current += 1;
      void client.hostEvent?.({
        id: bootstrap.id,
        kind: bootstrap.kind,
        hostEvent: {
          id: `${bootstrap.id}:${Date.now()}:${hostEventSequenceRef.current}`,
          name: 'gonavi:shortcut:toggle-ai-panel',
        },
      }).catch((error) => {
        console.warn('[Native Detached Window] Failed to forward AI shortcut to host', error);
      });
    };
    const listenerOptions = { capture: true };
    window.addEventListener('keydown', handleToggleAIShortcut, listenerOptions);
    return () => window.removeEventListener('keydown', handleToggleAIShortcut, listenerOptions);
  }, [bootstrap, client, shortcutOptions]);

  useEffect(() => {
    if (!bootstrap || !contentMounted || !contentReady) return undefined;
    let active = true;
    void Promise.resolve(client.present?.())
      .then(() => waitForNativeDetachedContentPaint())
      .then(() => {
        if (!active) return undefined;
        return client.ready({ id: bootstrap.id, kind: bootstrap.kind }).then(() => {
          if (active) setControllerEnabled(true);
        });
      })
      .catch((error) => {
        if (!active) return;
        setLoadError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      active = false;
    };
  }, [bootstrap, client, contentMounted, contentReady]);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    document.body.setAttribute('data-theme', effectiveThemeMode === 'dark' ? 'dark' : 'light');
    document.body.setAttribute('data-ui-version', 'v2');
    document.body.style.color = effectiveThemeMode === 'dark' ? '#ffffff' : '#111827';
    document.body.style.fontSize = `${Math.max(10, Number(fontSize) || 14)}px`;
    document.documentElement.style.colorScheme = effectiveThemeMode === 'dark' ? 'dark' : 'light';
  }, [effectiveThemeMode, fontSize]);

  const readCurrentTab = useCallback((): TabData | undefined => {
    const bootstrapTab = bootstrap?.payload.tab;
    if (!bootstrapTab) return undefined;
    return resolveLiveQueryTab(
      useStore.getState().tabs.find((item) => item.id === bootstrapTab.id)
        || bootstrapTab,
    );
  }, [bootstrap]);

  const readUnsyncedSqlLogs = useCallback((): SqlLog[] => {
    const syncedIds = syncedSqlLogIdsRef.current;
    return (useStore.getState().sqlLogs || []).filter((log) => {
      const id = String(log.id || '').trim();
      return id !== '' && !syncedIds.has(id);
    });
  }, []);

  const markSqlLogsSynced = useCallback((logs: SqlLog[]): void => {
    for (const log of logs) {
      const id = String(log.id || '').trim();
      if (id) syncedSqlLogIdsRef.current.add(id);
    }
  }, []);

  const readWorkbenchSyncData = useCallback(() => {
    if (bootstrap?.kind !== 'workbench' && bootstrap?.kind !== 'query-result') {
      return {
        workbenchState: {},
        workbenchStateBase: {},
        openedTabs: [] as TabData[],
      };
    }
    const state = useStore.getState();
    const workbenchState = buildNativeDetachedChangedWorkbenchStoreSnapshot(
      state,
      workbenchStateSourceRef.current,
    );
    const workbenchStateBase = buildNativeDetachedStoreSnapshot(Object.fromEntries(
      Object.keys(workbenchState).map((key) => [key, workbenchStateSourceRef.current[key]]),
    ));
    return {
      workbenchState,
      workbenchStateBase,
      openedTabs: bootstrap.kind === 'workbench'
        ? resolveLiveQueryTabs(state.tabs.filter(
          (tab) => !syncedWorkbenchTabIdsRef.current.has(String(tab.id || '').trim()),
        ))
        : [],
    };
  }, [bootstrap?.kind]);

  const markWorkbenchStateSynced = useCallback((
    workbenchState: NativeDetachedStoreSnapshot,
    openedTabs: TabData[],
  ): void => {
    workbenchStateSourceRef.current = advanceNativeDetachedStoreSource(
      workbenchStateSourceRef.current,
      workbenchState,
    );
    for (const tab of openedTabs) {
      const id = String(tab.id || '').trim();
      if (id) syncedWorkbenchTabIdsRef.current.add(id);
    }
  }, []);

  const nextActionRevision = useCallback((): number => {
    actionRevisionRef.current += 1;
    return actionRevisionRef.current;
  }, []);

  const enqueueAction = useCallback(<T,>(operation: () => Promise<T>): Promise<T> => {
    const result = actionQueueRef.current.catch(() => undefined).then(operation);
    actionQueueRef.current = result.then(() => undefined, () => undefined);
    return result;
  }, []);
  return {
    i18n, translate, bootstrap, loadError, contentMounted, setContentMounted, controllerEnabled,
    customThemeOverride, markContentReady, terminalAction, setTerminalAction,
    terminalCloseRecoveryAvailable, setTerminalCloseRecoveryAvailable, terminalCloseRecoveryPending,
    setTerminalCloseRecoveryPending, terminalActionStartedRef, terminalActionRequestedRef,
    terminalActionGenerationRef, terminalCloseRecoveryPendingRef, openAISettingsAfterHideRef,
    openAISettingsProviderIdRef, activeTerminalActionRef, closePreemptionRequestedRef,
    hideVisibilityRevisionRef, lastFocusVisibilityRevisionRef, aiTerminalGuardRef, resultSessionRef,
    queryResultWindowRef, queryResultDirtyGenerationRef, scheduleSyncRef, syncedSqlLogIdsRef,
    sqlLogsClearPendingRef, syncTimerRef, syncIncludesResultSessionRef, actionQueueRef,
    handleQueryResultStateChange, fontSize, uiScale, computedCustomThemeAntTokens,
    setComputedCustomThemeAntTokens, effectiveThemeMode, readCurrentTab, readUnsyncedSqlLogs,
    markSqlLogsSynced, readWorkbenchSyncData, markWorkbenchStateSynced, nextActionRevision,
    enqueueAction,
  };
};

export type NativeDetachedWindowStateApi = ReturnType<typeof useNativeDetachedWindowState>;
