import { describe, expect, it } from 'vitest';

import {
  buildStatementHighlightKey,
  buildStatementOverlayRects,
  buildWrappedStatementPolygon,
  getStatementLineSlices,
  resolveHighlightableStatementRange,
  resolveRunShortcutAction,
  shouldDisarmArmedHighlightOnClick,
} from './queryEditorStatementHighlight';

const MULTI_STATEMENT_SQL = 'SELECT 1;\nSELECT id FROM users;\nSELECT 3;';

describe('resolveHighlightableStatementRange', () => {
  it('resolves the statement under the cursor', () => {
    const range = resolveHighlightableStatementRange(MULTI_STATEMENT_SQL, 12, 'mysql');
    expect(range?.text).toBe('SELECT id FROM users;');
  });

  it('keeps a caret after a semicolon on the previous statement', () => {
    const range = resolveHighlightableStatementRange(MULTI_STATEMENT_SQL, 9, 'mysql');
    expect(range?.text).toBe('SELECT 1;');
  });

  it('returns null for empty sql', () => {
    expect(resolveHighlightableStatementRange('   \n', 0, 'mysql')).toBeNull();
  });
});

describe('resolveRunShortcutAction', () => {
  const statementKey = '10:20:SELECT 1;';
  const action = (overrides: Partial<Parameters<typeof resolveRunShortcutAction>[0]> = {}) => (
    resolveRunShortcutAction({
      enabled: true,
      requireConfirm: true,
      hasSelection: false,
      statementKey,
      armedKey: null,
      ...overrides,
    })
  );

  it('runs immediately when the feature is disabled', () => {
    expect(action({ enabled: false })).toBe('run');
  });

  it('runs immediately when the editor has a selection', () => {
    expect(action({ hasSelection: true })).toBe('run');
  });

  it('runs on a single press when confirmation is off', () => {
    expect(action({ requireConfirm: false })).toBe('run');
    expect(action({ requireConfirm: false, armedKey: statementKey })).toBe('run');
  });

  it('arms on the first shortcut press when confirmation is on', () => {
    expect(action()).toBe('arm');
  });

  it('runs on the second shortcut press for the same statement', () => {
    expect(action({ armedKey: statementKey })).toBe('run');
  });

  it('re-arms when the caret moves to another statement', () => {
    expect(action({ statementKey: '30:40:SELECT 2;', armedKey: statementKey })).toBe('arm');
  });

  it('runs when no statement can be identified', () => {
    expect(action({ statementKey: null })).toBe('run');
  });
});

describe('shouldDisarmArmedHighlightOnClick', () => {
  const armedRange = { start: 10, end: 20, text: 'SELECT 1;' };

  it('keeps the armed highlight when clicking inside it', () => {
    expect(shouldDisarmArmedHighlightOnClick({ armedRange, clickOffset: 10 })).toBe(false);
    expect(shouldDisarmArmedHighlightOnClick({ armedRange, clickOffset: 20 })).toBe(false);
  });

  it('clears the armed highlight when clicking outside it', () => {
    expect(shouldDisarmArmedHighlightOnClick({ armedRange, clickOffset: 9 })).toBe(true);
    expect(shouldDisarmArmedHighlightOnClick({ armedRange, clickOffset: 21 })).toBe(true);
    expect(shouldDisarmArmedHighlightOnClick({ armedRange, clickOffset: null })).toBe(true);
  });

  it('does nothing when no highlight is armed', () => {
    expect(shouldDisarmArmedHighlightOnClick({ armedRange: null, clickOffset: 0 })).toBe(false);
  });
});

