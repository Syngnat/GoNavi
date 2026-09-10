/// <reference types="vite/client" />

declare module 'monaco-editor/esm/nls.messages.zh-cn' {
  const messages: Record<string, string>;
  export default messages;
}

// 按需引入的 monaco 模块(纯副作用,无类型定义):见 MonacoEditor.tsx 的加载链
declare module 'monaco-editor/esm/vs/editor/editor.all.js';
declare module 'monaco-editor/esm/vs/basic-languages/sql/sql.contribution.js';
declare module 'monaco-editor/esm/vs/basic-languages/mysql/mysql.contribution.js';
declare module 'monaco-editor/esm/vs/basic-languages/redis/redis.contribution.js';
declare module 'monaco-editor/esm/vs/language/json/monaco.contribution.js';

declare module 'monaco-editor/esm/vs/editor/contrib/clipboard/browser/clipboard.js' {
  export const PasteAction: {
    addImplementation(
      priority: number,
      name: string,
      implementation: () => boolean | Promise<void>,
    ): { dispose(): void };
  } | undefined;
}

declare module 'monaco-editor/esm/vs/editor/browser/controller/editContext/clipboardUtils.js' {
  interface ClipboardMetadata {
    isFromEmptySelection?: boolean;
    multicursorText?: string[] | null;
    mode?: unknown;
  }

  export const InMemoryClipboardMetadataManager: {
    INSTANCE: {
      get(text: string): ClipboardMetadata | null;
    };
  };
}

interface ImportMetaEnv {
  readonly VITE_GONAVI_ENABLE_MAC_WINDOW_DIAGNOSTICS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
