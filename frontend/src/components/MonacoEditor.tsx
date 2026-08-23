import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Editor, { loader, type BeforeMount, type EditorProps, type OnMount } from '@monaco-editor/react';
import { message } from 'antd';
import { t } from '../i18n';
import { useStore } from '../store';
import { sanitizeDataTableFontSize } from '../utils/dataGridDisplay';
import { DEFAULT_MONO_FONT_FAMILY } from '../utils/fontFamilies';
import {
  resolveSqlEditorFontSize,
  resolveSqlEditorSuggestionLayout,
} from '../utils/sqlEditorTypography';
import {
  installWailsMonacoClipboardPasteHandler,
  MONACO_CLIPBOARD_HANDLER_REVISION,
  type MonacoClipboardReadFailure,
} from '../utils/monacoClipboard';

export type { BeforeMount, OnMount } from '@monaco-editor/react';
export type GonaviMonacoTypography = 'code' | 'data' | 'sql';

/** Unified host class for all GoNavi Monaco instances (theme bg via --gn-monaco-bg). */
export const GONAVI_MONACO_SURFACE_CLASS = 'gn-monaco-surface';
/** CSS variable used by .gn-monaco-surface; defaults to --gn-bg-panel in theme sheets. */
export const GONAVI_MONACO_BG_CSS_VAR = '--gn-monaco-bg';

const DEFAULT_FONT_SIZE = 14;
const MIN_FONT_SIZE = 12;
const MAX_FONT_SIZE = 20;
const PRINTABLE_INPUT_FALLBACK_DELAY_MS = 80;
let monacoConfiguredPromise: Promise<void> | null = null;
let transparentThemesRegistered = false;

const isTestRuntime = (): boolean => {
  const env = (import.meta as unknown as { env?: Record<string, unknown> }).env || {};
  return env.MODE === 'test' || env.VITEST === true || env.VITEST === 'true';
};

type MonacoWorkerFactory = () => Worker;

interface MonacoWorkerFactories {
  editor: MonacoWorkerFactory;
  json: MonacoWorkerFactory;
  css: MonacoWorkerFactory;
  html: MonacoWorkerFactory;
  typescript: MonacoWorkerFactory;
}

export const installMonacoWorkerEnvironment = (
  scope: Record<string, any>,
  workers: MonacoWorkerFactories,
) => {
  scope.MonacoEnvironment = {
    ...(scope.MonacoEnvironment || {}),
    getWorker(_moduleId: string, label: string) {
      if (label === 'json') return workers.json();
      if (label === 'css' || label === 'scss' || label === 'less') return workers.css();
      if (label === 'html' || label === 'handlebars' || label === 'razor') return workers.html();
      if (label === 'typescript' || label === 'javascript') return workers.typescript();
      return workers.editor();
    },
  };
};

const sameEditorPosition = (left: any, right: any): boolean => (
  Number(left?.lineNumber) === Number(right?.lineNumber)
  && Number(left?.column) === Number(right?.column)
);

const sameEditorRange = (left: any, right: any): boolean => (
  Number(left?.startLineNumber) === Number(right?.startLineNumber)
  && Number(left?.startColumn) === Number(right?.startColumn)
  && Number(left?.endLineNumber) === Number(right?.endLineNumber)
  && Number(left?.endColumn) === Number(right?.endColumn)
);

const isSelectionEmpty = (selection: any): boolean => (
  !selection
  || (
    Number(selection.startLineNumber) === Number(selection.endLineNumber)
    && Number(selection.startColumn) === Number(selection.endColumn)
  )
);

const stripSqlIdentifierQuotes = (value: string): string => {
  const text = String(value || '').trim();
  if (!text) return '';
  if ((text.startsWith('`') && text.endsWith('`'))
    || (text.startsWith('"') && text.endsWith('"'))
    || (text.startsWith('[') && text.endsWith(']'))) {
    return text.slice(1, -1).trim();
  }
  return text;
};

const splitSqlIdentifierPath = (raw: string): string[] => (
  String(raw || '')
    .split('.')
    .map(stripSqlIdentifierQuotes)
    .map((part) => part.trim())
    .filter(Boolean)
);

