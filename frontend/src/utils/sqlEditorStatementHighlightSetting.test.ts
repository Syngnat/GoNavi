import { describe, expect, it } from 'vitest';

import {
  DEFAULT_HIGHLIGHT_CURRENT_SQL_STATEMENT,
  sanitizeHighlightCurrentSqlStatement,
} from './sqlEditorStatementHighlightSetting';

describe('sanitizeHighlightCurrentSqlStatement', () => {
  it('defaults to on when the persisted value is missing', () => {
    expect(DEFAULT_HIGHLIGHT_CURRENT_SQL_STATEMENT).toBe(true);
    expect(sanitizeHighlightCurrentSqlStatement(undefined)).toBe(true);
    expect(sanitizeHighlightCurrentSqlStatement(null)).toBe(true);
  });

  it('preserves an explicit boolean', () => {
    expect(sanitizeHighlightCurrentSqlStatement(false)).toBe(false);
    expect(sanitizeHighlightCurrentSqlStatement(true)).toBe(true);
  });
});
