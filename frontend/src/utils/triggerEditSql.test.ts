import { describe, expect, it } from 'vitest';

import { buildEditableTriggerSql } from './triggerEditSql';

describe('triggerEditSql', () => {
  it('builds a replace-style trigger edit script with drop and create statements', () => {
    const sql = buildEditableTriggerSql(
      'bit_check',
      'CREATE TRIGGER `bit_check`\nBEFORE INSERT ON `c_check`\nFOR EACH ROW\nBEGIN\n  SET NEW.flag = 1;\nEND',
      { dropSql: 'DROP TRIGGER IF EXISTS `bit_check`' },
    );

    expect(sql).toContain('-- Edit trigger: bit_check');
    expect(sql).toContain('The table design change will drop the original trigger before creating a new one');
    expect(sql).toContain('DROP TRIGGER IF EXISTS `bit_check`;');
    expect(sql).toContain('CREATE TRIGGER `bit_check`');
    expect(sql.trim().endsWith(';')).toBe(true);
  });

  it('localizes editable trigger SQL comments while keeping SQL and names raw', () => {
    const translate = (key: string, params?: Record<string, unknown>): string => {
      const values: Record<string, string> = {
        'trigger_viewer.edit_sql.header': 'Edit trigger: {{name}}',
        'trigger_viewer.edit_sql.replace_hint': 'The original trigger will be dropped before recreating it.',
        'trigger_viewer.edit_sql.compatibility_hint': 'Review compatibility with the current database before running.',
        'trigger_viewer.edit_sql.empty_definition': 'The trigger definition is empty. Complete the CREATE TRIGGER statement before running.',
        'trigger_viewer.edit_sql.fragment_definition': 'Only a trigger definition fragment was returned. Complete the CREATE TRIGGER statement before running.',
      };
      return (values[key] || key).replace(/\{\{(\w+)\}\}/g, (_, name) => String(params?.[name] ?? ''));
    };

    const sql = buildEditableTriggerSql(
      'bit_check',
      'BEGIN\n  SET NEW.flag = 1;\nEND',
      { dropSql: 'DROP TRIGGER IF EXISTS `bit_check`', translate },
    );

    expect(sql).toContain('-- Edit trigger: bit_check');
    expect(sql).toContain('-- The original trigger will be dropped before recreating it.');
    expect(sql).toContain('-- Only a trigger definition fragment was returned. Complete the CREATE TRIGGER statement before running.');
    expect(sql).toContain('DROP TRIGGER IF EXISTS `bit_check`;');
    expect(sql).toContain('bit_check');
    expect(sql).toContain('CREATE TRIGGER');
    expect(sql).not.toContain('修改触发器');
    expect(sql).not.toContain('请补全 CREATE TRIGGER 语句');
  });

  it('uses PostgreSQL-compatible CREATE TRIGGER for fragments', () => {
    const sql = buildEditableTriggerSql(
      'users_bi',
      'BEFORE INSERT ON public.users FOR EACH ROW EXECUTE FUNCTION users_bi_fn()',
      { dbType: 'postgres', dropSql: 'DROP TRIGGER IF EXISTS users_bi ON public.users' },
    );
    expect(sql).toContain('CREATE TRIGGER users_bi');
    expect(sql).not.toContain('CREATE OR REPLACE TRIGGER');
  });

  it('retains Oracle OR REPLACE semantics for trigger fragments', () => {
    const sql = buildEditableTriggerSql(
      'USERS_BI',
      'BEFORE INSERT ON USERS FOR EACH ROW BEGIN NULL; END;',
      { dbType: 'oracle' },
    );
    expect(sql).toContain('CREATE OR REPLACE TRIGGER USERS_BI');
  });

  it('preserves complete CREATE OR ALTER trigger definitions', () => {
    const sql = buildEditableTriggerSql(
      'users_bi',
      'CREATE OR ALTER TRIGGER users_bi ON dbo.users AFTER INSERT AS BEGIN SELECT 1; END',
      { dbType: 'sqlserver' },
    );

    expect(sql).toContain('CREATE OR ALTER TRIGGER users_bi');
    expect(sql).not.toContain('Only a trigger definition fragment was returned');
  });

  it('preserves complete Oracle editionable trigger definitions', () => {
    const sql = buildEditableTriggerSql(
      'USERS_BI',
      'CREATE OR REPLACE EDITIONABLE TRIGGER USERS_BI BEFORE INSERT ON USERS BEGIN NULL; END;',
      { dbType: 'oracle' },
    );

    expect(sql).toContain('CREATE OR REPLACE EDITIONABLE TRIGGER USERS_BI');
    expect(sql).not.toContain('Only a trigger definition fragment was returned');
  });

  it('normalizes a legacy PostgreSQL replace header after leading comments', () => {
    const sql = buildEditableTriggerSql(
      'users_bi',
      '-- captured definition\nCREATE OR REPLACE TRIGGER users_bi BEFORE INSERT ON users EXECUTE FUNCTION users_bi_fn();',
      { dbType: 'postgres' },
    );

    expect(sql).toContain('-- captured definition\nCREATE TRIGGER users_bi');
    expect(sql).not.toContain('CREATE OR REPLACE TRIGGER');
  });

  it('normalizes a legacy PostgreSQL constraint-trigger replace header', () => {
    const sql = buildEditableTriggerSql(
      'users_constraint',
      'CREATE OR REPLACE CONSTRAINT TRIGGER users_constraint AFTER INSERT ON users EXECUTE FUNCTION users_constraint_fn();',
      { dbType: 'postgres' },
    );

    expect(sql).toContain('CREATE CONSTRAINT TRIGGER users_constraint');
    expect(sql).not.toContain('CREATE OR REPLACE CONSTRAINT TRIGGER');
  });
});
