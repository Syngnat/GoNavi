import {
  SHORTCUT_INPUT_GUARD_WINDOW_MS,
  NON_PRINTABLE_INPUT_PATTERN,
  PRINTABLE_INPUT_FALLBACK_DELAY_MS,
} from './monacoEditorConstants';
import { sameEditorPosition, isSelectionEmpty, sameEditorRange } from './monacoEditorPositions';
import { isPrintableInputConsumedWithoutTextChange } from './printableInputConsumption';

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
    valueLengthBefore: number;
    positionBefore: any;
    offsetBefore: number;
    text: string;
    timer: number | null;
  } | null = null;
  let pendingSelectionInput: {
    valueLengthBefore: number;
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

  const getModelValueLength = (): number => {
    const model = editor.getModel?.();
    if (typeof model?.getValueLength === 'function') {
      const length = Number(model.getValueLength());
      if (Number.isFinite(length)) {
        return length;
      }
    }
    return String(editor.getValue?.() ?? '').length;
  };

  const getTextInOffsetRange = (startOffset: number, endOffset: number): string => {
    const model = editor.getModel?.();
    const safeStart = Math.max(0, Math.min(startOffset, endOffset));
    const safeEnd = Math.max(safeStart, endOffset);
    if (
      typeof model?.getPositionAt === 'function'
      && typeof model?.getValueInRange === 'function'
    ) {
      const start = model.getPositionAt(safeStart);
      const end = model.getPositionAt(safeEnd);
      if (start && end) {
        return String(model.getValueInRange({
          startLineNumber: start.lineNumber,
          startColumn: start.column,
          endLineNumber: end.lineNumber,
          endColumn: end.column,
        }) ?? '');
      }
    }
    return String(editor.getValue?.() ?? '').slice(safeStart, safeEnd);
  };

  const getPendingNativeInputDelta = (pending: NonNullable<typeof pendingInput>) => {
    const insertedLength = getModelValueLength() - pending.valueLengthBefore;
    if (insertedLength <= 0) {
      return null;
    }
    return {
      insertedText: getTextInOffsetRange(
        pending.offsetBefore,
        pending.offsetBefore + insertedLength,
      ),
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

  // Monaco 会「吃掉」某些按键而不改动文本（例如自动补全括号后再次输入右括号时直接跳过右括号），
  // 这类输入必须视为已生效，一旦回放就会多出一个右括号。
  const isConsumedWithoutTextChange = (
    pending: { valueLengthBefore: number; offsetBefore: number; text: string },
    currentPosition: any,
  ): boolean => {
    const model = editor.getModel?.();
    const currentOffset = Number(model?.getOffsetAt?.(currentPosition));
    return isPrintableInputConsumedWithoutTextChange(
      pending,
      getModelValueLength(),
      Number.isFinite(currentOffset) ? currentOffset : undefined,
      (offset) => getTextInOffsetRange(offset, offset + 1),
    );
  };

  const isPendingInputContextCurrent = (
    pending: NonNullable<typeof pendingInput>,
    position: any,
  ): boolean => {
    if (getModelValueLength() === pending.valueLengthBefore) {
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
    const afterLength = getModelValueLength();
    if (
      (afterLength !== pending.valueLengthBefore
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

  const hasSelectionInputValueApplied = (
    pending: NonNullable<typeof pendingSelectionInput>,
  ): boolean => {
    const expectedLength = pending.valueLengthBefore
      - (pending.endOffset - pending.startOffset)
      + pending.text.length;
    if (getModelValueLength() !== expectedLength) {
      return false;
    }
    return getTextInOffsetRange(
      pending.startOffset,
      pending.startOffset + pending.text.length,
    ) === pending.text;
  };

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
    const afterLength = getModelValueLength();
    const deletedLength = pending.valueLengthBefore - (pending.endOffset - pending.startOffset);
    const expectedLength = deletedLength + pending.text.length;
    const model = editor.getModel?.();
    if (afterLength === expectedLength && hasSelectionInputValueApplied(pending)) {
      const expectedPosition = model?.getPositionAt?.(
        pending.startOffset + pending.text.length,
      );
      if (expectedPosition) {
        editor.setPosition?.(expectedPosition);
      }
      return true;
    }
    if (
      (afterLength !== pending.valueLengthBefore && afterLength !== deletedLength)
      || typeof editor.executeEdits !== 'function'
    ) {
      return false;
    }

    const range = afterLength === pending.valueLengthBefore
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
        valueLengthBefore: getModelValueLength(),
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
    if (pendingInput && !isPendingInputContextCurrent(pendingInput, beforePosition)) {
      if (!isConsumedWithoutTextChange(pendingInput, beforePosition)) {
        recoverPendingInputAtOriginalPosition(pendingInput, beforePosition);
      }
      clearPendingInput();
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
        valueLengthBefore: getModelValueLength(),
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
      const afterLength = getModelValueLength();
      const afterPosition = editor.getPosition?.();
      if (hasNativeInputApplied(pending)) {
        return;
      }
      if (afterLength !== pending.valueLengthBefore || !sameEditorPosition(pending.positionBefore, afterPosition)) {
        if (!isConsumedWithoutTextChange(pending, afterPosition)) {
          recoverPendingInputAtOriginalPosition(pending, afterPosition);
        }
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
