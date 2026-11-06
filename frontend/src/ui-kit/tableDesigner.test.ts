import { describe, expect, it } from 'vitest';
import { buildGonaviCreateTableDdl, gonaviNewColumn, gonaviQuoteIdentifier } from './tableDesigner';

describe('table designer helpers', () => {
  it('quotes identifiers per dialect', () => {
    expect(gonaviQuoteIdentifier('users', 'mysql')).toBe('`users`');
    expect(gonaviQuoteIdentifier('users', 'postgres')).toBe('"users"');
    expect(gonaviQuoteIdentifier('a]b', 'sqlserver')).toBe('[a]]b]');
  });

  it('builds a CREATE TABLE statement with defaults and a primary key', () => {
    const ddl = buildGonaviCreateTableDdl({
      name: 'users',
      columns: [
        { id: '1', name: 'id', type: 'BIGINT', nullable: false, primaryKey: true },
        { id: '2', name: 'name', type: 'VARCHAR', length: '255', nullable: false, primaryKey: false, defaultValue: 'anonymous' },
        { id: '3', name: 'created_at', type: 'TIMESTAMP', nullable: true, primaryKey: false, defaultValue: 'CURRENT_TIMESTAMP' },
      ],
    }, 'mysql');
    expect(ddl).toContain('CREATE TABLE `users`');
    expect(ddl).toContain('`id` BIGINT NOT NULL');
    expect(ddl).toContain("`name` VARCHAR(255) NOT NULL DEFAULT 'anonymous'");
    expect(ddl).toContain('`created_at` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP');
    expect(ddl).toContain('PRIMARY KEY (`id`)');
  });

  it('escapes string defaults and skips unnamed columns', () => {
    const ddl = buildGonaviCreateTableDdl({
      name: 'notes',
      columns: [
        { id: '1', name: '', type: 'TEXT', nullable: true, primaryKey: false },
        { id: '2', name: 'body', type: 'TEXT', nullable: true, primaryKey: false, defaultValue: "it's" },
      ],
    }, 'postgres');
    expect(ddl).toContain('"body" TEXT NULL DEFAULT \'it\'\'s\'');
    expect(ddl).not.toContain('""');
  });

  it('adds MySQL comments and ignores them elsewhere', () => {
    const design = {
      name: 't',
      columns: [{ id: '1', name: 'a', type: 'INT', nullable: true, primaryKey: false, comment: "note's" }],
    };
    expect(buildGonaviCreateTableDdl(design, 'mysql')).toContain("COMMENT 'note''s'");
    expect(buildGonaviCreateTableDdl(design, 'postgres')).not.toContain('COMMENT');
  });

  it('returns an empty statement without a table name or columns', () => {
    expect(buildGonaviCreateTableDdl({ name: ' ', columns: [] })).toBe('');
    expect(buildGonaviCreateTableDdl({ name: 't', columns: [] })).toBe('');
    expect(gonaviNewColumn('x')).toMatchObject({ id: 'x', nullable: true, primaryKey: false });
  });
});
