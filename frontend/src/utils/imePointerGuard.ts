/*
 * macOS 27 + 第三方输入法 + 触控板「轻点点按」时，Wails v3 会把焦点切走，
 * 但不把这次 click 交给页面（wailsapp/wails#6516）。
 * 在输入框还持有焦点时先主动失焦，输入法不会参与这次按下的后续处理，
 * 按钮和弹层就能正常收到点击。
 */

const NON_TEXT_INPUT_TYPES = new Set([
  'button',
  'checkbox',
  'color',
  'file',
  'hidden',
  'image',
  'radio',
  'range',
  'reset',
  'submit',
]);

const TEXT_ENTRY_SELECTOR = [
  'input',
  'textarea',
  '[contenteditable=""]',
  '[contenteditable="true"]',
  '[contenteditable="plaintext-only"]',
].join(', ');

// 编辑器内部（行、滚动条、查找框）都靠自己的 mousedown 接管焦点，不能被提前 blur。
const TEXT_SURFACE_SELECTOR = `${TEXT_ENTRY_SELECTOR}, .monaco-editor`;

export const isTextEntryElement = (element: Element | null): boolean => {
  if (!element) return false;
  const tagName = element.tagName.toLowerCase();
  if (tagName === 'textarea') return true;
  if (tagName === 'input') {
    const inputType = (element as HTMLInputElement).type.toLowerCase();
    return !NON_TEXT_INPUT_TYPES.has(inputType);
  }
  return (element as HTMLElement).isContentEditable === true;
};

export const shouldBlurBeforePointerDown = (input: {
  button: number;
  targetIsTextEntry: boolean;
  activeIsTextEntry: boolean;
  activeContainsTarget: boolean;
}): boolean => (
  input.button === 0
  && !input.targetIsTextEntry
  && input.activeIsTextEntry
  && !input.activeContainsTarget
);

export const installImePointerGuard = (): (() => void) => {
  if (typeof document === 'undefined') {
    return () => undefined;
  }

  const handlePointerDown = (event: PointerEvent) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    const active = document.activeElement;
    const shouldBlur = shouldBlurBeforePointerDown({
      button: event.button,
      targetIsTextEntry: Boolean(target.closest(TEXT_SURFACE_SELECTOR)),
      activeIsTextEntry: isTextEntryElement(active),
      activeContainsTarget: Boolean(active && active.contains(target)),
    });
    if (!shouldBlur) return;
    (active as HTMLElement).blur();
  };

  document.addEventListener('pointerdown', handlePointerDown, true);
  return () => document.removeEventListener('pointerdown', handlePointerDown, true);
};
