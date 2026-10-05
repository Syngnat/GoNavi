import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Editor, { type BeforeMount, type EditorProps, type OnMount } from '@monaco-editor/react';
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
import { registerGonaviMonacoThemes } from './monacoThemes';
import {
  type GonaviMonacoTypography,
  MAX_FONT_SIZE,
  MIN_FONT_SIZE,
  DEFAULT_FONT_SIZE,
  GONAVI_MONACO_BG_CSS_VAR,
  GONAVI_MONACO_SURFACE_CLASS,
} from './monacoEditor/monacoEditorConstants';
import { isTestRuntime } from './monacoEditor/monacoWorkerEnvironment';
import { ensureMonacoConfigured } from './monacoEditor/monacoConfiguration';
import {
  installOceanBaseOracleNavigationFallback,
} from './monacoEditor/oceanBaseNavigationFallback';
import { installPrintableInputFallback } from './monacoEditor/printableInputFallback';
import { installWebKitImeScrollStabilizer } from './monacoEditor/webKitImeScrollStabilizer';
export {
  GONAVI_MONACO_SURFACE_CLASS,
  GONAVI_MONACO_BG_CSS_VAR,
} from './monacoEditor/monacoEditorConstants';
export type { GonaviMonacoTypography } from './monacoEditor/monacoEditorConstants';
export { installMonacoWorkerEnvironment } from './monacoEditor/monacoWorkerEnvironment';
export { installWebKitImeScrollStabilizer } from './monacoEditor/webKitImeScrollStabilizer';
export { installPrintableInputFallback } from './monacoEditor/printableInputFallback';
export { ensureMonacoConfigured } from './monacoEditor/monacoConfiguration';

export { registerGonaviMonacoThemes } from './monacoThemes';

export type { BeforeMount, OnMount } from '@monaco-editor/react';

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
  ]);

  const suggestionLayout = gonaviTypography === 'sql'
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
