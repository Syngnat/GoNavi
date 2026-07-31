import React, { useEffect, useRef } from 'react';

type RedisResizableDividerProps = {
  onResizeEnd: (newWidth: number) => void;
  targetRef: React.RefObject<HTMLDivElement>;
  minWidth?: number;
  maxReservedWidth?: number;
  containerWidthCssVariable?: `--${string}`;
  title: string;
};

// Direct DOM updates keep the Redis workbench responsive during a drag.
const RedisResizableDivider: React.FC<RedisResizableDividerProps> = ({
  onResizeEnd,
  targetRef,
  minWidth = 300,
  maxReservedWidth = 350,
  containerWidthCssVariable,
  title,
}) => {
  const abortInteractionRef = useRef<(() => void) | null>(null);

  useEffect(() => () => {
    abortInteractionRef.current?.();
  }, []);

  const handleMouseDown = (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();

    const target = targetRef.current;
    if (!target) return;

    abortInteractionRef.current?.();

    const startX = event.clientX;
    const startWidth = target.offsetWidth;
    const container = target.parentElement;
    const containerWidth = container?.offsetWidth || window.innerWidth;
    const maxWidth = containerWidth - maxReservedWidth;
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;cursor:col-resize;z-index:9999;';
    document.body.appendChild(overlay);

    let currentWidth = startWidth;

    const cleanup = (commit: boolean) => {
      if (abortInteractionRef.current !== abortInteraction) return;
      abortInteractionRef.current = null;
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', finishInteraction);
      window.removeEventListener('blur', finishInteraction);
      if (overlay.isConnected) {
        overlay.remove();
      }
      if (commit) {
        onResizeEnd(currentWidth);
      }
    };

    const abortInteraction = () => cleanup(false);
    const finishInteraction = () => cleanup(true);
    const handleMouseMove = (moveEvent: MouseEvent) => {
      if (moveEvent.buttons === 0) {
        finishInteraction();
        return;
      }
      moveEvent.preventDefault();
      const delta = moveEvent.clientX - startX;
      currentWidth = Math.max(minWidth, Math.min(maxWidth, startWidth + delta));
      if (containerWidthCssVariable && container) {
        container.style.setProperty(containerWidthCssVariable, `${currentWidth}px`);
      } else {
        target.style.width = `${currentWidth}px`;
        target.style.flexBasis = `${currentWidth}px`;
      }
    };

    abortInteractionRef.current = abortInteraction;
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', finishInteraction);
    window.addEventListener('blur', finishInteraction);
  };

  return (
    <div
      className="redis-resizable-divider"
      onMouseDown={handleMouseDown}
      style={{
        width: 5,
        cursor: 'col-resize',
        background: 'transparent',
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 10,
      }}
      title={title}
    />
  );
};

export default RedisResizableDivider;
