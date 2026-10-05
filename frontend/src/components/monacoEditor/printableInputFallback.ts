import {
  SHORTCUT_INPUT_GUARD_WINDOW_MS,
  NON_PRINTABLE_INPUT_PATTERN,
  PRINTABLE_INPUT_FALLBACK_DELAY_MS,
} from './monacoEditorConstants';
import { sameEditorPosition, isSelectionEmpty, sameEditorRange } from './monacoEditorPositions';

export const installPrintableInputFallback = (editor: any, monaco: any) => {
  const editorDomNode = editor?.getDomNode?.();
  if (!editorDomNode || editor.__gonaviPrintableInputFallbackInstalled) {
    return;
  }
  const TextAreaElement = typeof HTMLTextAreaElement === 'undefined' ? null : HTMLTextAreaElement;
  const input = editorDomNode.querySelector?.('textarea.inputarea, .inputarea textarea, textarea') as HTMLTextAreaElement | null;
  if (!TextAreaElement || !(input instanceof TextAreaElement)) {
    return;
  }
  Object.defineProperty(editor, '__gonaviPrintableInputFallbackInstalled', {
    value: true,
    configurable: true,
  });

  let pendingInput: {
    valueBefore: string;
    positionBefore: any;
    offsetBefore: number;
    text: string;
    timer: number | null;
  } | null = null;
  let pendingSelectionInput: {
    valueBefore: string;
    rangeBefore: {
      startLineNumber: number;
      startColumn: number;
      endLineNumber: number;
      endColumn: number;
    };
    startOffset: number;
    endOffset: number;
    text: string;
    timer: number | null;
  } | null = null;
  let shortcutInputGuardKey = '';
  let shortcutInputGuardUntil = 0;
  let sqlInputFocused = true;

  const clearPendingInput = () => {
    if (!pendingInput) {
      return;
    }
    if (pendingInput.timer !== null) {
      clearTimeout(pendingInput.timer);
    }
    pendingInput = null;
  };

  const clearPendingSelectionInput = () => {
    if (!pendingSelectionInput) {
      return;
    }
    if (pendingSelectionInput.timer !== null) {
      clearTimeout(pendingSelectionInput.timer);
    }
    pendingSelectionInput = null;
  };

  const clearPendingInputs = () => {
    clearPendingInput();
    clearPendingSelectionInput();
  };

  const resolveKeyboardEvent = (rawEvent: any): any => (
    rawEvent?.browserEvent || rawEvent?.event || rawEvent
  );

  const hasModifier = (event: any, modifier: 'Alt' | 'Control' | 'Meta') => {
    const property = modifier === 'Control'
      ? 'ctrlKey'
      : modifier === 'Meta'
        ? 'metaKey'
        : 'altKey';
    if (event?.[property] === true) {
      return true;
    }
    try {
      return event?.getModifierState?.(modifier) === true;
    } catch {
      return false;
    }
  };

  const isAltGraphKeyEvent = (event: any): boolean => (
    hasModifier(event, 'Control')
    && hasModifier(event, 'Alt')
    && !hasModifier(event, 'Meta')
  );

  const isModifierOnlyKey = (event: any): boolean => {
    const key = String(event?.key || '').trim().toLowerCase();
    const code = String(event?.code || '').trim().toLowerCase();
    return key === 'control'
      || key === 'ctrl'
      || key === 'meta'
      || key === 'command'
      || key === 'os'
      || key === 'shift'
      || key === 'alt'
      || code.startsWith('control')
      || code.startsWith('meta')
      || code.startsWith('shift')
      || code.startsWith('alt');
  };

  const markShortcutKeyDown = (rawEvent: any) => {
    const event = resolveKeyboardEvent(rawEvent);
    if (!event || String(event.type || '').toLowerCase() === 'keyup') {
      return;
    }
    const hasControlModifier = hasModifier(event, 'Control') || hasModifier(event, 'Meta');
    if (!hasControlModifier || isAltGraphKeyEvent(event) || isModifierOnlyKey(event)) {
      return;
    }
    shortcutInputGuardKey = String(event.key || '').trim().toLowerCase();
    shortcutInputGuardUntil = Date.now() + SHORTCUT_INPUT_GUARD_WINDOW_MS;
    clearPendingInputs();
  };

  const isShortcutInputEvent = (rawEvent: any, text: string): boolean => {
    const event = resolveKeyboardEvent(rawEvent);
    const hasControlModifier = hasModifier(event, 'Control') || hasModifier(event, 'Meta');
    if (hasControlModifier && !isAltGraphKeyEvent(event)) {
      return true;
    }
    if (shortcutInputGuardUntil <= Date.now()) {
      shortcutInputGuardKey = '';
      return false;
    }
    const normalizedText = String(text || '').toLowerCase();
    const matchesShortcutKey = Boolean(
      shortcutInputGuardKey
      && normalizedText.length === 1
      && normalizedText === shortcutInputGuardKey,
    );
    shortcutInputGuardKey = '';
    shortcutInputGuardUntil = 0;
    return matchesShortcutKey;
  };

  const getPendingNativeInputDelta = (pending: NonNullable<typeof pendingInput>) => {
    const afterValue = String(editor.getValue?.() ?? '');
    if (afterValue === pending.valueBefore) {
      return null;
    }

    let startOffset = 0;
    while (
      startOffset < pending.valueBefore.length
      && startOffset < afterValue.length
      && pending.valueBefore[startOffset] === afterValue[startOffset]
    ) {
      startOffset += 1;
    }

    let beforeEndOffset = pending.valueBefore.length;
    let afterEndOffset = afterValue.length;
    while (
      beforeEndOffset > startOffset
      && afterEndOffset > startOffset
      && pending.valueBefore[beforeEndOffset - 1] === afterValue[afterEndOffset - 1]
    ) {
      beforeEndOffset -= 1;
      afterEndOffset -= 1;
    }

    if (startOffset !== pending.offsetBefore || beforeEndOffset !== startOffset) {
      return null;
    }

    return {
      insertedText: afterValue.slice(startOffset, afterEndOffset),
    };
  };

  const isSubsequence = (candidate: string, source: string): boolean => {
    let sourceIndex = 0;
    for (const char of candidate) {
      sourceIndex = source.indexOf(char, sourceIndex);
      if (sourceIndex < 0) {
        return false;
      }
      sourceIndex += char.length;
    }
    return true;
  };

  const hasNativeInputApplied = (pending: NonNullable<typeof pendingInput>): boolean => (
    getPendingNativeInputDelta(pending)?.insertedText === pending.text
  );

  const isPendingInputContextCurrent = (
    pending: NonNullable<typeof pendingInput>,
    value: string,
    position: any,
  ): boolean => {
    if (value === pending.valueBefore) {
      return sameEditorPosition(position, pending.positionBefore);
    }
    const nativeDelta = getPendingNativeInputDelta(pending);
    if (!nativeDelta?.insertedText || !isSubsequence(nativeDelta.insertedText, pending.text)) {
      return false;
    }
    const expectedPosition = editor.getModel?.()?.getPositionAt?.(
      pending.offsetBefore + nativeDelta.insertedText.length,
    );
    return sameEditorPosition(position, expectedPosition);
  };

  const recoverPendingInputAtOriginalPosition = (
    pending: NonNullable<typeof pendingInput>,
    currentPosition: any,
  ): boolean => {
    const nativeDelta = getPendingNativeInputDelta(pending);
    const afterValue = String(editor.getValue?.() ?? '');
    if (
      (afterValue !== pending.valueBefore
        && (!nativeDelta?.insertedText || !isSubsequence(nativeDelta.insertedText, pending.text)))
      || typeof editor.executeEdits !== 'function'
    ) {
      return false;
    }

    const model = editor.getModel?.();
    const nativeText = nativeDelta?.insertedText || '';
    const currentOffset = Number(model?.getOffsetAt?.(currentPosition));
    const endPosition = model?.getPositionAt?.(
      pending.offsetBefore + nativeText.length,
    );
    if (!endPosition || !Number.isFinite(currentOffset)) {
      return false;
    }

    editor.executeEdits('gonavi-printable-input-fallback', [{
      range: {
        startLineNumber: pending.positionBefore.lineNumber,
        startColumn: pending.positionBefore.column,
        endLineNumber: endPosition.lineNumber,
        endColumn: endPosition.column,
      },
      text: pending.text,
      forceMoveMarkers: true,
    }]);
    const insertedLengthDelta = pending.text.length - nativeText.length;
    const nextOffset = currentOffset <= pending.offsetBefore
      ? currentOffset
      : currentOffset >= pending.offsetBefore + nativeText.length
        ? currentOffset + insertedLengthDelta
        : pending.offsetBefore + Math.min(
          currentOffset - pending.offsetBefore,
          pending.text.length,
        );
    const nextPosition = model?.getPositionAt?.(nextOffset);
    if (nextPosition) {
      editor.setPosition?.(nextPosition);
    }
    return true;
  };

  const getSelectionReplacementValue = (
    pending: NonNullable<typeof pendingSelectionInput>,
    text: string,
  ): string => (
    pending.valueBefore.slice(0, pending.startOffset)
    + text
    + pending.valueBefore.slice(pending.endOffset)
  );

  const hasSelectionInputValueApplied = (
    pending: NonNullable<typeof pendingSelectionInput>,
  ): boolean => (
    String(editor.getValue?.() ?? '') === getSelectionReplacementValue(pending, pending.text)
  );

  const hasNativeSelectionInputApplied = (
    pending: NonNullable<typeof pendingSelectionInput>,
  ): boolean => {
    if (!hasSelectionInputValueApplied(pending)) {
      return false;
    }
    const expectedPosition = editor.getModel?.()?.getPositionAt?.(
      pending.startOffset + pending.text.length,
    );
    return isSelectionEmpty(editor.getSelection?.())
      && sameEditorPosition(editor.getPosition?.(), expectedPosition);
  };

  const recoverPendingSelectionInput = (
    pending: NonNullable<typeof pendingSelectionInput>,
  ): boolean => {
    const afterValue = String(editor.getValue?.() ?? '');
    const expectedValue = getSelectionReplacementValue(pending, pending.text);
    const model = editor.getModel?.();
    if (afterValue === expectedValue) {
      const expectedPosition = model?.getPositionAt?.(
        pending.startOffset + pending.text.length,
      );
      if (expectedPosition) {
        editor.setPosition?.(expectedPosition);
      }
      return true;
    }
    const valueAfterDeletion = getSelectionReplacementValue(pending, '');
    if (
      (afterValue !== pending.valueBefore && afterValue !== valueAfterDeletion)
      || typeof editor.executeEdits !== 'function'
    ) {
      return false;
    }

    const range = afterValue === pending.valueBefore
      ? pending.rangeBefore
      : (() => {
          const startPosition = model?.getPositionAt?.(pending.startOffset);
          if (!startPosition) {
            return null;
          }
          return {
            startLineNumber: startPosition.lineNumber,
            startColumn: startPosition.column,
            endLineNumber: startPosition.lineNumber,
            endColumn: startPosition.column,
          };
        })();
    if (!range) {
      return false;
    }

    editor.executeEdits('gonavi-printable-selection-fallback', [{
      range,
      text: pending.text,
      forceMoveMarkers: true,
    }]);
    const nextPosition = model?.getPositionAt?.(pending.startOffset + pending.text.length);
    if (nextPosition) {
      editor.setPosition?.(nextPosition);
    }
    return true;
  };

  const settlePendingSelectionInput = () => {
    const pending = pendingSelectionInput;
    if (!pending) {
      return;
    }
    clearPendingSelectionInput();
    if (!hasNativeSelectionInputApplied(pending)) {
      recoverPendingSelectionInput(pending);
    }
  };

  const isReadOnly = (): boolean => {
    try {
      const optionId = monaco?.editor?.EditorOption?.readOnly;
      return optionId !== undefined ? editor.getOption?.(optionId) === true : false;
    } catch {
      return false;
    }
  };

  const isFindWidgetFocused = (): boolean => {
    const activeElement = editorDomNode?.ownerDocument?.activeElement
      || (typeof document !== 'undefined' ? document.activeElement : null);
    try {
      return Boolean(activeElement?.closest?.(
        '.find-widget, .monaco-inputbox, .find-part, .replace-part',
      ));
    } catch {
      return false;
    }
  };

  const handleBeforeInput = (event: InputEvent) => {
    const text = String(event.data || '');
    if (!sqlInputFocused || isFindWidgetFocused()) {
      clearPendingInputs();
      return;
    }
    if (
      event.isComposing
      || event.inputType !== 'insertText'
      || !text
      || text.length > 8
      || NON_PRINTABLE_INPUT_PATTERN.test(text)
      || isShortcutInputEvent(event, text)
      || isReadOnly()
    ) {
      return;
    }

    let selectionBefore = editor.getSelection?.();
    if (pendingSelectionInput) {
      if (
        isSelectionEmpty(selectionBefore)
        || sameEditorRange(selectionBefore, pendingSelectionInput.rangeBefore)
      ) {
        settlePendingSelectionInput();
        selectionBefore = editor.getSelection?.();
      } else {
        clearPendingSelectionInput();
      }
    }
    if (!isSelectionEmpty(selectionBefore)) {
      if (pendingInput) {
        clearPendingInput();
      }

      const model = editor.getModel?.();
      const startOffset = Number(model?.getOffsetAt?.({
        lineNumber: selectionBefore.startLineNumber,
        column: selectionBefore.startColumn,
      }));
      const endOffset = Number(model?.getOffsetAt?.({
        lineNumber: selectionBefore.endLineNumber,
        column: selectionBefore.endColumn,
      }));
      if (!Number.isFinite(startOffset) || !Number.isFinite(endOffset) || startOffset >= endOffset) {
        return;
      }

      const pending = {
        valueBefore: String(editor.getValue?.() ?? ''),
        rangeBefore: {
          startLineNumber: selectionBefore.startLineNumber,
          startColumn: selectionBefore.startColumn,
          endLineNumber: selectionBefore.endLineNumber,
          endColumn: selectionBefore.endColumn,
        },
        startOffset,
        endOffset,
        text,
        timer: null as number | null,
      };
      pendingSelectionInput = pending;
      pending.timer = window.setTimeout(() => {
        if (pendingSelectionInput !== pending) {
          return;
        }
        pendingSelectionInput = null;
        const domNode = editor.getDomNode?.();
        if (
          !(domNode instanceof HTMLElement)
          || !domNode.isConnected
          || isReadOnly()
          || !sqlInputFocused
          || isFindWidgetFocused()
        ) {
          return;
        }
        if (document.activeElement && !domNode.contains(document.activeElement)) {
          return;
        }
        if (!hasNativeSelectionInputApplied(pending)) {
          recoverPendingSelectionInput(pending);
        }
      }, PRINTABLE_INPUT_FALLBACK_DELAY_MS);
      return;
    }
    let beforeValue = String(editor.getValue?.() ?? '');
    let beforePosition = editor.getPosition?.();
    if (!beforePosition) {
      return;
    }
    let beforeOffset = Number(editor.getModel?.()?.getOffsetAt?.(beforePosition));
    if (!Number.isFinite(beforeOffset)) {
      return;
    }
    if (pendingInput && hasNativeInputApplied(pendingInput)) {
      clearPendingInput();
    }
    if (pendingInput && !isPendingInputContextCurrent(pendingInput, beforeValue, beforePosition)) {
      recoverPendingInputAtOriginalPosition(pendingInput, beforePosition);
      clearPendingInput();
      beforeValue = String(editor.getValue?.() ?? '');
      beforePosition = editor.getPosition?.();
      if (!beforePosition) {
        return;
      }
      beforeOffset = Number(editor.getModel?.()?.getOffsetAt?.(beforePosition));
      if (!Number.isFinite(beforeOffset)) {
        return;
      }
    }
    if (pendingInput) {
      pendingInput.text += text;
      if (pendingInput.timer !== null) {
        clearTimeout(pendingInput.timer);
      }
    } else {
      pendingInput = {
        valueBefore: beforeValue,
        positionBefore: beforePosition,
        offsetBefore: beforeOffset,
        text,
        timer: null,
      };
    }

    const pending = pendingInput;
    pending.timer = window.setTimeout(() => {
      if (pendingInput !== pending) {
        return;
      }
      pendingInput = null;
      const domNode = editor.getDomNode?.();
      if (
        !(domNode instanceof HTMLElement)
        || !domNode.isConnected
        || isReadOnly()
        || !sqlInputFocused
        || isFindWidgetFocused()
      ) {
        return;
      }
      if (document.activeElement && !domNode.contains(document.activeElement)) {
        return;
      }
      const afterValue = String(editor.getValue?.() ?? '');
      const afterPosition = editor.getPosition?.();
      if (hasNativeInputApplied(pending)) {
        return;
      }
      if (afterValue !== pending.valueBefore || !sameEditorPosition(pending.positionBefore, afterPosition)) {
        recoverPendingInputAtOriginalPosition(pending, afterPosition);
        return;
      }
      editor.trigger?.('gonavi-printable-input-fallback', 'type', { text: pending.text });
    }, PRINTABLE_INPUT_FALLBACK_DELAY_MS);
  };

  const handleInputBlur = () => {
    // A shortcut can move focus to Monaco's find/replace widget while a fallback timer is pending.
    // Never replay that stale input into the editor after the focus transition.
    sqlInputFocused = false;
    clearPendingInputs();
  };
  const handleInputFocus = () => {
    sqlInputFocused = true;
  };
  input.addEventListener('keydown', markShortcutKeyDown, true);
  input.addEventListener('beforeinput', handleBeforeInput);
  input.addEventListener('focus', handleInputFocus);
  input.addEventListener('blur', handleInputBlur);
  const keyDownDisposable = editor.onKeyDown?.(markShortcutKeyDown);
  const modelContentDisposable = editor.onDidChangeModelContent?.(() => {
    if (pendingInput && hasNativeInputApplied(pendingInput)) {
      clearPendingInput();
    }
    if (pendingSelectionInput && hasSelectionInputValueApplied(pendingSelectionInput)) {
      clearPendingSelectionInput();
    }
  });
  editor.onDidDispose?.(() => {
    clearPendingInputs();
    keyDownDisposable?.dispose?.();
    modelContentDisposable?.dispose?.();
    input.removeEventListener('keydown', markShortcutKeyDown, true);
    input.removeEventListener('beforeinput', handleBeforeInput);
    input.removeEventListener('focus', handleInputFocus);
    input.removeEventListener('blur', handleInputBlur);
  });
};
