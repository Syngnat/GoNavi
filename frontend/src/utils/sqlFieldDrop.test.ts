import { describe, expect, it } from 'vitest';
import {
  buildSqlFieldDropEdit,
  resolveSqlFieldDropAnchorRange,
  resolveSqlFieldDropCursorOffset,
} from './sqlFieldDrop';

const applyEdit = (sql: string, offset: number, fieldName: string): string => {
  const edit = buildSqlFieldDropEdit({ sql, offset, fieldName });
  if (!edit) return sql;
  return `${sql.slice(0, edit.startOffset)}${edit.text}${sql.slice(edit.endOffset)}`;
};

describe('buildSqlFieldDropEdit', () => {
  it('replaces a select star', () => {
    const sql = 'select * from users';
    expect(applyEdit(sql, sql.indexOf('*'), 'name')).toBe('select name from users');
  });

  it('inserts directly after select', () => {
    const sql = 'select  from users';
    expect(applyEdit(sql, sql.indexOf('from'), 'name')).toBe('select name from users');
  });

  it('adds a comma after an existing select field', () => {
    const sql = 'select id  from users';
    expect(applyEdit(sql, sql.indexOf('from'), 'name')).toBe('select id, name from users');
  });

  it('does not duplicate a comma', () => {
    const sql = 'select id,  from users';
    expect(applyEdit(sql, sql.indexOf('from'), 'name')).toBe('select id, name from users');
  });

  it('adds a comma when dropped immediately after an existing field', () => {
    const sql = 'select id from users';
    expect(applyEdit(sql, sql.indexOf(' from'), 'name')).toBe('select id, name from users');
  });

  it('supports insert column lists and update set lists', () => {
    const insertSql = 'insert into users () values ()';
    expect(applyEdit(insertSql, insertSql.indexOf('(') + 1, 'name')).toBe('insert into users (name) values ()');
    expect(applyEdit('update users set  where id = 1', 17, 'name')).toBe('update users set name where id = 1');
    const updateSql = 'update users set id = 1 where name = ?';
    expect(applyEdit(updateSql, updateSql.indexOf(' where'), 'enabled')).toBe('update users set id = 1, enabled where name = ?');

    const populatedInsertSql = 'insert into users (id, name) values (?, ?)';
    expect(applyEdit(populatedInsertSql, populatedInsertSql.indexOf('id') + 1, 'enabled'))
      .toBe('insert into users (id, enabled, name) values (?, ?)');
    expect(applyEdit(populatedInsertSql, populatedInsertSql.indexOf('name') + 1, 'name'))
      .toBe(populatedInsertSql);
  });

  it('does not treat update FROM and OUTPUT clauses as SET lists', () => {
    const postgresSql = 'UPDATE users SET active = source.active FROM source WHERE users.id = source.user_id';
    expect(applyEdit(postgresSql, postgresSql.indexOf(' WHERE'), 'archived_at'))
      .toBe('UPDATE users SET active = source.active FROM source archived_at WHERE users.id = source.user_id');

    const sqlServerOutputSql = 'UPDATE users SET active = 1 OUTPUT  FROM users WHERE users.id = 1';
    expect(applyEdit(sqlServerOutputSql, sqlServerOutputSql.indexOf(' FROM'), 'updated_at'))
      .toBe('UPDATE users SET active = 1 OUTPUT updated_at FROM users WHERE users.id = 1');

    const sqlServerFromSql = 'UPDATE users SET active = 1 FROM users WHERE users.id = 1';
    expect(applyEdit(sqlServerFromSql, sqlServerFromSql.indexOf(' WHERE'), 'audit'))
      .toBe('UPDATE users SET active = 1 FROM users audit WHERE users.id = 1');
  });

  it('does not add a comma in predicate contexts', () => {
    const sql = 'delete from users where  = 1';
    expect(applyEdit(sql, sql.indexOf('=') - 1, 'id')).toBe('delete from users where id = 1');
  });

  it('snaps a drop inside an identifier to the complete field boundary', () => {
    const sql = 'SELECT announcement_id FROM announcements';
    const rawOffset = sql.indexOf('announcement_id') + 2;
    expect(resolveSqlFieldDropCursorOffset(sql, rawOffset)).toBe(sql.indexOf('announcement_id') + 'announcement_id'.length);
    expect(applyEdit(sql, rawOffset, 'org_id')).toBe('SELECT announcement_id, org_id FROM announcements');
  });

  it('adds the trailing comma when inserting before the first field', () => {
    const sql = 'SELECT announcement_id, created_at FROM announcements';
    expect(applyEdit(sql, sql.indexOf('announcement_id'), 'org_id'))
      .toBe('SELECT org_id, announcement_id, created_at FROM announcements');
  });

  it('rejects duplicate fields including aliases and qualified references', () => {
    const sql = 'SELECT a.announcement_id an, org_id org_i FROM announcements a';
    expect(applyEdit(sql, sql.indexOf('org_id'), 'announcement_id')).toBe(sql);
    expect(applyEdit(sql, sql.indexOf(' FROM'), 'org_id')).toBe(sql);
    expect(applyEdit(sql, sql.indexOf(' FROM'), 'an')).toBe(sql);
  });

  it('treats function calls with commas as one projection item', () => {
    const sql = 'SELECT COALESCE(title, short_title) display_title, created_at FROM announcements';
    expect(applyEdit(sql, sql.indexOf('short_title') + 3, 'org_id'))
      .toBe('SELECT COALESCE(title, short_title) display_title, org_id, created_at FROM announcements');
  });

  it('preserves select modifiers when replacing a star', () => {
    const sql = 'SELECT DISTINCT * FROM announcements';
    expect(applyEdit(sql, sql.indexOf('*'), 'announcement_id'))
      .toBe('SELECT DISTINCT announcement_id FROM announcements');
  });

  it('only treats direct fields and output aliases as duplicates', () => {
    const sql = 'SELECT COUNT(announcement_id) announcement_count FROM announcements';
    expect(applyEdit(sql, sql.indexOf(' FROM'), 'announcement_id'))
      .toBe('SELECT COUNT(announcement_id) announcement_count, announcement_id FROM announcements');
    expect(applyEdit(sql, sql.indexOf(' FROM'), 'announcement_count')).toBe(sql);
  });

  it('keeps dialect-specific select modifiers ahead of inserted fields', () => {
    const topSql = 'SELECT TOP 10 announcement_id FROM announcements';
    expect(applyEdit(topSql, topSql.indexOf('announcement_id'), 'org_id'))
      .toBe('SELECT TOP 10 org_id, announcement_id FROM announcements');

    const distinctOnSql = 'SELECT DISTINCT ON (org_id) announcement_id FROM announcements';
    expect(applyEdit(distinctOnSql, distinctOnSql.indexOf('announcement_id'), 'created_at'))
      .toBe('SELECT DISTINCT ON (org_id) created_at, announcement_id FROM announcements');

    const mysqlSql = 'SELECT SQL_CALC_FOUND_ROWS announcement_id FROM announcements';
    expect(applyEdit(mysqlSql, mysqlSql.indexOf('announcement_id'), 'org_id'))
      .toBe('SELECT SQL_CALC_FOUND_ROWS org_id, announcement_id FROM announcements');
  });

  it('anchors and inserts after the field below the horizontal drag position', () => {
    const sql = 'SELECT org_id, title FROM a_cninfo_announcement';
    const orgOffset = sql.indexOf('org_id') + 2;
    const titleOffset = sql.indexOf('title') + 2;

    expect(resolveSqlFieldDropAnchorRange(sql, resolveSqlFieldDropCursorOffset(sql, orgOffset))).toEqual({
      startOffset: sql.indexOf('org_id'),
      endOffset: sql.indexOf('org_id') + 'org_id'.length,
    });
    expect(applyEdit(sql, resolveSqlFieldDropCursorOffset(sql, orgOffset), 'announcement_id'))
      .toBe('SELECT org_id, announcement_id, title FROM a_cninfo_announcement');

    expect(resolveSqlFieldDropAnchorRange(sql, resolveSqlFieldDropCursorOffset(sql, titleOffset))).toEqual({
      startOffset: sql.indexOf('title'),
      endOffset: sql.indexOf('title') + 'title'.length,
    });
    expect(applyEdit(sql, resolveSqlFieldDropCursorOffset(sql, titleOffset), 'announcement_id'))
      .toBe('SELECT org_id, title, announcement_id FROM a_cninfo_announcement');
  });

  it('uses the nearest field on either side of projection whitespace', () => {
    const sql = 'SELECT org_id,       title FROM a_cninfo_announcement';
    const gapStart = sql.indexOf('org_id') + 'org_id'.length;
    const nearOrg = gapStart + 1;
    const nearTitle = sql.indexOf('title') - 1;

    expect(resolveSqlFieldDropAnchorRange(sql, nearOrg)).toEqual({
      startOffset: sql.indexOf('org_id'),
      endOffset: gapStart,
    });
    expect(resolveSqlFieldDropAnchorRange(sql, nearTitle)).toEqual({
      startOffset: sql.indexOf('title'),
      endOffset: sql.indexOf('title') + 'title'.length,
    });
    expect(applyEdit(sql, nearTitle, 'announcement_id'))
      .toBe('SELECT org_id,       title, announcement_id FROM a_cninfo_announcement');
  });
});
