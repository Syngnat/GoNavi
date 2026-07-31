import { describe, expect, it } from 'vitest';

import {
  cloneTableDesignerColumnsForPaste,
  parseTableDesignerColumns,
  serializeTableDesignerColumns,
  TABLE_DESIGNER_COLUMN_CLIPBOARD_PREFIX,
  type TableDesignerClipboardColumn,
} from './tableDesignerColumnClipboard';

const column = (overrides: Partial<TableDesignerClipboardColumn> = {}): TableDesignerClipboardColumn => ({
  _key: 'column-1',
  name: 'created_at',
  type: 'datetime',
  nullable: 'NO',
  key: '',
  extra: 'DEFAULT_GENERATED',
  comment: '创建时间',
  default: 'CURRENT_TIMESTAMP',
  hasDefault: true,
  charset: 'utf8mb4',
  collation: 'utf8mb4_bin',
  isAutoIncrement: false,
  ...overrides,
});

describe('tableDesignerColumnClipboard', () => {
  it('serializes and parses column definitions without UI keys', () => {
    const text = serializeTableDesignerColumns([column()]);
    expect(text.startsWith(TABLE_DESIGNER_COLUMN_CLIPBOARD_PREFIX)).toBe(true);
    expect(text).not.toContain('column-1');
    expect(parseTableDesignerColumns(text)).toEqual([expect.objectContaining({
      name: 'created_at',
      type: 'datetime',
      default: 'CURRENT_TIMESTAMP',
      charset: 'utf8mb4',
    })]);
  });

  it('rejects ordinary, malformed, and incomplete clipboard text', () => {
    expect(parseTableDesignerColumns('created_at')).toBeNull();
    expect(parseTableDesignerColumns(`${TABLE_DESIGNER_COLUMN_CLIPBOARD_PREFIX}{`)).toBeNull();
    expect(parseTableDesignerColumns(`${TABLE_DESIGNER_COLUMN_CLIPBOARD_PREFIX}${JSON.stringify({ version: 1, columns: [{ name: 'id' }] })}`)).toBeNull();
  });

  it('clones columns at the end with preserved definitions and unique names', () => {
    const pasted = cloneTableDesignerColumnsForPaste(
      [column({ name: 'id' }), column({ name: 'ID' })],
      [column({ name: 'id' }), column({ name: 'id_copy' })],
    );

    expect(pasted).toHaveLength(2);
    expect(pasted.map(item => item.name)).toEqual(['id_copy_2', 'ID_copy_3']);
    expect(pasted.every(item => item.isNew && item._key && item._key !== 'column-1')).toBe(true);
    expect(pasted[0]).toEqual(expect.objectContaining({
      type: 'datetime',
      nullable: 'NO',
      default: 'CURRENT_TIMESTAMP',
      hasDefault: true,
      extra: 'DEFAULT_GENERATED',
      comment: '创建时间',
    }));
  });
});
