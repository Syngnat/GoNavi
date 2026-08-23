import { describe, expect, it, vi } from 'vitest';

import {
  installWailsMonacoClipboardPasteHandler,
  readClipboardTextWithFallback,
  type MonacoClipboardInternals,
} from './monacoClipboard';

type PasteImplementation = () => boolean | Promise<void>;

const createPasteAction = () => {
  const implementations: Array<{ priority: number; implementation: PasteImplementation }> = [];

  return {
    addImplementation: vi.fn((priority: number, _name: string, implementation: PasteImplementation) => {
      const entry = { priority, implementation };
      implementations.push(entry);
      implementations.sort((left, right) => right.priority - left.priority);
      return {
        dispose: () => {
          const index = implementations.indexOf(entry);
          if (index >= 0) {
            implementations.splice(index, 1);
          }
        },
      };
    }),
    get implementations() {
      return implementations.map((entry) => entry.implementation);
    },
  };
};

const createInternals = (
  pasteAction: ReturnType<typeof createPasteAction>,
  metadataByText = new Map<string, {
    isFromEmptySelection?: boolean;
    multicursorText?: string[] | null;
    mode?: unknown;
  }>(),
): MonacoClipboardInternals => ({
  pasteAction,
  metadataManager: {
    get: vi.fn((text: string) => metadataByText.get(text) ?? null),
  },
});

const createEditorDomNode = () => {
  const listeners = new Map<string, (event?: unknown) => void>();
  return {
    addEventListener: vi.fn((type: string, listener: (event?: unknown) => void) => {
      listeners.set(type, listener);
    }),
    removeEventListener: vi.fn((type: string, listener: (event?: unknown) => void) => {
      if (listeners.get(type) === listener) listeners.delete(type);
    }),
    dispatch: (type: string, event?: unknown) => listeners.get(type)?.(event),
  };
};

const createEditor = (overrides: Record<string, unknown> = {}) => {
  const domNode = createEditorDomNode();
  return {
    getDomNode: vi.fn(() => domNode),
    getOption: vi.fn(() => true),
    getRawOptions: vi.fn(() => ({ readOnly: false })),
    hasModel: vi.fn(() => true),
    hasTextFocus: vi.fn(() => false),
    hasWidgetFocus: vi.fn(() => false),
    onDidDispose: vi.fn(() => ({ dispose: vi.fn() })),
    trigger: vi.fn(),
    dispatchDomEvent: domNode.dispatch,
    ...overrides,
  };
};

const wailsScope = (readText = vi.fn().mockResolvedValue('native text')) => ({
  window: {
    runtime: { ClipboardGetText: readText },
  },
});

const runPasteAction = async (implementations: PasteImplementation[]) => {
  for (const implementation of implementations) {
    const result = implementation();
    if (result !== false) {
      await result;
      return;
    }
  }
};

