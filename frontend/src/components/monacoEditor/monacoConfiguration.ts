import { loader } from '@monaco-editor/react';
import { GONAVI_MONACO_LANGUAGE_LOADERS } from '../monacoLanguageLoaders';
import { isTestRuntime, installMonacoWorkerEnvironment } from './monacoWorkerEnvironment';

let monacoConfiguredPromise: Promise<void> | null = null;

export const ensureMonacoConfigured = (): Promise<void> => {
  if (isTestRuntime()) {
    return Promise.resolve();
  }

  if (!monacoConfiguredPromise) {
    monacoConfiguredPromise = import('monaco-editor/esm/nls.messages.zh-cn')
      .then(() => Promise.all([
        import('monaco-editor/esm/vs/editor/editor.api.js'),
        import('monaco-editor/esm/vs/editor/editor.worker?worker'),
        import('monaco-editor/esm/vs/language/json/json.worker?worker'),
        // 编辑器组件按需引入(纯副作用);语言高亮清单见 monacoLanguageLoaders.ts。
        import('monaco-editor/esm/vs/editor/editor.all.js'),
        ...GONAVI_MONACO_LANGUAGE_LOADERS.map((load) => load()),
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
