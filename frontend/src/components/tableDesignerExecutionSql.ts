import { isOracleLikeDialect } from '../utils/sqlDialect';

export const splitSchemaExecutionStatements = (sqlText: string): string[] => (
  String(sqlText || '')
    .replace(/；/g, ';')
    .split(/;\s*\n/)
    .map(statement => statement.trim())
    .filter(statement => !statement.startsWith('--'))
    .filter(Boolean)
);

export const isSchemaExecutionOutcomeUnknown = (result: any): boolean => (
  result?.outcomeUnknown === true
  || result?.data?.outcomeUnknown === true
);

export type TableDesignerSchemaExecutionResult = {
  ok: boolean;
  message?: string;
  failedStatementIndex?: number;
  schemaMayHaveChanged?: boolean;
  statementCount: number;
};

type ExecuteTableDesignerSchemaStatementsOptions = {
  sqlText: string;
  dbType: string;
  execute: (statement: string) => Promise<any>;
  refreshSchemaConsumers: () => void;
  emptySqlMessage?: string;
  // Trigger/function bodies can contain semicolon-newline sequences that are
  // part of one server-side DDL statement. Those callers must opt out of the
  // preview-oriented statement splitter and preserve their original SQL.
  splitStatements?: boolean;
};

// All Table Designer DDL flows use this executor so success and uncertain
// failures invalidate sidebar and QueryEditor metadata consistently.
export const executeTableDesignerSchemaStatements = async ({
  sqlText,
  dbType,
  execute,
  refreshSchemaConsumers,
  emptySqlMessage,
  splitStatements = true,
}: ExecuteTableDesignerSchemaStatementsOptions): Promise<TableDesignerSchemaExecutionResult> => {
  const rawSqlText = String(sqlText || '');
  const statements = splitStatements
    ? splitSchemaExecutionStatements(rawSqlText)
    : (rawSqlText.trim() ? [rawSqlText] : []);
  if (statements.length === 0) {
    return {
      ok: false,
      message: String(emptySqlMessage || ''),
      statementCount: 0,
    };
  }
  let hasExecutedSchemaStatement = false;

  for (let index = 0; index < statements.length; index += 1) {
    const statement = splitStatements
      ? normalizeSchemaStatementForExecution(statements[index], dbType)
      : statements[index];
    try {
      const result = await execute(statement);
      if (!result?.success) {
        const schemaMayHaveChanged = hasExecutedSchemaStatement
          || !result
          || isSchemaExecutionOutcomeUnknown(result);
        if (schemaMayHaveChanged) refreshSchemaConsumers();
        return {
          ok: false,
          message: String(result?.message || ''),
          failedStatementIndex: index,
          schemaMayHaveChanged,
          statementCount: statements.length,
        };
      }
      hasExecutedSchemaStatement = true;
    } catch (error: any) {
      // Transport errors can occur after the server has already applied the DDL.
      refreshSchemaConsumers();
      return {
        ok: false,
        message: error?.message || String(error || ''),
        failedStatementIndex: index,
        schemaMayHaveChanged: true,
        statementCount: statements.length,
      };
    }
  }

  if (hasExecutedSchemaStatement) refreshSchemaConsumers();
  return {
    ok: true,
    schemaMayHaveChanged: hasExecutedSchemaStatement,
    statementCount: statements.length,
  };
};

export const normalizeSchemaStatementForExecution = (statement: string, dbType: string): string => {
  const trimmed = String(statement || '').trim();
  if (!trimmed) return '';
  if (isOracleLikeDialect(dbType)) {
    return trimmed.replace(/;+\s*$/, '').trim();
  }
  return trimmed.endsWith(';') ? trimmed : `${trimmed};`;
};

const unescapeSqlComment = (text: string, mysqlBackslashEscapes = false): string => {
  const unescaped = text.replace(/''/g, "'");
  return mysqlBackslashEscapes ? unescaped.replace(/\\'/g, "'") : unescaped;
};

export const parseTableCommentFromDDL = (ddlText: string): string => {
  const ddl = String(ddlText || '').replace(/\r?\n/g, ' ');
  const mysqlMatch = ddl.match(/COMMENT\s*=\s*'((?:\\'|''|[^'])*)'/i);
  if (mysqlMatch) {
    return unescapeSqlComment(mysqlMatch[1], true);
  }

  const commentOnTableMatch = ddl.match(/\bCOMMENT\s+ON\s+TABLE\s+.+?\s+IS\s+(NULL|'((?:''|[^'])*)')/i);
  if (!commentOnTableMatch || commentOnTableMatch[1].toUpperCase() === 'NULL') {
    return '';
  }
  return unescapeSqlComment(commentOnTableMatch[2] || '');
};
