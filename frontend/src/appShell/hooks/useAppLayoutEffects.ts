import { useLayoutEffect, useEffect } from 'react';
import { message } from 'antd';
import { withAISettingsLeaveGuard } from '../../utils/aiSettingsLeaveGuard';
import { shouldSuppressMacNativeEscapeExit } from '../../utils/macWindow';
import { useStore } from '../../store';
import {
  isEditableElement,
  isImeComposingKeyEvent,
  SHORTCUT_ACTION_ORDER,
  SHORTCUT_ACTION_META,
  resolveShortcutBinding,
  isShortcutMatch,
  eventToShortcut,
  normalizeShortcutCombo,
  canRecordShortcutForAction,
  findEnabledActionConflicts,
  findReservedConflictsForAction,
  splitConflictsByContext,
} from '../../utils/shortcuts';
import {
  resolveCloseShortcutScopeFromTarget,
  resolveCloseShortcutKeydownDecision,
  isCloseShortcutInteractionBlocked,
  dispatchCloseActiveWorkspaceTab,
  resolveDockedActiveTabId,
  dispatchCloseActiveResultTab,
} from '../../utils/closeTabShortcut';
import type { AppCoreStateApi } from './useAppCoreState';
import type { AppShellStateApi } from './useAppShellState';
import type { AppSettingsNavigationApi } from './useAppSettingsNavigation';
import type { AppProxySettingsApi } from './useAppProxySettings';
import type { AppUpdateAndDiagnosticsApi } from './useAppUpdateAndDiagnostics';
import type { AppWorkbenchActionsApi } from './useAppWorkbenchActions';

export interface UseAppLayoutEffectsInput {
  darkMode: AppCoreStateApi['darkMode'];
  documentPlatform: AppShellStateApi['documentPlatform'];
  effectiveFontSize: AppCoreStateApi['effectiveFontSize'];
  resolvedUiFontFamily: AppShellStateApi['resolvedUiFontFamily'];
  resolvedMonoFontFamily: AppShellStateApi['resolvedMonoFontFamily'];
  effectiveUiScale: AppCoreStateApi['effectiveUiScale'];
  effectiveOpacity: AppShellStateApi['effectiveOpacity'];
  effectiveDataTableFontSize: AppCoreStateApi['effectiveDataTableFontSize'];
  effectiveSidebarTreeFontSize: AppCoreStateApi['effectiveSidebarTreeFontSize'];
  effectiveSidebarRailScale: AppCoreStateApi['effectiveSidebarRailScale'];
  tokenControlHeight: AppCoreStateApi['tokenControlHeight'];
  tokenControlHeightSM: AppCoreStateApi['tokenControlHeightSM'];
  handleOpenToolCenterPane: AppSettingsNavigationApi['handleOpenToolCenterPane'];
  aiSettingsLeaveGuardRef: AppShellStateApi['aiSettingsLeaveGuardRef'];
  closeSettingsCenterWorkbenchTab: AppShellStateApi['closeSettingsCenterWorkbenchTab'];
  setThemeModalSection: AppProxySettingsApi['setThemeModalSection'];
  setIsThemeModalOpen: AppProxySettingsApi['setIsThemeModalOpen'];
  setTabDisplaySettingsFocusRequest: AppProxySettingsApi['setTabDisplaySettingsFocusRequest'];
  handleNewQuery: AppUpdateAndDiagnosticsApi['handleNewQuery'];
  isMacRuntime: AppShellStateApi['isMacRuntime'];
  useNativeMacWindowControls: AppUpdateAndDiagnosticsApi['useNativeMacWindowControls'];
  closeShortcutScopeRef: AppProxySettingsApi['closeShortcutScopeRef'];
  capturingShortcutAction: AppProxySettingsApi['capturingShortcutAction'];
  shortcutOptions: AppCoreStateApi['shortcutOptions'];
  activeShortcutPlatform: AppUpdateAndDiagnosticsApi['activeShortcutPlatform'];
  handleFocusSidebarSearch: AppSettingsNavigationApi['handleFocusSidebarSearch'];
  switchActiveTabByOffset: AppUpdateAndDiagnosticsApi['switchActiveTabByOffset'];
  handleCreateConnection: AppWorkbenchActionsApi['handleCreateConnection'];
  handleToggleOrFocusAIPanel: AppShellStateApi['handleToggleOrFocusAIPanel'];
  handleToggleLogPanel: AppWorkbenchActionsApi['handleToggleLogPanel'];
  selectPresetTheme: AppCoreStateApi['selectPresetTheme'];
  themeMode: AppCoreStateApi['themeMode'];
  handleTitleBarWindowToggle: AppWorkbenchActionsApi['handleTitleBarWindowToggle'];
  handleManualResetWindowZoom: AppWorkbenchActionsApi['handleManualResetWindowZoom'];
  setCapturingShortcutAction: AppProxySettingsApi['setCapturingShortcutAction'];
  t: AppCoreStateApi['t'];
  updateShortcut: AppCoreStateApi['updateShortcut'];
}

