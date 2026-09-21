export const DEFAULT_HIGHLIGHT_CURRENT_SQL_STATEMENT = true;

export const sanitizeHighlightCurrentSqlStatement = (value: unknown): boolean => (
  typeof value === 'boolean' ? value : DEFAULT_HIGHLIGHT_CURRENT_SQL_STATEMENT
);

/** Off by default: the run shortcut highlights and executes in a single press. */
export const DEFAULT_CONFIRM_SQL_STATEMENT_RUN = false;

export const sanitizeConfirmSqlStatementRun = (value: unknown): boolean => (
  typeof value === 'boolean' ? value : DEFAULT_CONFIRM_SQL_STATEMENT_RUN
);
