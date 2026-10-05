import React, { useEffect } from 'react';
import { useStore } from '../../store';
import type { DetachedQueryResultWindow } from '../../utils/detachedWindow';
import type { NativeDetachedWindowBootstrap } from '../../utils/nativeDetachedWindowClient';
import { buildOverlayWorkbenchTheme } from '../../utils/overlayWorkbenchTheme';
import NativeDetachedQueryResult from '../NativeDetachedQueryResult';
import { WorkbenchTabContent, AIChatPanel } from './nativeDetachedLazyParts';

export const NativeDetachedWindowContent: React.FC<{
  bootstrap: NativeDetachedWindowBootstrap;
  themeModeOverride?: 'light' | 'dark';
  onContentReady: () => void;
  onAttach: () => void;
  onClose: () => void;
  onOpenSettings: (providerId?: string) => void;
  onRegisterAITerminalGuard: (guard: (() => Promise<boolean>) | null) => void;
  onQueryResultStateChange: (patch: Partial<DetachedQueryResultWindow['result']>) => void;
  interactionDisabled?: boolean;
}> = ({
  bootstrap,
  themeModeOverride,
  onContentReady,
  onAttach,
  onClose,
  onOpenSettings,
  onRegisterAITerminalGuard,
  onQueryResultStateChange,
  interactionDisabled = false,
}) => {
  const tabFromStore = useStore((state) => bootstrap.payload.tab
    ? state.tabs.find((item) => item.id === bootstrap.payload.tab?.id)
    : undefined);
  const tab = tabFromStore || bootstrap.payload.tab;
  const storeThemeMode = useStore((state) => state.theme);
  const themeMode = themeModeOverride ?? storeThemeMode;

  if (bootstrap.kind === 'workbench') {
    return tab
      ? (
          <WorkbenchTabContent
            tab={tab}
            isActive
            onContentReady={onContentReady}
            onRequestClose={onClose}
          />
        )
      : null;
  }
  if (bootstrap.kind === 'query-result') {
    return bootstrap.payload.resultWindow
      ? (
          <>
            <NativeDetachedQueryResult
              windowState={bootstrap.payload.resultWindow}
              onStateChange={onQueryResultStateChange}
            />
            <NativeDetachedContentReady onReady={onContentReady} />
          </>
        )
      : null;
  }
  const isDark = themeMode === 'dark';
  const aiPanelBackground = isDark
    ? 'var(--gn-bg-panel, #161a21)'
    : 'var(--gn-bg-panel, #ffffff)';
  return (
    <div className="gn-native-detached-ai-chat">
      <AIChatPanel
        width={typeof window === 'undefined' ? 440 : window.innerWidth}
        darkMode={isDark}
        bgColor={aiPanelBackground}
        overlayTheme={buildOverlayWorkbenchTheme(isDark, {
          disableBackdropFilter: true,
          useThemeVariables: true,
        })}
        presentation="detached"
        onClose={onClose}
        onAttach={onAttach}
        onOpenSettings={onOpenSettings}
        onRegisterTerminalGuard={onRegisterAITerminalGuard}
        interactionDisabled={interactionDisabled}
      />
      <NativeDetachedContentReady onReady={onContentReady} />
    </div>
  );
};

const NativeDetachedContentReady: React.FC<{ onReady: () => void }> = ({ onReady }) => {
  useEffect(() => {
    onReady();
  }, [onReady]);
  return null;
};
