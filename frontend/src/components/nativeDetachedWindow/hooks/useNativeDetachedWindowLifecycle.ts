import React, { useEffect, useCallback, useMemo } from 'react';
import { peekQueryEditorResultSession } from '../../../utils/queryEditorResultSessionCache';
import { buildActionPayload } from '../nativeDetachedAppClient';
import { NATIVE_DETACHED_CANCEL_CLOSE_ATTEMPTS } from '../nativeDetachedAppearance';
import type { NativeDetachedWindowActionPayload } from '../../../utils/nativeDetachedWindowClient';
import {
  isWailsDevNativeContextMenu,
  shouldAllowNativeContextMenu,
} from '../../../utils/nativeContextMenu';
import type { NativeDetachedWindowStateApi } from './useNativeDetachedWindowState';
import type { NativeDetachedWindowSyncApi } from './useNativeDetachedWindowSync';
import type { NativeDetachedWindowAppProps } from '../../NativeDetachedWindowApp';

export interface UseNativeDetachedWindowLifecycleInput {
  client: Exclude<NativeDetachedWindowAppProps['client'], undefined>;
  bootstrap: NativeDetachedWindowStateApi['bootstrap'];
  terminalAction: NativeDetachedWindowStateApi['terminalAction'];
  setTerminalAction: NativeDetachedWindowStateApi['setTerminalAction'];
  terminalActionStartedRef: NativeDetachedWindowStateApi['terminalActionStartedRef'];
  terminalActionRequestedRef: NativeDetachedWindowStateApi['terminalActionRequestedRef'];
  activeTerminalActionRef: NativeDetachedWindowStateApi['activeTerminalActionRef'];
  contentMounted: NativeDetachedWindowStateApi['contentMounted'];
  setContentMounted: NativeDetachedWindowStateApi['setContentMounted'];
  terminalActionGenerationRef: NativeDetachedWindowStateApi['terminalActionGenerationRef'];
  resultSessionRef: NativeDetachedWindowStateApi['resultSessionRef'];
  readWorkbenchSyncData: NativeDetachedWindowStateApi['readWorkbenchSyncData'];
  readCurrentTab: NativeDetachedWindowStateApi['readCurrentTab'];
  readUnsyncedSqlLogs: NativeDetachedWindowStateApi['readUnsyncedSqlLogs'];
  nextActionRevision: NativeDetachedWindowStateApi['nextActionRevision'];
  sqlLogsClearPendingRef: NativeDetachedWindowStateApi['sqlLogsClearPendingRef'];
  queryResultWindowRef: NativeDetachedWindowStateApi['queryResultWindowRef'];
  setTerminalCloseRecoveryAvailable: NativeDetachedWindowStateApi['setTerminalCloseRecoveryAvailable'];
  closePreemptionRequestedRef: NativeDetachedWindowStateApi['closePreemptionRequestedRef'];
  hideVisibilityRevisionRef: NativeDetachedWindowStateApi['hideVisibilityRevisionRef'];
  actionQueueRef: NativeDetachedWindowStateApi['actionQueueRef'];
  aiTerminalGuardRef: NativeDetachedWindowStateApi['aiTerminalGuardRef'];
  syncedSqlLogIdsRef: NativeDetachedWindowStateApi['syncedSqlLogIdsRef'];
  markSqlLogsSynced: NativeDetachedWindowStateApi['markSqlLogsSynced'];
  markWorkbenchStateSynced: NativeDetachedWindowStateApi['markWorkbenchStateSynced'];
  openAISettingsAfterHideRef: NativeDetachedWindowStateApi['openAISettingsAfterHideRef'];
  openAISettingsProviderIdRef: NativeDetachedWindowStateApi['openAISettingsProviderIdRef'];
  terminalCloseRecoveryAvailable: NativeDetachedWindowStateApi['terminalCloseRecoveryAvailable'];
  terminalCloseRecoveryPendingRef: NativeDetachedWindowStateApi['terminalCloseRecoveryPendingRef'];
  setTerminalCloseRecoveryPending: NativeDetachedWindowStateApi['setTerminalCloseRecoveryPending'];
  requestTerminalAction: NativeDetachedWindowSyncApi['requestTerminalAction'];
  translate: NativeDetachedWindowStateApi['translate'];
  effectiveThemeMode: NativeDetachedWindowStateApi['effectiveThemeMode'];
  computedCustomThemeAntTokens: NativeDetachedWindowStateApi['computedCustomThemeAntTokens'];
  uiScale: NativeDetachedWindowStateApi['uiScale'];
}

