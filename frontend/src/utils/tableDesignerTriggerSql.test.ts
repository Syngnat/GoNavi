import { describe, expect, it } from 'vitest';

import {
  buildTableDesignerTriggerDropSql,
  buildTableDesignerTriggerRestoreSql,
  normalizeTableDesignerTriggerRestoreSql,
  shouldDropTableDesignerTriggerBeforeReplace,
} from './tableDesignerTriggerSql';

describe('tableDesignerTriggerSql', () => {
  it('rebuilds a MySQL trigger body for rollback', () => {
    expect(buildTableDesignerTriggerRestoreSql({
      name: 'users_bi',
      timing: 'BEFORE',
      event: 'INSERT',
      statement: 'BEGIN\n  SET NEW.created_at = NOW();\nEND',
    }, 'users', 'mysql')).toBe([
      'CREATE TRIGGER `users_bi`',
      'BEFORE INSERT ON `users`',
      'FOR EACH ROW',
      'BEGIN',
      '  SET NEW.created_at = NOW();',
      'END',
    ].join('\n'));
  });

  it('rebuilds a PostgreSQL trigger action statement for rollback', () => {
    const restoreSql = buildTableDesignerTriggerRestoreSql({
      name: 'users_bi',
      timing: 'BEFORE',
      event: 'INSERT',
      orientation: 'ROW',
      statement: 'EXECUTE FUNCTION users_bi_fn()',
    }, 'public.users', 'postgres');
    expect(restoreSql).toContain('CREATE TRIGGER users_bi');
    expect(restoreSql).not.toContain('CREATE OR REPLACE TRIGGER');
  });

  it('normalizes legacy invalid PostgreSQL replace headers in persisted definitions', () => {
    const restoreSql = buildTableDesignerTriggerRestoreSql({
      name: 'users_bi',
      statement: 'CREATE OR REPLACE TRIGGER users_bi BEFORE INSERT ON users EXECUTE FUNCTION users_bi_fn();',
    }, 'users', 'postgres');

    expect(restoreSql).toContain('CREATE TRIGGER users_bi');
    expect(restoreSql).not.toContain('CREATE OR REPLACE TRIGGER');

    const constraintRestoreSql = buildTableDesignerTriggerRestoreSql({
      name: 'users_constraint',
      statement: 'CREATE OR REPLACE CONSTRAINT TRIGGER users_constraint AFTER INSERT ON users EXECUTE FUNCTION users_constraint_fn();',
    }, 'users', 'postgres');
    expect(constraintRestoreSql).toContain('CREATE CONSTRAINT TRIGGER users_constraint');
    expect(constraintRestoreSql).not.toContain('CREATE OR REPLACE CONSTRAINT TRIGGER');
  });

  it('normalizes legacy PostgreSQL headers after leading comments without dropping the comments', () => {
    const restoreSql = buildTableDesignerTriggerRestoreSql({
      name: 'users_bi',
      statement: '-- captured definition\nCREATE OR REPLACE TRIGGER users_bi BEFORE INSERT ON users EXECUTE FUNCTION users_bi_fn();',
    }, 'users', 'postgres');

    expect(restoreSql).toContain('-- captured definition\nCREATE TRIGGER users_bi');
    expect(restoreSql).not.toContain('CREATE OR REPLACE TRIGGER');
  });

  it('normalizes legacy persisted PostgreSQL rollback SQL directly', () => {
    expect(normalizeTableDesignerTriggerRestoreSql(
      '-- persisted definition\nCREATE OR REPLACE TRIGGER users_bi BEFORE INSERT ON users EXECUTE FUNCTION audit_users();',
      'postgres',
    )).toBe('-- persisted definition\nCREATE TRIGGER users_bi BEFORE INSERT ON users EXECUTE FUNCTION audit_users();');
    expect(normalizeTableDesignerTriggerRestoreSql(
      'CREATE TRIGGER users_bi BEFORE INSERT ON users EXECUTE FUNCTION audit_users();',
      'mysql',
    )).toBe('CREATE TRIGGER users_bi BEFORE INSERT ON users EXECUTE FUNCTION audit_users();');
  });

  it('preserves a PostgreSQL statement-level trigger when orientation is available', () => {
    const restoreSql = buildTableDesignerTriggerRestoreSql({
      name: 'users_stmt',
      timing: 'AFTER',
      event: 'INSERT',
      orientation: 'STATEMENT',
      statement: 'EXECUTE FUNCTION audit_users_stmt()',
    }, 'public.users', 'postgres');

    expect(restoreSql).toContain('CREATE TRIGGER users_stmt');
    expect(restoreSql).not.toContain('FOR EACH ROW');
  });

  it('refuses to synthesize PostgreSQL rollback SQL when orientation metadata is unavailable', () => {
    const restoreSql = buildTableDesignerTriggerRestoreSql({
      name: 'users_unknown_level',
      timing: 'AFTER',
      event: 'INSERT',
      statement: 'EXECUTE FUNCTION audit_users_unknown_level()',
    }, 'public.users', 'postgres');

    expect(restoreSql).toBe('');
  });

  it('preserves a complete definition and refuses hidden fragments', () => {
    expect(buildTableDesignerTriggerRestoreSql({
      name: 'users_bi',
      statement: 'CREATE TRIGGER users_bi AFTER INSERT ON users BEGIN SELECT 1; END',
    }, 'users', 'sqlite')).toContain('CREATE TRIGGER users_bi');
    expect(buildTableDesignerTriggerRestoreSql({
      name: 'users_bi',
      timing: 'BEFORE',
      event: 'INSERT',
      statement: 'SOURCE HIDDEN',
    }, 'users', 'dameng')).toBe('');
    expect(buildTableDesignerTriggerRestoreSql({
      name: 'users_bi',
      timing: 'BEFORE',
      event: 'INSERT',
      statement: 'SOURCE HIDDEN',
    }, 'users', 'kingbase')).toBe('');
    expect(buildTableDesignerTriggerRestoreSql({
      name: 'users_bi',
      timing: 'BEFORE',
      event: 'INSERT',
      statement: '-- metadata unavailable\nSOURCE HIDDEN',
    }, 'users', 'kingbase')).toBe('');
    expect(buildTableDesignerTriggerRestoreSql({
      name: 'users_bi',
      timing: 'BEFORE',
      event: 'INSERT',
      statement: 'SOURCE HIDDEN;',
    }, 'users', 'kingbase')).toBe('');
    expect(buildTableDesignerTriggerRestoreSql({
      name: 'users_bi',
      statement: 'CREATE DEFINER=`root`@`localhost` TRIGGER `users_bi` BEFORE INSERT ON `users` FOR EACH ROW SET NEW.id = 1',
    }, 'users', 'mysql')).toContain('CREATE DEFINER=`root`@`localhost` TRIGGER');
  });

  it('builds dialect-aware drop SQL for replacement flows', () => {
    expect(buildTableDesignerTriggerDropSql('users_bi', 'public.users', 'postgres'))
      .toBe('DROP TRIGGER IF EXISTS users_bi ON public.users');
    expect(buildTableDesignerTriggerDropSql('users_bi', 'users', 'mysql'))
      .toBe('DROP TRIGGER IF EXISTS `users_bi`');
    expect(buildTableDesignerTriggerDropSql('audit.users_bi', 'audit.users', 'sqlserver'))
      .toBe('DROP TRIGGER IF EXISTS [audit].[users_bi]');
    expect(buildTableDesignerTriggerDropSql('users_bi', '', 'postgres')).toBe('');
  });

  it('keeps dots inside quoted owner and table identifiers', () => {
    const qualifiedTable = '"PEM2.4_V1_1"."COM_APPROVE_INFO"';
    expect(buildTableDesignerTriggerDropSql('TRG_APPROVE', qualifiedTable, 'postgres'))
      .toBe('DROP TRIGGER IF EXISTS "TRG_APPROVE" ON "PEM2.4_V1_1"."COM_APPROVE_INFO"');
    expect(buildTableDesignerTriggerRestoreSql({
      name: 'TRG_APPROVE',
      timing: 'BEFORE',
      event: 'INSERT',
      orientation: 'ROW',
      statement: 'BEGIN NULL; END;',
    }, qualifiedTable, 'postgres')).toContain(`ON ${qualifiedTable}`);
  });

  it('keeps the SQL Server trigger schema in reconstructed rollback SQL', () => {
    expect(buildTableDesignerTriggerRestoreSql({
      name: 'audit.users_bi',
      timing: 'AFTER',
      event: 'INSERT',
      statement: 'BEGIN SELECT 1; END',
    }, 'audit.users', 'sqlserver')).toContain('CREATE TRIGGER [audit].[users_bi]');
  });

  it('derives the SQL Server trigger schema from a qualified table when metadata returns a bare trigger name', () => {
    expect(buildTableDesignerTriggerDropSql('users_bi', 'audit.users', 'sqlserver'))
      .toBe('DROP TRIGGER IF EXISTS [audit].[users_bi]');
    expect(buildTableDesignerTriggerRestoreSql({
      name: 'users_bi',
      timing: 'AFTER',
      event: 'INSERT',
      statement: 'BEGIN SELECT 1; END',
    }, 'audit.users', 'sqlserver')).toContain('CREATE TRIGGER [audit].[users_bi]');
  });

  it('keeps a dotted trigger metadata name as one SQL Server identifier', () => {
    expect(buildTableDesignerTriggerDropSql(
      'a.b',
      '[audit].[order.items]',
      'sqlserver',
    )).toBe('DROP TRIGGER IF EXISTS [audit].[a.b]');
    expect(buildTableDesignerTriggerRestoreSql({
      name: 'a.b',
      timing: 'AFTER',
      event: 'INSERT',
      statement: 'BEGIN SELECT 1; END',
    }, '[audit].[order.items]', 'sqlserver')).toContain('CREATE TRIGGER [audit].[a.b]');
    expect(buildTableDesignerTriggerDropSql('a.b', 'users', 'mysql'))
      .toBe('DROP TRIGGER IF EXISTS `a.b`');
    expect(buildTableDesignerTriggerDropSql('a.b', 'public.users', 'postgres'))
      .toBe('DROP TRIGGER IF EXISTS "a.b" ON public.users');
  });

  it('uses only PostgreSQL orientation metadata for the firing-level clause', () => {
    expect(buildTableDesignerTriggerRestoreSql({
      name: 'users_bi',
      timing: 'BEFORE EACH ROW',
      event: 'INSERT',
      statement: 'EXECUTE FUNCTION users_bi_fn()',
    }, 'public.users', 'postgres')).toBe('');
  });

  it('does not add DROP before Oracle and Dameng replaceable trigger definitions', () => {
    const replaceSql = 'CREATE OR REPLACE TRIGGER "AUDIT"."USERS_BI" BEFORE INSERT ON "AUDIT"."USERS" BEGIN NULL; END;';
    expect(shouldDropTableDesignerTriggerBeforeReplace(replaceSql, 'oracle')).toBe(false);
    expect(shouldDropTableDesignerTriggerBeforeReplace(replaceSql, 'dameng')).toBe(false);
    expect(shouldDropTableDesignerTriggerBeforeReplace(
      'CREATE TRIGGER users_bi BEFORE INSERT ON users FOR EACH ROW SET NEW.id = 1',
      'mysql',
    )).toBe(true);
  });

  it('keeps Oracle editionable trigger definitions on the replace-without-drop path', () => {
    const replaceSql = 'CREATE OR REPLACE EDITIONABLE TRIGGER "AUDIT"."USERS_BI" BEFORE INSERT ON "AUDIT"."USERS" BEGIN NULL; END;';
    expect(buildTableDesignerTriggerRestoreSql({
      name: 'USERS_BI',
      statement: replaceSql,
    }, 'AUDIT.USERS', 'oracle')).toBe(replaceSql);
    expect(shouldDropTableDesignerTriggerBeforeReplace(replaceSql, 'oracle')).toBe(false);
  });
});
