import {
  DEFAULT_CONFIRM_SQL_STATEMENT_RUN,
  DEFAULT_HIGHLIGHT_CURRENT_SQL_STATEMENT,
  sanitizeConfirmSqlStatementRun,
  sanitizeHighlightCurrentSqlStatement,
} from '../utils/sqlEditorStatementHighlightSetting';

export interface SqlStatementHighlightSettings {
  highlightCurrentSqlStatement: boolean;
  confirmSqlStatementRun: boolean;
}

export interface SqlStatementHighlightSlice {
  sqlStatementHighlight: SqlStatementHighlightSettings;
  setSqlStatementHighlightSettings: (
    settings: Partial<SqlStatementHighlightSettings>,
  ) => void;
}

export const DEFAULT_SQL_STATEMENT_HIGHLIGHT_SETTINGS: SqlStatementHighlightSettings = {
  highlightCurrentSqlStatement: DEFAULT_HIGHLIGHT_CURRENT_SQL_STATEMENT,
  confirmSqlStatementRun: DEFAULT_CONFIRM_SQL_STATEMENT_RUN,
};

export const sanitizeSqlStatementHighlightSettings = (
  settings: Partial<SqlStatementHighlightSettings> | undefined,
): SqlStatementHighlightSettings => ({
  highlightCurrentSqlStatement: sanitizeHighlightCurrentSqlStatement(
    settings?.highlightCurrentSqlStatement,
  ),
  confirmSqlStatementRun: sanitizeConfirmSqlStatementRun(
    settings?.confirmSqlStatementRun,
  ),
});

export const resolvePersistedSqlStatementHighlightSettings = (
  settings: unknown,
  legacyAppearance?: unknown,
): SqlStatementHighlightSettings => {
  const source = settings && typeof settings === 'object'
    ? settings
    : legacyAppearance && typeof legacyAppearance === 'object'
      ? legacyAppearance
      : undefined;
  return sanitizeSqlStatementHighlightSettings(
    source as Partial<SqlStatementHighlightSettings> | undefined,
  );
};

type SliceStateSetter = (
  update: (
    state: SqlStatementHighlightSlice,
  ) => Partial<SqlStatementHighlightSlice>,
) => void;

export const createSqlStatementHighlightSlice = (
  set: SliceStateSetter,
): SqlStatementHighlightSlice => ({
  sqlStatementHighlight: { ...DEFAULT_SQL_STATEMENT_HIGHLIGHT_SETTINGS },
  setSqlStatementHighlightSettings: (settings) => {
    set((state) => ({
      sqlStatementHighlight: sanitizeSqlStatementHighlightSettings({
        highlightCurrentSqlStatement:
          settings.highlightCurrentSqlStatement
          ?? state.sqlStatementHighlight.highlightCurrentSqlStatement,
        confirmSqlStatementRun:
          settings.confirmSqlStatementRun
          ?? state.sqlStatementHighlight.confirmSqlStatementRun,
      }),
    }));
  },
});
