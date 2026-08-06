import { isOracleLikeDialect } from '../utils/sqlDialect';

export const splitSchemaExecutionStatements = (sqlText: string): string[] => (
  String(sqlText || '')
    .replace(/；/g, ';')
    .split(/;\s*\n/)
    .map(statement => statement.trim())
    .filter(statement => !statement.startsWith('--'))
    .filter(Boolean)
);

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
