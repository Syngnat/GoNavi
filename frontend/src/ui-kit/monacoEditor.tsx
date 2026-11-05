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
  /** 编辑器字号；插件宿主用它对齐自身排版，未传时沿用默认值。 */
  fontSize?: number;
}

const DEFAULT_EDITOR_FONT_SIZE = 12;

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
  fontSize,
}) => {
  useEffect(() => {
    configureGonaviMonaco();
  }, []);

  // 选项在调用点之外构造：Monaco 界面的排版是仓库级约束（monacoFontPinning），
  // 不允许在 <Editor> 里写死字号。插件宿主可通过 fontSize 对齐自己的字号档位。
  const editorOptions = {
    readOnly,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    fontSize: typeof fontSize === 'number' && Number.isFinite(fontSize)
      ? fontSize
      : DEFAULT_EDITOR_FONT_SIZE,
    automaticLayout: true,
    wordWrap: 'on' as const,
    renderLineHighlight: 'none' as const,
    overviewRulerLanes: 0,
  };

  return (
    <div className="gonavi-monaco-editor" style={{ height }}>
      <Editor
        height={height}
        language={gonaviMonacoLanguage(language)}
        theme={theme === 'dark' ? 'vs-dark' : 'light'}
        value={value ?? ''}
        onChange={(next) => onChange?.(next ?? '')}
        options={editorOptions}
      />
    </div>
  );
};
