import React, { useCallback, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Button, ConfigProvider, Tooltip } from 'antd';
import { CloseOutlined, CompressOutlined } from '@ant-design/icons';
import { useStore } from '../store';
import { t } from '../i18n';
import {
  buildTabDisplayModel,
  resolveConnectionHostSummary,
} from '../utils/tabDisplay';
import {
  clamp,
  DEFAULT_DETACHED_WINDOW_MIN_HEIGHT,
  DEFAULT_DETACHED_WINDOW_MIN_WIDTH,
  DETACHED_WINDOW_VIEWPORT_PADDING,
  resolveDetachedWindowTitle,
} from '../utils/detachedWindow';
import WorkbenchTabContent from './WorkbenchTabContent';
import { hasNativeDetachedWindowManager } from '../utils/nativeDetachedWindowHost';
import { useWorkbenchTabs } from '../hooks/useWorkbenchTabs';
import { useManagedPointerInteraction } from '../hooks/useManagedPointerInteraction';
import {
  APP_DETACHED_WINDOW_Z_INDEX_BASE,
  APP_POPUP_Z_INDEX,
} from '../utils/overlayZIndex';
import { requestCloseWorkbenchTabs } from '../utils/workbenchTabCloseProtection';

const getTabKindLabel = (type: string): string => {
  if (type === 'query') return t('tab_manager.kind_badge.query');
  if (type === 'table') return t('tab_manager.kind_badge.table');
  if (type === 'design') return t('tab_manager.kind_badge.design');
  if (type === 'table-overview') return t('tab_manager.kind_badge.table_overview');
  if (type === 'table-export') return t('tab_manager.kind_badge.table_export');
  if (type === 'data-import') return t('tab_manager.kind_badge.data_import');
  if (type === 'data-sync') return t('app.tools.entry.sync.title');
  if (type === 'sql-file-execution') return t('sidebar.sql_file_exec.title');
  if (type === 'sql-analysis') return t('tab_manager.kind_badge.sql_analysis');
  if (type === 'sql-audit') return t('tab_manager.kind_badge.sql_audit');
  if (type.startsWith('redis')) return t('tab_manager.kind_badge.redis');
  if (type.startsWith('jvm')) return t('tab_manager.kind_badge.jvm');
  if (type === 'trigger') return t('tab_manager.kind_badge.trigger');
  if (type === 'view-def') return t('tab_manager.kind_badge.view');
  if (type === 'event-def') return t('tab_manager.kind_badge.event');
  if (type === 'routine-def') return t('tab_manager.kind_badge.routine');
  if (type === 'sequence-def') return t('tab_manager.kind_badge.sequence');
  if (type === 'package-def') return t('tab_manager.kind_badge.package');
  return t('tab_manager.kind_badge.fallback');
};

type DragMode = 'move' | 'resize-e' | 'resize-s' | 'resize-se';

