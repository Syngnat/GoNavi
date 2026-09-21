import { describe, expect, it, vi } from 'vitest';

import {
  createSqlStatementHighlightSlice,
  DEFAULT_SQL_STATEMENT_HIGHLIGHT_SETTINGS,
  resolvePersistedSqlStatementHighlightSettings,
  sanitizeSqlStatementHighlightSettings,
  type SqlStatementHighlightSlice,
} from './sqlStatementHighlightSlice';

describe('sqlStatementHighlightSlice', () => {
  it('sanitizes missing and explicit settings', () => {
    expect(sanitizeSqlStatementHighlightSettings(undefined)).toEqual(
      DEFAULT_SQL_STATEMENT_HIGHLIGHT_SETTINGS,
    );
    expect(sanitizeSqlStatementHighlightSettings({
      highlightCurrentSqlStatement: false,
      confirmSqlStatementRun: true,
    })).toEqual({
      highlightCurrentSqlStatement: false,
      confirmSqlStatementRun: true,
    });
  });

  it('hydrates current and legacy persisted settings', () => {
    expect(resolvePersistedSqlStatementHighlightSettings({
      highlightCurrentSqlStatement: false,
      confirmSqlStatementRun: true,
    })).toEqual({
      highlightCurrentSqlStatement: false,
      confirmSqlStatementRun: true,
    });
    expect(resolvePersistedSqlStatementHighlightSettings(undefined, {
      highlightCurrentSqlStatement: false,
      confirmSqlStatementRun: true,
    })).toEqual({
      highlightCurrentSqlStatement: false,
      confirmSqlStatementRun: true,
    });
  });

  it('updates only the requested highlight setting', () => {
    const state: SqlStatementHighlightSlice = {
      sqlStatementHighlight: {
        highlightCurrentSqlStatement: true,
        confirmSqlStatementRun: true,
      },
      setSqlStatementHighlightSettings: vi.fn(),
    };
    const set = vi.fn((updater: (
      current: SqlStatementHighlightSlice,
    ) => Partial<SqlStatementHighlightSlice>) => {
      Object.assign(state, updater(state));
    });
    const slice = createSqlStatementHighlightSlice(set);

    slice.setSqlStatementHighlightSettings({
      highlightCurrentSqlStatement: false,
    });

    expect(state.sqlStatementHighlight.highlightCurrentSqlStatement).toBe(false);
    expect(state.sqlStatementHighlight.confirmSqlStatementRun).toBe(true);
  });
});
