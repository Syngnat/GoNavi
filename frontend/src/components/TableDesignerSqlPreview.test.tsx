import { readFileSync } from 'node:fs';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import TableDesignerSqlPreview, { resolveSqlChangeHighlights } from './TableDesignerSqlPreview';

const sharedI18nDir = new URL('../../../shared/i18n/', import.meta.url);
const sharedI18nLocaleFiles = [
  'de-DE.json',
  'en-US.json',
  'ja-JP.json',
  'ru-RU.json',
  'zh-CN.json',
  'zh-TW.json',
] as const;

const mockMonaco = {
  Range: class {
    startLineNumber: number;
    startColumn: number;
    endLineNumber: number;
    endColumn: number;

    constructor(
      startLineNumber: number,
      startColumn: number,
      endLineNumber: number,
      endColumn: number,
    ) {
      this.startLineNumber = startLineNumber;
      this.startColumn = startColumn;
      this.endLineNumber = endLineNumber;
      this.endColumn = endColumn;
    }
  },
  editor: {
    defineTheme: vi.fn(),
  },
};

const mockEditor = {
  deltaDecorations: vi.fn(() => ['decoration-1']),
  getModel: vi.fn(() => ({
    getLineCount: () => 5,
    getLineMaxColumn: (lineNumber: number) => (lineNumber === 1 ? 22 : 80),
  })),
};

vi.mock('@monaco-editor/react', () => ({
  default: ({
    beforeMount,
    defaultLanguage,
    language,
    onMount,
    options,
    theme,
    value,
  }: {
    beforeMount?: (monaco: any) => void;
    defaultLanguage?: string;
    language?: string;
    onMount?: (editor: any, monaco: any) => void;
    options?: Record<string, any>;
    theme?: string;
    value?: string;
  }) => {
    beforeMount?.(mockMonaco);
    onMount?.(mockEditor, mockMonaco);
    return (
      <div
        data-default-language={defaultLanguage}
        data-language={language}
        data-monaco-editor-mock="true"
        data-options={JSON.stringify(options)}
        data-theme={theme}
      >
        {value}
      </div>
    );
  },
}));

