export const DEFAULT_HIGHLIGHT_CURRENT_SQL_STATEMENT = true;

export const sanitizeHighlightCurrentSqlStatement = (value: unknown): boolean => (
  typeof value === 'boolean' ? value : DEFAULT_HIGHLIGHT_CURRENT_SQL_STATEMENT
);
