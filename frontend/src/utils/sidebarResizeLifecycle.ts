export const SIDEBAR_RESIZING_ATTRIBUTE = 'data-sidebar-resizing';
export const SIDEBAR_TRANSITIONING_ATTRIBUTE = 'data-sidebar-transitioning';
export const SIDEBAR_RESIZE_SETTLED_EVENT = 'gonavi:sidebar-resize-settled';

export const isSidebarResizeActive = (): boolean => (
  typeof document !== 'undefined'
  && (
    document.body?.getAttribute(SIDEBAR_RESIZING_ATTRIBUTE) === 'true'
    || document.body?.getAttribute(SIDEBAR_TRANSITIONING_ATTRIBUTE) === 'true'
  )
);

export const notifySidebarResizeSettled = (): void => {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
  const event = typeof Event === 'function'
    ? new Event(SIDEBAR_RESIZE_SETTLED_EVENT)
    : ({ type: SIDEBAR_RESIZE_SETTLED_EVENT } as Event);
  window.dispatchEvent(event);
};

type SidebarResizeAwareFrameScheduler = {
  dispose: () => void;
  schedule: () => void;
};

/**
 * Coalesces resize work into one animation frame and suspends it while the
 * sidebar is being dragged or collapsing/expanding. The final sidebar width is
 * measured once after layout settles instead of forcing React/layout work for
 * every intermediate geometry update.
 */
export const createSidebarResizeAwareFrameScheduler = (
  callback: () => void,
): SidebarResizeAwareFrameScheduler => {
  let disposed = false;
  let dirty = false;
  let frameId: number | null = null;

  const flush = () => {
    frameId = null;
    if (disposed || !dirty) return;
    if (isSidebarResizeActive()) return;
    dirty = false;
    callback();
  };

  const queueFrame = () => {
    if (disposed || frameId !== null) return;
    frameId = requestAnimationFrame(flush);
  };

  const schedule = () => {
    if (disposed) return;
    dirty = true;
    if (isSidebarResizeActive()) return;
    queueFrame();
  };

  const handleSidebarResizeSettled = () => {
    if (!dirty || disposed) return;
    queueFrame();
  };

  if (typeof window !== 'undefined') {
    window.addEventListener(SIDEBAR_RESIZE_SETTLED_EVENT, handleSidebarResizeSettled);
  }

  return {
    schedule,
    dispose: () => {
      disposed = true;
      dirty = false;
      if (frameId !== null) {
        cancelAnimationFrame(frameId);
        frameId = null;
      }
      if (typeof window !== 'undefined') {
        window.removeEventListener(SIDEBAR_RESIZE_SETTLED_EVENT, handleSidebarResizeSettled);
      }
    },
  };
};
