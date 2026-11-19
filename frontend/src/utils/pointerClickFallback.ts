/*
 * macOS 27.2 有一批系统级丢点击的反馈：鼠标按下了，页面收不到 click，
 * 只有轻微移动或改用触控板才正常。按钮看起来完全没反应，也没有任何报错。
 * 这里在 pointerup 后补发一次 click；正常浏览器已经发出 click 时不会重复。
 */

const CLICKABLE_SELECTOR = [
  'button',
  '[role="button"]',
  'a[href]',
  '.ant-dropdown-trigger',
].join(', ');

const FALLBACK_DELAY_MS = 30;
const SUPPRESS_WINDOW_MS = 500;

export const shouldFallbackClick = (input: {
  button: number;
  targetIsClickable: boolean;
  targetDisabled: boolean;
  targetInEditor: boolean;
}): boolean => (
  input.button === 0
  && input.targetIsClickable
  && !input.targetDisabled
  && !input.targetInEditor
);

export const installPointerClickFallback = (): (() => void) => {
  if (typeof document === 'undefined') {
    return () => undefined;
  }

  let sequence = 0;
  let clickSeenFor = 0;
  let suppressTarget: Element | null = null;
  let suppressUntil = 0;

  const isDisabled = (element: Element): boolean => {
    if (element.matches(':disabled')) return true;
    if (element.getAttribute('aria-disabled') === 'true') return true;
    return Boolean(element.closest('.ant-btn-disabled'));
  };

  const handlePointerUp = (event: PointerEvent) => {
    const rawTarget = event.target instanceof Element ? event.target : null;
    const target = rawTarget?.closest(CLICKABLE_SELECTOR) ?? null;
    if (!target) return;
    if (!shouldFallbackClick({
      button: event.button,
      targetIsClickable: true,
      targetDisabled: isDisabled(target),
      targetInEditor: Boolean(target.closest('.monaco-editor')),
    })) return;

    const id = ++sequence;
    const { clientX, clientY } = event;
    window.setTimeout(() => {
      if (id !== sequence || clickSeenFor === id) return;
      suppressTarget = target;
      suppressUntil = performance.now() + SUPPRESS_WINDOW_MS;
      const synthetic = new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
        button: 0,
        clientX,
        clientY,
      });
      (synthetic as MouseEvent & { __gnSynthetic?: boolean }).__gnSynthetic = true;
      target.dispatchEvent(synthetic);
    }, FALLBACK_DELAY_MS);
  };

  const handleClick = (event: MouseEvent) => {
    if ((event as MouseEvent & { __gnSynthetic?: boolean }).__gnSynthetic) return;
    if (suppressTarget && performance.now() < suppressUntil) {
      const target = event.target instanceof Node ? event.target : null;
      if (target && (suppressTarget === target || suppressTarget.contains(target))) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
    }
    clickSeenFor = sequence;
  };

  document.addEventListener('pointerup', handlePointerUp, true);
  document.addEventListener('click', handleClick, true);
  return () => {
    document.removeEventListener('pointerup', handlePointerUp, true);
    document.removeEventListener('click', handleClick, true);
  };
};