const FloatingWorkbenchWindows: React.FC = () => {
  const tabs = useWorkbenchTabs();
  const connections = useStore((state) => state.connections);
  const appearance = useStore((state) => state.appearance);
  const theme = useStore((state) => state.theme);
  const detachedWorkbenchWindows = useStore((state) => state.detachedWorkbenchWindows);
  const activeTabId = useStore((state) => state.activeTabId);
  const attachWorkbenchTab = useStore((state) => state.attachWorkbenchTab);
  const updateDetachedWorkbenchBounds = useStore((state) => state.updateDetachedWorkbenchBounds);
  const focusDetachedWorkbenchTab = useStore((state) => state.focusDetachedWorkbenchTab);
  const dragRef = useRef<{
    tabId: string;
    mode: DragMode;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
    originW: number;
    originH: number;
  } | null>(null);

  const windowModels = useMemo(() => {
    return detachedWorkbenchWindows
      .map((windowState) => {
        const tab = tabs.find((item) => item.id === windowState.tabId);
        if (!tab) return null;
        const connection = connections.find((conn) => conn.id === tab.connectionId);
        const displayModel = buildTabDisplayModel(tab, connection, appearance.tabDisplay, t);
        const kindLabel = getTabKindLabel(tab.type);
        const objectLabel =
          tab.tableName ||
          tab.viewName ||
          tab.eventName ||
          tab.routineName ||
          tab.sequenceName ||
          tab.packageName ||
          tab.triggerName ||
          tab.resourcePath ||
          tab.filePath ||
          '';
        const title = resolveDetachedWindowTitle({
          kindLabel,
          objectLabel,
          fallbackTitle: displayModel.fullTitle || tab.title || t('tab_manager.detached.title_fallback'),
        });
        return {
          windowState,
          tab,
          title,
          hostSummary: resolveConnectionHostSummary(connection?.config),
          connectionName: connection?.name || '',
          isFocused: activeTabId === tab.id,
        };
      })
      .filter(Boolean) as Array<{
      windowState: (typeof detachedWorkbenchWindows)[number];
      tab: (typeof tabs)[number];
      title: string;
      hostSummary: string;
      connectionName: string;
      isFocused: boolean;
    }>;
  }, [activeTabId, appearance.tabDisplay, connections, detachedWorkbenchWindows, tabs]);
  const nativeWindowManagerAvailable = hasNativeDetachedWindowManager();
  const { startInteraction: startManagedInteraction } = useManagedPointerInteraction(
    windowModels.length > 0 && !nativeWindowManagerAvailable,
  );

  const startInteraction = useCallback((
    event: React.PointerEvent,
    tabId: string,
    mode: DragMode,
    bounds: { x: number; y: number; width: number; height: number },
  ) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    focusDetachedWorkbenchTab(tabId);
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
          updateDetachedWorkbenchBounds(drag.tabId, {
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
            DEFAULT_DETACHED_WINDOW_MIN_WIDTH,
            window.innerWidth - drag.originX - DETACHED_WINDOW_VIEWPORT_PADDING,
          );
        }
        if (drag.mode === 'resize-s' || drag.mode === 'resize-se') {
          nextH = clamp(
            drag.originH + dy,
            DEFAULT_DETACHED_WINDOW_MIN_HEIGHT,
            window.innerHeight - drag.originY - DETACHED_WINDOW_VIEWPORT_PADDING,
          );
        }
        updateDetachedWorkbenchBounds(drag.tabId, { width: nextW, height: nextH });
      },
      onStop: () => {
        dragRef.current = null;
      },
    });
    if (!started) return;
    dragRef.current = {
      tabId,
      mode,
      startX: event.clientX,
      startY: event.clientY,
      originX: bounds.x,
      originY: bounds.y,
      originW: bounds.width,
      originH: bounds.height,
    };
  }, [focusDetachedWorkbenchTab, startManagedInteraction, updateDetachedWorkbenchBounds]);

  if (nativeWindowManagerAvailable || windowModels.length === 0) {
    return null;
  }

  const isDark = theme === 'dark';

  const floatingWindows = (
    <ConfigProvider theme={{ token: { zIndexPopupBase: APP_POPUP_Z_INDEX } }}>
      <div className="gn-detached-window-layer" aria-label={t('tab_manager.detached.title_fallback')}>
      <style>{`
        .gn-detached-window-layer {
          position: fixed;
          inset: 0;
          pointer-events: none;
          z-index: ${APP_DETACHED_WINDOW_Z_INDEX_BASE};
        }
        .gn-detached-window {
          position: fixed;
          display: flex;
          flex-direction: column;
          min-width: ${DEFAULT_DETACHED_WINDOW_MIN_WIDTH}px;
          min-height: ${DEFAULT_DETACHED_WINDOW_MIN_HEIGHT}px;
          border-radius: 10px;
          border: 1px solid ${isDark ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.12)'};
          background: ${isDark ? 'rgba(22,24,28,0.98)' : 'rgba(255,255,255,0.98)'};
          box-shadow: ${isDark
            ? '0 18px 48px rgba(0,0,0,0.45)'
            : '0 18px 48px rgba(15,23,42,0.18)'};
          overflow: hidden;
          pointer-events: auto;
          animation: gn-detached-workbench-enter 180ms cubic-bezier(0.22, 1, 0.36, 1);
          transform-origin: top left;
        }
        @keyframes gn-detached-workbench-enter {
          from {
            opacity: 0.55;
            transform: scale(0.92);
          }
          to {
            opacity: 1;
            transform: scale(1);
          }
        }
        .gn-detached-window.is-focused {
          border-color: ${isDark ? 'rgba(255,214,102,0.55)' : 'rgba(22,119,255,0.45)'};
          box-shadow: ${isDark
            ? '0 0 0 1px rgba(255,214,102,0.25), 0 20px 52px rgba(0,0,0,0.5)'
            : '0 0 0 1px rgba(22,119,255,0.18), 0 20px 52px rgba(15,23,42,0.2)'};
        }
        .gn-detached-window-header {
          flex: 0 0 auto;
          display: flex;
          align-items: center;
          gap: 8px;
          min-height: 40px;
          padding: 6px 8px 6px 12px;
          border-bottom: 1px solid ${isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)'};
          background: ${isDark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.02)'};
          cursor: move;
          user-select: none;
        }
        .gn-detached-window-title {
          min-width: 0;
          flex: 1 1 auto;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          font-size: 13px;
          font-weight: 600;
          color: ${isDark ? 'rgba(255,255,255,0.92)' : 'rgba(0,0,0,0.88)'};
        }
        .gn-detached-window-subtitle {
          display: block;
          margin-top: 1px;
          font-size: 11px;
          font-weight: 500;
          color: ${isDark ? 'rgba(255,255,255,0.45)' : 'rgba(0,0,0,0.45)'};
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .gn-detached-window-actions {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          flex: 0 0 auto;
        }
        .gn-detached-window-body {
          flex: 1 1 auto;
          min-height: 0;
          min-width: 0;
          display: flex;
          flex-direction: column;
          overflow: hidden;
        }
        .gn-detached-window-body > * {
          flex: 1 1 auto;
          min-height: 0;
          min-width: 0;
        }
        .gn-detached-resize-handle {
          position: absolute;
          z-index: 2;
        }
        .gn-detached-resize-e {
          top: 36px;
          right: 0;
          width: 8px;
          height: calc(100% - 36px);
          cursor: ew-resize;
        }
        .gn-detached-resize-s {
          left: 0;
          bottom: 0;
          width: 100%;
          height: 8px;
          cursor: ns-resize;
        }
        .gn-detached-resize-se {
          right: 0;
          bottom: 0;
          width: 16px;
          height: 16px;
          cursor: nwse-resize;
        }
      `}</style>
      {windowModels.map(({ windowState, tab, title, hostSummary, connectionName, isFocused }) => (
        <div
          key={windowState.tabId}
          className={`gn-detached-window${isFocused ? ' is-focused' : ''}`}
          data-gonavi-close-shortcut-guard="true"
          data-gonavi-close-shortcut-scope="blocked"
          style={{
            left: windowState.x,
            top: windowState.y,
            width: windowState.width,
            height: windowState.height,
            zIndex: windowState.zIndex,
          }}
          onMouseDown={() => focusDetachedWorkbenchTab(windowState.tabId)}
        >
          <div
            className="gn-detached-window-header"
            onPointerDown={(event) => startInteraction(event, windowState.tabId, 'move', windowState)}
          >
            <div className="gn-detached-window-title" title={title}>
              <span>{title}</span>
              {(connectionName || hostSummary) ? (
                <span className="gn-detached-window-subtitle">
                  {[connectionName, hostSummary].filter(Boolean).join(' · ')}
                </span>
              ) : null}
            </div>
            <div className="gn-detached-window-actions" onPointerDown={(event) => event.stopPropagation()}>
              <Tooltip title={t('tab_manager.detached.restore')}>
                <Button
                  type="text"
                  size="small"
                  icon={<CompressOutlined />}
                  aria-label={t('tab_manager.detached.restore')}
                  onClick={() => attachWorkbenchTab(windowState.tabId)}
                />
              </Tooltip>
              <Tooltip title={t('tab_manager.detached.close')}>
                <Button
                  type="text"
                  size="small"
                  icon={<CloseOutlined />}
                  aria-label={t('tab_manager.detached.close')}
                  onClick={() => requestCloseWorkbenchTabs([windowState.tabId])}
                />
              </Tooltip>
            </div>
          </div>
          <div className="gn-detached-window-body">
            <WorkbenchTabContent tab={tab} isActive={isFocused || activeTabId === tab.id} />
          </div>
          <div
            className="gn-detached-resize-handle gn-detached-resize-e"
            onPointerDown={(event) => startInteraction(event, windowState.tabId, 'resize-e', windowState)}
          />
          <div
            className="gn-detached-resize-handle gn-detached-resize-s"
            onPointerDown={(event) => startInteraction(event, windowState.tabId, 'resize-s', windowState)}
          />
          <div
            className="gn-detached-resize-handle gn-detached-resize-se"
            onPointerDown={(event) => startInteraction(event, windowState.tabId, 'resize-se', windowState)}
          />
        </div>
      ))}
      </div>
    </ConfigProvider>
  );

  return typeof document === 'undefined'
    ? floatingWindows
    : createPortal(floatingWindows, document.body);
};

export default FloatingWorkbenchWindows;