export const useAppLayoutEffects = ({
  darkMode, documentPlatform, effectiveFontSize, resolvedUiFontFamily, resolvedMonoFontFamily,
  effectiveUiScale, effectiveOpacity, effectiveDataTableFontSize, effectiveSidebarTreeFontSize,
  effectiveSidebarRailScale, tokenControlHeight, tokenControlHeightSM, handleOpenToolCenterPane,
  aiSettingsLeaveGuardRef, closeSettingsCenterWorkbenchTab, setThemeModalSection,
  setIsThemeModalOpen, setTabDisplaySettingsFocusRequest, handleNewQuery, isMacRuntime,
  useNativeMacWindowControls, closeShortcutScopeRef, capturingShortcutAction, shortcutOptions,
  activeShortcutPlatform, handleFocusSidebarSearch, switchActiveTabByOffset, handleCreateConnection,
  handleToggleOrFocusAIPanel, handleToggleLogPanel, selectPresetTheme, themeMode,
  handleTitleBarWindowToggle, handleManualResetWindowZoom, setCapturingShortcutAction, t,
  updateShortcut,
}: UseAppLayoutEffectsInput) => {
  // Apply the document theme before the first paint. V2 structural styles are
  // scoped by data-ui-version; a passive effect leaves one unstyled titlebar
  // frame where the centered context and its marker collapse into the legacy
  // flex layout.
  useLayoutEffect(() => {
    document.body.style.backgroundColor = 'transparent';
    document.body.style.color = darkMode ? '#ffffff' : '#000000';
    document.documentElement.style.colorScheme = darkMode ? 'dark' : 'light';
    document.body.setAttribute('data-theme', darkMode ? 'dark' : 'light');
    document.body.setAttribute('data-ui-version', 'v2');
    document.body.setAttribute('data-platform', documentPlatform);
    document.body.style.fontSize = `${effectiveFontSize}px`;
    document.body.style.setProperty('--gn-font-sans', resolvedUiFontFamily);
    document.body.style.setProperty('--gn-font-mono', resolvedMonoFontFamily);
    document.documentElement.style.setProperty('--gonavi-font-size', `${effectiveFontSize}px`);
    document.documentElement.style.setProperty('--gn-font-sans', resolvedUiFontFamily);
    document.documentElement.style.setProperty('--gn-font-mono', resolvedMonoFontFamily);
    document.documentElement.style.setProperty('--gn-ui-scale', `${effectiveUiScale}`);
    document.documentElement.style.setProperty('--gn-window-opacity', `${effectiveOpacity}`);
    document.documentElement.style.setProperty('--gn-window-opacity-percent', `${effectiveOpacity * 100}%`);
    document.documentElement.style.setProperty('--gn-font-size', `${effectiveFontSize}px`);
    document.documentElement.style.setProperty('--gn-font-size-sm', `${Math.max(10, Math.round(effectiveFontSize * 0.86))}px`);
    document.documentElement.style.setProperty('--gn-font-size-xs', `${Math.max(9, Math.round(effectiveFontSize * 0.76))}px`);
    document.documentElement.style.setProperty('--gn-font-size-mono', `${Math.max(10, Math.round(effectiveDataTableFontSize * 0.92))}px`);
    document.documentElement.style.setProperty('--gn-data-table-font-size', `${effectiveDataTableFontSize}px`);
    document.documentElement.style.setProperty('--gn-sidebar-tree-font-size', `${effectiveSidebarTreeFontSize}px`);
    document.documentElement.style.setProperty('--gn-sidebar-rail-scale', `${effectiveSidebarRailScale}`);
    document.documentElement.style.setProperty('--gn-control-height', `${tokenControlHeight}px`);
    document.documentElement.style.setProperty('--gn-control-height-sm', `${tokenControlHeightSM}px`);
  }, [
    darkMode,
    effectiveDataTableFontSize,
    effectiveFontSize,
    effectiveOpacity,
    resolvedMonoFontFamily,
    resolvedUiFontFamily,
    documentPlatform,
    effectiveSidebarRailScale,
    effectiveSidebarTreeFontSize,
    effectiveUiScale,
    tokenControlHeight,
    tokenControlHeightSM,
  ]);

  useEffect(() => {
      const handleOpenShortcutSettingsEvent = () => {
          handleOpenToolCenterPane('workspace', 'shortcut-settings');
      };
      window.addEventListener('gonavi:open-shortcut-settings', handleOpenShortcutSettingsEvent as EventListener);
      return () => {
          window.removeEventListener('gonavi:open-shortcut-settings', handleOpenShortcutSettingsEvent as EventListener);
      };
  }, [handleOpenToolCenterPane]);

  useEffect(() => {
      const handleOpenSnippetSettingsEvent = () => {
          handleOpenToolCenterPane('workspace', 'snippet-settings');
      };
      window.addEventListener('gonavi:open-snippet-settings', handleOpenSnippetSettingsEvent as EventListener);
      return () => {
          window.removeEventListener('gonavi:open-snippet-settings', handleOpenSnippetSettingsEvent as EventListener);
      };
  }, [handleOpenToolCenterPane]);

  useEffect(() => {
      const handleOpenTabDisplaySettingsEvent = () => withAISettingsLeaveGuard(aiSettingsLeaveGuardRef.current, () => {
          closeSettingsCenterWorkbenchTab();
          setThemeModalSection('workspace');
          setIsThemeModalOpen(true);
          setTabDisplaySettingsFocusRequest((current) => current + 1);
      });
      window.addEventListener('gonavi:open-tab-display-settings', handleOpenTabDisplaySettingsEvent as EventListener);
      return () => {
          window.removeEventListener('gonavi:open-tab-display-settings', handleOpenTabDisplaySettingsEvent as EventListener);
      };
  }, []);

  useEffect(() => {
      const handleCreateQueryTabEvent = () => {
          handleNewQuery();
      };
      window.addEventListener('gonavi:create-query-tab', handleCreateQueryTabEvent as EventListener);
      return () => {
          window.removeEventListener('gonavi:create-query-tab', handleCreateQueryTabEvent as EventListener);
      };
  }, [handleNewQuery]);

  useEffect(() => {
      if (!isMacRuntime || !useNativeMacWindowControls) {
          return;
      }

      const handleMacNativeEscapeCapture = (event: KeyboardEvent) => {
          if (!shouldSuppressMacNativeEscapeExit(
              isMacRuntime,
              useNativeMacWindowControls,
              useStore.getState().windowState === 'fullscreen',
              event,
              { isEditableTarget: isEditableElement(event.target) },
          )) {
              return;
          }
          event.preventDefault();
          event.stopPropagation();
      };

      window.addEventListener('keydown', handleMacNativeEscapeCapture, true);
      return () => {
          window.removeEventListener('keydown', handleMacNativeEscapeCapture, true);
      };
  }, [isMacRuntime, useNativeMacWindowControls]);

  useEffect(() => {
      const handleExplicitCloseShortcutScope = (event: Event) => {
          const nextScope = resolveCloseShortcutScopeFromTarget(event.target);
          if (nextScope) {
              closeShortcutScopeRef.current = nextScope;
          }
      };

      document.addEventListener('pointerdown', handleExplicitCloseShortcutScope, true);
      document.addEventListener('focusin', handleExplicitCloseShortcutScope, true);
      return () => {
          document.removeEventListener('pointerdown', handleExplicitCloseShortcutScope, true);
          document.removeEventListener('focusin', handleExplicitCloseShortcutScope, true);
      };
  }, []);

  useEffect(() => {
      const handleGlobalShortcut = (event: KeyboardEvent) => {
          // The recorder owns every key while it is active, including Cmd/Ctrl+W.
          if (capturingShortcutAction) {
              return;
          }

          const closeDecision = resolveCloseShortcutKeydownDecision({
              event,
              shortcutOptions,
              platform: activeShortcutPlatform,
              capturingShortcut: false,
              imeComposing: isImeComposingKeyEvent(event),
              interactionBlocked: isCloseShortcutInteractionBlocked(event.target, document),
          });
          if (closeDecision.preventDefault) {
              event.preventDefault();
          }
          if (closeDecision.kind === 'consume') {
              event.stopImmediatePropagation();
              return;
          }
          if (closeDecision.kind === 'close') {
              event.stopImmediatePropagation();
              if (closeShortcutScopeRef.current === 'workspace') {
                  dispatchCloseActiveWorkspaceTab();
              } else if (closeShortcutScopeRef.current === 'result') {
                  const currentState = useStore.getState();
                  const targetTabId = resolveDockedActiveTabId(
                      currentState.tabs,
                      currentState.activeTabId,
                      currentState.detachedWorkbenchWindows,
                  );
                  const outcome = dispatchCloseActiveResultTab(targetTabId);
                  if (outcome === 'hidden') {
                      closeShortcutScopeRef.current = 'blocked';
                  }
              }
              return;
          }

          const delegatedAction = closeDecision.kind === 'delegate'
              ? closeDecision.ownerAction
              : null;
          const matchedAction = SHORTCUT_ACTION_ORDER.find((action) => {
              if (action === 'closeActiveTab') {
                  return false;
              }
              if (delegatedAction && action !== delegatedAction) {
                  return false;
              }
              const meta = SHORTCUT_ACTION_META[action];
              if (meta.scope && meta.scope !== 'global') {
                  return false;
              }
              const binding = resolveShortcutBinding(shortcutOptions, action, activeShortcutPlatform);
              if (!binding?.enabled) {
                  return false;
              }
              if (isEditableElement(event.target) && !meta.allowInEditable) {
                  return false;
              }
              return isShortcutMatch(event, binding.combo);
          });

          if (!matchedAction) {
              return;
          }

          if (event.repeat && matchedAction === 'toggleAIPanel') {
              event.preventDefault();
              event.stopImmediatePropagation();
              return;
          }

          event.preventDefault();
          event.stopPropagation();

          switch (matchedAction) {
              case 'runQuery':
                  window.dispatchEvent(new CustomEvent('gonavi:run-active-query'));
                  break;
              case 'focusSidebarSearch':
                  handleFocusSidebarSearch();
                  break;
              case 'newQueryTab':
                  handleNewQuery();
                  break;
              case 'switchToNextTab':
                  switchActiveTabByOffset(1);
                  break;
              case 'switchToPreviousTab':
                  switchActiveTabByOffset(-1);
                  break;
              case 'newConnection':
                  handleCreateConnection();
                  break;
              case 'toggleAIPanel':
                  handleToggleOrFocusAIPanel();
                  break;
              case 'toggleLogPanel':
                  handleToggleLogPanel();
                  break;
              case 'toggleTheme':
                  selectPresetTheme(themeMode === 'dark' ? 'light' : 'dark');
                  break;
              case 'openShortcutManager':
                  handleOpenToolCenterPane('workspace', 'shortcut-settings');
                  break;
              case 'toggleMacFullscreen':
                  if (isMacRuntime && useNativeMacWindowControls) {
                      void handleTitleBarWindowToggle({ allowMacNativeFullscreen: true });
                  }
                  break;
              case 'resetWindowZoom':
                  void handleManualResetWindowZoom();
                  break;
          }
      };

      window.addEventListener('keydown', handleGlobalShortcut, true);
      return () => {
          window.removeEventListener('keydown', handleGlobalShortcut, true);
      };
  }, [activeShortcutPlatform, capturingShortcutAction, handleCreateConnection, handleFocusSidebarSearch, handleManualResetWindowZoom, handleNewQuery, handleOpenToolCenterPane, handleTitleBarWindowToggle, handleToggleLogPanel, handleToggleOrFocusAIPanel, isMacRuntime, selectPresetTheme, shortcutOptions, switchActiveTabByOffset, themeMode, useNativeMacWindowControls]);

  useEffect(() => {
      if (!capturingShortcutAction) {
          return;
      }

      const handleShortcutCapture = (event: KeyboardEvent) => {
          event.preventDefault();
          event.stopPropagation();

          if (event.key === 'Escape') {
              setCapturingShortcutAction(null);
              return;
          }

          const combo = eventToShortcut(event);
          if (!combo) {
              return;
          }

          const normalizedCombo = normalizeShortcutCombo(combo);
          if (!canRecordShortcutForAction(capturingShortcutAction, normalizedCombo)) {
              const meta = SHORTCUT_ACTION_META[capturingShortcutAction];
              void message.warning(meta.scope === 'aiComposer'
                  ? t('app.shortcuts.message.ai_send_limit')
                  : t('app.shortcuts.message.modifier_required'));
              return;
          }
          const conflictAction = findEnabledActionConflicts(
              shortcutOptions,
              capturingShortcutAction,
              normalizedCombo,
              activeShortcutPlatform,
          )[0];
          if (conflictAction) {
              void message.warning(t('app.shortcuts.message.conflict', { action: SHORTCUT_ACTION_META[conflictAction].label }));
              return;
          }

          const reservedConflicts = findReservedConflictsForAction(
              capturingShortcutAction,
              normalizedCombo,
              activeShortcutPlatform,
          );
          if (reservedConflicts.length > 0) {
              const { hasMonaco, hasOther, monacoLabels, otherLabels, otherContexts } = splitConflictsByContext(reservedConflicts);
              if (hasMonaco) {
                  void message.info(t('app.shortcuts.message.reserved_conflict_info', { labels: monacoLabels }), 4);
              }
              if (hasOther) {
                  void message.warning(t('app.shortcuts.message.reserved_conflict_warning', { contexts: otherContexts, labels: otherLabels }), 4);
              }
          }

          updateShortcut(capturingShortcutAction, { combo: normalizedCombo, enabled: true }, activeShortcutPlatform);
          setCapturingShortcutAction(null);
      };

      window.addEventListener('keydown', handleShortcutCapture, true);
      return () => {
          window.removeEventListener('keydown', handleShortcutCapture, true);
      };
  }, [activeShortcutPlatform, capturingShortcutAction, shortcutOptions, t, updateShortcut]);
};

export type AppLayoutEffectsApi = ReturnType<typeof useAppLayoutEffects>;
