/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest';
import { bindQueryEditorEditorEvents, type BindQueryEditorEditorEventsInput } from './queryEditorEditorEventBindings';

const fixture = () => {
  const editorDomNode = document.createElement('div');
  const lines = document.createElement('div');
  lines.className = 'view-lines';
  const line = document.createElement('div');
  line.className = 'view-line';
  line.getBoundingClientRect = () => ({ top: 100, height: 20, bottom: 120, left: 0, right: 300, width: 300, x: 0, y: 100, toJSON: () => ({}) });
  lines.append(line);
  const textarea = document.createElement('textarea');
  editorDomNode.append(lines, textarea);
  const otherInput = document.createElement('input');
  document.body.append(otherInput, editorDomNode);
  otherInput.focus();
  const disposers: Array<() => void> = [];
  const editor = {
    addAction: vi.fn(() => ({ dispose: vi.fn() })),
    getModel: () => ({ getLineCount: () => 1, getWordAtPosition: () => ({ startColumn: 1, endColumn: 7 }) }),
    getSelection: () => null,
    getTargetAtClientPoint: (_x: number, y: number) => y >= 100 && y <= 120
      ? { type: 6, position: { lineNumber: 1, column: 4 } } : { type: 0 },
    setPosition: vi.fn(), setSelection: vi.fn(), focus: vi.fn(() => textarea.focus()),
    onDidDispose: (dispose: () => void) => disposers.push(dispose),
  };
  const input = new Proxy<Record<string, unknown>>({
    editor, editorDomNode,
    monaco: { editor: { setTheme: vi.fn() }, Selection: class { constructor(public startLineNumber: number, public startColumn: number, public endLineNumber: number, public endColumn: number) {} } },
    tab: { id: 'test-focus', title: 'Query', type: 'query' },
  }, {
    get: (target, property) => property in target ? Reflect.get(target, property)
      : String(property).endsWith('Ref') ? { current: null } : vi.fn(),
  });
  bindQueryEditorEditorEvents(input as unknown as BindQueryEditorEditorEventsInput);
  return {
    editor, textarea, otherInput,
    dispatch: (type: string, init: MouseEventInit = {}) => {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 40, clientY: 200, button: 0, ...init });
      editorDomNode.dispatchEvent(event);
      return event;
    },
    dispose: () => { disposers.forEach(dispose => dispose()); editorDomNode.remove(); otherInput.remove(); },
  };
};

describe('last-line mouse fallback binding', () => {
  it.each(['mousedown', 'dblclick'])('focuses the editor for a handled %s', type => {
    const context = fixture();
    try {
      const event = context.dispatch(type);
      expect(context.editor.focus).toHaveBeenCalledOnce();
      expect(document.activeElement).toBe(context.textarea);
      expect(event.defaultPrevented).toBe(true);
    } finally { context.dispose(); }
  });

  it('leaves native content hits alone', () => {
    const context = fixture();
    try {
      const event = context.dispatch('mousedown', { clientY: 110 });
      expect(context.editor.focus).not.toHaveBeenCalled();
      expect(context.editor.setPosition).not.toHaveBeenCalled();
      expect(event.defaultPrevented).toBe(false);
    } finally { context.dispose(); }
  });

  it('does not collapse modifier selections with the caret fallback', () => {
    const context = fixture();
    try {
      context.dispatch('mousedown', { shiftKey: true });
      expect(context.editor.setPosition).not.toHaveBeenCalled();
    } finally { context.dispose(); }
  });
});
