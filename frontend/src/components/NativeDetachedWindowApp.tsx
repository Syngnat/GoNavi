import React from 'react';
import { Button, ConfigProvider, Spin, Tooltip, theme as antdTheme } from 'antd';
import { CloseOutlined, CompressOutlined } from '@ant-design/icons';
import { getAntdLocale } from '../i18n/frameworkLocale';
import { APP_OVERLAY_Z_INDEX_BASE } from '../utils/overlayZIndex';
import CustomThemeStyleHost from './theme/CustomThemeStyleHost';
import ToolbarAppearanceStyleHost from './theme/ToolbarAppearanceStyleHost';
import {
  type NativeDetachedWindowClient,
  defaultClient,
} from './nativeDetachedWindow/nativeDetachedAppClient';
import { NativeDetachedWindowController } from './nativeDetachedWindow/nativeDetachedLazyParts';
import { NativeDetachedWindowContent } from './nativeDetachedWindow/NativeDetachedWindowContent';
import {
  useNativeDetachedWindowState,
} from './nativeDetachedWindow/hooks/useNativeDetachedWindowState';
import {
  useNativeDetachedWindowSync,
} from './nativeDetachedWindow/hooks/useNativeDetachedWindowSync';
import {
  useNativeDetachedWindowLifecycle,
} from './nativeDetachedWindow/hooks/useNativeDetachedWindowLifecycle';
export {
  NATIVE_DETACHED_SYNC_DEBOUNCE_MS,
  NATIVE_DETACHED_PAINT_FALLBACK_MS,
  applyNativeDetachedDocumentAppearance,
  waitForNativeDetachedContentPaint,
} from './nativeDetachedWindow/nativeDetachedAppearance';

export interface NativeDetachedWindowAppProps {
  client?: NativeDetachedWindowClient;
}

