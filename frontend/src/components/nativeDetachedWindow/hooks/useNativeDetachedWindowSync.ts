import { useCallback, useEffect } from 'react';
import { buildActionPayload } from '../nativeDetachedAppClient';
import { NATIVE_DETACHED_SYNC_DEBOUNCE_MS } from '../nativeDetachedAppearance';
import { useStore } from '../../../store';
import { subscribeQueryEditorResultSession } from '../../../utils/queryEditorResultSessionCache';
import { subscribeQueryTabDraftChanges } from '../../../utils/sqlFileTabDrafts';
import type { NativeDetachedWindowStateApi } from './useNativeDetachedWindowState';
import type { NativeDetachedWindowAppProps } from '../../NativeDetachedWindowApp';

export interface UseNativeDetachedWindowSyncInput {
  client: Exclude<NativeDetachedWindowAppProps['client'], undefined>;
  bootstrap: NativeDetachedWindowStateApi['bootstrap'];
  terminalAction: NativeDetachedWindowStateApi['terminalAction'];
  syncIncludesResultSessionRef: NativeDetachedWindowStateApi['syncIncludesResultSessionRef'];
  syncTimerRef: NativeDetachedWindowStateApi['syncTimerRef'];
  enqueueAction: NativeDetachedWindowStateApi['enqueueAction'];
  readUnsyncedSqlLogs: NativeDetachedWindowStateApi['readUnsyncedSqlLogs'];
  sqlLogsClearPendingRef: NativeDetachedWindowStateApi['sqlLogsClearPendingRef'];
  queryResultDirtyGenerationRef: NativeDetachedWindowStateApi['queryResultDirtyGenerationRef'];
  readWorkbenchSyncData: NativeDetachedWindowStateApi['readWorkbenchSyncData'];
  readCurrentTab: NativeDetachedWindowStateApi['readCurrentTab'];
  resultSessionRef: NativeDetachedWindowStateApi['resultSessionRef'];
  nextActionRevision: NativeDetachedWindowStateApi['nextActionRevision'];
  queryResultWindowRef: NativeDetachedWindowStateApi['queryResultWindowRef'];
  syncedSqlLogIdsRef: NativeDetachedWindowStateApi['syncedSqlLogIdsRef'];
  markSqlLogsSynced: NativeDetachedWindowStateApi['markSqlLogsSynced'];
  markWorkbenchStateSynced: NativeDetachedWindowStateApi['markWorkbenchStateSynced'];
  scheduleSyncRef: NativeDetachedWindowStateApi['scheduleSyncRef'];
  openAISettingsAfterHideRef: NativeDetachedWindowStateApi['openAISettingsAfterHideRef'];
  lastFocusVisibilityRevisionRef: NativeDetachedWindowStateApi['lastFocusVisibilityRevisionRef'];
  terminalActionRequestedRef: NativeDetachedWindowStateApi['terminalActionRequestedRef'];
  activeTerminalActionRef: NativeDetachedWindowStateApi['activeTerminalActionRef'];
  hideVisibilityRevisionRef: NativeDetachedWindowStateApi['hideVisibilityRevisionRef'];
  closePreemptionRequestedRef: NativeDetachedWindowStateApi['closePreemptionRequestedRef'];
  terminalActionGenerationRef: NativeDetachedWindowStateApi['terminalActionGenerationRef'];
  setTerminalCloseRecoveryAvailable: NativeDetachedWindowStateApi['setTerminalCloseRecoveryAvailable'];
  setContentMounted: NativeDetachedWindowStateApi['setContentMounted'];
  setTerminalAction: NativeDetachedWindowStateApi['setTerminalAction'];
  openAISettingsProviderIdRef: NativeDetachedWindowStateApi['openAISettingsProviderIdRef'];
}

