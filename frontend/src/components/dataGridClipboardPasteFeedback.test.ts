import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DATA_GRID_PASTE_OVERFLOW_MESSAGE_KEY,
  DATA_GRID_PASTE_SKIP_MESSAGE_KEYS,
  countDataGridPasteOverflow,
  resolveDataGridPasteGateReason,
  resolveDataGridPasteMatrixReason,
  traceDataGridPaste,
} from './dataGridClipboardPasteFeedback';
import { t } from '../i18n';

describe('resolveDataGridPasteGateReason', () => {
  it('ignores pastes that show no intent to fill the grid', () => {
    expect(resolveDataGridPasteGateReason({ canModifyData: true, hasAnchor: false, cellEditMode: false })).toBe('ignore');
    expect(resolveDataGridPasteGateReason({ canModifyData: false, hasAnchor: false, cellEditMode: false })).toBe('ignore');
  });

  it('explains read-only results as soon as the user selected a cell or entered selection mode', () => {
    expect(resolveDataGridPasteGateReason({ canModifyData: false, hasAnchor: true, cellEditMode: false })).toBe('read-only');
    expect(resolveDataGridPasteGateReason({ canModifyData: false, hasAnchor: false, cellEditMode: true })).toBe('read-only');
  });

  it('asks for a start cell when selection mode is on without a selection', () => {
    expect(resolveDataGridPasteGateReason({ canModifyData: true, hasAnchor: false, cellEditMode: true })).toBe('no-anchor');
  });

  it('lets a writable grid with a start cell continue to clipboard parsing', () => {
    expect(resolveDataGridPasteGateReason({ canModifyData: true, hasAnchor: true, cellEditMode: false })).toBeNull();
    expect(resolveDataGridPasteGateReason({ canModifyData: true, hasAnchor: true, cellEditMode: true })).toBeNull();
  });
});

describe('resolveDataGridPasteMatrixReason', () => {
  it('flags clipboards that carry no tabular data', () => {
    expect(resolveDataGridPasteMatrixReason({ matrix: [], anchorResolved: true })).toBe('clipboard-empty');
    expect(resolveDataGridPasteMatrixReason({ matrix: [[], []], anchorResolved: true })).toBe('clipboard-empty');
  });

  it('keeps a single empty cell pasteable because it clears the target', () => {
    expect(resolveDataGridPasteMatrixReason({ matrix: [['']], anchorResolved: true })).toBeNull();
    expect(resolveDataGridPasteMatrixReason({ matrix: [[null]], anchorResolved: true })).toBeNull();
  });

  it('flags a start cell that is gone from the current data', () => {
    expect(resolveDataGridPasteMatrixReason({ matrix: [['a']], anchorResolved: false })).toBe('anchor-missing');
  });
});

describe('countDataGridPasteOverflow', () => {
  const matrix = [['a', 'b', 'c'], ['d', 'e', 'f'], ['g', 'h', 'i']];

  it('reports nothing when the matrix fits', () => {
    expect(countDataGridPasteOverflow({
      matrix, startRowIndex: 0, startColumnIndex: 0, rowCount: 3, columnCount: 3,
    })).toEqual({ rows: 0, columns: 0 });
    expect(countDataGridPasteOverflow({
      matrix, startRowIndex: 2, startColumnIndex: 1, rowCount: 10, columnCount: 10,
    })).toEqual({ rows: 0, columns: 0 });
  });

  it('counts rows below the last row', () => {
    expect(countDataGridPasteOverflow({
      matrix, startRowIndex: 1, startColumnIndex: 0, rowCount: 3, columnCount: 3,
    })).toEqual({ rows: 1, columns: 0 });
  });

  it('counts columns past the last column using the widest row', () => {
    expect(countDataGridPasteOverflow({
      matrix: [['a'], ['b', 'c', 'd']], startRowIndex: 0, startColumnIndex: 1, rowCount: 5, columnCount: 3,
    })).toEqual({ rows: 0, columns: 1 });
  });

  it('counts both directions at once', () => {
    expect(countDataGridPasteOverflow({
      matrix, startRowIndex: 2, startColumnIndex: 2, rowCount: 3, columnCount: 3,
    })).toEqual({ rows: 2, columns: 2 });
  });
});

describe('paste feedback catalog', () => {
  it.each(['zh-CN', 'zh-TW', 'en-US', 'ja-JP', 'de-DE', 'ru-RU'] as const)(
    'has every message key translated in %s',
    (language) => {
      const keys = [...Object.values(DATA_GRID_PASTE_SKIP_MESSAGE_KEYS), DATA_GRID_PASTE_OVERFLOW_MESSAGE_KEY];
      keys.forEach((key) => {
        const text = t(key, { rows: 2, columns: 3 }, language);
        expect(text).not.toBe(key);
        expect(text.length).toBeGreaterThan(0);
      });
      const overflow = t(DATA_GRID_PASTE_OVERFLOW_MESSAGE_KEY, { rows: 2, columns: 3 }, language);
      expect(overflow).toContain('2');
      expect(overflow).toContain('3');
      expect(overflow).not.toContain('{{');
    },
  );
});

describe('traceDataGridPaste', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs the reason and clipboard format names without leaking clipboard content', () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    const active = { tagName: 'TEXTAREA', className: 'inputarea monaco-mouse-cursor-text' } as unknown as Element;

    traceDataGridPaste('skipped: focus is in a native editable target', {
      clipboardTypes: ['text/plain', 'text/html'],
      activeElement: active,
      canModifyData: true,
    });

    expect(debug).toHaveBeenCalledOnce();
    expect(debug).toHaveBeenCalledWith(
      '[GoNavi][DataGrid][paste]',
      'skipped: focus is in a native editable target',
      {
        clipboardTypes: ['text/plain', 'text/html'],
        activeElement: 'textarea.inputarea',
        canModifyData: true,
      },
    );
  });

  it('tolerates a missing clipboard and active element', () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);

    traceDataGridPaste('received', {});

    expect(debug).toHaveBeenCalledWith('[GoNavi][DataGrid][paste]', 'received', {
      clipboardTypes: [],
      activeElement: 'none',
    });
  });
});
