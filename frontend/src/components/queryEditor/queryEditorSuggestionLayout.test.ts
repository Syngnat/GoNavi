import { describe, expect, it, vi } from 'vitest';

import {
  installQueryEditorSuggestWidgetWidth,
  QUERY_EDITOR_SUGGEST_WIDGET_MIN_WIDTH,
  resolveQueryEditorSuggestWidgetWidth,
} from './queryEditorSuggestionLayout';

describe('query editor suggest widget layout', () => {
  it('enforces a wider minimum through Monaco resize so the list and outer widget stay in sync', () => {
    const resize = vi.fn();
    const widget: any = { _resize: resize };
    const editor = {
      getContribution: vi.fn(() => ({ widget: { value: widget } })),
    };

    installQueryEditorSuggestWidgetWidth(editor);
    widget._resize(430, 360);
    widget._resize(720, 360);

    expect(QUERY_EDITOR_SUGGEST_WIDGET_MIN_WIDTH).toBe(600);
    expect(resize.mock.calls).toEqual([
      [600, 360],
      [720, 360],
    ]);
  });

  it('does not wrap the same Monaco widget more than once', () => {
    const resize = vi.fn();
    const widget: any = { _resize: resize };
    const editor = {
      getContribution: vi.fn(() => ({ widget: { value: widget } })),
    };

    installQueryEditorSuggestWidgetWidth(editor);
    const wrappedResize = widget._resize;
    installQueryEditorSuggestWidgetWidth(editor);
    widget._resize(430, 240);

    expect(widget._resize).toBe(wrappedResize);
    expect(resize).toHaveBeenCalledTimes(1);
    expect(resize).toHaveBeenCalledWith(600, 240);
  });

  it('normalizes invalid or undersized widths while preserving larger sizes', () => {
    expect(resolveQueryEditorSuggestWidgetWidth(Number.NaN)).toBe(600);
    expect(resolveQueryEditorSuggestWidgetWidth(Number.POSITIVE_INFINITY)).toBe(600);
    expect(resolveQueryEditorSuggestWidgetWidth(undefined)).toBe(600);
    expect(resolveQueryEditorSuggestWidgetWidth(320)).toBe(600);
    expect(resolveQueryEditorSuggestWidgetWidth(720)).toBe(720);
  });

  it('leaves adapters without Monaco resize internals untouched', () => {
    expect(() => installQueryEditorSuggestWidgetWidth({ getContribution: () => undefined })).not.toThrow();
  });
});