describe('TableDesignerSqlPreview', () => {
  beforeEach(() => {
    mockEditor.deltaDecorations.mockClear();
    mockMonaco.editor.defineTheme.mockClear();
  });

  it('does not ship corrupted table designer i18n catalog strings', () => {
    const badLocalizedValuePattern = /\?{2,}|\uFFFD|f\?r|verf\?gbar|Schl\?ssel|Zuf\?llige|Schreibgesch\?tzt|OLAP \?|\{\{count\}\} \?/;
    const badValues: string[] = [];

    for (const localeFile of sharedI18nLocaleFiles) {
      const catalog = JSON.parse(readFileSync(new URL(localeFile, sharedI18nDir), 'utf8')) as Record<string, unknown>;

      for (const [key, value] of Object.entries(catalog)) {
        if (
          key.startsWith('table_designer.')
          && typeof value === 'string'
          && badLocalizedValuePattern.test(value)
        ) {
          badValues.push(`${localeFile} ${key}=${value}`);
        }
      }
    }

    expect(badValues).toEqual([]);
  });

  it('renders SQL changes in a read-only Monaco SQL editor with explicit syntax highlight theme', () => {
    const markup = renderToStaticMarkup(
      <TableDesignerSqlPreview
        sql={'ALTER TABLE "users"\nRENAME COLUMN "name" TO "display_name";'}
        darkMode={false}
      />,
    );

    expect(markup).toContain('data-table-designer-sql-preview="true"');
    expect(markup).toContain('data-monaco-editor-mock="true"');
    expect(markup).toContain('data-default-language="sql"');
    expect(markup).toContain('data-language="sql"');
    expect(markup).toContain('data-theme="gonavi-sql-preview-light"');
    expect(markup).toContain('&quot;readOnly&quot;:true');
    expect(markup).toContain('&quot;lineNumbers&quot;:&quot;on&quot;');
    expect(markup).not.toContain('&quot;glyphMargin&quot;:true');
    expect(markup).toContain('ALTER TABLE');
    expect(markup).toContain('RENAME COLUMN');

    expect(mockMonaco.editor.defineTheme).toHaveBeenCalledWith(
      'gonavi-sql-preview-light',
      expect.objectContaining({
        base: 'vs',
        inherit: true,
        rules: expect.arrayContaining([
          expect.objectContaining({ token: 'keyword', foreground: expect.any(String) }),
          expect.objectContaining({ token: 'string', foreground: expect.any(String) }),
          expect.objectContaining({ token: 'comment', foreground: expect.any(String) }),
        ]),
      }),
    );
  });

  it('detects only SQL change operation lines instead of highlighting the whole SQL block', () => {
    const translate = (key: string) => `translated:${key}`;
    const highlights = resolveSqlChangeHighlights([
      'ALTER TABLE "users"',
      'ADD COLUMN "age" int NULL;',
      'ALTER TABLE "users"',
      'RENAME COLUMN "name" TO "display_name";',
      '-- DuckDB 不支持通过 COMMENT ON COLUMN 持久化字段备注',
    ].join('\n'), translate);

    expect(highlights).toEqual([
      expect.objectContaining({
        kind: 'add',
        lineNumber: 2,
        label: 'translated:table_designer.sql_preview.change.add',
      }),
      expect.objectContaining({
        kind: 'rename',
        lineNumber: 4,
        label: 'translated:table_designer.sql_preview.change.rename',
      }),
    ]);
  });

  it('detects CREATE INDEX preview lines as create changes', () => {
    const translate = (key: string) => `translated:${key}`;
    const highlights = resolveSqlChangeHighlights(
      'CREATE UNIQUE NONCLUSTERED INDEX [IX_Users_Email] ON [dbo].[Users] ([email]);',
      translate,
    );

    expect(highlights).toEqual([
      expect.objectContaining({
        kind: 'create',
        lineNumber: 1,
        label: 'translated:table_designer.sql_preview.change.create_index',
      }),
    ]);
  });

  it('adds Monaco decorations to changed SQL lines only', () => {
    renderToStaticMarkup(
      <TableDesignerSqlPreview
        sql={[
          'ALTER TABLE "users"',
          'ADD COLUMN "age" int NULL;',
          'ALTER TABLE "users"',
          'DROP COLUMN "legacy_name";',
        ].join('\n')}
      />,
    );

    expect(mockEditor.deltaDecorations).toHaveBeenCalledWith(
      [],
      expect.arrayContaining([
        expect.objectContaining({
          range: expect.objectContaining({ startLineNumber: 2, endLineNumber: 2 }),
          options: expect.objectContaining({
            className: expect.stringContaining('gonavi-sql-preview-change-line-add'),
            isWholeLine: true,
            linesDecorationsClassName: expect.stringContaining('gonavi-sql-preview-change-marker-add'),
          }),
        }),
        expect.objectContaining({
          range: expect.objectContaining({ startLineNumber: 4, endLineNumber: 4 }),
          options: expect.objectContaining({
            className: expect.stringContaining('gonavi-sql-preview-change-line-drop'),
            isWholeLine: true,
            linesDecorationsClassName: expect.stringContaining('gonavi-sql-preview-change-marker-drop'),
          }),
        }),
      ]),
    );
    const firstDecorationCall = mockEditor.deltaDecorations.mock.calls[0] as unknown as [unknown, unknown[]];
    expect(firstDecorationCall[1]).toHaveLength(2);
    expect(firstDecorationCall[1]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          options: expect.not.objectContaining({
            glyphMarginClassName: expect.any(String),
          }),
        }),
      ]),
    );
  });

  it('uses the dark SQL preview theme when dark mode is enabled', () => {
    const markup = renderToStaticMarkup(
      <TableDesignerSqlPreview sql="CREATE TABLE users (id int);" darkMode />,
    );

    expect(markup).toContain('data-theme="gonavi-sql-preview-dark"');
    expect(mockMonaco.editor.defineTheme).toHaveBeenCalledWith(
      'gonavi-sql-preview-dark',
      expect.objectContaining({
        base: 'vs-dark',
        inherit: true,
      }),
    );
  });
});