const resolveIdentifierWindowAtColumn = (
  lineContent: string,
  column: number,
): { start: number; end: number; text: string } | null => {
  const text = String(lineContent || '');
  if (!text) return null;
  const isIdentChar = (ch: string) => /[A-Za-z0-9_$`"\[\].]/.test(ch || '');
  let offset = Math.max(0, Math.min(text.length - 1, Number(column || 1) - 2));
  if (!isIdentChar(text[offset] || '')) {
    if (offset > 0 && isIdentChar(text[offset - 1] || '')) {
      offset -= 1;
    } else if (offset + 1 < text.length && isIdentChar(text[offset + 1] || '')) {
      offset += 1;
    } else {
      return null;
    }
  }
  let start = offset;
  while (start > 0 && isIdentChar(text[start - 1] || '')) start -= 1;
  let end = offset + 1;
  while (end < text.length && isIdentChar(text[end] || '')) end += 1;
  return start < end ? { start, end, text: text.slice(start, end).trim() } : null;
};

const isLikelyTableReferenceIdentifier = (
  lineContent: string,
  identifierStart: number,
): boolean => {
  const beforeIdentifier = String(lineContent || '').slice(0, Math.max(0, identifierStart));
  return /\b(?:from|join|update|into|delete\s+from|alter\s+table|drop\s+table|truncate\s+table)\s*$/i.test(beforeIdentifier);
};

const isOceanBaseOracleConnection = (connection: any): boolean => {
  const config = connection?.config || {};
  return String(config.type || '').trim().toLowerCase() === 'oceanbase'
    && String(config.oceanBaseProtocol || '').trim().toLowerCase() === 'oracle';
};

const installOceanBaseOracleNavigationFallback = (editor: any) => {
  const editorDomNode = editor?.getDomNode?.();
  if (!editorDomNode || editor.__gonaviObOracleNavigationFallbackInstalled) {
    return;
  }
  Object.defineProperty(editor, '__gonaviObOracleNavigationFallbackInstalled', {
    value: true,
    configurable: true,
  });

  const handleMouseDownCapture = (event: MouseEvent) => {
    if (event.button !== 0 || !(event.ctrlKey || event.metaKey) || event.altKey) {
      return;
    }

    const store = useStore.getState();
    const activeTab = (store.tabs || []).find((tab: any) => tab.id === store.activeTabId);
    if (!activeTab || activeTab.type !== 'query') {
      return;
    }
    const connectionId = String(activeTab.connectionId || store.activeContext?.connectionId || '').trim();
    if (!connectionId) {
      return;
    }
    const connection = (store.connections || []).find((item: any) => item.id === connectionId);
    if (!isOceanBaseOracleConnection(connection)) {
      return;
    }

    const target = editor.getTargetAtClientPoint?.(event.clientX, event.clientY);
    const position = target?.position;
    if (!position) {
      return;
    }
    const model = editor.getModel?.();
    const lineContent = String(model?.getLineContent?.(position.lineNumber) || '');
    const identifier = resolveIdentifierWindowAtColumn(lineContent, position.column);
    if (!identifier || !identifier.text.includes('.')) {
      return;
    }
    if (!isLikelyTableReferenceIdentifier(lineContent, identifier.start)) {
      return;
    }

    const parts = splitSqlIdentifierPath(identifier.text);
    if (parts.length < 2) {
      return;
    }
    const schemaName = parts[parts.length - 2];
    const tableName = parts[parts.length - 1];
    if (!schemaName || !tableName) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
    store.setActiveContext?.({ connectionId, dbName: schemaName });
    store.addTab?.({
      id: `${connectionId}-${schemaName}-table-${tableName}`,
      title: tableName,
      type: 'table',
      connectionId,
      dbName: schemaName,
      tableName,
      initialViewMode: 'fields',
      initialViewModeRequestId: String(Date.now()),
      objectType: 'table',
      returnToTabId: activeTab.id || undefined,
    });
  };

  editorDomNode.addEventListener('mousedown', handleMouseDownCapture, true);
  editor.onDidDispose?.(() => {
    editorDomNode.removeEventListener('mousedown', handleMouseDownCapture, true);
  });
};

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

  const handleBeforeInput = (event: InputEvent) => {
    const text = String(event.data || '');
    if (
      event.isComposing
      || event.inputType !== 'insertText'
      || !text
      || text.length > 8
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
        if (!(domNode instanceof HTMLElement) || !domNode.isConnected || isReadOnly()) {
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
      if (!(domNode instanceof HTMLElement) || !domNode.isConnected || isReadOnly()) {
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

  input.addEventListener('beforeinput', handleBeforeInput);
  const modelContentDisposable = editor.onDidChangeModelContent?.(() => {
    if (pendingInput && hasNativeInputApplied(pendingInput)) {
      clearPendingInput();
    }
    if (pendingSelectionInput && hasSelectionInputValueApplied(pendingSelectionInput)) {
      clearPendingSelectionInput();
    }
  });
  editor.onDidDispose?.(() => {
    clearPendingInput();
    clearPendingSelectionInput();
    modelContentDisposable?.dispose?.();
    input.removeEventListener('beforeinput', handleBeforeInput);
  });
};

export const registerGonaviMonacoThemes: BeforeMount = (monaco) => {
  if (transparentThemesRegistered) {
    return;
  }

  monaco.editor.defineTheme('transparent-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'keyword.sql', foreground: 'C792EA', fontStyle: 'bold' },
      { token: 'keyword.try.sql', foreground: 'C792EA', fontStyle: 'bold' },
      { token: 'keyword.catch.sql', foreground: 'C792EA', fontStyle: 'bold' },
      { token: 'keyword.block.sql', foreground: 'C792EA', fontStyle: 'bold' },
      { token: 'keyword.choice.sql', foreground: 'C792EA', fontStyle: 'bold' },
    ],
    colors: {
      'editor.background': '#00000000',
      'editor.lineHighlightBackground': '#ffffff10',
      'editorGutter.background': '#00000000',
      // Transparent sticky scroll so panel/theme bg shows through (CSS may also paint --gn-bg-panel).
      'editorStickyScroll.background': '#00000000',
      'editorStickyScrollHover.background': '#ffffff12',
    },
  });
  monaco.editor.defineTheme('transparent-light', {
    base: 'vs',
    inherit: true,
    rules: [
      { token: 'keyword.sql', foreground: '6D28D9', fontStyle: 'bold' },
      { token: 'keyword.try.sql', foreground: '6D28D9', fontStyle: 'bold' },
      { token: 'keyword.catch.sql', foreground: '6D28D9', fontStyle: 'bold' },
      { token: 'keyword.block.sql', foreground: '6D28D9', fontStyle: 'bold' },
      { token: 'keyword.choice.sql', foreground: '6D28D9', fontStyle: 'bold' },
    ],
    colors: {
      'editor.background': '#00000000',
      'editor.lineHighlightBackground': '#00000010',
      'editorGutter.background': '#00000000',
      'editorStickyScroll.background': '#00000000',
      'editorStickyScrollHover.background': '#00000010',
    },
  });

  transparentThemesRegistered = true;
};

const ensureMonacoConfigured = (): Promise<void> => {
  if (isTestRuntime()) {
    return Promise.resolve();
  }

  if (!monacoConfiguredPromise) {
    monacoConfiguredPromise = import('monaco-editor/esm/nls.messages.zh-cn')
      .then(() => Promise.all([
        import('monaco-editor'),
        import('monaco-editor/esm/vs/editor/editor.worker?worker'),
        import('monaco-editor/esm/vs/language/json/json.worker?worker'),
        import('monaco-editor/esm/vs/language/css/css.worker?worker'),
        import('monaco-editor/esm/vs/language/html/html.worker?worker'),
        import('monaco-editor/esm/vs/language/typescript/ts.worker?worker'),
      ]))
      .then(([monaco, editorWorker, jsonWorker, cssWorker, htmlWorker, typescriptWorker]) => {
        installMonacoWorkerEnvironment(globalThis as unknown as Record<string, any>, {
          editor: () => new editorWorker.default(),
          json: () => new jsonWorker.default(),
          css: () => new cssWorker.default(),
          html: () => new htmlWorker.default(),
          typescript: () => new typescriptWorker.default(),
        });
        loader.config({ monaco });
      });
  }

  return monacoConfiguredPromise;
};

interface MonacoEditorProps extends EditorProps {
  gonaviTypography?: GonaviMonacoTypography;
}

const MonacoEditor: React.FC<MonacoEditorProps> = ({
  beforeMount,
  gonaviTypography = 'code',
  loading,
  onMount,
  options,
  theme,
  ...props
}) => {
  const [ready, setReady] = useState(isTestRuntime);
  const appTheme = useStore((state) => state.theme);
  const uiVersion = useStore((state) => state.appearance.uiVersion);
  const dataTableFontSize = useStore((state) => state.appearance.dataTableFontSize);
  const dataTableFontSizeFollowGlobal = useStore((state) => state.appearance.dataTableFontSizeFollowGlobal);
  const sqlEditorFontSize = useStore((state) => state.appearance.sqlEditorFontSize);
  const sqlEditorFontSizeFollowGlobal = useStore((state) => state.appearance.sqlEditorFontSizeFollowGlobal);
  const monoFontFamily = useStore((state) => state.appearance.customMonoFontFamily);
  const globalFontSize = useStore((state) => state.fontSize);
  const clipboardPasteCleanupRef = useRef<(() => void) | null>(null);
  const clipboardEditorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const clipboardMonacoRef = useRef<Parameters<OnMount>[1] | null>(null);
  // Monaco theme is process-global; never fall back to "light" or other editors get polluted.
  const resolvedTheme = theme
    ?? (appTheme === 'dark' ? 'transparent-dark' : 'transparent-light');

  useEffect(() => {
    let cancelled = false;

    void ensureMonacoConfigured()
      .then(() => {
        if (!cancelled) {
          setReady(true);
        }
      })
      .catch((error) => {
        console.error('Failed to configure Monaco Editor', error);
        if (!cancelled) {
          setReady(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const handleBeforeMount: BeforeMount = useCallback((monaco) => {
    registerGonaviMonacoThemes(monaco);
    beforeMount?.(monaco);
  }, [beforeMount]);

  const handleClipboardReadFailure = useCallback(({ source, error }: MonacoClipboardReadFailure) => {
    console.warn('Failed to read clipboard text for Monaco paste', error);
    void message.warning({
      key: 'gonavi-query-editor-clipboard-read-failed',
      content: t(source === 'browser'
        ? 'query_editor.message.clipboard_permission_required'
        : 'query_editor.message.clipboard_read_failed'),
      duration: 5,
    });
  }, []);

  const replaceClipboardPasteHandler = useCallback((editor: Parameters<OnMount>[0], monaco: Parameters<OnMount>[1]) => {
    clipboardPasteCleanupRef.current?.();
    clipboardPasteCleanupRef.current = gonaviTypography === 'sql'
      ? installWailsMonacoClipboardPasteHandler(
        monaco,
        editor,
        undefined,
        undefined,
        handleClipboardReadFailure,
      )
      : null;
  }, [gonaviTypography, handleClipboardReadFailure]);

  useEffect(() => {
    const editor = clipboardEditorRef.current;
    const monaco = clipboardMonacoRef.current;
    if (editor && monaco) {
      replaceClipboardPasteHandler(editor, monaco);
    }

    return () => {
      clipboardPasteCleanupRef.current?.();
      clipboardPasteCleanupRef.current = null;
    };
  }, [MONACO_CLIPBOARD_HANDLER_REVISION, replaceClipboardPasteHandler]);

  const handleMount: OnMount = useCallback((editor, monaco) => {
    clipboardEditorRef.current = editor;
    clipboardMonacoRef.current = monaco;
    replaceClipboardPasteHandler(editor, monaco);
    installOceanBaseOracleNavigationFallback(editor);
    installPrintableInputFallback(editor, monaco);
    installWebKitImeScrollStabilizer(editor);
    onMount?.(editor, monaco);
  }, [onMount, replaceClipboardPasteHandler]);

  const resolvedOptions = useMemo(() => {
    if (uiVersion !== 'v2') {
      return {
        ...options,
        editContext: false,
      };
    }

    const effectiveGlobalFontSize = Math.min(
      MAX_FONT_SIZE,
      Math.max(MIN_FONT_SIZE, Math.round(Number(globalFontSize) || DEFAULT_FONT_SIZE)),
    );
    const effectiveDataTableFontSize = dataTableFontSizeFollowGlobal !== false
      ? effectiveGlobalFontSize
      : (sanitizeDataTableFontSize(dataTableFontSize) ?? effectiveGlobalFontSize);
    const effectiveSqlEditorFontSize = resolveSqlEditorFontSize({
      globalFontSize: effectiveGlobalFontSize,
      sqlEditorFontSize,
      sqlEditorFontSizeFollowGlobal,
    });
    const resolvedFontSize = gonaviTypography === 'data'
      ? effectiveDataTableFontSize
      : gonaviTypography === 'sql'
        ? effectiveSqlEditorFontSize
        : Math.max(10, Math.round(effectiveDataTableFontSize * 0.92));
    const effectiveEditorFontSize = Math.max(
      10,
      Math.round(Number(options?.fontSize) || resolvedFontSize),
    );
    const suggestionLayout = gonaviTypography === 'sql'
      ? resolveSqlEditorSuggestionLayout(effectiveEditorFontSize)
      : null;

    return {
      ...options,
      editContext: false,
      fontFamily: options?.fontFamily ?? monoFontFamily ?? DEFAULT_MONO_FONT_FAMILY,
      fontSize: options?.fontSize ?? resolvedFontSize,
      lineHeight: options?.lineHeight ?? Math.max(18, Math.round(effectiveEditorFontSize * 1.62)),
      ...(suggestionLayout ? { suggestLineHeight: suggestionLayout.rowHeight } : {}),
    };
  }, [
    dataTableFontSize,
    dataTableFontSizeFollowGlobal,
    globalFontSize,
    gonaviTypography,
    monoFontFamily,
    options,
    sqlEditorFontSize,
    sqlEditorFontSizeFollowGlobal,
    uiVersion,
  ]);

  const suggestionLayout = uiVersion === 'v2' && gonaviTypography === 'sql'
    ? resolveSqlEditorSuggestionLayout(resolvedOptions.fontSize)
    : null;

  // Unified surface: all call sites inherit panel via --gn-monaco-bg (no per-page bg).
  const surfaceStyle = {
    height: props.height || '100%',
    width: props.width || '100%',
    minHeight: 0,
    minWidth: 0,
    background: `var(${GONAVI_MONACO_BG_CSS_VAR}, var(--gn-bg-panel, transparent))`,
    ...(suggestionLayout
      ? {
        '--gn-query-suggest-name-row-height': `${suggestionLayout.nameLineHeight}px`,
        '--gn-query-suggest-comment-row-height': `${suggestionLayout.commentLineHeight}px`,
        '--gn-query-suggest-row-height': `${suggestionLayout.rowHeight}px`,
      }
      : {}),
  } as React.CSSProperties;

  const loadingFallback = (
    <div
      className={GONAVI_MONACO_SURFACE_CLASS}
      data-monaco-editor-loading="true"
      aria-busy="true"
      style={surfaceStyle}
    >
      {loading || null}
    </div>
  );

  if (!ready) {
    return loadingFallback;
  }

  return (
    <div className={GONAVI_MONACO_SURFACE_CLASS} style={surfaceStyle}>
      <Editor
        {...props}
        height="100%"
        width="100%"
        theme={resolvedTheme}
        options={resolvedOptions}
        loading={loadingFallback}
        beforeMount={handleBeforeMount}
        onMount={handleMount}
      />
    </div>
  );
};

export default MonacoEditor;
