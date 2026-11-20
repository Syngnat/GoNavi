export const pickBrowserInputFile = (): Promise<File | null> => {
  if (typeof document === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.csv,.json,.xlsx';
    input.hidden = true;
    let settled = false;
    let windowBlurred = false;
    let focusTimer: ReturnType<typeof setTimeout> | null = null;
    let hardTimeout: ReturnType<typeof setTimeout> | null = null;
    const finish = (file: File | null) => {
      if (settled) return;
      settled = true;
      if (focusTimer !== null) clearTimeout(focusTimer);
      if (hardTimeout !== null) clearTimeout(hardTimeout);
      window.removeEventListener('focus', handleWindowFocus);
      window.removeEventListener('blur', handleWindowBlur);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      input.remove();
      resolve(file);
    };
    const checkCancel = () => {
      if (focusTimer !== null) clearTimeout(focusTimer);
      focusTimer = setTimeout(() => {
        focusTimer = null;
        finish(input.files?.[0] || null);
      }, 1_000);
    };
    const handleWindowBlur = () => { windowBlurred = true; };
    const handleWindowFocus = () => {
      if (windowBlurred) checkCancel();
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') checkCancel();
    };
    input.addEventListener('change', () => finish(input.files?.[0] || null), { once: true });
    input.addEventListener('cancel', () => finish(null), { once: true });
    window.addEventListener('focus', handleWindowFocus);
    window.addEventListener('blur', handleWindowBlur);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    hardTimeout = setTimeout(() => finish(null), 5 * 60_000);
    document.body.appendChild(input);
    input.click();
  });
};