describe('Monaco clipboard fallback', () => {
  it('uses the primary clipboard reader when it can read text', async () => {
    const primaryReadText = vi.fn().mockResolvedValue('native text');
    const fallbackReadText = vi.fn().mockResolvedValue('browser text');

    await expect(readClipboardTextWithFallback(primaryReadText, fallbackReadText))
      .resolves.toBe('native text');
    expect(fallbackReadText).not.toHaveBeenCalled();
  });

  it('falls back when the primary clipboard reader rejects the read', async () => {
    const primaryReadText = vi.fn().mockRejectedValue(new Error('native clipboard unavailable'));
    const fallbackReadText = vi.fn().mockResolvedValue('SELECT * FROM users;');

    await expect(readClipboardTextWithFallback(primaryReadText, fallbackReadText))
      .resolves.toBe('SELECT * FROM users;');
  });

  it('leaves Ctrl+V to Monaco when no context-menu paste was requested', async () => {
    const pasteAction = createPasteAction();
    const readText = vi.fn().mockResolvedValue('custom clipboard text');
    const editor = createEditor({ hasTextFocus: vi.fn(() => true) });
    const nativePaste = vi.fn(() => true);
    const release = installWailsMonacoClipboardPasteHandler(
      { editor: { EditorOption: { emptySelectionClipboard: 45 } } },
      editor,
      wailsScope(readText),
      createInternals(pasteAction),
    );

    await runPasteAction([...pasteAction.implementations, nativePaste]);

    expect(nativePaste).toHaveBeenCalledTimes(1);
    expect(readText).not.toHaveBeenCalled();
    expect(editor.trigger).not.toHaveBeenCalled();
    release();
  });

  it('clears a stale context-menu owner before Ctrl+V reaches Monaco', async () => {
    const pasteAction = createPasteAction();
    const editorDomNode = createEditorDomNode();
    const readText = vi.fn().mockResolvedValue('custom clipboard text');
    const editor = createEditor({
      getDomNode: vi.fn(() => editorDomNode),
      hasTextFocus: vi.fn(() => true),
    });
    const nativePaste = vi.fn(() => true);
    const release = installWailsMonacoClipboardPasteHandler(
      { editor: { EditorOption: { emptySelectionClipboard: 45 } } },
      editor,
      wailsScope(readText),
      createInternals(pasteAction),
    );

    editorDomNode.dispatch('contextmenu');
    editorDomNode.dispatch('keydown');
    await runPasteAction([...pasteAction.implementations, nativePaste]);

    expect(nativePaste).toHaveBeenCalledTimes(1);
    expect(readText).not.toHaveBeenCalled();
    expect(editor.trigger).not.toHaveBeenCalled();
    release();
  });

  it('only handles context-menu paste for the registered SQL editor', async () => {
    const pasteAction = createPasteAction();
    const internals = createInternals(pasteAction);
    const sqlEditor = createEditor({ hasTextFocus: vi.fn(() => true) });
    const nonSqlEditor = createEditor({ hasTextFocus: vi.fn(() => true) });
    const scope = wailsScope();

    const releaseSql = installWailsMonacoClipboardPasteHandler(
      { editor: { EditorOption: { emptySelectionClipboard: 45 } } },
      sqlEditor,
      scope,
      internals,
    );

    expect(pasteAction.addImplementation).toHaveBeenCalledTimes(1);
    sqlEditor.dispatchDomEvent('contextmenu');
    await runPasteAction(pasteAction.implementations);
    expect(scope.window.runtime.ClipboardGetText).toHaveBeenCalledTimes(1);
    expect(sqlEditor.trigger).toHaveBeenCalledWith('keyboard', 'paste', {
      text: 'native text',
      pasteOnNewLine: false,
      multicursorText: null,
      mode: null,
    });
    expect(nonSqlEditor.trigger).not.toHaveBeenCalled();

    releaseSql();
  });

  it('handles context-menu paste while the SQL editor retains widget focus', async () => {
    const pasteAction = createPasteAction();
    const internals = createInternals(pasteAction);
    const editor = createEditor({ hasWidgetFocus: vi.fn(() => true) });
    const scope = wailsScope();

    const release = installWailsMonacoClipboardPasteHandler(
      { editor: { EditorOption: { emptySelectionClipboard: 45 } } },
      editor,
      scope,
      internals,
    );

    editor.dispatchDomEvent('contextmenu');
    await runPasteAction(pasteAction.implementations);

    expect(scope.window.runtime.ClipboardGetText).toHaveBeenCalledTimes(1);
    expect(editor.trigger).toHaveBeenCalledWith(
      'keyboard',
      'paste',
      expect.objectContaining({ text: 'native text' }),
    );
    release();
  });

  it('routes context-menu paste to its editor after the menu takes focus', async () => {
    const pasteAction = createPasteAction();
    const editorDomNode = createEditorDomNode();
    const editor = createEditor({ getDomNode: vi.fn(() => editorDomNode) });
    const scope = wailsScope();

    const release = installWailsMonacoClipboardPasteHandler(
      { editor: { EditorOption: { emptySelectionClipboard: 45 } } },
      editor,
      scope,
      createInternals(pasteAction),
    );

    editorDomNode.dispatch('contextmenu');
    await runPasteAction(pasteAction.implementations);

    expect(scope.window.runtime.ClipboardGetText).toHaveBeenCalledTimes(1);
    expect(editor.trigger).toHaveBeenCalledWith(
      'keyboard',
      'paste',
      expect.objectContaining({ text: 'native text' }),
    );

    release();
    expect(editorDomNode.removeEventListener).toHaveBeenCalledWith('contextmenu', expect.any(Function));
  });

  it('keeps context-menu ownership while clicking Monaco menu items', async () => {
    const pasteAction = createPasteAction();
    const editor = createEditor();
    const scope = wailsScope();
    const release = installWailsMonacoClipboardPasteHandler(
      { editor: { EditorOption: { emptySelectionClipboard: 45 } } },
      editor,
      scope,
      createInternals(pasteAction),
    );

    editor.dispatchDomEvent('contextmenu');
    editor.dispatchDomEvent('pointerdown', {
      target: {
        closest: vi.fn(() => null),
      },
      composedPath: vi.fn(() => [{
        closest: vi.fn((selector: string) => (
          selector === '.monaco-menu-container' ? {} : null
        )),
      }]),
    });
    await runPasteAction(pasteAction.implementations);

    expect(scope.window.runtime.ClipboardGetText).toHaveBeenCalledTimes(1);
    expect(editor.trigger).toHaveBeenCalledWith(
      'keyboard',
      'paste',
      expect.objectContaining({ text: 'native text' }),
    );
    release();
  });

  it('routes context-menu paste only to the most recently requested editor', async () => {
    const pasteAction = createPasteAction();
    const internals = createInternals(pasteAction);
    const firstEditorDomNode = createEditorDomNode();
    const secondEditorDomNode = createEditorDomNode();
    const firstEditor = createEditor({ getDomNode: vi.fn(() => firstEditorDomNode) });
    const secondEditor = createEditor({ getDomNode: vi.fn(() => secondEditorDomNode) });
    const firstScope = wailsScope(vi.fn().mockResolvedValue('first editor text'));
    const secondScope = wailsScope(vi.fn().mockResolvedValue('second editor text'));
    const monaco = { editor: { EditorOption: { emptySelectionClipboard: 45 } } };

    const releaseFirst = installWailsMonacoClipboardPasteHandler(monaco, firstEditor, firstScope, internals);
    const releaseSecond = installWailsMonacoClipboardPasteHandler(monaco, secondEditor, secondScope, internals);

    firstEditorDomNode.dispatch('contextmenu');
    secondEditorDomNode.dispatch('contextmenu');
    await runPasteAction(pasteAction.implementations);

    releaseFirst();
    releaseSecond();
    expect(firstScope.window.runtime.ClipboardGetText).not.toHaveBeenCalled();
    expect(firstEditor.trigger).not.toHaveBeenCalled();
    expect(secondScope.window.runtime.ClipboardGetText).toHaveBeenCalledTimes(1);
    expect(secondEditor.trigger).toHaveBeenCalledWith(
      'keyboard',
      'paste',
      expect.objectContaining({ text: 'second editor text' }),
    );
  });

  it('leaves Ctrl+V in another SQL editor to Monaco after a context menu is cancelled', async () => {
    const pasteAction = createPasteAction();
    const internals = createInternals(pasteAction);
    const firstEditor = createEditor();
    const secondEditor = createEditor();
    const firstReadText = vi.fn().mockResolvedValue('stale editor text');
    const secondReadText = vi.fn().mockResolvedValue('second editor text');
    const nativePaste = vi.fn(() => true);
    const monaco = { editor: { EditorOption: { emptySelectionClipboard: 45 } } };

    const releaseFirst = installWailsMonacoClipboardPasteHandler(
      monaco,
      firstEditor,
      wailsScope(firstReadText),
      internals,
    );
    const releaseSecond = installWailsMonacoClipboardPasteHandler(
      monaco,
      secondEditor,
      wailsScope(secondReadText),
      internals,
    );

    firstEditor.dispatchDomEvent('contextmenu');
    secondEditor.dispatchDomEvent('keydown');
    await runPasteAction([...pasteAction.implementations, nativePaste]);

    expect(nativePaste).toHaveBeenCalledTimes(1);
    expect(firstReadText).not.toHaveBeenCalled();
    expect(secondReadText).not.toHaveBeenCalled();
    expect(firstEditor.trigger).not.toHaveBeenCalled();
    expect(secondEditor.trigger).not.toHaveBeenCalled();
    releaseFirst();
    releaseSecond();
  });

  it('leaves Ctrl+V outside the SQL editor to Monaco after a context menu is cancelled', async () => {
    const pasteAction = createPasteAction();
    const internals = createInternals(pasteAction);
    const documentNode = createEditorDomNode();
    const editorDomNode = {
      ...createEditorDomNode(),
      ownerDocument: documentNode,
    };
    const editor = createEditor({
      getDomNode: vi.fn(() => editorDomNode),
    });
    const scope = wailsScope();
    const defaultPaste = vi.fn(() => true);
    pasteAction.addImplementation(10000, 'monaco-default-paste', defaultPaste);

    const release = installWailsMonacoClipboardPasteHandler(
      { editor: { EditorOption: { emptySelectionClipboard: 45 } } },
      editor,
      scope,
      internals,
    );

    editorDomNode.dispatch('contextmenu');
    documentNode.dispatch('keydown');
    await runPasteAction(pasteAction.implementations);

    expect(defaultPaste).toHaveBeenCalledTimes(1);
    expect(scope.window.runtime.ClipboardGetText).not.toHaveBeenCalled();
    expect(editor.trigger).not.toHaveBeenCalled();
    release();
  });

  it('does not finish an async context-menu paste after another SQL editor is activated', async () => {
    const pasteAction = createPasteAction();
    const internals = createInternals(pasteAction);
    let resolveRead: ((text: string) => void) | undefined;
    const firstEditor = createEditor();
    const secondEditor = createEditor();
    const firstReadText = vi.fn(() => new Promise<string>((resolve) => {
      resolveRead = resolve;
    }));
    const monaco = { editor: { EditorOption: { emptySelectionClipboard: 45 } } };

    const releaseFirst = installWailsMonacoClipboardPasteHandler(
      monaco,
      firstEditor,
      wailsScope(firstReadText),
      internals,
    );
    const releaseSecond = installWailsMonacoClipboardPasteHandler(
      monaco,
      secondEditor,
      wailsScope(),
      internals,
    );

    firstEditor.dispatchDomEvent('contextmenu');
    const pastePromise = runPasteAction(pasteAction.implementations);
    secondEditor.dispatchDomEvent('pointerdown');
    resolveRead?.('stale editor text');
    await pastePromise;

    expect(firstReadText).toHaveBeenCalledTimes(1);
    expect(firstEditor.trigger).not.toHaveBeenCalled();
    expect(secondEditor.trigger).not.toHaveBeenCalled();
    releaseFirst();
    releaseSecond();
  });

  it('invokes Monaco trigger with the editor as its receiver', async () => {
    const pasteAction = createPasteAction();
    const internals = createInternals(pasteAction);
    const editor = createEditor({ hasWidgetFocus: vi.fn(() => true) });
    editor.trigger = vi.fn(function (this: unknown) {
      if (this !== editor) {
        throw new Error('trigger called without editor receiver');
      }
    });

    const release = installWailsMonacoClipboardPasteHandler(
      { editor: { EditorOption: { emptySelectionClipboard: 45 } } },
      editor,
      wailsScope(),
      internals,
    );

    editor.dispatchDomEvent('contextmenu');
    await runPasteAction(pasteAction.implementations);

    expect(editor.trigger).toHaveBeenCalledTimes(1);
    release();
  });

  it('does not paste after keyboard input interrupts an async context-menu read', async () => {
    const pasteAction = createPasteAction();
    const internals = createInternals(pasteAction);
    let resolveRead: ((text: string) => void) | undefined;
    const editor = createEditor();
    const scope = wailsScope(vi.fn(() => new Promise<string>((resolve) => {
      resolveRead = resolve;
    })));

    const release = installWailsMonacoClipboardPasteHandler(
      { editor: { EditorOption: { emptySelectionClipboard: 45 } } },
      editor,
      scope,
      internals,
    );

    editor.dispatchDomEvent('contextmenu');
    const pastePromise = runPasteAction(pasteAction.implementations);
    editor.dispatchDomEvent('keydown');
    resolveRead?.('stale text');
    await pastePromise;

    expect(scope.window.runtime.ClipboardGetText).toHaveBeenCalledTimes(1);
    expect(editor.trigger).not.toHaveBeenCalled();
    release();
  });

  it('leaves the global paste action to Monaco when only a non-SQL editor is focused', async () => {
    const pasteAction = createPasteAction();
    const internals = createInternals(pasteAction);
    const sqlEditor = createEditor({ hasTextFocus: vi.fn(() => false) });
    const scope = wailsScope();
    const defaultPaste = vi.fn(() => true);
    pasteAction.addImplementation(10000, 'monaco-default-paste', defaultPaste);

    const release = installWailsMonacoClipboardPasteHandler(
      { editor: { EditorOption: { emptySelectionClipboard: 45 } } },
      sqlEditor,
      scope,
      internals,
    );

    await runPasteAction(pasteAction.implementations);
    expect(defaultPaste).toHaveBeenCalledTimes(1);
    expect(scope.window.runtime.ClipboardGetText).not.toHaveBeenCalled();
    expect(sqlEditor.trigger).not.toHaveBeenCalled();
    release();
  });

  it('routes context-menu paste to its requesting editor and cleans each editor independently', async () => {
    const pasteAction = createPasteAction();
    const internals = createInternals(pasteAction);
    const firstEditor = createEditor();
    const secondEditor = createEditor();
    const scope = wailsScope(vi.fn().mockResolvedValue('native text'));
    const monaco = { editor: { EditorOption: { emptySelectionClipboard: 45 } } };

    const releaseFirst = installWailsMonacoClipboardPasteHandler(monaco, firstEditor, scope, internals);
    const releaseSecond = installWailsMonacoClipboardPasteHandler(monaco, secondEditor, scope, internals);

    firstEditor.dispatchDomEvent('contextmenu');
    await runPasteAction(pasteAction.implementations);
    expect(firstEditor.trigger).toHaveBeenCalledTimes(1);
    expect(secondEditor.trigger).not.toHaveBeenCalled();

    secondEditor.dispatchDomEvent('contextmenu');
    await runPasteAction(pasteAction.implementations);
    expect(firstEditor.trigger).toHaveBeenCalledTimes(1);
    expect(secondEditor.trigger).toHaveBeenCalledTimes(1);

    releaseSecond();
    expect(pasteAction.implementations).toHaveLength(1);
    expect(pasteAction.implementations[0]()).toBe(false);

    releaseFirst();
    expect(pasteAction.implementations).toHaveLength(0);
  });

  it('automatically unregisters a disposed SQL editor', () => {
    const pasteAction = createPasteAction();
    const internals = createInternals(pasteAction);
    let onDispose: (() => void) | undefined;
    const editor = createEditor({
      onDidDispose: vi.fn((listener: () => void) => {
        onDispose = listener;
        return { dispose: vi.fn() };
      }),
    });

    installWailsMonacoClipboardPasteHandler(
      { editor: { EditorOption: { emptySelectionClipboard: 45 } } },
      editor,
      wailsScope(),
      internals,
    );

    expect(pasteAction.implementations).toHaveLength(1);
    onDispose?.();
    expect(pasteAction.implementations).toHaveLength(0);
  });

  it('does not paste after the SQL editor is released during an async clipboard read', async () => {
    const pasteAction = createPasteAction();
    const internals = createInternals(pasteAction);
    const editor = createEditor({ hasTextFocus: vi.fn(() => true) });
    let resolveRead: ((text: string) => void) | undefined;
    const wailsReadText = vi.fn(() => new Promise<string>((resolve) => {
      resolveRead = resolve;
    }));

    const release = installWailsMonacoClipboardPasteHandler(
      { editor: { EditorOption: { emptySelectionClipboard: 45 } } },
      editor,
      wailsScope(wailsReadText),
      internals,
    );

    editor.dispatchDomEvent('contextmenu');
    const pastePromise = runPasteAction(pasteAction.implementations);
    release();
    resolveRead?.('late text');
    await pastePromise;

    expect(editor.trigger).not.toHaveBeenCalled();
    expect(pasteAction.implementations).toHaveLength(0);
  });

  it('reuses Monaco metadata for matching multi-cursor and whole-line copies only', async () => {
    const pasteAction = createPasteAction();
    const metadata = new Map([
      ['first value\nsecond value', {
        isFromEmptySelection: false,
        multicursorText: ['first value', 'second value'],
        mode: null,
      }],
      ['whole line\n', {
        isFromEmptySelection: true,
        multicursorText: null,
        mode: null,
      }],
    ]);
    const internals = createInternals(pasteAction, metadata);
    const editor = createEditor({ hasTextFocus: vi.fn(() => true) });
    const wailsReadText = vi.fn()
      .mockResolvedValueOnce('first value\nsecond value')
      .mockResolvedValueOnce('whole line\n')
      .mockResolvedValueOnce('foreign text');

    const release = installWailsMonacoClipboardPasteHandler(
      { editor: { EditorOption: { emptySelectionClipboard: 45 } } },
      editor,
      wailsScope(wailsReadText),
      internals,
    );

    editor.dispatchDomEvent('contextmenu');
    await runPasteAction(pasteAction.implementations);
    expect(editor.trigger).toHaveBeenLastCalledWith('keyboard', 'paste', {
      text: 'first value\nsecond value',
      pasteOnNewLine: false,
      multicursorText: ['first value', 'second value'],
      mode: null,
    });

    editor.dispatchDomEvent('contextmenu');
    await runPasteAction(pasteAction.implementations);
    expect(editor.trigger).toHaveBeenLastCalledWith('keyboard', 'paste', {
      text: 'whole line\n',
      pasteOnNewLine: true,
      multicursorText: null,
      mode: null,
    });

    editor.dispatchDomEvent('contextmenu');
    await runPasteAction(pasteAction.implementations);
    expect(editor.trigger).toHaveBeenLastCalledWith('keyboard', 'paste', {
      text: 'foreign text',
      pasteOnNewLine: false,
      multicursorText: null,
      mode: null,
    });
    expect(internals.metadataManager.get).toHaveBeenCalledWith('foreign text');

    release();
  });

  it('uses the browser reader if the Wails clipboard is temporarily unavailable', async () => {
    const pasteAction = createPasteAction();
    const internals = createInternals(pasteAction);
    const browserReadText = vi.fn().mockResolvedValue('browser text');
    const wailsReadText = vi.fn().mockRejectedValue(new Error('native clipboard unavailable'));
    const editor = createEditor({ hasTextFocus: vi.fn(() => true) });

    const release = installWailsMonacoClipboardPasteHandler(
      { editor: { EditorOption: { emptySelectionClipboard: 45 } } },
      editor,
      {
        navigator: { clipboard: { readText: browserReadText } },
        ...wailsScope(wailsReadText),
      },
      internals,
    );

    editor.dispatchDomEvent('contextmenu');
    await runPasteAction(pasteAction.implementations);
    expect(wailsReadText).toHaveBeenCalledTimes(1);
    expect(browserReadText).toHaveBeenCalledTimes(1);
    expect(editor.trigger).toHaveBeenCalledWith('keyboard', 'paste', expect.objectContaining({ text: 'browser text' }));
    release();
  });

  it('registers for the generated Wails runtime shape without a legacy WailsInvoke global', async () => {
    const pasteAction = createPasteAction();
    const readText = vi.fn().mockResolvedValue('bridge text');
    const editor = createEditor({ hasTextFocus: vi.fn(() => true) });
    const release = installWailsMonacoClipboardPasteHandler(
      { editor: { EditorOption: { emptySelectionClipboard: 45 } } },
      editor,
      {
        navigator: { clipboard: { readText: vi.fn().mockResolvedValue('browser text') } },
        window: { runtime: { ClipboardGetText: readText } },
      },
      createInternals(pasteAction),
    );

    expect(pasteAction.addImplementation).toHaveBeenCalledTimes(1);
    editor.dispatchDomEvent('contextmenu');
    await runPasteAction(pasteAction.implementations);
    expect(readText).toHaveBeenCalledTimes(1);
    expect(editor.trigger).toHaveBeenCalledWith(
      'keyboard',
      'paste',
      expect.objectContaining({ text: 'bridge text' }),
    );
    release();
  });

  it('keeps the Monaco paste action in a plain browser runtime', async () => {
    const pasteAction = createPasteAction();
    const browserReadText = vi.fn().mockResolvedValue('browser text');
    const editor = createEditor({ hasTextFocus: vi.fn(() => true) });
    const release = installWailsMonacoClipboardPasteHandler(
      { editor: { EditorOption: { emptySelectionClipboard: 45 } } },
      editor,
      {
        navigator: { clipboard: { readText: browserReadText } },
        window: {},
      },
      createInternals(pasteAction),
    );

    expect(pasteAction.addImplementation).toHaveBeenCalledTimes(1);
    editor.dispatchDomEvent('contextmenu');
    await runPasteAction(pasteAction.implementations);
    expect(browserReadText).toHaveBeenCalledTimes(1);
    expect(editor.trigger).toHaveBeenCalledWith(
      'keyboard',
      'paste',
      expect.objectContaining({ text: 'browser text' }),
    );
    release();
  });

  it('falls through when no clipboard reader is available at invocation time', () => {
    const pasteAction = createPasteAction();
    const editor = createEditor({ hasTextFocus: vi.fn(() => true) });
    const release = installWailsMonacoClipboardPasteHandler(
      { editor: { EditorOption: { emptySelectionClipboard: 45 } } },
      editor,
      { window: {} },
      createInternals(pasteAction),
    );

    expect(pasteAction.addImplementation).toHaveBeenCalledTimes(1);
    editor.dispatchDomEvent('contextmenu');
    expect(pasteAction.implementations[0]()).toBe(false);
    expect(editor.trigger).not.toHaveBeenCalled();
    release();
  });

  it('resolves a Wails clipboard reader injected after editor mount', async () => {
    const pasteAction = createPasteAction();
    const editor = createEditor({ hasTextFocus: vi.fn(() => true) });
    const scope: any = { window: { runtime: {} } };
    const readText = vi.fn().mockResolvedValue('late bridge text');

    const release = installWailsMonacoClipboardPasteHandler(
      { editor: { EditorOption: { emptySelectionClipboard: 45 } } },
      editor,
      scope,
      createInternals(pasteAction),
    );
    scope.window.runtime.ClipboardGetText = readText;

    editor.dispatchDomEvent('contextmenu');
    await runPasteAction(pasteAction.implementations);

    expect(readText).toHaveBeenCalledTimes(1);
    expect(editor.trigger).toHaveBeenCalledWith(
      'keyboard',
      'paste',
      expect.objectContaining({ text: 'late bridge text' }),
    );
    release();
  });

  it('reports browser clipboard permission failures instead of swallowing them', async () => {
    const pasteAction = createPasteAction();
    const error = new DOMException('Read permission denied', 'NotAllowedError');
    const onReadFailure = vi.fn();
    const editor = createEditor({ hasTextFocus: vi.fn(() => true) });

    const release = installWailsMonacoClipboardPasteHandler(
      { editor: { EditorOption: { emptySelectionClipboard: 45 } } },
      editor,
      {
        navigator: { clipboard: { readText: vi.fn().mockRejectedValue(error) } },
        window: {},
      },
      createInternals(pasteAction),
      onReadFailure,
    );

    editor.dispatchDomEvent('contextmenu');
    await runPasteAction(pasteAction.implementations);

    expect(onReadFailure).toHaveBeenCalledWith({ source: 'browser', error });
    expect(editor.trigger).not.toHaveBeenCalled();
    release();
  });

  it('does not read or paste into a read-only SQL editor', () => {
    const pasteAction = createPasteAction();
    const internals = createInternals(pasteAction);
    const editor = createEditor({
      getRawOptions: vi.fn(() => ({ readOnly: true })),
      hasTextFocus: vi.fn(() => true),
    });
    const scope = wailsScope();

    const release = installWailsMonacoClipboardPasteHandler(
      { editor: { EditorOption: { emptySelectionClipboard: 45 } } },
      editor,
      scope,
      internals,
    );

    editor.dispatchDomEvent('contextmenu');
    expect(pasteAction.implementations[0]()).toBe(false);
    expect(scope.window.runtime.ClipboardGetText).not.toHaveBeenCalled();
    expect(editor.trigger).not.toHaveBeenCalled();
    release();
  });
});
