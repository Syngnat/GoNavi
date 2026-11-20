import React, { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircleOutlined, CodeOutlined, RobotOutlined } from '@ant-design/icons';
import MonacoEditor, { type OnMount } from '../MonacoEditor';
import type { ScriptWorkbenchTranslate } from './useScriptWorkbenchCopy';
import {
  formatScriptBytes,
  scriptLineCount,
  scriptSourceBytes,
} from './scriptWorkbenchUtils';

interface ScriptWorkbenchEditorProps {
  name: string;
  source: string;
  dirty: boolean;
  t: ScriptWorkbenchTranslate;
  onChange: (source: string) => void;
  onRequestAI: () => void;
}

export const ScriptWorkbenchEditor: React.FC<ScriptWorkbenchEditorProps> = ({
  name,
  source,
  dirty,
  t,
  onChange,
  onRequestAI,
}) => {
  const [cursor, setCursor] = useState({ line: 1, column: 1 });
  const cursorCleanupRef = useRef<(() => void) | null>(null);
  const options = React.useMemo(() => ({
    ariaLabel: t('script_workbench.editor.aria_label'),
    automaticLayout: true,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    lineNumbersMinChars: 3,
    glyphMargin: false,
    folding: true,
    wordWrap: 'off' as const,
    tabSize: 2,
    padding: { top: 10, bottom: 12 },
    suggest: { showWords: false },
  }), [t]);

  const handleMount = useCallback<OnMount>((editor) => {
    cursorCleanupRef.current?.();
    const subscription = editor.onDidChangeCursorPosition((event) => {
      setCursor({
        line: event.position.lineNumber,
        column: event.position.column,
      });
    });
    cursorCleanupRef.current = () => subscription.dispose();
  }, []);

  useEffect(() => () => {
    cursorCleanupRef.current?.();
    cursorCleanupRef.current = null;
  }, []);

  return (
    <section className="gn-script-editor-card" aria-label={t('script_workbench.editor.aria_label')}>
      <header className="gn-script-editor-header">
        <span className="gn-script-editor-file">
          <CodeOutlined aria-hidden="true" />
          <span>{`${name || t('script_workbench.default_name')}.js`}</span>
          {dirty ? <span className="gn-script-dirty-dot" aria-label={t('script_workbench.meta.unsaved')} /> : null}
        </span>
        <div className="gn-script-editor-header-actions">
          <span>{t('script_workbench.language.javascript')}</span>
          <button type="button" className="gn-script-icon-button" onClick={onRequestAI} aria-label={t('script_workbench.action.ai')}>
            <RobotOutlined aria-hidden="true" />
          </button>
        </div>
      </header>
      <div className="gn-script-editor-surface" data-testid="script-workbench-editor">
        <MonacoEditor
          language="javascript"
          value={source}
          onChange={(value) => onChange(value || '')}
          onMount={handleMount}
          options={options}
          gonaviTypography="code"
        />
      </div>
      <footer className="gn-script-editor-footer">
        <span className="gn-script-editor-ready">
          <CheckCircleOutlined aria-hidden="true" />
          {t('script_workbench.editor.status.ready')}
        </span>
        <span>{t('script_workbench.editor.position', { line: cursor.line, column: cursor.column })}</span>
        <span>{t('script_workbench.editor.size', {
          lines: scriptLineCount(source),
          size: formatScriptBytes(scriptSourceBytes(source)),
        })}</span>
        <span>UTF-8</span>
      </footer>
    </section>
  );
};
