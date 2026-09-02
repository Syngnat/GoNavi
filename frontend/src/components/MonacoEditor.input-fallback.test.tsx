import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installPrintableInputFallback } from './MonacoEditor';

class FakeHTMLElement {
  isConnected = true;

  contains(target: unknown): boolean {
    return target === this;
  }
}

class FakeTextAreaElement extends FakeHTMLElement {
  private listeners = new Map<string, Set<(event: any) => void>>();

  addEventListener(type: string, listener: (event: any) => void): void {
    const listeners = this.listeners.get(type) || new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: any) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  dispatchKeyDown(key: string, modifiers: Partial<KeyboardEvent> = {}): void {
    const event = {
      type: 'keydown',
      key,
      code: `Key${key.toUpperCase()}`,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      shiftKey: false,
      ...modifiers,
    } as KeyboardEvent;
    this.listeners.get('keydown')?.forEach((listener) => listener(event));
  }

  dispatchPrintableBeforeInput(
    text: string,
    defaultPrevented = false,
    modifiers: Partial<KeyboardEvent> = {},
  ): void {
    const event = {
      data: text,
      inputType: 'insertText',
      isComposing: false,
      defaultPrevented,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      ...modifiers,
    } as unknown as InputEvent;
    this.listeners.get('beforeinput')?.forEach((listener) => listener(event));
  }

  dispatchFocus(type: 'blur' | 'focus'): void {
    this.listeners.get(type)?.forEach((listener) => listener({ type }));
  }
}

