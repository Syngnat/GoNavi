import React, { useEffect } from 'react';
import Editor, { loader } from '@monaco-editor/react';
import { gonaviMonacoLanguage, type GonaviMonacoLanguage } from './monacoLanguage';
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js';
import 'monaco-editor/esm/vs/basic-languages/sql/sql.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution.js';
import 'monaco-editor/esm/vs/language/json/monaco.contribution.js';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';

export { gonaviMonacoLanguage } from './monacoLanguage';
export type { GonaviMonacoLanguage } from './monacoLanguage';

let configured = false;

/**
 * Points `@monaco-editor/react` at the bundled Monaco and installs workers.
 * Idempotent: multiple editors share one configuration.
 */
function configureGonaviMonaco(): void {
  if (configured) return;
  configured = true;
  (globalThis as unknown as { MonacoEnvironment?: unknown }).MonacoEnvironment = {
    getWorker(_moduleId: string, label: string) {
      return label === 'json' ? new JsonWorker() : new EditorWorker();
    },
  };
  loader.config({ monaco: monaco as unknown as typeof import('monaco-editor') });
}

export interface GonaviMonacoEditorProps {
  value?: string;
  onChange?: (value: string) => void;
  language?: GonaviMonacoLanguage;
  height?: number;
  readOnly?: boolean;
  theme?: 'light' | 'dark';
  placeholder?: string;
}

/**
 * Full Monaco editor for plugin windows. Unlike `GonaviCodeEditor` (a plain
 * textarea), this bundles the real editor, its workers and syntax highlighting;
 * prefer it for SQL/JSON where highlighting and large documents matter.
 */
export const GonaviMonacoEditor: React.FC<GonaviMonacoEditorProps> = ({
  value,
  onChange,
  language = 'sql',
  height = 240,
  readOnly = false,
  theme = 'light',
}) => {
  useEffect(() => {
    configureGonaviMonaco();
  }, []);

  return (
    <div className="gonavi-monaco-editor" style={{ height }}>
      <Editor
        height={height}
        language={gonaviMonacoLanguage(language)}
        theme={theme === 'dark' ? 'vs-dark' : 'light'}
        value={value ?? ''}
        onChange={(next) => onChange?.(next ?? '')}
        options={{
          readOnly,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          fontSize: 12,
          automaticLayout: true,
          wordWrap: 'on',
          renderLineHighlight: 'none',
          overviewRulerLanes: 0,
        }}
      />
    </div>
  );
};