describe('statement overlay geometry', () => {
  it('builds line slices covering a multi-line statement', () => {
    const sql = 'SELECT\n  id\nFROM users;';
    const range = resolveHighlightableStatementRange(sql, 0, 'mysql');
    expect(range).not.toBeNull();
    const slices = getStatementLineSlices(sql, range!);
    expect(slices).toHaveLength(3);
    expect(slices[0]).toEqual({ lineNumber: 1, startColumn: 1, endColumn: 7 });
    expect(slices[2]).toEqual({ lineNumber: 3, startColumn: 1, endColumn: 12 });
  });

  it('keeps first and last lines on character edges', () => {
    const rects = buildStatementOverlayRects(
      [
        { lineNumber: 1, startColumn: 3, endColumn: 8 },
        { lineNumber: 2, startColumn: 1, endColumn: 5 },
      ],
      (lineNumber, column) => {
        if (lineNumber === 1) {
          return { left: column === 3 ? 40 : 110, top: 20, height: 18 };
        }
        return { left: column === 1 ? 10 : 50, top: 38, height: 18 };
      },
      3,
    );
    expect(rects).toEqual([
      { left: 37, top: 17, width: 76, height: 21 },
      { left: 7, top: 38, width: 46, height: 21 },
    ]);
  });

  it('stretches middle lines to the longest line width', () => {
    const rects = buildStatementOverlayRects(
      [
        { lineNumber: 1, startColumn: 1, endColumn: 8 },
        { lineNumber: 2, startColumn: 1, endColumn: 3 },
        { lineNumber: 3, startColumn: 1, endColumn: 5 },
      ],
      (lineNumber, column) => {
        if (lineNumber === 1) {
          return { left: column === 1 ? 20 : 120, top: 0, height: 18 };
        }
        if (lineNumber === 2) {
          return { left: column === 1 ? 20 : 40, top: 18, height: 18 };
        }
        return { left: column === 1 ? 20 : 70, top: 36, height: 18 };
      },
      0,
    );
    expect(rects).toEqual([
      { left: 20, top: 0, width: 100, height: 18 },
      { left: 20, top: 18, width: 100, height: 18 },
      { left: 20, top: 36, width: 50, height: 18 },
    ]);
  });

  it('keeps continuation lines on the leftmost later character when the first line is indented', () => {
    const rects = buildStatementOverlayRects(
      [
        { lineNumber: 1, startColumn: 5, endColumn: 12 },
        { lineNumber: 2, startColumn: 1, endColumn: 3 },
        { lineNumber: 3, startColumn: 1, endColumn: 6 },
      ],
      (lineNumber, column) => {
        if (lineNumber === 1) {
          return { left: column === 5 ? 40 : 140, top: 0, height: 18 };
        }
        if (lineNumber === 2) {
          return { left: column === 1 ? 10 : 30, top: 18, height: 18 };
        }
        return { left: column === 1 ? 10 : 60, top: 36, height: 18 };
      },
      0,
    );
    expect(rects).toEqual([
      { left: 40, top: 0, width: 100, height: 18 },
      { left: 10, top: 18, width: 130, height: 18 },
      { left: 10, top: 36, width: 50, height: 18 },
    ]);
  });

  it('wraps uneven line widths into an irregular polygon', () => {
    expect(buildWrappedStatementPolygon([
      { left: 40, top: 0, width: 80, height: 18 },
      { left: 10, top: 18, width: 40, height: 18 },
    ])).toEqual([
      { x: 40, y: 0 },
      { x: 120, y: 0 },
      { x: 120, y: 18 },
      { x: 50, y: 18 },
      { x: 50, y: 36 },
      { x: 10, y: 36 },
      { x: 10, y: 18 },
      { x: 40, y: 18 },
    ]);
  });

  it('connects first and last lines to the middle with horizontal seams', () => {
    const points = buildWrappedStatementPolygon([
      { left: 40, top: 0, width: 100, height: 18 },
      { left: 10, top: 18, width: 130, height: 18 },
      { left: 10, top: 36, width: 50, height: 18 },
    ]);
    const seams = [
      [points[2], points[3]],
      [points[3], points[4]],
      [points[7], points[8]],
      [points[8], points[9]],
    ];
    expect(points).toEqual([
      { x: 40, y: 0 },
      { x: 140, y: 0 },
      { x: 140, y: 18 },
      { x: 140, y: 36 },
      { x: 60, y: 36 },
      { x: 60, y: 54 },
      { x: 10, y: 54 },
      { x: 10, y: 36 },
      { x: 10, y: 18 },
      { x: 40, y: 18 },
    ]);
    seams.forEach(([from, to]) => {
      expect(from.y === to.y || from.x === to.x).toBe(true);
    });
  });

  it('builds a stable arm key from the statement range', () => {
    const range = resolveHighlightableStatementRange('SELECT 1;', 0, 'mysql');
    expect(buildStatementHighlightKey(range!)).toBe(`0:${range!.end}:${range!.text}`);
  });
});
