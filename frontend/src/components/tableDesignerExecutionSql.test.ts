import { describe, expect, it, vi } from 'vitest';

import {
  containsTableDesignerTriggerCreateStatement,
  executeTableDesignerSchemaStatements,
  isSchemaExecutionOutcomeUnknown,
  normalizeSchemaStatementForExecution,
  parseTableCommentFromDDL,
  splitSchemaExecutionStatements,
} from './tableDesignerExecutionSql';

describe('tableDesignerExecutionSql', () => {
  it('strips trailing semicolons before executing oracle schema statements', () => {
    expect(
      normalizeSchemaStatementForExecution(`COMMENT ON COLUMN "H2"."D_YS_MEMCARD_CX"."ID" IS 'ID';`, 'oracle'),
    ).toBe(`COMMENT ON COLUMN "H2"."D_YS_MEMCARD_CX"."ID" IS 'ID'`);
  });

  it('keeps trailing semicolons for non-oracle schema statements', () => {
    expect(normalizeSchemaStatementForExecution('ALTER TABLE `users` ADD COLUMN `age` int', 'mysql'))
      .toBe('ALTER TABLE `users` ADD COLUMN `age` int;');
  });

  it('splits generated schema SQL into individual statements', () => {
    expect(splitSchemaExecutionStatements('ALTER TABLE users ADD age int;\nCOMMENT ON COLUMN users.age IS \'年龄\';'))
      .toEqual(['ALTER TABLE users ADD age int', "COMMENT ON COLUMN users.age IS '年龄';"]);
  });

  it('executes TDengine supertable and child-table previews as complete statements', () => {
    const sql = 'CREATE STABLE `meters` (`ts` TIMESTAMP, `value` FLOAT) TAGS (`location` BINARY(64));\nCREATE TABLE `meter_001` USING `meters` TAGS (\'Shanghai\', 1);';
    expect(splitSchemaExecutionStatements(sql)).toEqual([
      'CREATE STABLE `meters` (`ts` TIMESTAMP, `value` FLOAT) TAGS (`location` BINARY(64))',
      "CREATE TABLE `meter_001` USING `meters` TAGS ('Shanghai', 1);",
    ]);
    expect(normalizeSchemaStatementForExecution('CREATE STABLE `meters` (`ts` TIMESTAMP) TAGS (`location` BINARY(64))', 'tdengine'))
      .toBe('CREATE STABLE `meters` (`ts` TIMESTAMP) TAGS (`location` BINARY(64));');
  });

  it('does not execute standalone preview warning comments as SQL', () => {
    expect(splitSchemaExecutionStatements('CREATE TABLE `meters` (`value` FLOAT);\n-- TDengine timestamp hint'))
      .toEqual(['CREATE TABLE `meters` (`value` FLOAT)']);
  });

  it('parses mysql and oracle table comments from DDL', () => {
    expect(parseTableCommentFromDDL("CREATE TABLE `users` (`id` int) COMMENT='用户\\'表';"))
      .toBe("用户'表");
    expect(parseTableCommentFromDDL(`CREATE TABLE "HR"."EMPLOYEES" ("ID" NUMBER);
COMMENT ON TABLE "HR"."EMPLOYEES" IS '员工''表';
COMMENT ON COLUMN "HR"."EMPLOYEES"."ID" IS '主键';`)).toBe("员工'表");
  });

  it('keeps semicolons inside DDL literals and comments in one statement', () => {
    const sql = [
      "CREATE TABLE users (name VARCHAR(20) COMMENT 'line one;",
      "line two');",
    ].join('\n');
    expect(splitSchemaExecutionStatements(sql, 'mysql')).toEqual([sql]);

    const commentedSql = 'CREATE TABLE users (id BIGINT) /* ;\n still part of this DDL */;';
    expect(splitSchemaExecutionStatements(commentedSql, 'mysql')).toEqual([commentedSql]);
  });

  it('requires a real CREATE TRIGGER statement before a trigger replacement can drop the original', () => {
    expect(containsTableDesignerTriggerCreateStatement('SELECT 1;', 'mysql')).toBe(false);
    expect(containsTableDesignerTriggerCreateStatement('-- no trigger\n/* still no trigger */', 'mysql')).toBe(false);
    expect(containsTableDesignerTriggerCreateStatement(
      'CREATE TRIGGER users_bi BEFORE INSERT ON users FOR EACH ROW SET NEW.id = 1;',
      'mysql',
    )).toBe(true);
    expect(containsTableDesignerTriggerCreateStatement([
      'CREATE OR REPLACE FUNCTION users_bi_fn() RETURNS trigger AS $$ BEGIN RETURN NEW; END; $$ LANGUAGE plpgsql;',
      'CREATE CONSTRAINT TRIGGER users_bi AFTER INSERT ON users DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION users_bi_fn();',
    ].join('\n'), 'postgres')).toBe(true);
    expect(containsTableDesignerTriggerCreateStatement(
      'CREATE OR REPLACE EDITIONABLE TRIGGER users_bi BEFORE INSERT ON users BEGIN NULL; END;',
      'oracle',
    )).toBe(true);
    expect(containsTableDesignerTriggerCreateStatement(
      'CREATE OR ALTER TRIGGER users_bi ON dbo.users AFTER INSERT AS SELECT 1;',
      'sqlserver',
    )).toBe(true);
  });

  it('keeps CRLF offsets aligned when retaining the final terminator', () => {
    expect(splitSchemaExecutionStatements('ALTER TABLE users ADD age int;\r\nCREATE INDEX ix_age ON users(age);', 'mysql'))
      .toEqual([
        'ALTER TABLE users ADD age int',
        'CREATE INDEX ix_age ON users(age);',
      ]);
  });

  it('recognizes ambiguous schema execution failures from both response shapes', () => {
    expect(isSchemaExecutionOutcomeUnknown({ outcomeUnknown: true })).toBe(true);
    expect(isSchemaExecutionOutcomeUnknown({ data: { outcomeUnknown: true } })).toBe(true);
    expect(isSchemaExecutionOutcomeUnknown({ success: false, cancellationState: 'unsupported' })).toBe(true);
    expect(isSchemaExecutionOutcomeUnknown({ success: false, data: { cancellationState: 'unsupported' } })).toBe(true);
    expect(isSchemaExecutionOutcomeUnknown({ message: 'malformed response' })).toBe(true);
    expect(isSchemaExecutionOutcomeUnknown({ success: false, data: { outcomeUnknown: false } })).toBe(false);
  });

  it('refreshes schema consumers after a copied-column CREATE TABLE succeeds', async () => {
    const execute = vi.fn().mockResolvedValue({ success: true });
    const refreshSchemaConsumers = vi.fn();

    const result = await executeTableDesignerSchemaStatements({
      sqlText: 'CREATE TABLE users_copy (id bigint)',
      dbType: 'mysql',
      execute,
      refreshSchemaConsumers,
    });

    expect(result).toEqual({
      ok: true,
      schemaMayHaveChanged: true,
      statementCount: 1,
    });
    expect(execute).toHaveBeenCalledWith('CREATE TABLE users_copy (id bigint);');
    expect(refreshSchemaConsumers).toHaveBeenCalledTimes(1);
  });

  it('sends a multi-statement MySQL trigger body unchanged when splitting is disabled', async () => {
    const execute = vi.fn().mockResolvedValue({ success: true });
    const refreshSchemaConsumers = vi.fn();
    const sql = [
      'CREATE TRIGGER trg_users_bi',
      'BEFORE INSERT ON users',
      'FOR EACH ROW BEGIN',
      '  SET NEW.created_at = NOW();',
      '  INSERT INTO audit_log(message) VALUES (\'created\');',
      'END;',
    ].join('\n');

    const result = await executeTableDesignerSchemaStatements({
      sqlText: sql,
      dbType: 'mysql',
      execute,
      refreshSchemaConsumers,
      splitStatements: false,
    });

    expect(result).toEqual({ ok: true, schemaMayHaveChanged: true, statementCount: 1 });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(sql);
    expect(refreshSchemaConsumers).toHaveBeenCalledTimes(1);
  });

  it('does not report success or call the driver for empty SQL', async () => {
    const execute = vi.fn();
    const refreshSchemaConsumers = vi.fn();

    const result = await executeTableDesignerSchemaStatements({
      sqlText: ' \n \t\n ',
      dbType: 'mysql',
      execute,
      refreshSchemaConsumers,
      emptySqlMessage: 'No SQL statement to execute',
      splitStatements: false,
    });

    expect(result).toEqual({
      ok: false,
      message: 'No SQL statement to execute',
      statementCount: 0,
    });
    expect(execute).not.toHaveBeenCalled();
    expect(refreshSchemaConsumers).not.toHaveBeenCalled();
  });

  it('does not report success or call the driver for comment-only opaque SQL', async () => {
    const execute = vi.fn();
    const refreshSchemaConsumers = vi.fn();

    const result = await executeTableDesignerSchemaStatements({
      sqlText: ' \n -- only a comment\n /* another comment */ \n ',
      dbType: 'mysql',
      execute,
      refreshSchemaConsumers,
      emptySqlMessage: 'No SQL statement to execute',
      splitStatements: false,
    });

    expect(result).toEqual({
      ok: false,
      message: 'No SQL statement to execute',
      statementCount: 0,
    });
    expect(execute).not.toHaveBeenCalled();
    expect(refreshSchemaConsumers).not.toHaveBeenCalled();
  });

  it('sends PostgreSQL function and trigger DDL as one unchanged request when splitting is disabled', async () => {
    const execute = vi.fn().mockResolvedValue({ success: true });
    const sql = [
      'CREATE OR REPLACE FUNCTION trigger_function_name() RETURNS trigger AS $$',
      'BEGIN',
      '  RETURN NEW;',
      'END;',
      '$$ LANGUAGE plpgsql;',
      'CREATE TRIGGER trigger_name BEFORE INSERT ON users',
      'FOR EACH ROW EXECUTE FUNCTION trigger_function_name();',
    ].join('\n');

    const result = await executeTableDesignerSchemaStatements({
      sqlText: sql,
      dbType: 'postgres',
      execute,
      refreshSchemaConsumers: vi.fn(),
      splitStatements: false,
    });

    expect(result).toEqual({ ok: true, schemaMayHaveChanged: true, statementCount: 1 });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(sql);
  });

  it('refreshes schema consumers after an unconfirmed first DDL failure', async () => {
    const refreshSchemaConsumers = vi.fn();
    const result = await executeTableDesignerSchemaStatements({
      sqlText: 'CREATE TABLE users_copy (id bigint)',
      dbType: 'mysql',
      execute: vi.fn().mockResolvedValue({
        success: false,
        outcomeUnknown: true,
        message: 'connection closed after execution',
      }),
      refreshSchemaConsumers,
    });

    expect(result).toMatchObject({
      ok: false,
      failedStatementIndex: 0,
      schemaMayHaveChanged: true,
      outcomeUnknown: true,
    });
    expect(refreshSchemaConsumers).toHaveBeenCalledTimes(1);
  });

  it('treats an empty driver response as an unknown schema outcome', async () => {
    const refreshSchemaConsumers = vi.fn();
    const result = await executeTableDesignerSchemaStatements({
      sqlText: 'CREATE TABLE users_copy (id bigint)',
      dbType: 'mysql',
      execute: vi.fn().mockResolvedValue(undefined),
      refreshSchemaConsumers,
    });

    expect(result).toMatchObject({ ok: false, schemaMayHaveChanged: true, outcomeUnknown: true });
    expect(refreshSchemaConsumers).toHaveBeenCalledTimes(1);
  });

  it('refreshes after a reported failure from an opaque trigger batch', async () => {
    const refreshSchemaConsumers = vi.fn();
    const result = await executeTableDesignerSchemaStatements({
      sqlText: 'CREATE FUNCTION helper() RETURNS trigger AS $$ BEGIN RETURN NEW; END; $$ LANGUAGE plpgsql;\nCREATE TRIGGER users_bi ...',
      dbType: 'postgres',
      execute: vi.fn().mockResolvedValue({ success: false, message: 'trigger creation failed' }),
      refreshSchemaConsumers,
      splitStatements: false,
    });

    expect(result).toMatchObject({ ok: false, schemaMayHaveChanged: true });
    expect(result.outcomeUnknown).toBeUndefined();
    expect(refreshSchemaConsumers).toHaveBeenCalledTimes(1);
  });
});
