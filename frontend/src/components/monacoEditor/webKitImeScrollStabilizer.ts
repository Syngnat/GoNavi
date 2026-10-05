const isWebKitImeScrollRuntime = (): boolean => {
  const userAgent = typeof navigator === 'undefined' ? '' : String(navigator.userAgent || '');
  return /AppleWebKit\//i.test(userAgent)
    && !/(?:Chrome|Chromium|CriOS|Edg|EdgiOS|OPR|OPiOS|FxiOS)\//i.test(userAgent);
};

export const installWebKitImeScrollStabilizer = (editor: any) => {
  if (!isWebKitImeScrollRuntime() || editor?.__gonaviWebKitImeScrollStabilizerInstalled) {
    return;
  }

  const editorDomNode = editor?.getDomNode?.();
  const TextAreaElement = typeof HTMLTextAreaElement === 'undefined' ? null : HTMLTextAreaElement;
  const input = editorDomNode?.querySelector?.('textarea.inputarea, .inputarea textarea, textarea') as HTMLTextAreaElement | null;
  if (!TextAreaElement || !(input instanceof TextAreaElement)) {
    return;
  }

  Object.defineProperty(editor, '__gonaviWebKitImeScrollStabilizerInstalled', {
    value: true,
    configurable: true,
  });

  let composing = false;
  let compositionScrollLeft = 0;
  let compositionScrollTop = 0;

  const restoreCompositionScroll = () => {
    if (!composing) {
      return;
    }
    if (input.scrollLeft !== compositionScrollLeft) {
      input.scrollLeft = compositionScrollLeft;
    }
    if (input.scrollTop !== compositionScrollTop) {
      input.scrollTop = compositionScrollTop;
    }
  };
  const handleCompositionStart = () => {
    // Monaco has already positioned its visible IME textarea when this listener runs.
    // Keep that baseline stable while WebKit and Monaco both try to scroll the textarea.
    compositionScrollLeft = input.scrollLeft;
    compositionScrollTop = input.scrollTop;
    composing = true;
  };
  const handleCompositionEnd = () => {
    composing = false;
  };
  const handleBlur = () => {
    composing = false;
  };

  input.addEventListener('compositionstart', handleCompositionStart);
  input.addEventListener('compositionupdate', restoreCompositionScroll);
  input.addEventListener('compositionend', handleCompositionEnd);
  input.addEventListener('scroll', restoreCompositionScroll);
  input.addEventListener('blur', handleBlur);

  editor.onDidDispose?.(() => {
    composing = false;
    input.removeEventListener('compositionstart', handleCompositionStart);
    input.removeEventListener('compositionupdate', restoreCompositionScroll);
    input.removeEventListener('compositionend', handleCompositionEnd);
    input.removeEventListener('scroll', restoreCompositionScroll);
    input.removeEventListener('blur', handleBlur);
  });
};
