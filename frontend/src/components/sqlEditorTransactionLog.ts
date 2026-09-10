export type SqlEditorTransactionFinishAction = 'commit' | 'rollback';

type TransactionBoundary = {
  begin?: string;
  commit: string;
  rollback: string;
  implicitBeginComment?: string;
};

const DEFAULT_TRANSACTION_BOUNDARY: TransactionBoundary = {
  begin: 'BEGIN',
  commit: 'COMMIT',
  rollback: 'ROLLBACK',
};

const TRANSACTION_BOUNDARIES: Record<string, TransactionBoundary> = {
  mysql: { begin: 'START TRANSACTION', commit: 'COMMIT', rollback: 'ROLLBACK' },
  mariadb: { begin: 'START TRANSACTION', commit: 'COMMIT', rollback: 'ROLLBACK' },
  diros: { begin: 'START TRANSACTION', commit: 'COMMIT', rollback: 'ROLLBACK' },
  starrocks: { begin: 'START TRANSACTION', commit: 'COMMIT', rollback: 'ROLLBACK' },
  sphinx: { begin: 'START TRANSACTION', commit: 'COMMIT', rollback: 'ROLLBACK' },
  oceanbase: { begin: 'START TRANSACTION', commit: 'COMMIT', rollback: 'ROLLBACK' },
  sqlserver: {
    begin: 'BEGIN TRANSACTION',
    commit: 'COMMIT TRANSACTION',
    rollback: 'ROLLBACK TRANSACTION',
  },
  postgres: DEFAULT_TRANSACTION_BOUNDARY,
  kingbase: DEFAULT_TRANSACTION_BOUNDARY,
  highgo: DEFAULT_TRANSACTION_BOUNDARY,
  vastbase: DEFAULT_TRANSACTION_BOUNDARY,
  opengauss: DEFAULT_TRANSACTION_BOUNDARY,
  gaussdb: DEFAULT_TRANSACTION_BOUNDARY,
  sqlite: DEFAULT_TRANSACTION_BOUNDARY,
  duckdb: DEFAULT_TRANSACTION_BOUNDARY,
  iris: DEFAULT_TRANSACTION_BOUNDARY,
  cache: DEFAULT_TRANSACTION_BOUNDARY,
  oracle: {
    commit: 'COMMIT',
    rollback: 'ROLLBACK',
    implicitBeginComment: '-- Oracle starts the transaction implicitly with the first DML statement.',
  },
};

const terminateSqlStatement = (statement: string): string => {
  const normalized = String(statement || '').trim();
  if (!normalized || /[;/]\s*$/.test(normalized)) {
    return normalized;
  }
  return `${normalized};`;
};

export const buildSqlEditorTransactionLog = ({
  dbType,
  statements,
  action,
}: {
  dbType?: string;
  statements?: string[];
  action: SqlEditorTransactionFinishAction;
}): string => {
  const boundary = TRANSACTION_BOUNDARIES[String(dbType || '').trim().toLowerCase()]
    || DEFAULT_TRANSACTION_BOUNDARY;
  const lines: string[] = [];

  if (boundary.implicitBeginComment) {
    lines.push(boundary.implicitBeginComment);
  } else if (boundary.begin) {
    lines.push(`${boundary.begin};`);
  }

  const normalizedStatements = Array.isArray(statements)
    ? statements.map(terminateSqlStatement).filter(Boolean)
    : [];
  if (normalizedStatements.length > 0) {
    lines.push(...normalizedStatements);
  } else {
    lines.push('-- No SQL statements were captured for this transaction.');
  }

  lines.push(`${action === 'commit' ? boundary.commit : boundary.rollback};`);
  return lines.join('\n');
};
