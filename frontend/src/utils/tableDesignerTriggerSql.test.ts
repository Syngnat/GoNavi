import { describe, expect, it } from 'vitest';

import {
  buildTableDesignerTriggerDropSql,
  buildTableDesignerTriggerRestoreSql,
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
    expect(buildTableDesignerTriggerRestoreSql({
      name: 'users_bi',
      timing: 'BEFORE',
      event: 'INSERT',
      statement: 'EXECUTE FUNCTION users_bi_fn()',
    }, 'public.users', 'postgres')).toContain('CREATE OR REPLACE TRIGGER users_bi');
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
      statement: 'CREATE DEFINER=`root`@`localhost` TRIGGER `users_bi` BEFORE INSERT ON `users` FOR EACH ROW SET NEW.id = 1',
    }, 'users', 'mysql')).toContain('CREATE DEFINER=`root`@`localhost` TRIGGER');
  });

  it('builds dialect-aware drop SQL for replacement flows', () => {
    expect(buildTableDesignerTriggerDropSql('users_bi', 'public.users', 'postgres'))
      .toBe('DROP TRIGGER IF EXISTS users_bi ON public.users');
    expect(buildTableDesignerTriggerDropSql('users_bi', 'users', 'mysql'))
      .toBe('DROP TRIGGER IF EXISTS `users_bi`');
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
});
