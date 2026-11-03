import { useCallback, useEffect, useMemo, useRef } from 'react';
import Editor, { type BeforeMount, type OnMount } from './MonacoEditor';
import { t as defaultTranslate } from '../i18n';
import { useOptionalI18n } from '../i18n/provider';
interface TableDesignerSqlPreviewProps {
  sql: string;
  darkMode?: boolean;
  height?: string | number;
}

export type SqlChangeHighlightKind =
  | 'add'
  | 'comment'
  | 'constraint'
  | 'create'
  | 'drop'
  | 'modify'
  | 'rename';

export interface SqlChangeHighlight {
  line: string;
  lineNumber: number;
  kind: SqlChangeHighlightKind;
  label: string;
}

type SqlPreviewTranslator = (key: string) => string;
type SqlChangeHighlightLabelKey =
  | 'table_designer.sql_preview.change.add'
  | 'table_designer.sql_preview.change.comment'
  | 'table_designer.sql_preview.change.constraint'
  | 'table_designer.sql_preview.change.create'
  | 'table_designer.sql_preview.change.create_index'
  | 'table_designer.sql_preview.change.drop'
  | 'table_designer.sql_preview.change.modify'
  | 'table_designer.sql_preview.change.rename';

const SQL_PREVIEW_LIGHT_THEME = 'gonavi-sql-preview-light';
const SQL_PREVIEW_DARK_THEME = 'gonavi-sql-preview-dark';
const SQL_PREVIEW_CHANGE_LABEL_FALLBACKS: Record<SqlChangeHighlightLabelKey, string> = {
  'table_designer.sql_preview.change.add': 'Add change',
  'table_designer.sql_preview.change.comment': 'Comment change',
  'table_designer.sql_preview.change.constraint': 'Constraint change',
  'table_designer.sql_preview.change.create': 'New table structure',
  'table_designer.sql_preview.change.create_index': 'Create index',
  'table_designer.sql_preview.change.drop': 'Drop change',
  'table_designer.sql_preview.change.modify': 'Column property change',
  'table_designer.sql_preview.change.rename': 'Rename change',
};

const CHANGE_LINE_RULES: Array<{
  kind: SqlChangeHighlightKind;
  labelKey: SqlChangeHighlightLabelKey;
  pattern: RegExp;
}> = [
  { kind: 'rename', labelKey: 'table_designer.sql_preview.change.rename', pattern: /\b(RENAME\s+COLUMN|CHANGE\s+COLUMN|RENAME\s+TO|SP_RENAME)\b/i },
  { kind: 'add', labelKey: 'table_designer.sql_preview.change.add', pattern: /\b(ADD\s+COLUMN|ADD\s+PRIMARY\s+KEY)\b/i },
  { kind: 'drop', labelKey: 'table_designer.sql_preview.change.drop', pattern: /\b(DROP\s+COLUMN|DROP\s+PRIMARY\s+KEY)\b/i },
  { kind: 'modify', labelKey: 'table_designer.sql_preview.change.modify', pattern: /\b(MODIFY\s+COLUMN|ALTER\s+COLUMN|SET\s+DATA\s+TYPE|SET\s+DEFAULT|DROP\s+DEFAULT|SET\s+NOT\s+NULL|DROP\s+NOT\s+NULL)\b/i },
  { kind: 'constraint', labelKey: 'table_designer.sql_preview.change.constraint', pattern: /\b(ADD\s+CONSTRAINT|DROP\s+CONSTRAINT)\b/i },
  { kind: 'comment', labelKey: 'table_designer.sql_preview.change.comment', pattern: /\b(COMMENT\s+ON\s+COLUMN|COMMENT\s+ON\s+TABLE)\b/i },
  { kind: 'create', labelKey: 'table_designer.sql_preview.change.create_index', pattern: /\bCREATE\s+(UNIQUE\s+)?((CLUSTERED|NONCLUSTERED)\s+)?INDEX\b/i },
];

