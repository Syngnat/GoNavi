import React, { useCallback, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button, ConfigProvider, Tooltip } from 'antd';
import { CloseOutlined, CompressOutlined } from '@ant-design/icons';
import { useStore } from '../store';
import { t } from '../i18n';
import DeferredWorkspaceContentErrorBoundary from './DeferredWorkspaceContentErrorBoundary';
import DeferredWorkspaceContentFallback from './DeferredWorkspaceContentFallback';
import { hasNativeDetachedWindowManager } from '../utils/nativeDetachedWindowHost';
import {
  clamp,
  DEFAULT_DETACHED_WINDOW_MIN_HEIGHT,
  DEFAULT_DETACHED_WINDOW_MIN_WIDTH,
  DETACHED_WINDOW_VIEWPORT_PADDING,
} from '../utils/detachedWindow';
import {
  APP_DETACHED_WINDOW_Z_INDEX_BASE,
  APP_POPUP_Z_INDEX,
} from '../utils/overlayZIndex';
import { useManagedPointerInteraction } from '../hooks/useManagedPointerInteraction';

const createLazyDetachedResultDataGrid = () => React.lazy(() => import('./DataGrid'));

type DeferredDetachedResultDataGridProps = React.ComponentProps<
  typeof import('./DataGrid')['default']
>;

const DeferredDetachedResultDataGrid: React.FC<DeferredDetachedResultDataGridProps> = (props) => {
  const [renderNonce, setRenderNonce] = useState(0);
  const LazyDataGrid = useMemo(createLazyDetachedResultDataGrid, [renderNonce]);
  const retry = useCallback(() => {
    setRenderNonce((current) => current + 1);
  }, []);

  return (
    <DeferredWorkspaceContentErrorBoundary key={renderNonce} onRetry={retry}>
      <React.Suspense fallback={<DeferredWorkspaceContentFallback />}>
        <LazyDataGrid {...props} />
      </React.Suspense>
    </DeferredWorkspaceContentErrorBoundary>
  );
};

type DragMode = 'move' | 'resize-e' | 'resize-s' | 'resize-se';

const isAffectedRowsResult = (columns: string[]): boolean =>
  columns.length === 1 && columns[0] === 'affectedRows';