const NativeDetachedWindowApp: React.FC<NativeDetachedWindowAppProps> = ({
  client = defaultClient,
}) => {
  const {
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
  } = useNativeDetachedWindowState({ client });

  const { requestTerminalAction, requestOpenAISettings } = useNativeDetachedWindowSync({
    client, bootstrap, terminalAction, syncIncludesResultSessionRef, syncTimerRef, enqueueAction,
    readUnsyncedSqlLogs, sqlLogsClearPendingRef, queryResultDirtyGenerationRef,
    readWorkbenchSyncData, readCurrentTab, resultSessionRef, nextActionRevision,
    queryResultWindowRef, syncedSqlLogIdsRef, markSqlLogsSynced, markWorkbenchStateSynced,
    scheduleSyncRef, openAISettingsAfterHideRef, lastFocusVisibilityRevisionRef,
    terminalActionRequestedRef, activeTerminalActionRef, hideVisibilityRevisionRef,
    closePreemptionRequestedRef, terminalActionGenerationRef, setTerminalCloseRecoveryAvailable,
    setContentMounted, setTerminalAction, openAISettingsProviderIdRef,
  });

  const {
    retryTerminalClose, requestWindowClose, chromeLabels, isDark, customThemeStyleContextKey,
    customThemeAntTokens, v2PrimaryColor, v2PrimaryContrastColor, v2PrimaryHoverColor,
    v2PrimaryActiveColor, v2PrimaryBgColor, v2PrimaryBgHoverColor, v2PrimaryBorderColor,
    v2PrimaryBorderHoverColor, v2ControlActiveBg, v2ControlActiveHoverBg, v2ControlOutline,
    componentSize, handleWindowContextMenu,
  } = useNativeDetachedWindowLifecycle({
    client, bootstrap, terminalAction, setTerminalAction, terminalActionStartedRef,
    terminalActionRequestedRef, activeTerminalActionRef, contentMounted, setContentMounted,
    terminalActionGenerationRef, resultSessionRef, readWorkbenchSyncData, readCurrentTab,
    readUnsyncedSqlLogs, nextActionRevision, sqlLogsClearPendingRef, queryResultWindowRef,
    setTerminalCloseRecoveryAvailable, closePreemptionRequestedRef, hideVisibilityRevisionRef,
    actionQueueRef, aiTerminalGuardRef, syncedSqlLogIdsRef, markSqlLogsSynced,
    markWorkbenchStateSynced, openAISettingsAfterHideRef, openAISettingsProviderIdRef,
    terminalCloseRecoveryAvailable, terminalCloseRecoveryPendingRef,
    setTerminalCloseRecoveryPending, requestTerminalAction, translate, effectiveThemeMode,
    computedCustomThemeAntTokens, uiScale,
  });
  return (
    <>
      <CustomThemeStyleHost
        contextKey={customThemeStyleContextKey}
        onAntTokensChange={setComputedCustomThemeAntTokens}
        themeOverride={customThemeOverride}
      />
      <ToolbarAppearanceStyleHost />
      <ConfigProvider
        locale={getAntdLocale(i18n?.language ?? 'en-US')}
        componentSize={componentSize}
        theme={{
          algorithm: isDark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
          token: {
            fontSize: Math.max(10, Number(fontSize) || 14),
            zIndexPopupBase: APP_OVERLAY_Z_INDEX_BASE,
            ...(customThemeAntTokens.bgContainer ? {
              colorBgContainer: customThemeAntTokens.bgContainer,
            } : {}),
            ...(customThemeAntTokens.bgElevated ? {
              colorBgElevated: customThemeAntTokens.bgElevated,
            } : {}),
            ...(customThemeAntTokens.fillAlter ? {
              colorFillAlter: customThemeAntTokens.fillAlter,
            } : {}),
            ...(customThemeAntTokens.textPrimary ? {
              colorText: customThemeAntTokens.textPrimary,
            } : {}),
            ...(customThemeAntTokens.textSecondary ? {
              colorTextSecondary: customThemeAntTokens.textSecondary,
            } : {}),
            ...(customThemeAntTokens.border ? {
              colorBorder: customThemeAntTokens.border,
              colorBorderSecondary: customThemeAntTokens.border,
            } : {}),
            colorPrimary: v2PrimaryColor,
            colorTextLightSolid: v2PrimaryContrastColor,
            colorPrimaryHover: v2PrimaryHoverColor,
            colorPrimaryActive: v2PrimaryActiveColor,
            colorInfo: customThemeAntTokens.info ?? v2PrimaryColor,
            colorPrimaryBg: v2PrimaryBgColor,
            colorPrimaryBgHover: v2PrimaryBgHoverColor,
            colorPrimaryBorder: v2PrimaryBorderColor,
            colorPrimaryBorderHover: v2PrimaryBorderHoverColor,
            controlItemBgActive: v2ControlActiveBg,
            controlItemBgActiveHover: v2ControlActiveHoverBg,
            controlOutline: v2ControlOutline,
          },
        }}
      >
      {bootstrap && controllerEnabled ? (
        <React.Suspense fallback={null}>
          <NativeDetachedWindowController currentWindowId={bootstrap.id} />
        </React.Suspense>
      ) : null}
      <div
        className="gn-native-detached-window"
        data-kind={bootstrap?.kind || 'loading'}
        onContextMenu={handleWindowContextMenu}
      >
        <style>{`
        .gn-native-detached-window {
          position: relative;
          width: 100%;
          height: 100%;
          min-width: 0;
          min-height: 0;
          display: flex;
          flex-direction: column;
          overflow: hidden;
          color: ${isDark ? '#f3f4f6' : '#111827'};
          background: ${isDark ? 'var(--gn-bg-app, #0c0e12)' : 'var(--gn-bg-app, #f6f6f4)'};
        }
        .gn-native-detached-chrome {
          flex: 0 0 36px;
          min-width: 0;
          display: flex;
          align-items: center;
          gap: 4px;
          padding: 0 6px 0 12px;
          border-bottom: 1px solid ${isDark ? 'rgba(255,255,255,0.10)' : 'rgba(15,23,42,0.10)'};
          background: ${isDark ? 'var(--gn-bg-chrome, #14171c)' : 'var(--gn-bg-chrome, #ececea)'};
          user-select: none;
          --wails-draggable: drag;
        }
        .gn-native-detached-title {
          min-width: 0;
          flex: 1 1 auto;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          font-size: 12px;
          font-weight: 600;
        }
        .gn-native-detached-actions {
          flex: 0 0 auto;
          display: inline-flex;
          gap: 2px;
          --wails-draggable: no-drag;
        }
        .gn-native-detached-close-recovery {
          position: absolute;
          top: 6px;
          right: 6px;
          z-index: ${APP_OVERLAY_Z_INDEX_BASE + 1};
          --wails-draggable: no-drag;
        }
        .gn-native-detached-body {
          flex: 1 1 auto;
          min-width: 0;
          min-height: 0;
          display: flex;
          flex-direction: column;
          overflow: hidden;
          background: ${isDark ? 'var(--gn-bg-panel, #161a21)' : 'var(--gn-bg-panel, #ffffff)'};
        }
        .gn-native-detached-loading,
        .gn-native-detached-error {
          flex: 1 1 auto;
          display: grid;
          place-items: center;
          min-width: 0;
          min-height: 0;
          padding: 24px;
        }
        .gn-native-detached-error {
          color: ${isDark ? '#fca5a5' : '#b91c1c'};
          overflow: auto;
          white-space: pre-wrap;
          overflow-wrap: anywhere;
        }
        .gn-native-detached-message {
          flex: 1 1 auto;
          width: 100%;
          min-width: 0;
          min-height: 0;
          box-sizing: border-box;
          margin: 0;
          padding: 12px;
          border: 0;
          resize: none;
          outline: none;
          color: inherit;
          background: transparent;
          font-family: var(--gn-font-mono, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace);
          font-size: 12px;
          line-height: 1.5;
        }
        .gn-native-detached-ai-chat {
          flex: 1 1 auto;
          min-width: 0;
          min-height: 0;
          display: flex;
          overflow: hidden;
        }
        .gn-native-detached-ai-chat .ai-chat-panel {
          width: 100% !important;
          height: 100%;
          min-width: 0;
          border-left: 0 !important;
        }
        .gn-native-detached-ai-chat .ai-resize-handle {
          display: none !important;
        }
        .gn-native-detached-ai-chat .ai-chat-header {
          cursor: move;
          user-select: none;
          --wails-draggable: drag;
        }
        .gn-native-detached-ai-chat .ai-chat-header button,
        .gn-native-detached-ai-chat .ai-chat-header a,
        .gn-native-detached-ai-chat .ai-chat-header input,
        .gn-native-detached-ai-chat .ai-chat-header textarea,
        .gn-native-detached-ai-chat .ai-chat-header-right,
        .gn-native-detached-ai-chat .gn-v2-ai-mode-tabs {
          --wails-draggable: no-drag;
        }
        `}</style>
        {terminalCloseRecoveryAvailable ? (
          <Tooltip title={chromeLabels.close}>
            <Button
              className="gn-native-detached-close-recovery"
              type="text"
              size="small"
              icon={<CloseOutlined />}
              aria-label={chromeLabels.close}
              data-native-close-recovery
              loading={terminalCloseRecoveryPending}
              onClick={retryTerminalClose}
            />
          </Tooltip>
        ) : null}
        {bootstrap?.kind !== 'ai-chat' ? <div className="gn-native-detached-chrome">
          <div className="gn-native-detached-title" title={bootstrap?.title || ''}>
            {bootstrap?.title || ''}
          </div>
          <div className="gn-native-detached-actions">
            <Tooltip title={chromeLabels.attach}>
              <Button
                type="text"
                size="small"
                icon={<CompressOutlined />}
                aria-label={chromeLabels.attach}
                disabled={!bootstrap || Boolean(terminalAction)}
                onClick={() => requestTerminalAction('attach')}
              />
            </Tooltip>
            <Tooltip title={chromeLabels.close}>
              <Button
                type="text"
                size="small"
                icon={<CloseOutlined />}
                aria-label={chromeLabels.close}
                disabled={!bootstrap || Boolean(terminalAction)}
                onClick={requestWindowClose}
              />
            </Tooltip>
          </div>
        </div> : null}
        <div className="gn-native-detached-body">
          {loadError ? (
            <div className="gn-native-detached-error" role="alert">{loadError}</div>
          ) : !bootstrap ? (
            <div className="gn-native-detached-loading"><Spin /></div>
          ) : contentMounted ? (
            <React.Suspense
              fallback={<div className="gn-native-detached-loading"><Spin /></div>}
            >
              <NativeDetachedWindowContent
                bootstrap={bootstrap}
                themeModeOverride={effectiveThemeMode}
                onContentReady={markContentReady}
                onAttach={() => requestTerminalAction('attach')}
                onClose={requestWindowClose}
                onOpenSettings={requestOpenAISettings}
                onRegisterAITerminalGuard={(guard) => {
                  aiTerminalGuardRef.current = guard;
                }}
                interactionDisabled={Boolean(terminalAction)}
                onQueryResultStateChange={handleQueryResultStateChange}
              />
            </React.Suspense>
          ) : null}
        </div>
      </div>
      </ConfigProvider>
    </>
  );
};

export default NativeDetachedWindowApp;
