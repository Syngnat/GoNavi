import React, { useCallback, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Button, ConfigProvider, Spin } from 'antd';
import { useStore } from '../store';
import { t } from '../i18n';
import {
  clamp,
  DEFAULT_DETACHED_AI_CHAT_MIN_HEIGHT,
  DEFAULT_DETACHED_AI_CHAT_MIN_WIDTH,
  DETACHED_WINDOW_VIEWPORT_PADDING,
} from '../utils/detachedWindow';
import type { OverlayWorkbenchTheme } from '../utils/overlayWorkbenchTheme';
import { hasNativeDetachedWindowManager } from '../utils/nativeDetachedWindowHost';
import { APP_POPUP_Z_INDEX } from '../utils/overlayZIndex';
import { useManagedPointerInteraction } from '../hooks/useManagedPointerInteraction';
import AIPanelErrorBoundary from './ai/AIPanelErrorBoundary';

const createLazyAIChatPanel = () => React.lazy(() => import('./AIChatPanel'));

type DragMode = 'move' | 'resize-e' | 'resize-s' | 'resize-se';

interface FloatingAIChatWindowProps {
  darkMode: boolean;
  bgColor?: string;
  overlayTheme: OverlayWorkbenchTheme;
  onOpenSettings: () => void;
  onRenderError?: (error: Error, errorInfo: React.ErrorInfo) => void;
  onRetryRender?: () => void;
  renderNonce?: number;
}