const FloatingQueryResultWindows: React.FC = () => {
  const theme = useStore((state) => state.theme);
  const detachedQueryResultWindows = useStore((state) => state.detachedQueryResultWindows);
  const attachQueryResultWindow = useStore((state) => state.attachQueryResultWindow);
  const closeDetachedQueryResultWindow = useStore((state) => state.closeDetachedQueryResultWindow);
  const updateDetachedQueryResultBounds = useStore((state) => state.updateDetachedQueryResultBounds);
  const focusDetachedQueryResultWindow = useStore((state) => state.focusDetachedQueryResultWindow);
  const dragRef = useRef<{
    id: string;
    mode: DragMode;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
    originW: number;
    originH: number;
  } | null>(null);
  const nativeWindowManagerAvailable = hasNativeDetachedWindowManager();
  const { startInteraction: startManagedInteraction } = useManagedPointerInteraction(
    detachedQueryResultWindows.length > 0 && !nativeWindowManagerAvailable,
  );

  const startInteraction = useCallback((
    event: React.PointerEvent,
    id: string,
    mode: DragMode,
    bounds: { x: number; y: number; width: number; height: number },
  ) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    focusDetachedQueryResultWindow(id);
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
          updateDetachedQueryResultBounds(drag.id, {
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
        updateDetachedQueryResultBounds(drag.id, { width: nextW, height: nextH });
      },
      onStop: () => {
        dragRef.current = null;
      },
    });
    if (!started) return;
    dragRef.current = {
      id,
      mode,
      startX: event.clientX,
      startY: event.clientY,
      originX: bounds.x,
      originY: bounds.y,
      originW: bounds.width,
      originH: bounds.height,
    };
  }, [focusDetachedQueryResultWindow, startManagedInteraction, updateDetachedQueryResultBounds]);

  const handleRestore = useCallback((id: string) => {
    const restored = attachQueryResultWindow(id);
    if (!restored) return;
    window.dispatchEvent(new CustomEvent('gonavi:restore-query-result', {
      detail: {
        sourceQueryTabId: restored.sourceQueryTabId,
        result: restored.result,
      },
    }));
  }, [attachQueryResultWindow]);

  const windows = useMemo(() => detachedQueryResultWindows, [detachedQueryResultWindows]);

  if (nativeWindowManagerAvailable || windows.length === 0) {
    return null;
  }

  const isDark = theme === 'dark';

  const floatingWindows = (
    <ConfigProvider theme={{ token: { zIndexPopupBase: APP_POPUP_Z_INDEX } }}>
      <div className="gn-detached-result-layer" aria-label={t('query_editor.results_panel.detached.title', { index: '' })}>
      <style>{`
        .gn-detached-result-layer {
          position: fixed;
          inset: 0;
          pointer-events: none;
          z-index: ${APP_DETACHED_WINDOW_Z_INDEX_BASE};
        }
        .gn-detached-result-window {
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
          animation: gn-detached-result-enter 180ms cubic-bezier(0.22, 1, 0.36, 1);
          transform-origin: top left;
        }
        @keyframes gn-detached-result-enter {
          from {
            opacity: 0.55;
            transform: scale(0.92);
          }
          to {
            opacity: 1;
            transform: scale(1);
          }
        }
        .gn-detached-result-header {
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
        .gn-detached-result-title {
          min-width: 0;
          flex: 1 1 auto;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          font-size: 13px;
          font-weight: 600;
        }
        .gn-detached-result-body {
          flex: 1 1 auto;
          min-height: 0;
          min-width: 0;
          display: flex;
          flex-direction: column;
          overflow: hidden;
          padding: 0;
        }
        .gn-detached-result-message {
          flex: 1 1 auto;
          margin: 0;
          padding: 12px;
          border: none;
          resize: none;
          outline: none;
          font-family: var(--gn-font-mono, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace);
          font-size: 12px;
          line-height: 1.5;
          background: transparent;
          color: inherit;
        }
        .gn-detached-result-resize-e {
          position: absolute;
          top: 36px;
          right: 0;
          width: 8px;
          height: calc(100% - 36px);
          cursor: ew-resize;
        }
        .gn-detached-result-resize-s {
          position: absolute;
          left: 0;
          bottom: 0;
          width: 100%;
          height: 8px;
          cursor: ns-resize;
        }
        .gn-detached-result-resize-se {
          position: absolute;
          right: 0;
          bottom: 0;
          width: 16px;
          height: 16px;
          cursor: nwse-resize;
        }
      `}</style>
      {windows.map((windowState) => {
        const isMessage =
          windowState.result.resultType === 'message' ||
          isAffectedRowsResult(windowState.result.columns || []);
        const messageText = (windowState.result.messages || []).join('\n')
          || (isAffectedRowsResult(windowState.result.columns || [])
            ? String(windowState.result.rows?.[0]?.affectedRows ?? '')
            : '');
        return (
          <div
            key={windowState.id}
            className="gn-detached-result-window"
            data-gonavi-close-shortcut-guard="true"
            data-gonavi-close-shortcut-scope="blocked"
            style={{
              left: windowState.x,
              top: windowState.y,
              width: windowState.width,
              height: windowState.height,
              zIndex: windowState.zIndex,
            }}
            onMouseDown={() => focusDetachedQueryResultWindow(windowState.id)}
          >
            <div
              className="gn-detached-result-header"
              onPointerDown={(event) => startInteraction(event, windowState.id, 'move', windowState)}
            >
              <div className="gn-detached-result-title" title={windowState.title}>
                {windowState.title}
              </div>
              <div onPointerDown={(event) => event.stopPropagation()} style={{ display: 'inline-flex', gap: 4 }}>
                <Tooltip title={t('query_editor.results_panel.detached.restore')}>
                  <Button
                    type="text"
                    size="small"
                    icon={<CompressOutlined />}
                    aria-label={t('query_editor.results_panel.detached.restore')}
                    onClick={() => handleRestore(windowState.id)}
                  />
                </Tooltip>
                <Tooltip title={t('query_editor.results_panel.detached.close')}>
                  <Button
                    type="text"
                    size="small"
                    icon={<CloseOutlined />}
                    aria-label={t('query_editor.results_panel.detached.close')}
                    onClick={() => closeDetachedQueryResultWindow(windowState.id)}
                  />
                </Tooltip>
              </div>
            </div>
            <div className="gn-detached-result-body">
              {isMessage ? (
                <textarea
                  className="gn-detached-result-message"
                  readOnly
                  value={messageText}
                />
              ) : (
                <DeferredDetachedResultDataGrid
                  data={windowState.result.rows || []}
                  columnNames={windowState.result.columns || []}
                  loading={false}
                  tableName={windowState.result.tableName}
                  pkColumns={windowState.result.pkColumns || []}
                  editLocator={windowState.result.editLocator as any}
                  readOnly={windowState.result.readOnly !== false}
                  connectionId={windowState.result.executionConnectionId || windowState.connectionId}
                  connectionParamsOverride={windowState.result.executionConnectionParams}
                  dbName={windowState.result.metadataDbName ?? windowState.result.executionDbName ?? windowState.dbName ?? ''}
                  ddlDbName={windowState.result.ddlDbName}
                  ddlTableName={windowState.result.ddlTableName}
                  resultSql={windowState.result.exportSql || windowState.result.sql}
                  exportScope="queryResult"
                />
              )}
            </div>
            <div
              className="gn-detached-result-resize-e"
              onPointerDown={(event) => startInteraction(event, windowState.id, 'resize-e', windowState)}
            />
            <div
              className="gn-detached-result-resize-s"
              onPointerDown={(event) => startInteraction(event, windowState.id, 'resize-s', windowState)}
            />
            <div
              className="gn-detached-result-resize-se"
              onPointerDown={(event) => startInteraction(event, windowState.id, 'resize-se', windowState)}
            />
          </div>
        );
      })}
      </div>
    </ConfigProvider>
  );

  return typeof document === 'undefined'
    ? floatingWindows
    : createPortal(floatingWindows, document.body);
};

export default FloatingQueryResultWindows;
