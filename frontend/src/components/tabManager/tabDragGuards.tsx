import React from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { NativeDetachTerminalPointer } from '../../utils/detachedWindow';

type DraggableTabNodeProps = {
  node: React.ReactElement;
};

const TAB_DRAG_INTERACTIVE_SELECTOR = [
  'button',
  'a',
  'input',
  'textarea',
  'select',
  '[contenteditable="true"]',
  '[role="button"]',
  '[role="menuitem"]',
  '[data-tab-drag-ignore="true"]',
  '.ant-dropdown-menu',
  '.ant-tabs-tab-remove',
  '.gn-v2-tab-close',
].join(', ');

export const shouldActivateTabDragPointer = (event: {
  button: number;
  ctrlKey?: boolean;
  isPrimary?: boolean;
  target: EventTarget | null;
}): boolean => {
  if (event.button !== 0 || event.ctrlKey || event.isPrimary === false) return false;
  const target = event.target as { closest?: (selector: string) => Element | null } | null;
  return typeof target?.closest !== 'function'
    || target.closest(TAB_DRAG_INTERACTIVE_SELECTOR) === null;
};

export const handleTabDragPointerDown = (
  event: React.PointerEvent<HTMLElement>,
  handlePointerDown?: React.PointerEventHandler<HTMLElement>,
): void => {
  if (!shouldActivateTabDragPointer(event)) return;
  try {
    event.currentTarget.setPointerCapture(event.pointerId);
  } catch {
    // Pointer capture is not exposed by every embedded WebView build.
  }
  handlePointerDown?.(event);
};

type TabDetachDragGuardOptions = {
  windowTarget: EventTarget;
  captureTarget: EventTarget | null;
  rootClassList: Pick<DOMTokenList, 'add' | 'remove'>;
  pointerId: number | null;
  isCurrent: () => boolean;
  onTerminalPointer: (pointer: NativeDetachTerminalPointer) => void;
  onInterrupted: () => void;
  cancelDndDrag: () => void;
};

export const installTabDetachDragGuards = ({
  windowTarget,
  captureTarget,
  rootClassList,
  pointerId,
  isCurrent,
  onTerminalPointer,
  onInterrupted,
  cancelDndDrag,
}: TabDetachDragGuardOptions): (() => void) => {
  let removed = false;
  const matchesPointer = (event: PointerEvent) => (
    pointerId === null || event.pointerId === pointerId
  );
  const interrupt = () => {
    if (removed || !isCurrent()) return;
    try {
      onInterrupted();
    } finally {
      cancelDndDrag();
    }
  };
  const recordTerminalPointer = (event: Event) => {
    const pointerEvent = event as PointerEvent;
    if (removed || !isCurrent() || !matchesPointer(pointerEvent)) return;
    onTerminalPointer({
      type: event.type === 'pointercancel' ? 'pointercancel' : 'pointerup',
      clientX: pointerEvent.clientX,
      clientY: pointerEvent.clientY,
      screenX: pointerEvent.screenX,
      screenY: pointerEvent.screenY,
    });
  };
  const handlePointerMove = (event: Event) => {
    const pointerEvent = event as PointerEvent;
    if (matchesPointer(pointerEvent) && pointerEvent.buttons === 0) {
      interrupt();
    }
  };
  const handleLostPointerCapture = (event: Event) => {
    if (matchesPointer(event as PointerEvent)) {
      interrupt();
    }
  };
  const handleWindowBlur = () => interrupt();

  windowTarget.addEventListener('pointermove', handlePointerMove, true);
  windowTarget.addEventListener('pointerup', recordTerminalPointer, true);
  windowTarget.addEventListener('pointercancel', recordTerminalPointer, true);
  windowTarget.addEventListener('blur', handleWindowBlur);
  captureTarget?.addEventListener('lostpointercapture', handleLostPointerCapture);
  rootClassList.add('gn-workbench-tab-detaching');

  return () => {
    if (removed) return;
    removed = true;
    windowTarget.removeEventListener('pointermove', handlePointerMove, true);
    windowTarget.removeEventListener('pointerup', recordTerminalPointer, true);
    windowTarget.removeEventListener('pointercancel', recordTerminalPointer, true);
    windowTarget.removeEventListener('blur', handleWindowBlur);
    captureTarget?.removeEventListener('lostpointercapture', handleLostPointerCapture);
    if (captureTarget && pointerId !== null) {
      const pointerCaptureTarget = captureTarget as HTMLElement;
      try {
        if (pointerCaptureTarget.hasPointerCapture?.(pointerId)) {
          pointerCaptureTarget.releasePointerCapture(pointerId);
        }
      } catch {
        // Pointer capture may already be gone after blur, cancellation, or unmount.
      }
    }
    rootClassList.remove('gn-workbench-tab-detaching');
  };
};

export const DraggableTabNode: React.FC<DraggableTabNodeProps> = ({ node }) => {
  const tabId = String(node.key || '').trim();
  const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: tabId });
  const style: React.CSSProperties = {
    ...(node.props.style || {}),
    transform: CSS.Transform.toString(transform),
    transition: transition || 'transform 180ms cubic-bezier(0.22, 1, 0.36, 1)',
    opacity: isDragging ? 0.88 : 1,
    cursor: isDragging ? 'grabbing' : 'grab',
    touchAction: 'none',
    zIndex: isDragging ? 2 : node.props.style?.zIndex,
  };
  const handlePointerDown = listeners?.onPointerDown as React.PointerEventHandler<HTMLElement> | undefined;

  return React.cloneElement(node, {
    ref: setNodeRef,
    style,
    ...listeners,
    onPointerDown: (event: React.PointerEvent<HTMLElement>) =>
      handleTabDragPointerDown(event, handlePointerDown),
    className: `${node.props.className || ''} tab-dnd-node${isDragging ? ' is-dragging' : ''}`,
  });
};
