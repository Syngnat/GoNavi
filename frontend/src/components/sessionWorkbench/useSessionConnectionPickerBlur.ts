import { useCallback, useEffect, useRef } from 'react';

const PICKER_SELECTOR = '.gn-session-workbench-connection-select';

const blurActivePickerElement = (): void => {
  if (typeof document === 'undefined') return;
  const activeElement = document.activeElement;
  if (!(activeElement instanceof HTMLElement)) return;
  if (!activeElement.closest(PICKER_SELECTOR)) return;
  activeElement.blur();
};

/**
 * WebKit can deliver the previous popup's blur after rc-select has already
 * reopened it. Release the search focus after the current click settles, and
 * cancel that release if a new open cycle starts first.
 */
export const useSessionConnectionPickerBlur = () => {
  const pendingBlurTimerRef = useRef<number | null>(null);

  const cancelPendingBlur = useCallback(() => {
    if (pendingBlurTimerRef.current === null) return;
    window.clearTimeout(pendingBlurTimerRef.current);
    pendingBlurTimerRef.current = null;
  }, []);

  const scheduleBlurAfterClose = useCallback(() => {
    cancelPendingBlur();
    pendingBlurTimerRef.current = window.setTimeout(() => {
      pendingBlurTimerRef.current = null;
      blurActivePickerElement();
    }, 0);
  }, [cancelPendingBlur]);

  useEffect(() => () => cancelPendingBlur(), [cancelPendingBlur]);

  return { cancelPendingBlur, scheduleBlurAfterClose };
};