const FloatingAIChatWindow: React.FC<FloatingAIChatWindowProps> = ({
  darkMode,
  bgColor,
  overlayTheme,
  onOpenSettings,
  onRenderError,
  onRetryRender,
  renderNonce = 0,
}) => {
  const windowState = useStore((state) => state.detachedAIChatWindow);
  const attachAIChatPanel = useStore((state) => state.attachAIChatPanel);
  const setAIPanelVisible = useStore((state) => state.setAIPanelVisible);
  const updateDetachedAIChatBounds = useStore((state) => state.updateDetachedAIChatBounds);
  const focusDetachedAIChatPanel = useStore((state) => state.focusDetachedAIChatPanel);
  const LazyAIChatPanel = useMemo(createLazyAIChatPanel, [renderNonce]);
  const nativeWindowManagerAvailable = hasNativeDetachedWindowManager();
  const { startInteraction: startManagedInteraction } = useManagedPointerInteraction(
    Boolean(windowState) && !nativeWindowManagerAvailable,
  );

  const dragRef = useRef<{
    mode: DragMode;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
    originW: number;
    originH: number;
  } | null>(null);

  const startInteraction = useCallback((
    event: React.PointerEvent,
    mode: DragMode,
    bounds: { x: number; y: number; width: number; height: number },
  ) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    focusDetachedAIChatPanel();
    const started = startManagedInteraction(event, {
      onMove: (moveEvent) => {
        const drag = dragRef.current;
        if (!drag) return;
        const dx = moveEvent.clientX - drag.startX;
        const dy = moveEvent.clientY - drag.startY;
        if (drag.mode === 'move') {
          const maxX = Math.max(
            DETACHED_WINDOW_VIEWPORT_PADDING,
            window.innerWidth - drag.originW - DETACHED_WINDOW_VIEWPORT_PADDING,
          );
          const maxY = Math.max(
            DETACHED_WINDOW_VIEWPORT_PADDING,
            window.innerHeight - drag.originH - DETACHED_WINDOW_VIEWPORT_PADDING,
          );
          updateDetachedAIChatBounds({
            x: clamp(drag.originX + dx, DETACHED_WINDOW_VIEWPORT_PADDING, maxX),
            y: clamp(drag.originY + dy, DETACHED_WINDOW_VIEWPORT_PADDING, maxY),
          });
          return;
        }
        let nextW = drag.originW;
        let nextH = drag.originH;
        if (drag.mode === 'resize-e' || drag.mode === 'resize-se') {
          nextW = clamp(
            drag.originW + dx,
            DEFAULT_DETACHED_AI_CHAT_MIN_WIDTH,
            window.innerWidth - drag.originX - DETACHED_WINDOW_VIEWPORT_PADDING,
          );
        }
        if (drag.mode === 'resize-s' || drag.mode === 'resize-se') {
          nextH = clamp(
            drag.originH + dy,
            DEFAULT_DETACHED_AI_CHAT_MIN_HEIGHT,
            window.innerHeight - drag.originY - DETACHED_WINDOW_VIEWPORT_PADDING,
          );
        }
        updateDetachedAIChatBounds({ width: nextW, height: nextH });
      },
      onStop: () => {
        dragRef.current = null;
      },
    });
    if (!started) return;
    dragRef.current = {
      mode,
      startX: event.clientX,
      startY: event.clientY,
      originX: bounds.x,
      originY: bounds.y,
      originW: bounds.width,
      originH: bounds.height,
    };
  }, [focusDetachedAIChatPanel, startManagedInteraction, updateDetachedAIChatBounds]);

  if (!windowState || nativeWindowManagerAvailable) {
    return null;
  }

  // `darkMode` is resolved by the host (including system/custom theme rules).
  // Reading the persisted store theme here can briefly describe a stale mode
  // while the host is already rendering the panel in the opposite theme.
  const isDark = darkMode;
  const windowBackground = bgColor ?? (isDark ? 'rgba(22,24,28,0.98)' : 'rgba(255,255,255,0.98)');
  const bounds = windowState;

  const floatingWindow = (
    <ConfigProvider theme={{ token: { zIndexPopupBase: APP_POPUP_Z_INDEX } }}>
      <div className="gn-detached-ai-chat-layer" aria-label={t('ai_chat.detached.window_aria')}>
      <style>{`
        .gn-detached-ai-chat-layer {
          position: fixed;
          inset: 0;
          pointer-events: none;
          z-index: ${bounds.zIndex};
        }
        .gn-detached-ai-chat-window {
          position: fixed;
          display: flex;
          flex-direction: column;
          min-width: ${DEFAULT_DETACHED_AI_CHAT_MIN_WIDTH}px;
          min-height: ${DEFAULT_DETACHED_AI_CHAT_MIN_HEIGHT}px;
          border-radius: 12px;
          border: 1px solid ${isDark ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.12)'};
          background: ${windowBackground};
          box-shadow: ${isDark
            ? '0 0 0 1px rgba(255,214,102,0.2), 0 20px 52px rgba(0,0,0,0.5)'
            : '0 0 0 1px rgba(22,119,255,0.14), 0 20px 52px rgba(15,23,42,0.18)'};
          /* 不用 transform 入场：scale 会破坏 macOS/WebView 中文输入法候选窗定位，造成“一直挂着” */
          overflow: hidden;
          pointer-events: auto;
          transform: none;
          animation: gn-detached-ai-enter 160ms ease-out;
        }
        @keyframes gn-detached-ai-enter {
          from { opacity: 0.45; }
          to { opacity: 1; }
        }
        /* 输入区祖先避免 transform/filter，保证 IME 浮层相对视口定位 */
        .gn-detached-ai-chat-body,
        .gn-detached-ai-chat-body .ai-chat-panel,
        .gn-detached-ai-chat-body .ai-chat-input-area {
          transform: none !important;
          filter: none !important;
          perspective: none !important;
        }
        /* 不再单独做外层标题栏，避免与面板内 header 按钮重复；拖拽交给面板 header */
        .gn-detached-ai-chat-body {
          flex: 1 1 auto;
          min-height: 0;
          min-width: 0;
          display: flex;
          flex-direction: column;
          overflow: hidden;
          border-radius: inherit;
        }
        .gn-detached-ai-chat-body .ai-chat-panel {
          width: 100% !important;
          height: 100%;
          border-left: none !important;
          border-radius: inherit;
        }
        .gn-detached-ai-chat-body .ai-resize-handle {
          display: none !important;
        }
        .gn-detached-ai-chat-body .ai-chat-header {
          cursor: move;
          user-select: none;
        }
        .gn-detached-ai-chat-body .ai-chat-header-right,
        .gn-detached-ai-chat-body .gn-v2-ai-header-actions,
        .gn-detached-ai-chat-body .gn-v2-ai-mode-tabs {
          cursor: default;
          user-select: auto;
        }
        .gn-detached-ai-chat-resize-e,
        .gn-detached-ai-chat-resize-s,
        .gn-detached-ai-chat-resize-se {
          position: absolute;
          z-index: 2;
        }
        .gn-detached-ai-chat-resize-e {
          top: 8px;
          right: 0;
          width: 6px;
          bottom: 12px;
          cursor: ew-resize;
        }
        .gn-detached-ai-chat-resize-s {
          left: 12px;
          right: 12px;
          bottom: 0;
          height: 6px;
          cursor: ns-resize;
        }
        .gn-detached-ai-chat-resize-se {
          right: 0;
          bottom: 0;
          width: 14px;
          height: 14px;
          cursor: nwse-resize;
        }
      `}</style>

      <div
        className="gn-detached-ai-chat-window"
        data-gonavi-close-shortcut-guard="true"
        data-gonavi-close-shortcut-scope="blocked"
        style={{
          left: bounds.x,
          top: bounds.y,
          width: bounds.width,
          height: bounds.height,
          zIndex: bounds.zIndex,
        }}
        onPointerDown={() => focusDetachedAIChatPanel()}
      >
        <div className="gn-detached-ai-chat-body">
          <AIPanelErrorBoundary
            key={`detached-ai-${renderNonce}`}
            onError={onRenderError}
            fallback={(error) => (
              <div style={{ padding: 20, color: isDark ? 'rgba(255,255,255,0.88)' : '#162033' }}>
                <div style={{ fontWeight: 600, marginBottom: 8 }}>{t('app.ai_panel.error.title')}</div>
                <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 12 }}>{t('app.ai_panel.error.description')}</div>
                {error?.message && (
                  <div style={{ fontSize: 12, marginBottom: 12, wordBreak: 'break-word' }}>{error.message}</div>
                )}
                {onRetryRender && (
                  <Button type="primary" size="small" onClick={onRetryRender}>
                    {t('app.ai_panel.action.reload')}
                  </Button>
                )}
              </div>
            )}
          >
            <React.Suspense
              fallback={(
                <div style={{ height: '100%', display: 'grid', placeItems: 'center' }} aria-busy="true">
                  <Spin />
                </div>
              )}
            >
              <LazyAIChatPanel
                width={bounds.width}
                darkMode={darkMode}
                bgColor={bgColor}
                overlayTheme={overlayTheme}
                presentation="detached"
                onClose={() => setAIPanelVisible(false)}
                onOpenSettings={onOpenSettings}
                onDetach={undefined}
                onAttach={() => attachAIChatPanel()}
                onWindowDragStart={(event) => startInteraction(event, 'move', bounds)}
              />
            </React.Suspense>
          </AIPanelErrorBoundary>
        </div>
        <div
          className="gn-detached-ai-chat-resize-e"
          onPointerDown={(event) => startInteraction(event, 'resize-e', bounds)}
        />
        <div
          className="gn-detached-ai-chat-resize-s"
          onPointerDown={(event) => startInteraction(event, 'resize-s', bounds)}
        />
        <div
          className="gn-detached-ai-chat-resize-se"
          onPointerDown={(event) => startInteraction(event, 'resize-se', bounds)}
        />
      </div>
      </div>
    </ConfigProvider>
  );

  return typeof document === 'undefined'
    ? floatingWindow
    : createPortal(floatingWindow, document.body);
};

export default FloatingAIChatWindow;
