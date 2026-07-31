import React, { useCallback, useEffect, useRef } from 'react';
import {
  SIDEBAR_RESIZE_MAX_WIDTH,
  SIDEBAR_RESIZE_MIN_WIDTH,
  resolveSidebarResizeMaxWidth,
} from '../utils/sidebarLayout';

type SidebarResizeBounds = { minWidth: number; maxWidth: number };
type SidebarResizeDragState = SidebarResizeBounds & {
  startX: number;
  startWidth: number;
};
type SidebarResizeListeners = {
  blur: () => void;
  move: (event: MouseEvent) => void;
  up: (event: MouseEvent) => void;
};

const parseCssPixelValue = (value: string | null | undefined): number | null => {
  const parsed = Number.parseFloat(String(value || ''));
  return Number.isFinite(parsed) ? parsed : null;
};

const resolveSidebarResizeBounds = (siderElement: Element | null): SidebarResizeBounds => {
  if (typeof window === 'undefined' || !(siderElement instanceof HTMLElement)) {
    return { minWidth: SIDEBAR_RESIZE_MIN_WIDTH, maxWidth: SIDEBAR_RESIZE_MAX_WIDTH };
  }
  const computed = window.getComputedStyle(siderElement);
  const cssMinWidth = parseCssPixelValue(computed.minWidth);
  const cssMaxWidth = parseCssPixelValue(computed.maxWidth);
  const minWidth = Math.max(SIDEBAR_RESIZE_MIN_WIDTH, cssMinWidth && cssMinWidth > 0 ? cssMinWidth : SIDEBAR_RESIZE_MIN_WIDTH);
  const viewportMaxWidth = resolveSidebarResizeMaxWidth(window.innerWidth, minWidth);
  const maxWidth = Math.max(minWidth, Math.min(viewportMaxWidth, cssMaxWidth && cssMaxWidth > 0 ? cssMaxWidth : viewportMaxWidth));
  return { minWidth, maxWidth };
};

const clampSidebarResizeWidth = (width: number, bounds: SidebarResizeBounds): number => (
  Math.max(bounds.minWidth, Math.min(bounds.maxWidth, width))
);

const SIDEBAR_RESIZE_WIDTH_CSS_VARIABLE = '--gonavi-sidebar-resize-width';

type UseAppSidebarResizeOptions = {
  effectiveUiScale: number;
  setSidebarWidth: (width: number) => void;
  sidebarWidth: number;
};

