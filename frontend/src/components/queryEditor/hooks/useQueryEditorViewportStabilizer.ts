import { useCallback, useEffect, useRef, type MutableRefObject, type RefObject } from 'react';

interface QueryEditorLayoutHandle {
  updateOptions?: (options: { automaticLayout: boolean }) => void;
  layout?: () => void;
  render?: (forceRedraw?: boolean) => void;
}

interface QueryEditorViewportStabilizerArgs {
  isActive: boolean;
  editorRef: MutableRefObject<QueryEditorLayoutHandle | null>;
  editorStageRef: RefObject<HTMLElement | null>;
  editorShellRef: RefObject<HTMLElement | null>;
}

const INITIAL_LAYOUT_DELAYS_MS = [0, 60, 240, 800];

const readElementSize = (element: HTMLElement | null): { width: number; height: number } => {
  const rect = element?.getBoundingClientRect?.();
  return {
    width: Math.max(0, Math.round(Number(rect?.width) || 0)),
    height: Math.max(0, Math.round(Number(rect?.height) || 0)),
  };
};

/**
 * Monaco can mount before a restored/maximised Wails window reaches its final
 * size. automaticLayout does not reliably catch that first WKWebView surface
 * change, leaving the editor viewport shorter than its DOM container until a
 * tab switch forces layout(). Keep the editor viewport in sync with the real
 * container and force a redraw after the window becomes visible/focused.
 */
export const useQueryEditorViewportStabilizer = ({
  isActive,
  editorRef,
  editorStageRef,
  editorShellRef,
}: QueryEditorViewportStabilizerArgs): (() => void) => {
  const scopeRef = useRef({
    isActive,
    editorRef,
    editorStageRef,
    editorShellRef,
  });
  const initialLayoutSettledRef = useRef(false);
  const forceLayoutRef = useRef<(() => void) | null>(null);
  scopeRef.current = {
    isActive,
    editorRef,
    editorStageRef,
    editorShellRef,
  };

  useEffect(() => {
    if (!isActive) {
      return undefined;
    }

    let disposed = false;
    let layoutFrame: number | null = null;
    let pendingForceRedraw = false;
    let lastSize = readElementSize(
      scopeRef.current.editorStageRef.current || scopeRef.current.editorShellRef.current,
    );
    const timers: Array<ReturnType<typeof globalThis.setTimeout>> = [];
    const requestFrame = typeof globalThis.requestAnimationFrame === 'function'
      ? globalThis.requestAnimationFrame.bind(globalThis)
      : null;
    const cancelFrame = typeof globalThis.cancelAnimationFrame === 'function'
      ? globalThis.cancelAnimationFrame.bind(globalThis)
      : null;

    const flushLayout = () => {
      layoutFrame = null;
      if (disposed) return;
      const editor = scopeRef.current.editorRef.current;
      if (!editor) return;
      const nextSize = readElementSize(
        scopeRef.current.editorStageRef.current || scopeRef.current.editorShellRef.current,
      );
      if (nextSize.width <= 0 || nextSize.height <= 0) return;
      editor.updateOptions?.({ automaticLayout: true });
      editor.layout?.();
      if (pendingForceRedraw) {
        editor.render?.();
      }
      pendingForceRedraw = false;
    };

    const scheduleLayout = (forceRedraw = false) => {
      if (disposed) return;
      pendingForceRedraw = pendingForceRedraw || forceRedraw;
      if (layoutFrame !== null) return;
      if (requestFrame) {
        layoutFrame = requestFrame(flushLayout);
      } else {
        flushLayout();
      }
    };

    const scheduleForObservedSize = () => {
      if (disposed) return;
      const nextSize = readElementSize(
        scopeRef.current.editorStageRef.current || scopeRef.current.editorShellRef.current,
      );
      if (nextSize.width <= 0 || nextSize.height <= 0) return;
      if (nextSize.width === lastSize.width && nextSize.height === lastSize.height) return;
      lastSize = nextSize;
      scheduleLayout();
    };

    const forceLayout = () => {
      lastSize = readElementSize(
        scopeRef.current.editorStageRef.current || scopeRef.current.editorShellRef.current,
      );
      scheduleLayout(true);
    };
    forceLayoutRef.current = forceLayout;

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        forceLayout();
      }
    };

    if (!initialLayoutSettledRef.current) {
      initialLayoutSettledRef.current = true;
      timers.push(...INITIAL_LAYOUT_DELAYS_MS.map((delayMs) => (
        globalThis.setTimeout(forceLayout, delayMs)
      )));
    } else {
      timers.push(globalThis.setTimeout(forceLayout, 0));
    }

    const ResizeObserverCtor = typeof ResizeObserver === 'function' ? ResizeObserver : null;
    const resizeObserver = ResizeObserverCtor ? new ResizeObserverCtor(scheduleForObservedSize) : null;
    const stage = scopeRef.current.editorStageRef.current;
    const shell = scopeRef.current.editorShellRef.current;
    if (stage) resizeObserver?.observe(stage);
    if (shell) resizeObserver?.observe(shell);

    window.addEventListener?.('resize', scheduleForObservedSize);
    window.addEventListener?.('focus', forceLayout);
    window.addEventListener?.('pageshow', forceLayout);
    document.addEventListener?.('visibilitychange', handleVisibilityChange);
    const visualViewport = window.visualViewport;
    visualViewport?.addEventListener?.('resize', scheduleForObservedSize);

    const fontsReady = document.fonts?.ready;
    if (fontsReady && typeof fontsReady.then === 'function') {
      void fontsReady.then(() => {
        if (!disposed) forceLayout();
      }).catch(() => undefined);
    }

    return () => {
      disposed = true;
      if (forceLayoutRef.current === forceLayout) {
        forceLayoutRef.current = null;
      }
      timers.forEach((timer) => globalThis.clearTimeout(timer));
      if (layoutFrame !== null) {
        cancelFrame?.(layoutFrame);
        layoutFrame = null;
      }
      resizeObserver?.disconnect();
      window.removeEventListener?.('resize', scheduleForObservedSize);
      window.removeEventListener?.('focus', forceLayout);
      window.removeEventListener?.('pageshow', forceLayout);
      document.removeEventListener?.('visibilitychange', handleVisibilityChange);
      visualViewport?.removeEventListener?.('resize', scheduleForObservedSize);
    };
  }, [isActive]);

  return useCallback(() => {
    forceLayoutRef.current?.();
    globalThis.setTimeout(() => forceLayoutRef.current?.(), 60);
    globalThis.setTimeout(() => forceLayoutRef.current?.(), 240);
  }, []);
};