export const useNativeDetachedWindowSync = ({
  client, bootstrap, terminalAction, syncIncludesResultSessionRef, syncTimerRef, enqueueAction,
  readUnsyncedSqlLogs, sqlLogsClearPendingRef, queryResultDirtyGenerationRef, readWorkbenchSyncData,
  readCurrentTab, resultSessionRef, nextActionRevision, queryResultWindowRef, syncedSqlLogIdsRef,
  markSqlLogsSynced, markWorkbenchStateSynced, scheduleSyncRef, openAISettingsAfterHideRef,
  lastFocusVisibilityRevisionRef, terminalActionRequestedRef, activeTerminalActionRef,
  hideVisibilityRevisionRef, closePreemptionRequestedRef, terminalActionGenerationRef,
  setTerminalCloseRecoveryAvailable, setContentMounted, setTerminalAction,
  openAISettingsProviderIdRef,
}: UseNativeDetachedWindowSyncInput) => {
  const scheduleSync = useCallback((includeResultSession = false) => {
    if (!bootstrap || terminalAction) return;
    syncIncludesResultSessionRef.current = syncIncludesResultSessionRef.current || includeResultSession;
    if (syncTimerRef.current !== null) {
      clearTimeout(syncTimerRef.current);
    }
    syncTimerRef.current = setTimeout(() => {
      syncTimerRef.current = null;
      void enqueueAction(async () => {
        const shouldIncludeResultSession = syncIncludesResultSessionRef.current;
        syncIncludesResultSessionRef.current = false;
        const newSqlLogs = readUnsyncedSqlLogs();
        const clearSqlLogs = sqlLogsClearPendingRef.current;
        const queryResultDirtyGeneration = queryResultDirtyGenerationRef.current;
        const queryResultChanged = queryResultDirtyGeneration > 0;
        const { workbenchState, workbenchStateBase, openedTabs } = readWorkbenchSyncData();
        if (
          bootstrap.kind === 'query-result'
          && newSqlLogs.length === 0
          && !clearSqlLogs
          && !queryResultChanged
          && Object.keys(workbenchState).length === 0
        ) return;
        await client.sync(buildActionPayload(
          bootstrap,
          readCurrentTab(),
          resultSessionRef.current,
          shouldIncludeResultSession,
          newSqlLogs,
          nextActionRevision(),
          workbenchState,
          workbenchStateBase,
          openedTabs,
          clearSqlLogs,
          queryResultWindowRef.current,
        ));
        if (
          queryResultChanged
          && queryResultDirtyGenerationRef.current === queryResultDirtyGeneration
        ) {
          queryResultDirtyGenerationRef.current = 0;
        }
        if (clearSqlLogs) {
          syncedSqlLogIdsRef.current.clear();
          sqlLogsClearPendingRef.current = false;
        }
        markSqlLogsSynced(newSqlLogs);
        markWorkbenchStateSynced(workbenchState, openedTabs);
      }).catch((error) => {
        console.warn('[Native Detached Window] Failed to sync tab state', error);
      });
    }, NATIVE_DETACHED_SYNC_DEBOUNCE_MS);
  }, [
    bootstrap,
    client,
    enqueueAction,
    markSqlLogsSynced,
    markWorkbenchStateSynced,
    nextActionRevision,
    readCurrentTab,
    readUnsyncedSqlLogs,
    readWorkbenchSyncData,
    terminalAction,
  ]);
  scheduleSyncRef.current = scheduleSync;

  useEffect(() => {
    if (!bootstrap) {
      return undefined;
    }
    const unsubscribeStore = useStore.subscribe((state, previousState) => {
      if (
        (previousState?.sqlLogs?.length || 0) > 0
        && (state.sqlLogs?.length || 0) === 0
      ) {
        sqlLogsClearPendingRef.current = true;
      }
      scheduleSync(false);
    });
    const unsubscribeResultSession = bootstrap.kind === 'workbench' && bootstrap.payload.tab
      ? subscribeQueryEditorResultSession(
          bootstrap.payload.tab.id,
          (snapshot) => {
            // QueryEditor consumes the initial cache entry during mount. Keep
            // the last non-null snapshot for the final attach action.
            if (snapshot) {
              resultSessionRef.current = snapshot;
              scheduleSync(false);
            }
          },
        )
      : () => undefined;
    const unsubscribeQueryDrafts = bootstrap.kind === 'workbench'
      ? subscribeQueryTabDraftChanges(() => scheduleSync(false))
      : () => undefined;
    return () => {
      unsubscribeStore();
      unsubscribeResultSession();
      unsubscribeQueryDrafts();
      if (syncTimerRef.current !== null) {
        clearTimeout(syncTimerRef.current);
        syncTimerRef.current = null;
      }
    };
  }, [bootstrap, scheduleSync]);

  const requestTerminalAction = useCallback((
    action: 'attach' | 'hide' | 'close',
    visibilityRevision = 0,
  ) => {
    if (!bootstrap) return;
    if (action !== 'hide') openAISettingsAfterHideRef.current = false;
    const normalizedVisibilityRevision = Math.trunc(Number(visibilityRevision));
    if (
      action === 'hide'
      && Number.isFinite(normalizedVisibilityRevision)
      && normalizedVisibilityRevision > 0
      && normalizedVisibilityRevision <= lastFocusVisibilityRevisionRef.current
    ) {
      return;
    }
    if (terminalActionRequestedRef.current) {
      if (
        action === 'hide'
        && activeTerminalActionRef.current === 'hide'
        && Number.isFinite(normalizedVisibilityRevision)
        && normalizedVisibilityRevision > 0
      ) {
        hideVisibilityRevisionRef.current = Math.max(
          hideVisibilityRevisionRef.current,
          normalizedVisibilityRevision,
        );
      }
      if (action === 'close' && activeTerminalActionRef.current === 'hide') {
        closePreemptionRequestedRef.current = true;
      }
      return;
    }
    if (action === 'hide' && bootstrap.kind !== 'ai-chat') return;
    terminalActionGenerationRef.current += 1;
    setTerminalCloseRecoveryAvailable(false);
    terminalActionRequestedRef.current = true;
    activeTerminalActionRef.current = action;
    closePreemptionRequestedRef.current = false;
    hideVisibilityRevisionRef.current = action === 'hide'
      && Number.isFinite(normalizedVisibilityRevision)
      && normalizedVisibilityRevision > 0
      ? normalizedVisibilityRevision
      : 0;
    if (syncTimerRef.current !== null) {
      clearTimeout(syncTimerRef.current);
      syncTimerRef.current = null;
    }
    if (bootstrap.kind !== 'ai-chat') setContentMounted(false);
    setTerminalAction(action);
  }, [bootstrap]);

  const requestOpenAISettings = useCallback((providerId?: string) => {
    if (
      !bootstrap
      || bootstrap.kind !== 'ai-chat'
      || terminalActionRequestedRef.current
    ) return;
    openAISettingsAfterHideRef.current = true;
    openAISettingsProviderIdRef.current = String(providerId || '').trim();
    requestTerminalAction('hide');
  }, [bootstrap, requestTerminalAction]);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const handleGracefulCloseRequest = () => requestTerminalAction('close');
    const handleHideRequest = (event: Event) => requestTerminalAction(
      'hide',
      Number((event as CustomEvent<{ visibilityRevision?: unknown }>).detail?.visibilityRevision),
    );
    window.addEventListener(
      'gonavi:native-detached-request-close',
      handleGracefulCloseRequest as EventListener,
    );
    window.addEventListener(
      'gonavi:native-detached-request-hide',
      handleHideRequest as EventListener,
    );
    return () => {
      window.removeEventListener(
        'gonavi:native-detached-request-close',
        handleGracefulCloseRequest as EventListener,
      );
      window.removeEventListener(
        'gonavi:native-detached-request-hide',
        handleHideRequest as EventListener,
      );
    };
  }, [requestTerminalAction]);
  return { requestTerminalAction, requestOpenAISettings };
};

export type NativeDetachedWindowSyncApi = ReturnType<typeof useNativeDetachedWindowSync>;
