type ChangePreview = {
  deletes?: unknown;
  updates?: unknown;
  inserts?: unknown;
};

type TransactionBoundary = {
  begin?: string;
  commit?: string;
};

const TRANSACTION_BOUNDARIES: Record<string, TransactionBoundary> = {
  mysql: { begin: 'START TRANSACTION', commit: 'COMMIT' },
  mariadb: { begin: 'START TRANSACTION', commit: 'COMMIT' },
  diros: { begin: 'START TRANSACTION', commit: 'COMMIT' },
  starrocks: { begin: 'START TRANSACTION', commit: 'COMMIT' },
  sphinx: { begin: 'START TRANSACTION', commit: 'COMMIT' },
  oceanbase: { begin: 'START TRANSACTION', commit: 'COMMIT' },
  sqlserver: { begin: 'BEGIN TRANSACTION', commit: 'COMMIT TRANSACTION' },
  postgres: { begin: 'BEGIN', commit: 'COMMIT' },
  kingbase: { begin: 'BEGIN', commit: 'COMMIT' },
  highgo: { begin: 'BEGIN', commit: 'COMMIT' },
  vastbase: { begin: 'BEGIN', commit: 'COMMIT' },
  opengauss: { begin: 'BEGIN', commit: 'COMMIT' },
  gaussdb: { begin: 'BEGIN', commit: 'COMMIT' },
  sqlite: { begin: 'BEGIN', commit: 'COMMIT' },
  duckdb: { begin: 'BEGIN', commit: 'COMMIT' },
  iris: { begin: 'BEGIN', commit: 'COMMIT' },
  cache: { begin: 'BEGIN', commit: 'COMMIT' },
  oracle: { commit: 'COMMIT' },
};

const previewStatements = (value: unknown): string[] => (
  Array.isArray(value)
    ? value.filter((statement): statement is string => typeof statement === 'string' && statement.trim().length > 0)
      .map((statement) => statement.trim())
    : []
);

const safeCommentText = (value: string) => value
  .replace(/[\r\n]+/g, ' ')
  .replace(/\*\//g, '* /')
  .trim();

export const buildDataGridTransactionLog = ({
  dbType,
  tableName,
  preview,
  committed,
}: {
  dbType: string;
  tableName: string;
  preview?: ChangePreview | null;
  committed: boolean;
}): string => {
  const statements = [
    ...previewStatements(preview?.deletes),
    ...previewStatements(preview?.updates),
    ...previewStatements(preview?.inserts),
  ];
  const tableLabel = safeCommentText(String(tableName || '')) || 'unknown table';
  const lines = [`/* Batch Apply on ${tableLabel} */`];

  if (statements.length === 0) {
    lines.push('/* Detailed statements are unavailable for this data source. */');
    return lines.join('\n');
  }

  const normalizedDbType = String(dbType || '').trim().toLowerCase();
  const boundary = TRANSACTION_BOUNDARIES[normalizedDbType];
  if (normalizedDbType === 'oracle') {
    lines.push('-- Oracle starts the transaction implicitly with the first DML statement.');
  } else if (boundary?.begin) {
    lines.push(`${boundary.begin};`);
  }

  lines.push(...statements);
  if (committed && boundary?.commit) {
    lines.push(`${boundary.commit};`);
  } else if (!committed) {
    lines.push('-- COMMIT was not issued because this batch failed.');
  }

  return lines.join('\n');
};