export const useAppSidebarResize = ({
  effectiveUiScale,
  setSidebarWidth,
  sidebarWidth,
}: UseAppSidebarResizeOptions) => {
  const sidebarDragRef = useRef<SidebarResizeDragState | null>(null);
  const rafRef = useRef<number | null>(null);
  const clearResizingFrameRef = useRef<number | null>(null);
  const siderRef = useRef<HTMLDivElement | null>(null);
  const sidebarDragBodyStyleRef = useRef<{ cursor: string; userSelect: string; webkitUserSelect: string } | null>(null);
  const sidebarResizeListenersRef = useRef<SidebarResizeListeners | null>(null);
  const latestMouseX = useRef<number>(0);
  const setSidebarWidthRef = useRef(setSidebarWidth);
  setSidebarWidthRef.current = setSidebarWidth;
  const sidebarResizeHandleWidth = Math.max(16, Math.round(16 * effectiveUiScale));

  const cancelClearResizingFrame = useCallback(() => {
    if (clearResizingFrameRef.current === null) return;
    cancelAnimationFrame(clearResizingFrameRef.current);
    clearResizingFrameRef.current = null;
  }, []);

  /**
   * Mark the sider as mid-resize so CSS can disable Ant Design's default
   * `transition: all`. Without this, committing width animates for ~200ms and
   * forces the workbench/DataGrid to reflow on every animation frame.
   */
  const setSidebarResizing = useCallback((active: boolean) => {
    const sider = siderRef.current;
    if (sider instanceof HTMLElement) {
      if (active) {
        sider.setAttribute('data-sidebar-resizing', 'true');
      } else {
        sider.removeAttribute('data-sidebar-resizing');
        sider.style.removeProperty(SIDEBAR_RESIZE_WIDTH_CSS_VARIABLE);
      }
    }
    if (typeof document !== 'undefined') {
      if (active) {
        document.body.setAttribute('data-sidebar-resizing', 'true');
      } else {
        document.body.removeAttribute('data-sidebar-resizing');
      }
    }
  }, []);

  const previewSidebarWidth = useCallback((width: number) => {
    const sider = siderRef.current;
    if (!(sider instanceof HTMLElement)) return;
    sider.style.setProperty(SIDEBAR_RESIZE_WIDTH_CSS_VARIABLE, `${width}px`);
  }, []);

  const scheduleClearSidebarResizing = useCallback(() => {
    cancelClearResizingFrame();
    if (typeof window === 'undefined') {
      setSidebarResizing(false);
      return;
    }
    // Wait two frames so React can paint the committed width while transition
    // is still disabled, then re-enable collapse animations.
    clearResizingFrameRef.current = requestAnimationFrame(() => {
      clearResizingFrameRef.current = requestAnimationFrame(() => {
        clearResizingFrameRef.current = null;
        setSidebarResizing(false);
      });
    });
  }, [cancelClearResizingFrame, setSidebarResizing]);

  const detachSidebarResizeListeners = useCallback(() => {
    const listeners = sidebarResizeListenersRef.current;
    if (!listeners) return;
    sidebarResizeListenersRef.current = null;
    if (typeof document !== 'undefined') {
      document.removeEventListener('mousemove', listeners.move);
      document.removeEventListener('mouseup', listeners.up);
    }
    if (typeof window !== 'undefined') {
      window.removeEventListener('blur', listeners.blur);
    }
  }, []);

  const restoreSidebarDragBodyStyles = useCallback(() => {
    if (!sidebarDragBodyStyleRef.current || typeof document === 'undefined') {
      sidebarDragBodyStyleRef.current = null;
      return;
    }

    const previous = sidebarDragBodyStyleRef.current;
    document.body.style.cursor = previous.cursor;
    document.body.style.userSelect = previous.userSelect;
    document.body.style.webkitUserSelect = previous.webkitUserSelect;
    sidebarDragBodyStyleRef.current = null;
  }, []);

  const finishSidebarResize = useCallback((clientX?: number, commit = true) => {
    const dragState = sidebarDragRef.current;
    sidebarDragRef.current = null;

    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }

    detachSidebarResizeListeners();
    restoreSidebarDragBodyStyles();

    if (commit && dragState) {
      const finalMouseX = Number.isFinite(clientX) ? clientX as number : latestMouseX.current;
      const delta = finalMouseX - dragState.startX;
      const finalWidth = clampSidebarResizeWidth(
        dragState.startWidth + delta,
        dragState,
      );
      // Keep transition disabled across the state commit + first paint.
      previewSidebarWidth(finalWidth);
      setSidebarResizing(true);
      setSidebarWidthRef.current(finalWidth);
      scheduleClearSidebarResizing();
      return;
    }

    cancelClearResizingFrame();
    setSidebarResizing(false);
  }, [
    cancelClearResizingFrame,
    detachSidebarResizeListeners,
    previewSidebarWidth,
    restoreSidebarDragBodyStyles,
    scheduleClearSidebarResizing,
    setSidebarResizing,
  ]);

  const handleSidebarMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    e.preventDefault();
    e.stopPropagation();

    finishSidebarResize(undefined, false);
    cancelClearResizingFrame();

    if (typeof document !== 'undefined') {
      sidebarDragBodyStyleRef.current = {
        cursor: document.body.style.cursor,
        userSelect: document.body.style.userSelect,
        webkitUserSelect: document.body.style.webkitUserSelect,
      };
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      document.body.style.webkitUserSelect = 'none';
    }

    const siderRect = siderRef.current?.getBoundingClientRect();
    const startWidth = siderRect?.width ?? sidebarWidth;
    const resizeBounds = resolveSidebarResizeBounds(siderRef.current);

    previewSidebarWidth(startWidth);
    setSidebarResizing(true);

    sidebarDragRef.current = {
      startX: e.clientX,
      startWidth,
      ...resizeBounds,
    };
    latestMouseX.current = e.clientX;

    const handleMove = (event: MouseEvent) => {
      if (!sidebarDragRef.current) return;
      latestMouseX.current = event.clientX;
      if (event.buttons === 0) {
        finishSidebarResize(event.clientX);
        return;
      }
      if (rafRef.current !== null) return;

      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        if (!sidebarDragRef.current) return;
        const { startX, startWidth, minWidth, maxWidth } = sidebarDragRef.current;
        const delta = latestMouseX.current - startX;
        const newWidth = clampSidebarResizeWidth(startWidth + delta, { minWidth, maxWidth });
        previewSidebarWidth(newWidth);
      });
    };
    const handleUp = (event: MouseEvent) => finishSidebarResize(event.clientX);
    const handleBlur = () => finishSidebarResize();

    sidebarResizeListenersRef.current = {
      blur: handleBlur,
      move: handleMove,
      up: handleUp,
    };
    document.addEventListener('mousemove', handleMove);
    document.addEventListener('mouseup', handleUp);
    window.addEventListener('blur', handleBlur);
  }, [cancelClearResizingFrame, finishSidebarResize, previewSidebarWidth, setSidebarResizing, sidebarWidth]);

  useEffect(() => () => {
    finishSidebarResize(undefined, false);
    cancelClearResizingFrame();
  }, [cancelClearResizingFrame, finishSidebarResize]);

  return {
    handleSidebarMouseDown,
    sidebarResizeHandleWidth,
    siderRef,
  };
};
