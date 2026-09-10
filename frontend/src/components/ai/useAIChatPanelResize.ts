import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';

interface UseAIChatPanelResizeOptions {
  width: number;
  onWidthChange?: (width: number) => void;
}

export const useAIChatPanelResize = ({
  width,
  onWidthChange,
}: UseAIChatPanelResizeOptions) => {
  const [panelWidth, setPanelWidth] = useState(width);
  const [isResizing, setIsResizing] = useState(false);

  const panelRef = useRef<HTMLDivElement>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  const panelRect = useRef<{ top: number; bottom: number; left: number } | null>(null);
  const resizeStartX = useRef(0);
  const resizeStartWidth = useRef(0);
  const dragWidthRef = useRef(width);

  useEffect(() => {
    setPanelWidth(width);
    dragWidthRef.current = width;
  }, [width]);

  const handleResizeStart = useCallback((event: ReactMouseEvent) => {
    event.preventDefault();
    if (!panelRef.current) {
      return;
    }
    setIsResizing(true);
    resizeStartX.current = event.clientX;
    resizeStartWidth.current = panelWidth;
    dragWidthRef.current = panelWidth;
    const rect = panelRef.current.getBoundingClientRect();
    panelRect.current = {
      top: rect.top,
      bottom: window.innerHeight - rect.bottom,
      left: rect.left,
    };
  }, [panelWidth]);

  useEffect(() => {
    if (!isResizing) {
      return;
    }

    let animationFrameId = 0;
    let resizeFinished = false;
    const previousBodyStyles = {
      cursor: document.body.style.cursor,
      pointerEvents: document.body.style.pointerEvents,
      userSelect: document.body.style.userSelect,
    };
    const finishResize = () => {
      if (resizeFinished) {
        return;
      }
      resizeFinished = true;
      if (animationFrameId) {
        cancelAnimationFrame(animationFrameId);
      }
      setIsResizing(false);
      setPanelWidth(dragWidthRef.current);
      onWidthChange?.(dragWidthRef.current);
    };

    const handleMouseMove = (event: MouseEvent) => {
      if (event.buttons === 0) {
        finishResize();
        return;
      }
      if (animationFrameId) {
        cancelAnimationFrame(animationFrameId);
      }
      animationFrameId = requestAnimationFrame(() => {
        const delta = resizeStartX.current - event.clientX;
        const minWidth = 300;
        const maxWidth = 520;
        const nextWidth = Math.min(Math.max(resizeStartWidth.current + delta, minWidth), maxWidth);
        dragWidthRef.current = nextWidth;

        if (!ghostRef.current || !panelRect.current) {
          return;
        }
        const actualDelta = nextWidth - resizeStartWidth.current;
        ghostRef.current.style.left = `${panelRect.current.left - actualDelta}px`;
      });
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', finishResize);
    window.addEventListener('blur', finishResize);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.body.style.pointerEvents = 'none';

    return () => {
      if (animationFrameId) {
        cancelAnimationFrame(animationFrameId);
      }
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', finishResize);
      window.removeEventListener('blur', finishResize);
      document.body.style.cursor = previousBodyStyles.cursor;
      document.body.style.userSelect = previousBodyStyles.userSelect;
      document.body.style.pointerEvents = previousBodyStyles.pointerEvents;
    };
  }, [isResizing, onWidthChange]);

  return {
    ghostRef,
    handleResizeStart,
    isResizing,
    panelRect,
    panelRef,
    panelWidth,
  };
};