const CREATE_TABLE_PATTERN = /^\s*CREATE\s+TABLE\b/i;

const resolveSqlPreviewChangeLabel = (
  labelKey: SqlChangeHighlightLabelKey,
  translate: SqlPreviewTranslator = defaultTranslate,
): string => {
  const translated = translate(labelKey);
  return translated === labelKey ? SQL_PREVIEW_CHANGE_LABEL_FALLBACKS[labelKey] : translated;
};

const getCreateTableLineHighlight = (
  line: string,
  lineNumber: number,
  translate?: SqlPreviewTranslator,
): SqlChangeHighlight | null => {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('--')) return null;
  return {
    line,
    lineNumber,
    kind: 'create',
    label: resolveSqlPreviewChangeLabel('table_designer.sql_preview.change.create', translate),
  };
};

const getAlterLineHighlight = (
  line: string,
  lineNumber: number,
  translate?: SqlPreviewTranslator,
): SqlChangeHighlight | null => {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('--')) return null;

  const matchedRule = CHANGE_LINE_RULES.find((rule) => rule.pattern.test(trimmed));
  if (!matchedRule) return null;

  return {
    line,
    lineNumber,
    kind: matchedRule.kind,
    label: resolveSqlPreviewChangeLabel(matchedRule.labelKey, translate),
  };
};

export const resolveSqlChangeHighlights = (
  sql: string,
  translate?: SqlPreviewTranslator,
): SqlChangeHighlight[] => {
  const lines = sql.split(/\r?\n/);
  const isCreateTableSql = lines.some((line) => CREATE_TABLE_PATTERN.test(line));

  return lines
    .map((line, index) => (
      isCreateTableSql
        ? getCreateTableLineHighlight(line, index + 1, translate)
        : getAlterLineHighlight(line, index + 1, translate)
    ))
    .filter((highlight): highlight is SqlChangeHighlight => Boolean(highlight));
};

const registerSqlPreviewThemes: BeforeMount = (monaco) => {
  monaco.editor.defineTheme(SQL_PREVIEW_LIGHT_THEME, {
    base: 'vs',
    inherit: true,
    rules: [
      { token: 'keyword', foreground: '006C9C', fontStyle: 'bold' },
      { token: 'operator', foreground: '8250DF' },
      { token: 'number', foreground: 'B45309' },
      { token: 'string', foreground: '15803D' },
      { token: 'comment', foreground: '64748B', fontStyle: 'italic' },
      { token: 'predefined', foreground: '0F766E' },
    ],
    colors: {
      'editor.background': '#00000000',
      'editor.lineHighlightBackground': '#0F172A0A',
      'editorGutter.background': '#00000000',
      'editorLineNumber.foreground': '#94A3B8',
    },
  });

  monaco.editor.defineTheme(SQL_PREVIEW_DARK_THEME, {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'keyword', foreground: '7DD3FC', fontStyle: 'bold' },
      { token: 'operator', foreground: 'C4B5FD' },
      { token: 'number', foreground: 'FDBA74' },
      { token: 'string', foreground: '86EFAC' },
      { token: 'comment', foreground: '94A3B8', fontStyle: 'italic' },
      { token: 'predefined', foreground: '5EEAD4' },
    ],
    colors: {
      'editor.background': '#00000000',
      'editor.lineHighlightBackground': '#FFFFFF12',
      'editorGutter.background': '#00000000',
      'editorLineNumber.foreground': '#64748B',
    },
  });
};

const getLineDecorationClassName = (kind: SqlChangeHighlightKind): string =>
  `gonavi-sql-preview-change-line gonavi-sql-preview-change-line-${kind}`;

const getLineDecorationMarkerClassName = (kind: SqlChangeHighlightKind): string =>
  `gonavi-sql-preview-change-marker gonavi-sql-preview-change-marker-${kind}`;

