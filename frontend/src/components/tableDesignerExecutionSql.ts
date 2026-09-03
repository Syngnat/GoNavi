import { isOracleLikeDialect } from '../utils/sqlDialect';
import { findSqlStatementRanges } from '../utils/sqlStatementSelection';

export const splitSchemaExecutionStatements = (sqlText: string, dbType = ''): string[] => (
  (() => {
    const normalizedSql = String(sqlText || '')
      .replace(/\r\n?/g, '\n')
      .replace(/；/g, ';');
    const ranges = findSqlStatementRanges(normalizedSql, dbType);
    return ranges
      .map((range, index) => {
        let statement = range.text.trim();
        // Keep the final terminator for compatibility with the old splitter;
        // normalizeSchemaStatementForExecution still supplies terminators for
        // every dialect where they are required.
        if (
          index === ranges.length - 1
          && !/[;；]\s*$/.test(statement)
          && normalizedSql[range.end] === ';'
          && !normalizedSql.slice(range.end + 1).trim().startsWith('--')
          && !normalizedSql.slice(range.end + 1).trim().startsWith('#')
        ) {
          statement += ';';
        }
        return statement;
      })
      .filter(Boolean);
  })()
);

const stripLeadingSchemaSqlTrivia = (sql: string): string => {
  const text = String(sql || '');
  let offset = 0;
  for (;;) {
    while (offset < text.length && /\s/.test(text[offset] || '')) offset += 1;
    if (text.startsWith('/*', offset)) {
      const blockEnd = text.indexOf('*/', offset + 2);
      if (blockEnd < 0) return '';
      offset = blockEnd + 2;
      continue;
    }
    if (text.startsWith('--', offset) || text.startsWith('#', offset)) {
      const lineEnd = text.indexOf('\n', offset);
      if (lineEnd < 0) return '';
      offset = lineEnd + 1;
      continue;
    }
    return text.slice(offset);
  }
};

const TRIGGER_CREATE_STATEMENT_REGEX = /^CREATE\s+(?:(?:DEFINER\s*=\s*\S+)\s+)?(?:OR\s+(?:REPLACE|ALTER)\s+)?(?:(?:EDITIONABLE|NONEDITIONABLE|CONSTRAINT)\s+)*TRIGGER\b/i;

export const isTableDesignerTriggerCreateStatement = (statement: string): boolean => (
  TRIGGER_CREATE_STATEMENT_REGEX.test(stripLeadingSchemaSqlTrivia(statement))
);

export const containsTableDesignerTriggerCreateStatement = (sqlText: string, dbType = ''): boolean => (
  splitSchemaExecutionStatements(sqlText, dbType).some(isTableDesignerTriggerCreateStatement)
);

export const isSchemaExecutionOutcomeUnknown = (result: any): boolean => (
  !result
  || typeof result?.success !== 'boolean'
  || result?.outcomeUnknown === true
  || result?.data?.outcomeUnknown === true
  || String(result?.cancellationState || '').trim().toLowerCase() === 'unsupported'
  || String(result?.data?.cancellationState || '').trim().toLowerCase() === 'unsupported'
);

export type TableDesignerSchemaExecutionResult = {
  ok: boolean;
  message?: string;
  failedStatementIndex?: number;
  schemaMayHaveChanged?: boolean;
  // A transport/driver failure can happen after the server applied the DDL.
  // Callers must refresh metadata but must not perform destructive compensation
  // against an outcome that has not been confirmed.
  outcomeUnknown?: boolean;
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
    ? splitSchemaExecutionStatements(rawSqlText, dbType)
    : (
      rawSqlText.trim() && splitSchemaExecutionStatements(rawSqlText, dbType).length > 0
        ? [rawSqlText]
        : []
    );
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
        const outcomeUnknown = !result || isSchemaExecutionOutcomeUnknown(result);
        // An opaque batch (trigger/function bodies) may contain several
        // server-side statements even though it is dispatched as one request.
        // A reported failure cannot prove that an earlier statement in that
        // batch was rolled back, so refresh metadata before returning.
        const schemaMayHaveChanged = hasExecutedSchemaStatement || outcomeUnknown || !splitStatements;
        if (schemaMayHaveChanged) refreshSchemaConsumers();
        return {
          ok: false,
          message: String(result?.message || ''),
          failedStatementIndex: index,
          schemaMayHaveChanged,
          ...(outcomeUnknown ? { outcomeUnknown: true } : {}),
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
        outcomeUnknown: true,
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