describe('MonacoEditor printable input fallback', () => {
  let editorDomNode: FakeHTMLElement & { querySelector: () => FakeTextAreaElement };
  let input: FakeTextAreaElement;
  let value: string;
  let position: { lineNumber: number; column: number };
  let selection: {
    startLineNumber: number;
    startColumn: number;
    endLineNumber: number;
    endColumn: number;
  } | null;
  let modelContentListener: (() => void) | null;
  let editor: any;

  const installFallback = () => installPrintableInputFallback(editor, {
    editor: { EditorOption: { readOnly: 1 } },
  });

  const setSingleLineSelection = (
    startColumn: number,
    endColumn: number,
    activeColumn = endColumn,
  ) => {
    selection = {
      startLineNumber: 1,
      startColumn,
      endLineNumber: 1,
      endColumn,
    };
    position = { lineNumber: 1, column: activeColumn };
  };

  beforeEach(() => {
    vi.useFakeTimers();
    input = new FakeTextAreaElement();
    editorDomNode = Object.assign(new FakeHTMLElement(), {
      contains: (target: unknown) => target === editorDomNode || target === input,
      querySelector: () => input,
    });
    vi.stubGlobal('HTMLElement', FakeHTMLElement);
    vi.stubGlobal('HTMLTextAreaElement', FakeTextAreaElement);
    vi.stubGlobal('document', { activeElement: input });
    vi.stubGlobal('window', { setTimeout, clearTimeout });

    value = '';
    position = { lineNumber: 1, column: 1 };
    selection = null;
    modelContentListener = null;
    const offsetAt = (target: { lineNumber: number; column: number }) => (
      Math.max(0, Math.min(value.length, Number(target.column || 1) - 1))
    );
    const positionAt = (offset: number) => ({
      lineNumber: 1,
      column: Math.max(1, Math.min(value.length, offset) + 1),
    });
    editor = {
      getDomNode: () => editorDomNode,
      getSelection: () => selection || ({
        startLineNumber: position.lineNumber,
        startColumn: position.column,
        endLineNumber: position.lineNumber,
        endColumn: position.column,
      }),
      getValue: () => value,
      getModel: () => ({
        getOffsetAt: offsetAt,
        getPositionAt: positionAt,
      }),
      getPosition: () => position,
      getOption: () => false,
      trigger: vi.fn((_source: string, _command: string, payload: { text: string }) => {
        const activeSelection = selection || {
          startLineNumber: position.lineNumber,
          startColumn: position.column,
          endLineNumber: position.lineNumber,
          endColumn: position.column,
        };
        const startOffset = offsetAt({
          lineNumber: activeSelection.startLineNumber,
          column: activeSelection.startColumn,
        });
        const endOffset = offsetAt({
          lineNumber: activeSelection.endLineNumber,
          column: activeSelection.endColumn,
        });
        value = value.slice(0, startOffset) + payload.text + value.slice(endOffset);
        position = positionAt(startOffset + payload.text.length);
        selection = null;
      }),
      executeEdits: vi.fn((_source: string, edits: Array<{ range: any; text: string }>) => {
        for (const edit of edits) {
          const startOffset = offsetAt({
            lineNumber: edit.range.startLineNumber,
            column: edit.range.startColumn,
          });
          const endOffset = offsetAt({
            lineNumber: edit.range.endLineNumber,
            column: edit.range.endColumn,
          });
          value = value.slice(0, startOffset) + edit.text + value.slice(endOffset);
        }
      }),
      setPosition: vi.fn((nextPosition: { lineNumber: number; column: number }) => {
        position = nextPosition;
        selection = null;
      }),
      onDidChangeModelContent: vi.fn((listener: () => void) => {
        modelContentListener = listener;
        return { dispose: vi.fn() };
      }),
      onDidDispose: vi.fn(),
    };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('coalesces consecutive missing printable input before recovering it once', () => {
    installPrintableInputFallback(editor, {
      editor: { EditorOption: { readOnly: 1 } },
    });

    input.dispatchPrintableBeforeInput('a');
    vi.advanceTimersByTime(30);
    input.dispatchPrintableBeforeInput('b');

    vi.advanceTimersByTime(79);
    expect(editor.trigger).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(editor.trigger).toHaveBeenCalledTimes(1);
    expect(editor.trigger).toHaveBeenCalledWith(
      'gonavi-printable-input-fallback',
      'type',
      { text: 'ab' },
    );
  });

  it('cancels recovery when Monaco receives the native model change', () => {
    installPrintableInputFallback(editor, {
      editor: { EditorOption: { readOnly: 1 } },
    });

    input.dispatchPrintableBeforeInput('a');
    value = 'a';
    position = { lineNumber: 1, column: 2 };
    modelContentListener?.();
    vi.advanceTimersByTime(200);

    expect(editor.trigger).not.toHaveBeenCalled();
  });

  it('recovers a missing leading character when a later character is committed natively', () => {
    installPrintableInputFallback(editor, {
      editor: { EditorOption: { readOnly: 1 } },
    });

    input.dispatchPrintableBeforeInput('a');
    input.dispatchPrintableBeforeInput('b');
    value = 'b';
    position = { lineNumber: 1, column: 2 };
    modelContentListener?.();

    vi.advanceTimersByTime(80);

    expect(editor.trigger).not.toHaveBeenCalled();
    expect(editor.executeEdits).toHaveBeenCalledWith(
      'gonavi-printable-input-fallback',
      [expect.objectContaining({ text: 'ab' })],
    );
    expect(value).toBe('ab');
    expect(position).toEqual({ lineNumber: 1, column: 3 });
  });

  it('recovers a default-prevented leading character when later input reaches the model', () => {
    installPrintableInputFallback(editor, {
      editor: { EditorOption: { readOnly: 1 } },
    });

    value = 'SELECT * FROM person';
    position = { lineNumber: 1, column: value.length + 1 };
    input.dispatchPrintableBeforeInput('s', true);
    input.dispatchPrintableBeforeInput('f');
    value = 'SELECT * FROM personf';
    position = { lineNumber: 1, column: value.length + 1 };
    modelContentListener?.();

    vi.advanceTimersByTime(80);

    expect(editor.executeEdits).toHaveBeenCalledWith(
      'gonavi-printable-input-fallback',
      [expect.objectContaining({ text: 'sf' })],
    );
    expect(value).toBe('SELECT * FROM personsf');
    expect(position).toEqual({ lineNumber: 1, column: value.length + 1 });
  });

  it('settles the previous missing input before buffering text after a cursor move', () => {
    installPrintableInputFallback(editor, {
      editor: { EditorOption: { readOnly: 1 } },
    });

    value = 'xy';
    position = { lineNumber: 1, column: 2 };
    input.dispatchPrintableBeforeInput('a');
    position = { lineNumber: 1, column: 3 };
    input.dispatchPrintableBeforeInput('b');

    vi.advanceTimersByTime(80);

    expect(editor.executeEdits).toHaveBeenCalledWith(
      'gonavi-printable-input-fallback',
      [expect.objectContaining({ text: 'a' })],
    );
    expect(editor.trigger).toHaveBeenCalledWith(
      'gonavi-printable-input-fallback',
      'type',
      { text: 'b' },
    );
    expect(value).toBe('xayb');
    expect(position).toEqual({ lineNumber: 1, column: 5 });
  });

  it('replaces selected text after one printable input when native input is dropped', () => {
    installFallback();

    value = 'and task_datetime &lt;= least(sysdate)';
    setSingleLineSelection(19, 23);

    input.dispatchPrintableBeforeInput('<');
    vi.advanceTimersByTime(80);

    expect(value).toBe('and task_datetime <= least(sysdate)');
    expect(position).toEqual({ lineNumber: 1, column: 20 });
  });

  it('does not duplicate printable text when Monaco replaces the selection natively', () => {
    installFallback();

    value = 'and task_datetime &lt;= least(sysdate)';
    setSingleLineSelection(19, 23);

    input.dispatchPrintableBeforeInput('<');
    value = 'and task_datetime <= least(sysdate)';
    selection = null;
    position = { lineNumber: 1, column: 20 };
    modelContentListener?.();
    vi.advanceTimersByTime(200);

    expect(value).toBe('and task_datetime <= least(sysdate)');
    expect(editor.executeEdits).not.toHaveBeenCalled();
    expect(position).toEqual({ lineNumber: 1, column: 20 });
  });

  it('recovers printable text when native input only deletes a reverse selection', () => {
    installFallback();

    value = 'and task_datetime &lt;= least(sysdate)';
    setSingleLineSelection(19, 23, 19);

    input.dispatchPrintableBeforeInput('<');
    value = 'and task_datetime = least(sysdate)';
    selection = null;
    position = { lineNumber: 1, column: 19 };
    modelContentListener?.();
    vi.advanceTimersByTime(80);

    expect(value).toBe('and task_datetime <= least(sysdate)');
    expect(position).toEqual({ lineNumber: 1, column: 20 });
  });

  it('does not let an older cursor fallback consume a new selection replacement', () => {
    installFallback();

    value = 'abcd';
    position = { lineNumber: 1, column: 1 };
    input.dispatchPrintableBeforeInput('x');
    setSingleLineSelection(3, 4);

    input.dispatchPrintableBeforeInput('y');
    vi.advanceTimersByTime(80);

    expect(value).toBe('abyd');
    expect(position).toEqual({ lineNumber: 1, column: 4 });
  });

  it('does not let an older selection fallback consume a newer selection replacement', () => {
    installFallback();

    value = 'abcd';
    setSingleLineSelection(1, 2);
    input.dispatchPrintableBeforeInput('x');
    setSingleLineSelection(3, 4);

    input.dispatchPrintableBeforeInput('y');
    vi.advanceTimersByTime(80);

    expect(value).toBe('abyd');
    expect(position).toEqual({ lineNumber: 1, column: 4 });
  });

  it('keeps consecutive dropped input when the original selection is still active', () => {
    installFallback();

    value = 'abcd';
    setSingleLineSelection(2, 4);

    input.dispatchPrintableBeforeInput('x');
    input.dispatchPrintableBeforeInput('y');
    vi.advanceTimersByTime(80);

    expect(value).toBe('axyd');
    expect(position).toEqual({ lineNumber: 1, column: 4 });
  });

  it('collapses a same-text selection when its native replacement is dropped', () => {
    installFallback();

    value = 'a<d';
    setSingleLineSelection(2, 3);

    input.dispatchPrintableBeforeInput('<');
    vi.advanceTimersByTime(80);

    expect(value).toBe('a<d');
    expect(editor.getSelection()).toEqual({
      startLineNumber: 1,
      startColumn: 3,
      endLineNumber: 1,
      endColumn: 3,
    });
  });

  it('ignores control characters emitted for Ctrl+H instead of replacing the selection', () => {
    installFallback();

    value = 'select abc from table1';
    setSingleLineSelection(8, 11);

    input.dispatchPrintableBeforeInput('\b', true);
    vi.advanceTimersByTime(80);

    expect(value).toBe('select abc from table1');
    expect(editor.trigger).not.toHaveBeenCalled();
    expect(editor.executeEdits).not.toHaveBeenCalled();
  });

  it('ignores printable-looking input that follows a Ctrl shortcut keydown', () => {
    installFallback();

    value = 'select abc from table1';
    setSingleLineSelection(8, 11);

    input.dispatchKeyDown('h', { ctrlKey: true });
    input.dispatchPrintableBeforeInput('h', true);
    vi.advanceTimersByTime(80);

    expect(value).toBe('select abc from table1');
    expect(editor.trigger).not.toHaveBeenCalled();
    expect(editor.executeEdits).not.toHaveBeenCalled();
  });

  it('does not suppress a different printable character after a Ctrl shortcut', () => {
    installFallback();

    value = 'select abc from table1';
    setSingleLineSelection(8, 11);

    input.dispatchKeyDown('h', { ctrlKey: true });
    input.dispatchPrintableBeforeInput('x');
    vi.advanceTimersByTime(80);

    expect(value).toBe('select x from table1');
  });

  it('keeps AltGr input available while filtering ordinary Ctrl shortcuts', () => {
    installFallback();

    value = 'select abc from table1';
    setSingleLineSelection(8, 11);

    input.dispatchKeyDown('q', { ctrlKey: true, altKey: true });
    input.dispatchPrintableBeforeInput('@', true, { ctrlKey: true, altKey: true });
    vi.advanceTimersByTime(80);

    expect(value).toBe('select @ from table1');
    expect(editor.trigger).not.toHaveBeenCalled();
  });

  it('allows normal input again after the shortcut guard expires', () => {
    installFallback();

    value = 'select abc from table1';
    setSingleLineSelection(8, 11);

    input.dispatchKeyDown('h', { ctrlKey: true });
    vi.advanceTimersByTime(251);
    input.dispatchPrintableBeforeInput('x');
    vi.advanceTimersByTime(80);

    expect(value).toBe('select x from table1');
  });

  it('does not replay input while Monaco find or replace widget owns focus', () => {
    installFallback();

    value = 'select abc from table1';
    setSingleLineSelection(8, 11);
    const findReplaceInput = {
      className: 'input',
      closest: vi.fn((selector: string) => (
        selector.includes('.find-widget') || selector.includes('.monaco-inputbox')
          ? { className: 'monaco-inputbox' }
          : null
      )),
    };
    editorDomNode.contains = () => true;
    (document as any).activeElement = findReplaceInput;

    input.dispatchPrintableBeforeInput('test');
    vi.advanceTimersByTime(80);

    expect(value).toBe('select abc from table1');
    expect(editor.trigger).not.toHaveBeenCalled();
    expect(editor.executeEdits).not.toHaveBeenCalled();
  });

  it('does not replay routed input after the SQL textarea has lost focus', () => {
    installFallback();

    value = 'select abc from table1';
    setSingleLineSelection(8, 11);
    input.dispatchFocus('blur');
    (document as any).activeElement = input;

    input.dispatchPrintableBeforeInput('test');
    vi.advanceTimersByTime(80);

    expect(value).toBe('select abc from table1');
    expect(editor.trigger).not.toHaveBeenCalled();
    expect(editor.executeEdits).not.toHaveBeenCalled();
  });

  it('restores printable input recovery after the SQL textarea regains focus', () => {
    installFallback();

    value = 'select abc from table1';
    setSingleLineSelection(8, 11);
    input.dispatchFocus('blur');
    input.dispatchFocus('focus');
    (document as any).activeElement = input;

    input.dispatchPrintableBeforeInput('x');
    vi.advanceTimersByTime(80);

    expect(value).toBe('select x from table1');
  });

  it('does not restore an old caret after a native replacement model event', () => {
    installFallback();

    value = 'abcd';
    setSingleLineSelection(2, 4);
    input.dispatchPrintableBeforeInput('x');

    value = 'axd';
    modelContentListener?.();
    selection = null;
    position = { lineNumber: 1, column: 4 };
    input.dispatchPrintableBeforeInput('y');
    vi.advanceTimersByTime(80);

    expect(value).toBe('axdy');
    expect(position).toEqual({ lineNumber: 1, column: 5 });
  });
});
