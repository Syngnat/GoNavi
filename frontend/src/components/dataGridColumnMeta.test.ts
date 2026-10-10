import { describe, expect, it } from 'vitest';

import { buildColumnMetaMap, createColumnCommentLookup, hasUsableColumnMeta, shouldOmitBlankDataGridInsertValue } from './dataGridColumnMeta';

describe('dataGridColumnMeta', () => {
  it('keeps column key metadata when building the header meta map', () => {
    const metaMap = buildColumnMetaMap([
      {
        name: 'id',
        type: 'bigint',
        nullable: 'NO',
        key: 'PRI',
        extra: 'auto_increment',
        comment: '主键',
      },
      {
        name: 'email',
        type: 'varchar(64)',
        nullable: 'NO',
        key: 'UNI',
        extra: '',
        comment: '',
      },
    ]);

    expect(metaMap.id).toMatchObject({ type: 'bigint', key: 'PRI', comment: '主键' });
    expect(metaMap.email).toMatchObject({ type: 'varchar(64)', key: 'UNI' });
    expect(hasUsableColumnMeta(metaMap)).toBe(true);
  });

  it('still omits blank generated columns from inserts', () => {
    expect(shouldOmitBlankDataGridInsertValue('', 'insert', {
      extra: 'auto_increment',
      hasDefault: true,
      default: "nextval('users_id_seq'::regclass)",
    })).toBe(true);
    expect(shouldOmitBlankDataGridInsertValue('', 'update', {
      extra: 'auto_increment',
    })).toBe(false);
  });

  it('resolves column comments from exact and lowercase meta keys', () => {
    const metaMap = buildColumnMetaMap([
      { name: 'USER_ID', type: 'number', nullable: 'YES', key: '', extra: '', comment: '用户唯一标识' },
    ]);
    const lowerMap = buildColumnMetaMap([
      { name: 'user_id', type: 'number', nullable: 'YES', key: '', extra: '', comment: '用户唯一标识' },
      { name: 'created_at', type: 'timestamp', nullable: 'YES', key: '', extra: '', comment: ' 创建时间 ' },
    ]);
    const getColumnComment = createColumnCommentLookup(metaMap, lowerMap);

    expect(getColumnComment('USER_ID')).toBe('用户唯一标识');
    expect(getColumnComment('user_id')).toBe('用户唯一标识');
    expect(getColumnComment('created_at')).toBe('创建时间');
    expect(getColumnComment('missing')).toBe('');
    expect(getColumnComment('  ')).toBe('');
  });

  it('returns empty comments when the grid has no usable column meta', () => {
    const getColumnComment = createColumnCommentLookup(undefined, undefined);

    expect(getColumnComment('user_id')).toBe('');
    expect(createColumnCommentLookup({}, {})('user_id')).toBe('');
  });
});
