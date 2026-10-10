import { describe, expect, it, vi } from 'vitest';

import {
  attachDataGridFindRenderVersion,
  collectDataGridFindMatches,
  collectDataGridFindResult,
  findDataGridTextRanges,
  hasDataGridFindRenderVersionChanged,
  matchesDataGridColumnQuickFind,
  normalizeDataGridFindQuery,
  rankDataGridColumnQuickFindMatchTier,
  resolveDataGridColumnQuickFindMatchTier,
  resolveDataGridColumnQuickFindTarget,
  resolveDataGridFindNavigationIndex,
  summarizeDataGridFindMatches,
} from './dataGridFind';

describe('dataGridFind', () => {
  it('normalizes blank queries to an empty search value without changing non-blank text', () => {
    expect(normalizeDataGridFindQuery('  alpha  ')).toBe('  alpha  ');
    expect(normalizeDataGridFindQuery('   ')).toBe('');
    expect(normalizeDataGridFindQuery(null)).toBe('');
  });

  it('finds case-insensitive non-overlapping text ranges', () => {
    expect(findDataGridTextRanges('Alpha beta ALPHA', 'alpha')).toEqual([
      { start: 0, end: 5 },
      { start: 11, end: 16 },
    ]);
  });

  it('treats special characters as plain text', () => {
    expect(findDataGridTextRanges('a+b a.b a+b', 'a+b')).toEqual([
      { start: 0, end: 3 },
      { start: 8, end: 11 },
    ]);
  });

  it('preserves whitespace in non-blank plain text queries', () => {
    expect(findDataGridTextRanges(' alpha alpha ', ' alpha')).toEqual([
      { start: 0, end: 6 },
      { start: 6, end: 12 },
    ]);
    expect(findDataGridTextRanges('alpha  beta alphabeta', 'alpha ')).toEqual([
      { start: 0, end: 6 },
    ]);
  });

  it('returns no ranges for empty query or empty text', () => {
    expect(findDataGridTextRanges('alpha', '')).toEqual([]);
    expect(findDataGridTextRanges('', 'alpha')).toEqual([]);
  });

  it('summarizes matches across selected columns only', () => {
    const rows = [
      { id: 1, name: 'Alpha', note: 'alpha beta', hidden: 'alpha' },
      { id: 2, name: 'Gamma', note: 'none', hidden: 'alpha' },
    ];

    expect(
      summarizeDataGridFindMatches(rows, ['name', 'note'], 'alpha', (value) => String(value ?? '')),
    ).toEqual({ matchedCellCount: 2, occurrenceCount: 2 });
  });

  it('collects ordered cell matches with row and column coordinates', () => {
    const rows = [
      { __gonavi_row_key__: 'row-1', name: 'Alpha alpha', note: 'beta Alpha' },
      { __gonavi_row_key__: 'row-2', name: 'none', note: 'alpha' },
    ];

    expect(
      collectDataGridFindMatches(
        rows,
        ['name', 'note'],
        'alpha',
        (value) => String(value ?? ''),
        (row) => String(row.__gonavi_row_key__),
      ),
    ).toEqual([
      { rowIndex: 0, rowKey: 'row-1', columnName: 'name', columnIndex: 0, occurrenceIndex: 0, start: 0, end: 5 },
      { rowIndex: 0, rowKey: 'row-1', columnName: 'name', columnIndex: 0, occurrenceIndex: 1, start: 6, end: 11 },
      { rowIndex: 0, rowKey: 'row-1', columnName: 'note', columnIndex: 1, occurrenceIndex: 0, start: 5, end: 10 },
      { rowIndex: 1, rowKey: 'row-2', columnName: 'note', columnIndex: 1, occurrenceIndex: 0, start: 0, end: 5 },
    ]);
  });

  it('collects matches and their summary with one cell scan', () => {
    const rows = [
      { id: 1, name: 'Alpha alpha', note: 'beta' },
      { id: 2, name: 'none', note: 'Alpha' },
    ];
    const getCellText = vi.fn((value: unknown) => String(value ?? ''));

    const result = collectDataGridFindResult(
      rows,
      ['name', 'note'],
      'alpha',
      getCellText,
      (row) => String(row.id),
    );

    expect(getCellText).toHaveBeenCalledTimes(rows.length * 2);
    expect(result.summary).toEqual({ matchedCellCount: 2, occurrenceCount: 3 });
    expect(result.matches).toHaveLength(3);
  });

  it('resolves previous and next navigation indexes with wrapping', () => {
    expect(resolveDataGridFindNavigationIndex(-1, 4, 'next')).toBe(0);
    expect(resolveDataGridFindNavigationIndex(0, 4, 'next')).toBe(1);
    expect(resolveDataGridFindNavigationIndex(3, 4, 'next')).toBe(0);
    expect(resolveDataGridFindNavigationIndex(-1, 4, 'previous')).toBe(3);
    expect(resolveDataGridFindNavigationIndex(0, 4, 'previous')).toBe(3);
    expect(resolveDataGridFindNavigationIndex(2, 4, 'previous')).toBe(1);
    expect(resolveDataGridFindNavigationIndex(0, 0, 'next')).toBe(-1);
  });

  it('prefers an exact quick-find column match over earlier fuzzy matches', () => {
    const columnNames = ['user_id', 'username', 'created_at'];

    expect(resolveDataGridColumnQuickFindTarget(columnNames, 'username')).toBe('username');
    expect(resolveDataGridColumnQuickFindTarget(columnNames, 'user')).toBe('user_id');
    expect(resolveDataGridColumnQuickFindTarget(columnNames, '  ')).toBe('');
    expect(resolveDataGridColumnQuickFindTarget(columnNames, 'missing')).toBe('');
  });

  it('matches quick-find column names without case sensitivity', () => {
    const columnNames = ['USER_NAME_ARCHIVE', 'USER_NAME', 'CREATED_AT'];

    expect(matchesDataGridColumnQuickFind('USER_NAME', 'user')).toBe(true);
    expect(matchesDataGridColumnQuickFind('user_name', 'USER')).toBe(true);
    expect(matchesDataGridColumnQuickFind('USER_NAME', 'missing')).toBe(false);
    expect(resolveDataGridColumnQuickFindTarget(columnNames, 'user_name')).toBe('USER_NAME');
    expect(resolveDataGridColumnQuickFindTarget(columnNames, 'created')).toBe('CREATED_AT');
  });

  it('matches quick-find columns by comment when the name does not hit', () => {
    const comments: Record<string, string> = {
      user_id: '用户唯一标识',
      created_at: '创建时间',
    };
    const getColumnComment = (columnName: string) => comments[columnName] || '';

    expect(matchesDataGridColumnQuickFind('user_id', 'user', getColumnComment)).toBe(true);
    expect(matchesDataGridColumnQuickFind('user_id', '唯一标识', getColumnComment)).toBe(true);
    expect(matchesDataGridColumnQuickFind('user_id', '备注', getColumnComment)).toBe(false);
    expect(matchesDataGridColumnQuickFind('user_id', '唯一标识')).toBe(false);
    expect(matchesDataGridColumnQuickFind('user_id', '唯一标识', () => '  ')).toBe(false);
  });

  it('resolves quick-find targets with comment tiers behind name tiers', () => {
    const columnNames = ['user_id', 'user_name', 'created_at'];
    const comments: Record<string, string> = {
      user_id: '用户名',
      user_name: '用户显示名',
      created_at: '创建时间',
    };
    const getColumnComment = (columnName: string) => comments[columnName] || '';

    expect(resolveDataGridColumnQuickFindTarget(columnNames, '用户名', getColumnComment)).toBe('user_id');
    expect(resolveDataGridColumnQuickFindTarget(columnNames, 'user', getColumnComment)).toBe('user_id');
    expect(resolveDataGridColumnQuickFindTarget(columnNames, '显示名', getColumnComment)).toBe('user_name');
    expect(resolveDataGridColumnQuickFindTarget(columnNames, '用户', getColumnComment)).toBe('user_id');
    expect(resolveDataGridColumnQuickFindTarget(columnNames, 'missing', getColumnComment)).toBe('');
    expect(resolveDataGridColumnQuickFindTarget(columnNames, '用户名')).toBe('');
  });

  it('prefers an exact comment match over a substring name match and keeps name exact first', () => {
    const columnNames = ['user_name', 'nickname'];
    const getColumnComment = (columnName: string) => (columnName === 'nickname' ? 'user_name 的展示别名' : '登录账号');

    expect(resolveDataGridColumnQuickFindTarget(columnNames, 'user_name', getColumnComment)).toBe('user_name');
    expect(resolveDataGridColumnQuickFindTarget(columnNames, 'user_name 的', getColumnComment)).toBe('nickname');
  });

  it('ranks quick-find tiers in priority order for dropdown ordering', () => {
    expect(rankDataGridColumnQuickFindMatchTier('name-exact')).toBeLessThan(rankDataGridColumnQuickFindMatchTier('comment-exact'));
    expect(rankDataGridColumnQuickFindMatchTier('comment-exact')).toBeLessThan(rankDataGridColumnQuickFindMatchTier('name-substring'));
    expect(rankDataGridColumnQuickFindMatchTier('name-substring')).toBeLessThan(rankDataGridColumnQuickFindMatchTier('comment-substring'));
    expect(resolveDataGridColumnQuickFindMatchTier('USER_ID', '用户', (name) => (name === 'USER_ID' ? '用户唯一标识' : ''))).toBe('comment-substring');
    expect(resolveDataGridColumnQuickFindMatchTier('user_id', '  ')).toBeUndefined();
  });

  it('tracks render version changes without exposing metadata as row data', () => {
    const rows = [{ id: 1, name: 'Alpha' }];

    expect(attachDataGridFindRenderVersion(rows, '')).toBe(rows);

    const alphaRows = attachDataGridFindRenderVersion(rows, 'alpha');
    const betaRows = attachDataGridFindRenderVersion(rows, 'beta');

    expect(alphaRows).not.toBe(rows);
    expect(alphaRows[0]).not.toBe(rows[0]);
    expect(Object.keys(alphaRows[0])).toEqual(['id', 'name']);
    expect(hasDataGridFindRenderVersionChanged(alphaRows[0], rows[0])).toBe(true);
    expect(hasDataGridFindRenderVersionChanged(betaRows[0], alphaRows[0])).toBe(true);
    expect(hasDataGridFindRenderVersionChanged(rows[0], alphaRows[0])).toBe(true);
  });

  it('keeps find render metadata on symbol keys while allowing wrapped rows to preserve it', () => {
    const rows = [{ id: 1, name: 'Alpha' }];
    const alphaRows = attachDataGridFindRenderVersion(rows, 'alpha');

    expect(Object.keys(alphaRows[0])).toEqual(['id', 'name']);
    expect(Object.getOwnPropertySymbols(alphaRows[0]).length).toBeGreaterThan(0);
    expect(hasDataGridFindRenderVersionChanged(alphaRows[0], rows[0])).toBe(true);
  });
});
