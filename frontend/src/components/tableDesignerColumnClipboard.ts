export const TABLE_DESIGNER_COLUMN_CLIPBOARD_PREFIX = 'gonavi-table-designer-columns-v1:';

export type TableDesignerClipboardColumn = {
  _key?: string;
  name: string;
  type: string;
  nullable: string;
  key: string;
  default?: string;
  hasDefault?: boolean;
  extra: string;
  comment: string;
  charset?: string;
  collation?: string;
  isAutoIncrement?: boolean;
  isNew?: boolean;
};

const isRecord = (value: unknown): value is Record<string, unknown> => (
  !!value && typeof value === 'object' && !Array.isArray(value)
);

const readRequiredText = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  return value;
};

const normalizeColumn = (value: unknown): TableDesignerClipboardColumn | null => {
  if (!isRecord(value)) return null;
  const name = readRequiredText(value.name);
  const type = readRequiredText(value.type);
  const nullable = readRequiredText(value.nullable);
  const key = readRequiredText(value.key);
  const extra = readRequiredText(value.extra);
  const comment = readRequiredText(value.comment);
  if (name === null || type === null || nullable === null || key === null || extra === null || comment === null) {
    return null;
  }

  const column: TableDesignerClipboardColumn = {
    name,
    type,
    nullable,
    key,
    extra,
    comment,
  };
  if (typeof value.default === 'string') column.default = value.default;
  if (typeof value.hasDefault === 'boolean') column.hasDefault = value.hasDefault;
  if (typeof value.charset === 'string') column.charset = value.charset;
  if (typeof value.collation === 'string') column.collation = value.collation;
  if (typeof value.isAutoIncrement === 'boolean') column.isAutoIncrement = value.isAutoIncrement;
  return column;
};

export const serializeTableDesignerColumns = (columns: TableDesignerClipboardColumn[]): string => (
  `${TABLE_DESIGNER_COLUMN_CLIPBOARD_PREFIX}${JSON.stringify({
    version: 1,
    columns: columns.map(({ _key: _ignored, ...column }) => column),
  })}`
);

export const parseTableDesignerColumns = (text: string): TableDesignerClipboardColumn[] | null => {
  if (!String(text || '').startsWith(TABLE_DESIGNER_COLUMN_CLIPBOARD_PREFIX)) return null;
  try {
    const payload = JSON.parse(String(text).slice(TABLE_DESIGNER_COLUMN_CLIPBOARD_PREFIX.length));
    if (!isRecord(payload) || payload.version !== 1 || !Array.isArray(payload.columns)) return null;
    const columns = payload.columns.map(normalizeColumn);
    return columns.every((column): column is TableDesignerClipboardColumn => column !== null)
      ? columns
      : null;
  } catch {
    return null;
  }
};

const createUniqueColumnName = (sourceName: string, usedNames: Set<string>): string => {
  const baseName = sourceName.trim() || 'new_column';
  let candidate = `${baseName}_copy`;
  let suffix = 2;
  while (usedNames.has(candidate.toLowerCase())) {
    candidate = `${baseName}_copy_${suffix}`;
    suffix += 1;
  }
  usedNames.add(candidate.toLowerCase());
  return candidate;
};

export const cloneTableDesignerColumnsForPaste = (
  columns: TableDesignerClipboardColumn[],
  existingColumns: TableDesignerClipboardColumn[],
): TableDesignerClipboardColumn[] => {
  const usedNames = new Set(existingColumns.map((column) => String(column.name || '').trim().toLowerCase()));
  return columns.map((column) => ({
    ...column,
    name: createUniqueColumnName(column.name, usedNames),
    _key: `new-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    isNew: true,
  }));
};