const TableDesignerSqlPreview: React.FC<TableDesignerSqlPreviewProps> = ({
  sql,
  darkMode = false,
  height = '360px',
}) => {
  const decorationIdsRef = useRef<string[]>([]);
  const editorRef = useRef<any>(null);
  const monacoRef = useRef<any>(null);
  const i18n = useOptionalI18n();
  const translate = i18n?.t ?? defaultTranslate;
  const changeHighlights = useMemo(() => resolveSqlChangeHighlights(sql, translate), [sql, translate]);

  const applyChangeDecorations = useCallback(() => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    const model = editor?.getModel?.();
    if (!editor || !monaco || !model) return;

    const lineCount = model.getLineCount();
    const decorations = changeHighlights
      .filter((highlight) => highlight.lineNumber <= lineCount)
      .map((highlight) => {
        const endColumn = Math.max(1, model.getLineMaxColumn(highlight.lineNumber));
        return {
          range: new monaco.Range(highlight.lineNumber, 1, highlight.lineNumber, endColumn),
          options: {
            className: getLineDecorationClassName(highlight.kind),
            hoverMessage: { value: highlight.label },
            isWholeLine: true,
            linesDecorationsClassName: getLineDecorationMarkerClassName(highlight.kind),
          },
        };
      });

    decorationIdsRef.current = editor.deltaDecorations(decorationIdsRef.current, decorations);
  }, [changeHighlights]);

  const handleEditorMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;
    applyChangeDecorations();
  };

  useEffect(() => {
    applyChangeDecorations();
  }, [applyChangeDecorations, sql]);

  return (
    <div
      data-table-designer-sql-preview="true"
      style={{
        maxHeight: 400,
        overflow: 'hidden',
        borderRadius: 8,
        border: darkMode ? '1px solid #333' : '1px solid #eee',
      }}
    >
      <style>
        {`
.gonavi-sql-preview-change-line {
  border-left: 3px solid transparent;
}
.gonavi-sql-preview-change-line-add,
.gonavi-sql-preview-change-line-create {
  background: rgba(22, 163, 74, 0.14);
  border-left-color: #16a34a;
}
.gonavi-sql-preview-change-line-drop {
  background: rgba(220, 38, 38, 0.14);
  border-left-color: #dc2626;
}
.gonavi-sql-preview-change-line-modify,
.gonavi-sql-preview-change-line-rename,
.gonavi-sql-preview-change-line-constraint,
.gonavi-sql-preview-change-line-comment {
  background: rgba(217, 119, 6, 0.16);
  border-left-color: #d97706;
}
.gonavi-sql-preview-change-marker {
  width: 4px !important;
  margin-left: 2px;
  border-radius: 999px;
}
.gonavi-sql-preview-change-marker-add,
.gonavi-sql-preview-change-marker-create {
  background: #16a34a;
}
.gonavi-sql-preview-change-marker-drop {
  background: #dc2626;
}
.gonavi-sql-preview-change-marker-modify,
.gonavi-sql-preview-change-marker-rename,
.gonavi-sql-preview-change-marker-constraint,
.gonavi-sql-preview-change-marker-comment {
  background: #d97706;
}
        `}
      </style>
      <Editor
        beforeMount={registerSqlPreviewThemes}
        defaultLanguage="sql"
        gonaviTypography="sql"
        height={height}
        language="sql"
        onMount={handleEditorMount}
        options={{
          automaticLayout: true,
          lineNumbers: 'on',
          lineDecorationsWidth: 14,
          minimap: { enabled: false },
          padding: { top: 8, bottom: 8 },
          readOnly: true,
          scrollBeyondLastLine: false,
          wordWrap: 'on',
        }}
        theme={darkMode ? SQL_PREVIEW_DARK_THEME : SQL_PREVIEW_LIGHT_THEME}
        value={sql}
      />
    </div>
  );
};

export default TableDesignerSqlPreview;
