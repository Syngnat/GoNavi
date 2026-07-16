import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Editor, { loader, type BeforeMount, type EditorProps, type OnMount } from '@monaco-editor/react';
import { useStore } from '../store';
import { sanitizeDataTableFontSize } from '../utils/dataGridDisplay';
import { DEFAULT_MONO_FONT_FAMILY } from '../utils/fontFamilies';

export type { BeforeMount, OnMount } from '@monaco-editor/react';
export type GonaviMonacoTypography = 'code' | 'data';

const DEFAULT_FONT_SIZE = 14;
const MIN_FONT_SIZE = 12;
const MAX_FONT_SIZE = 20;
const QUERY_EDITOR_AI_INLINE_CONTEXT_KEY = 'gonaviAiInlineSuggestionVisible';
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

const patchQueryEditorAiInlineRightArrowFallback = (editor: any, monaco: any) => {
  const rawAddCommand = editor?.addCommand;
  const originalAddCommand = rawAddCommand?.bind?.(editor);
  if (!originalAddCommand || !monaco?.KeyCode?.RightArrow) {
    return;
  }
  if (editor.__gonaviAiInlineRightArrowFallbackPatched) {
    return;
  }
  Object.defineProperty(editor, '__gonaviAiInlineRightArrowFallbackPatched', {
    value: true,
    configurable: true,
  });

  const patchedAddCommand = (keybinding: any, handler: any, context: any) => {
    if (
      keybinding === monaco.KeyCode.RightArrow
      && context === QUERY_EDITOR_AI_INLINE_CONTEXT_KEY
      && typeof handler === 'function'
    ) {
      return originalAddCommand(keybinding, (...args: any[]) => {
        const beforePosition = editor.getPosition?.();
        const beforeValue = String(editor.getValue?.() ?? '');
        const result = handler(...args);
        const afterPosition = editor.getPosition?.();
        const afterValue = String(editor.getValue?.() ?? '');
        if (beforeValue === afterValue && sameEditorPosition(beforePosition, afterPosition)) {
          editor.trigger?.('gonavi-ai-inline-fallback', 'cursorRight', null);
        }
        return result;
      }, context);
    }
    return originalAddCommand(keybinding, handler, context);
  };

  if (rawAddCommand?.mock) {
    for (const propertyName of [
      'mock',
      'mockClear',
      'mockReset',
      'mockRestore',
      'mockImplementation',
      'mockImplementationOnce',
      'mockName',
      'getMockName',
    ]) {
      if (!(propertyName in rawAddCommand)) {
        continue;
      }
      Object.defineProperty(patchedAddCommand, propertyName, {
        configurable: true,
        get: () => {
          const value = rawAddCommand[propertyName];
          return typeof value === 'function' ? value.bind(rawAddCommand) : value;
        },
      });
    }
  }

  editor.addCommand = patchedAddCommand;
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

  const clearPendingInput = () => {
    if (!pendingInput) {
      return;
    }
    if (pendingInput.timer !== null) {
      clearTimeout(pendingInput.timer);
    }
    pendingInput = null;
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

    const selectionBefore = editor.getSelection?.();
    if (!isSelectionEmpty(selectionBefore)) {
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
  });
  editor.onDidDispose?.(() => {
    clearPendingInput();
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
      'editorStickyScroll.background': '#1e1e1e',
      'editorStickyScrollHover.background': '#2a2a2a',
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
      'editorStickyScroll.background': '#ffffff',
      'editorStickyScrollHover.background': '#f5f5f5',
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
      ]))
      .then(([monaco, editorWorker, jsonWorker]) => {
        installMonacoWorkerEnvironment(globalThis as unknown as Record<string, any>, {
          editor: () => new editorWorker.default(),
          json: () => new jsonWorker.default(),
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
  ...props
}) => {
  const [ready, setReady] = useState(isTestRuntime);
  const uiVersion = useStore((state) => state.appearance.uiVersion);
  const dataTableFontSize = useStore((state) => state.appearance.dataTableFontSize);
  const dataTableFontSizeFollowGlobal = useStore((state) => state.appearance.dataTableFontSizeFollowGlobal);
  const monoFontFamily = useStore((state) => state.appearance.customMonoFontFamily);
  const globalFontSize = useStore((state) => state.fontSize);

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

  const handleMount: OnMount = useCallback((editor, monaco) => {
    installOceanBaseOracleNavigationFallback(editor);
    patchQueryEditorAiInlineRightArrowFallback(editor, monaco);
    installPrintableInputFallback(editor, monaco);
    onMount?.(editor, monaco);
  }, [onMount]);

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
    const resolvedFontSize = gonaviTypography === 'data'
      ? effectiveDataTableFontSize
      : Math.max(10, Math.round(effectiveDataTableFontSize * 0.92));
    const effectiveEditorFontSize = Math.max(
      10,
      Math.round(Number(options?.fontSize) || resolvedFontSize),
    );

    return {
      ...options,
      editContext: false,
      fontFamily: options?.fontFamily ?? monoFontFamily ?? DEFAULT_MONO_FONT_FAMILY,
      fontSize: options?.fontSize ?? resolvedFontSize,
      lineHeight: options?.lineHeight ?? Math.max(18, Math.round(effectiveEditorFontSize * 1.62)),
    };
  }, [
    dataTableFontSize,
    dataTableFontSizeFollowGlobal,
    globalFontSize,
    gonaviTypography,
    monoFontFamily,
    options,
    uiVersion,
  ]);

  if (!ready) {
    return (
      <div
        data-monaco-editor-loading="true"
        style={{ height: props.height || '100%', width: props.width || '100%' }}
      >
        {loading || null}
      </div>
    );
  }

  return (
    <Editor
      {...props}
      options={resolvedOptions}
      loading={loading}
      beforeMount={handleBeforeMount}
      onMount={handleMount}
    />
  );
};

export default MonacoEditor;