export const useNativeDetachedWindowLifecycle = ({
  client, bootstrap, terminalAction, setTerminalAction, terminalActionStartedRef,
  terminalActionRequestedRef, activeTerminalActionRef, contentMounted, setContentMounted,
  terminalActionGenerationRef, resultSessionRef, readWorkbenchSyncData, readCurrentTab,
  readUnsyncedSqlLogs, nextActionRevision, sqlLogsClearPendingRef, queryResultWindowRef,
  setTerminalCloseRecoveryAvailable, closePreemptionRequestedRef, hideVisibilityRevisionRef,
  actionQueueRef, aiTerminalGuardRef, syncedSqlLogIdsRef, markSqlLogsSynced,
  markWorkbenchStateSynced, openAISettingsAfterHideRef, openAISettingsProviderIdRef,
  terminalCloseRecoveryAvailable, terminalCloseRecoveryPendingRef, setTerminalCloseRecoveryPending,
  requestTerminalAction, translate, effectiveThemeMode, computedCustomThemeAntTokens, uiScale,
}: UseNativeDetachedWindowLifecycleInput) => {
  useEffect(() => {
    if (
      !bootstrap
      || !terminalAction
      || terminalActionStartedRef.current
      || !terminalActionRequestedRef.current
      || activeTerminalActionRef.current !== terminalAction
      || (bootstrap.kind !== 'ai-chat' && contentMounted)
    ) {
      return;
    }
    terminalActionStartedRef.current = true;
    const terminalActionGeneration = terminalActionGenerationRef.current;
    const isCurrentTerminalAction = () => (
      terminalActionGenerationRef.current === terminalActionGeneration
    );

    // Workbench content has unmounted before this effect runs, so QueryEditor
    // has published its final result session to the cache.
    const currentSession = bootstrap.payload.tab
      ? peekQueryEditorResultSession(bootstrap.payload.tab.id) || resultSessionRef.current
      : null;
    void (async () => {
      let actionToRun = terminalAction;
      let closeActionSubmitted = false;
      const submitPreemptingClose = async () => {
        const closeWorkbench = readWorkbenchSyncData();
        await client.close(buildActionPayload(
          bootstrap,
          readCurrentTab(),
          currentSession,
          false,
          readUnsyncedSqlLogs(),
          nextActionRevision(),
          closeWorkbench.workbenchState,
          closeWorkbench.workbenchStateBase,
          closeWorkbench.openedTabs,
          sqlLogsClearPendingRef.current,
          queryResultWindowRef.current,
        ));
        closeActionSubmitted = true;
        actionToRun = 'close';
      };
      const rollbackTerminalAction = async () => {
        setTerminalCloseRecoveryAvailable(false);
        let parentCancelError: unknown;
        let parentCancelSucceeded = !client.cancelCloseRequest;
        for (
          let attempt = 0;
          client.cancelCloseRequest && attempt < NATIVE_DETACHED_CANCEL_CLOSE_ATTEMPTS;
          attempt += 1
        ) {
          const cancelWorkbench = readWorkbenchSyncData();
          const cancelPayload = {
            ...buildActionPayload(
              bootstrap,
              readCurrentTab(),
              currentSession,
              false,
              readUnsyncedSqlLogs(),
              nextActionRevision(),
              cancelWorkbench.workbenchState,
              cancelWorkbench.workbenchStateBase,
              cancelWorkbench.openedTabs,
              sqlLogsClearPendingRef.current,
              queryResultWindowRef.current,
            ),
            rollbackAction: actionToRun,
          } satisfies NativeDetachedWindowActionPayload;
          try {
            await client.cancelCloseRequest(cancelPayload);
            parentCancelSucceeded = true;
            break;
          } catch (error) {
            parentCancelError = error;
          }
        }
        if (!parentCancelSucceeded) {
          console.error(
            '[Native Detached Window] Failed to cancel parent close fallback',
            parentCancelError,
          );
        }
        if (!isCurrentTerminalAction()) return;
        let localCancelError: unknown;
        let localCancelSucceeded = false;
        try {
          await client.cancelClose?.();
          localCancelSucceeded = true;
        } catch (error) {
          localCancelError = error;
          console.error(
            '[Native Detached Window] Failed to cancel local close fallback',
            localCancelError,
          );
        }
        if (!isCurrentTerminalAction()) return;
        if (!parentCancelSucceeded || !localCancelSucceeded) {
          try {
            await client.closeCurrentWindow();
          } catch (convergenceError) {
            console.error(
              '[Native Detached Window] Failed to converge after close rollback',
              convergenceError,
            );
            setTerminalCloseRecoveryAvailable(true);
          }
          return;
        }
        terminalActionStartedRef.current = false;
        terminalActionRequestedRef.current = false;
        activeTerminalActionRef.current = null;
        closePreemptionRequestedRef.current = false;
        hideVisibilityRevisionRef.current = 0;
        setTerminalCloseRecoveryAvailable(false);
        setTerminalAction(null);
        setContentMounted(true);
      };
      try {
        await actionQueueRef.current;
        if (!isCurrentTerminalAction()) return;
        if (bootstrap.kind === 'ai-chat') {
          const canTerminate = await aiTerminalGuardRef.current?.();
          if (!isCurrentTerminalAction()) return;
          if (canTerminate === false) {
            throw new Error('AI stream did not stop before the detached window handoff');
          }
        }
        actionToRun = closePreemptionRequestedRef.current ? 'close' : terminalAction;
        if (actionToRun === 'attach' && bootstrap.kind === 'workbench') {
          const finalSqlLogs = readUnsyncedSqlLogs();
          const clearSqlLogs = sqlLogsClearPendingRef.current;
          const finalWorkbench = readWorkbenchSyncData();
          try {
            await client.sync(buildActionPayload(
              bootstrap,
              readCurrentTab(),
              currentSession,
              true,
              finalSqlLogs,
              nextActionRevision(),
              finalWorkbench.workbenchState,
              finalWorkbench.workbenchStateBase,
              finalWorkbench.openedTabs,
              clearSqlLogs,
              queryResultWindowRef.current,
            ));
            if (clearSqlLogs) {
              syncedSqlLogIdsRef.current.clear();
              sqlLogsClearPendingRef.current = false;
            }
            markSqlLogsSynced(finalSqlLogs);
            markWorkbenchStateSynced(
              finalWorkbench.workbenchState,
              finalWorkbench.openedTabs,
            );
          } catch (error) {
            // The attach request carries the same final tab/session payload, so
            // a failed best-effort sync must not prevent the user from restoring.
            console.warn('[Native Detached Window] Final sync before attach failed', error);
          }
        }
        const terminalWorkbench = readWorkbenchSyncData();
        const payload = buildActionPayload(
          bootstrap,
          readCurrentTab(),
          currentSession,
          actionToRun === 'attach',
          readUnsyncedSqlLogs(),
          nextActionRevision(),
          terminalWorkbench.workbenchState,
          terminalWorkbench.workbenchStateBase,
          terminalWorkbench.openedTabs,
          sqlLogsClearPendingRef.current,
          queryResultWindowRef.current,
        );
        if (actionToRun === 'attach') {
          await client.attach(payload);
        } else if (actionToRun === 'hide') {
          let visibilityRevision = hideVisibilityRevisionRef.current;
          if (visibilityRevision > 0) {
            await client.sync(payload);
            if (!isCurrentTerminalAction()) return;
          } else {
            if (!client.hide) throw new Error('Native detached hide action is unavailable');
            visibilityRevision = await client.hide(payload);
            if (!isCurrentTerminalAction()) return;
            hideVisibilityRevisionRef.current = Math.max(
              hideVisibilityRevisionRef.current,
              visibilityRevision,
            );
          }
          if (closePreemptionRequestedRef.current) {
            await submitPreemptingClose();
          } else if (openAISettingsAfterHideRef.current) {
            const providerId = openAISettingsProviderIdRef.current;
            if (providerId) {
              await client.openAISettings(visibilityRevision, providerId);
            } else {
              await client.openAISettings(visibilityRevision);
            }
          } else {
            if (!client.hideCurrentWindow) {
              throw new Error('Native detached hide control is unavailable');
            }
            await client.hideCurrentWindow(visibilityRevision);
            if (!isCurrentTerminalAction()) return;
            if (closePreemptionRequestedRef.current) {
              await submitPreemptingClose();
            }
          }
        } else {
          await client.close(payload);
          closeActionSubmitted = true;
        }
      } catch (error) {
        if (!isCurrentTerminalAction()) return;
        console.error(`[Native Detached Window] Failed to ${actionToRun}`, error);
        if (closePreemptionRequestedRef.current && !closeActionSubmitted) {
          try {
            await submitPreemptingClose();
          } catch (closeError) {
            console.error('[Native Detached Window] Failed to continue with requested close', closeError);
          }
        }
        if (
          actionToRun === 'hide'
          && !closeActionSubmitted
          && !openAISettingsAfterHideRef.current
        ) {
          const visibilityRevision = hideVisibilityRevisionRef.current;
          if (visibilityRevision > 0) {
            try {
              await client.hideCurrentWindow?.(visibilityRevision);
              if (!isCurrentTerminalAction()) return;
            } catch (localHideError) {
              if (!isCurrentTerminalAction()) return;
              console.error('[Native Detached Window] Failed to apply requested hide', localHideError);
            }
          }
          if (closePreemptionRequestedRef.current && !closeActionSubmitted) {
            try {
              await submitPreemptingClose();
            } catch (closeError) {
              console.error('[Native Detached Window] Failed to continue with requested close', closeError);
            }
          }
        }
        if (!isCurrentTerminalAction()) return;
        if (actionToRun === 'hide' && !closeActionSubmitted) {
          openAISettingsAfterHideRef.current = false;
          openAISettingsProviderIdRef.current = '';
          terminalActionStartedRef.current = false;
          terminalActionRequestedRef.current = false;
          activeTerminalActionRef.current = null;
          closePreemptionRequestedRef.current = false;
          hideVisibilityRevisionRef.current = 0;
          setTerminalCloseRecoveryAvailable(false);
          setTerminalAction(null);
          return;
        }
        if (!closeActionSubmitted) {
          await rollbackTerminalAction();
          return;
        }
      }
      if (!isCurrentTerminalAction()) return;
      if (actionToRun === 'hide') {
        openAISettingsAfterHideRef.current = false;
        openAISettingsProviderIdRef.current = '';
        terminalActionStartedRef.current = false;
        terminalActionRequestedRef.current = false;
        activeTerminalActionRef.current = null;
        closePreemptionRequestedRef.current = false;
        hideVisibilityRevisionRef.current = 0;
        setTerminalCloseRecoveryAvailable(false);
        setTerminalAction(null);
        return;
      }
      try {
        await client.closeCurrentWindow();
      } catch (error) {
        console.error('[Native Detached Window] Failed to close native window', error);
        await rollbackTerminalAction();
      }
    })();
  }, [
    bootstrap,
    client,
    contentMounted,
    markSqlLogsSynced,
    markWorkbenchStateSynced,
    nextActionRevision,
    readCurrentTab,
    readUnsyncedSqlLogs,
    readWorkbenchSyncData,
    terminalAction,
  ]);

  const retryTerminalClose = useCallback(() => {
    if (!terminalCloseRecoveryAvailable || terminalCloseRecoveryPendingRef.current) return;
    terminalCloseRecoveryPendingRef.current = true;
    setTerminalCloseRecoveryPending(true);
    void client.closeCurrentWindow()
      .then(() => {
        setTerminalCloseRecoveryAvailable(false);
      })
      .catch((error) => {
        console.error('[Native Detached Window] Failed to retry native window close', error);
      })
      .finally(() => {
        terminalCloseRecoveryPendingRef.current = false;
        setTerminalCloseRecoveryPending(false);
      });
  }, [client, terminalCloseRecoveryAvailable]);

  const requestWindowClose = useCallback(() => {
    requestTerminalAction(bootstrap?.kind === 'ai-chat' ? 'hide' : 'close');
  }, [bootstrap?.kind, requestTerminalAction]);

  const chromeLabels = useMemo(() => ({
    attach: bootstrap?.kind === 'workbench'
      ? translate('tab_manager.detached.restore')
      : bootstrap?.kind === 'ai-chat'
        ? translate('ai_chat.detached.action.dock')
        : translate('query_editor.results_panel.detached.restore'),
    close: bootstrap?.kind === 'workbench'
      ? translate('tab_manager.detached.close')
      : bootstrap?.kind === 'ai-chat'
        ? translate('ai_chat.header.tooltip.close')
        : translate('query_editor.results_panel.detached.close'),
  }), [bootstrap?.kind, translate]);

  const isDark = effectiveThemeMode === 'dark';
  const customThemeStyleContextKey = `${effectiveThemeMode}:v2`;
  const customThemeAntTokens = computedCustomThemeAntTokens?.contextKey === customThemeStyleContextKey
    ? computedCustomThemeAntTokens.tokens
    : {};
  const v2PrimaryColor = customThemeAntTokens.primary ?? (isDark ? '#22c55e' : '#16a34a');
  const v2PrimaryContrastColor = customThemeAntTokens.primaryContrast ?? '#ffffff';
  const v2PrimaryHoverColor = customThemeAntTokens.primaryHover ?? (isDark ? '#4ade80' : '#15803d');
  const v2PrimaryActiveColor = customThemeAntTokens.primaryActive ?? (isDark ? '#16a34a' : '#166534');
  const v2PrimaryBgColor = customThemeAntTokens.primaryBg ?? (isDark ? 'rgba(34, 197, 94, 0.20)' : '#dcfce7');
  const v2PrimaryBgHoverColor = customThemeAntTokens.primaryBgHover ?? (isDark ? 'rgba(34, 197, 94, 0.28)' : '#bbf7d0');
  const v2PrimaryBorderColor = customThemeAntTokens.primaryBorder ?? (isDark ? 'rgba(34, 197, 94, 0.42)' : '#86efac');
  const v2PrimaryBorderHoverColor = customThemeAntTokens.primaryBorderHover ?? (isDark ? 'rgba(74, 222, 128, 0.58)' : '#4ade80');
  const v2ControlActiveBg = customThemeAntTokens.controlActiveBg ?? (isDark ? 'rgba(34, 197, 94, 0.16)' : 'rgba(34, 197, 94, 0.10)');
  const v2ControlActiveHoverBg = customThemeAntTokens.controlActiveHoverBg ?? (isDark ? 'rgba(34, 197, 94, 0.24)' : 'rgba(34, 197, 94, 0.16)');
  const v2ControlOutline = customThemeAntTokens.controlOutline ?? (isDark ? 'rgba(34, 197, 94, 0.42)' : 'rgba(22, 163, 74, 0.22)');
  const componentSize: 'small' | 'middle' | 'large' = uiScale <= 0.92 ? 'small' : (uiScale >= 1.12 ? 'large' : 'middle');
  const allowDebugNativeContextMenu = isWailsDevNativeContextMenu(import.meta.env.DEV);
  const handleWindowContextMenu = useCallback((event: React.MouseEvent<HTMLElement>) => {
    if (event.defaultPrevented || shouldAllowNativeContextMenu(event.target, { allowDebugMenu: allowDebugNativeContextMenu })) return;
    event.preventDefault();
  }, [allowDebugNativeContextMenu]);
  return {
    retryTerminalClose, requestWindowClose, chromeLabels, isDark, customThemeStyleContextKey,
    customThemeAntTokens, v2PrimaryColor, v2PrimaryContrastColor, v2PrimaryHoverColor,
    v2PrimaryActiveColor, v2PrimaryBgColor, v2PrimaryBgHoverColor, v2PrimaryBorderColor,
    v2PrimaryBorderHoverColor, v2ControlActiveBg, v2ControlActiveHoverBg, v2ControlOutline,
    componentSize, handleWindowContextMenu,
  };
};

export type NativeDetachedWindowLifecycleApi = ReturnType<typeof useNativeDetachedWindowLifecycle>;
