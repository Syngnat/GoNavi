import { describe, expect, it } from 'vitest';

import {
  buildViewEditExecutionSql,
  buildViewEditPrefix,
  splitViewDefinitionForEditing,
} from './viewEditSql';

describe('view edit SQL', () => {
  it('splits a full MySQL view definition into a display body and executable prefix', () => {
    const parts = splitViewDefinitionForEditing(
      'CREATE ALGORITHM=UNDEFINED DEFINER=`root`@`%` SQL SECURITY DEFINER VIEW `app`.`v_users` AS select id, name from users',
      'app.v_users',
      'mysql',
    );

    expect(parts.body).toBe('select id, name from users;');
    expect(parts.prefix).toContain('CREATE ALGORITHM=UNDEFINED');
    expect(parts.prefix).toContain('VIEW `app`.`v_users` AS');
  });

  it('keeps WITH CHECK OPTION out of the displayed body and restores it when saving', () => {
    const parts = splitViewDefinitionForEditing(
      'CREATE OR REPLACE VIEW reporting.active_users AS SELECT id FROM users WITH LOCAL CHECK OPTION;',
      'reporting.active_users',
      'oracle',
    );

    expect(parts.body).toBe('SELECT id FROM users;');
    expect(parts.suffix).toBe('WITH LOCAL CHECK OPTION');
    expect(buildViewEditExecutionSql(parts.body, {
      viewName: 'reporting.active_users',
      dialect: 'oracle',
      prefix: parts.prefix,
      suffix: parts.suffix,
    })).toBe('CREATE OR REPLACE VIEW reporting.active_users AS\nSELECT id FROM users\nWITH LOCAL CHECK OPTION;');
  });

  it('keeps Oracle WITH READ ONLY in the executable suffix', () => {
    const parts = splitViewDefinitionForEditing(
      'CREATE OR REPLACE FORCE VIEW APP.V_RISK AS SELECT id FROM risks WITH READ ONLY',
      'APP.V_RISK',
      'oracle',
    );

    expect(parts.body).toBe('SELECT id FROM risks;');
    expect(parts.suffix).toBe('WITH READ ONLY');
  });

  it('generates a replaceable prefix for SELECT-only definitions', () => {
    expect(splitViewDefinitionForEditing('select id from users', 'app.v_users', 'postgres')).toEqual({
      body: 'select id from users;',
      prefix: 'CREATE OR REPLACE VIEW app.v_users AS',
      suffix: '',
    });
  });

  it('uses CREATE VIEW for SQL Server and SQLite fallbacks', () => {
    expect(buildViewEditPrefix('dbo.v_users', 'sqlserver')).toBe('CREATE VIEW dbo.v_users AS');
    expect(buildViewEditPrefix('main.v_users', 'sqlite')).toBe('CREATE VIEW main.v_users AS');
  });

  it('leaves a full CREATE VIEW statement unchanged for legacy edit tabs', () => {
    const fullDdl = 'CREATE OR REPLACE VIEW app.v_users AS\nSELECT id FROM users;';
    expect(buildViewEditExecutionSql(fullDdl, {
      viewName: 'app.v_users',
      prefix: 'CREATE OR REPLACE VIEW app.v_users AS',
    })).toBe(fullDdl);
  });

  it('wraps a body-only editor value with the stored prefix', () => {
    expect(buildViewEditExecutionSql('SELECT id FROM users', {
      viewName: 'app.v_users',
      dialect: 'mysql',
      prefix: 'CREATE OR REPLACE VIEW `app`.`v_users` AS',
    })).toBe('CREATE OR REPLACE VIEW `app`.`v_users` AS\nSELECT id FROM users;');
  });
});
