type ClipboardReadText = () => string | Promise<string>;

interface ClipboardLike {
  readText: ClipboardReadText;
}

interface WailsClipboardRuntimeLike {
  ClipboardGetText?: ClipboardReadText;
}

interface WailsWindowLike {
  runtime?: WailsClipboardRuntimeLike;
}

export interface MonacoClipboardScope {
  navigator?: {
    clipboard?: ClipboardLike;
  };
  window?: WailsWindowLike;
}

export interface MonacoClipboardReadFailure {
  source: 'wails' | 'browser';
  error: unknown;
}

// A fresh token lets mounted editors replace stale Monaco actions after a Vite/Wails HMR update.
export const MONACO_CLIPBOARD_HANDLER_REVISION = Symbol('gonavi-monaco-clipboard-handler');

interface DisposableLike {
  dispose: () => void;
}

interface MonacoClipboardDomEventLike {
  target?: {
    closest?: (selector: string) => unknown;
  } | null;
  composedPath?: () => unknown[];
}

interface MonacoClipboardEventTargetLike {
  addEventListener?: (
    type: string,
    listener: (event?: unknown) => void,
    useCapture?: boolean,
  ) => void;
  removeEventListener?: (
    type: string,
    listener: (event?: unknown) => void,
    useCapture?: boolean,
  ) => void;
}

interface MonacoClipboardDomNodeLike extends MonacoClipboardEventTargetLike {
  ownerDocument?: MonacoClipboardEventTargetLike;
}

interface MonacoClipboardEditorLike {
  getDomNode?: () => MonacoClipboardDomNodeLike | null;
  getOption?: (option: any) => unknown;
  getRawOptions?: () => { readOnly?: boolean };
  hasModel?: () => boolean;
  onDidDispose?: (listener: () => void) => DisposableLike;
  trigger?: (source: string, handlerId: string, payload: unknown) => void;
}

interface MonacoEditorApiLike {
  EditorOption?: {
    emptySelectionClipboard?: unknown;
  };
}

export interface MonacoClipboardApiLike {
  editor?: MonacoEditorApiLike;
}

interface MonacoClipboardMetadata {
  isFromEmptySelection?: boolean;
  multicursorText?: string[] | null;
  mode?: unknown;
}

interface MonacoClipboardMetadataManagerLike {
  get: (text: string) => MonacoClipboardMetadata | null;
}

export interface MonacoClipboardPasteActionLike {
  addImplementation?: (
    priority: number,
    name: string,
    implementation: () => boolean | Promise<void>,
  ) => DisposableLike;
}

export interface MonacoClipboardInternals {
  metadataManager: MonacoClipboardMetadataManagerLike;
  pasteAction?: MonacoClipboardPasteActionLike;
}

const MONACO_PASTE_IMPLEMENTATION_PRIORITY = 10001;
const CONTEXT_MENU_OWNERSHIP_MS = 15_000;
const CONTEXT_MENU_OWNER_KEY = Symbol.for('gonavi.monacoClipboard.contextMenuOwner');
const INTERACTION_REVISION_KEY = Symbol.for('gonavi.monacoClipboard.interactionRevision');
const noop = () => {};

interface MonacoClipboardContextMenuOwner {
  editor: MonacoClipboardEditorLike;
  requestedAt: number;
  interactionRevision: number;
}

interface MonacoClipboardGlobalScope {
  [key: symbol]: unknown;
}

const getContextMenuOwnerScope = (): MonacoClipboardGlobalScope => (
  globalThis as unknown as MonacoClipboardGlobalScope
);

const getContextMenuOwner = (): MonacoClipboardContextMenuOwner | undefined => {
  const ownerScope = getContextMenuOwnerScope();
  const owner = ownerScope[CONTEXT_MENU_OWNER_KEY] as MonacoClipboardContextMenuOwner | undefined;
  if (owner && Date.now() - owner.requestedAt > CONTEXT_MENU_OWNERSHIP_MS) {
    delete ownerScope[CONTEXT_MENU_OWNER_KEY];
    return undefined;
  }
  return owner;
};

const getInteractionRevision = (): number => {
  const revision = getContextMenuOwnerScope()[INTERACTION_REVISION_KEY];
  return typeof revision === 'number' ? revision : 0;
};

const bumpInteractionRevision = (): number => {
  const ownerScope = getContextMenuOwnerScope();
  const revision = getInteractionRevision() + 1;
  ownerScope[INTERACTION_REVISION_KEY] = revision;
  return revision;
};

const setContextMenuOwner = (editor: MonacoClipboardEditorLike): void => {
  getContextMenuOwnerScope()[CONTEXT_MENU_OWNER_KEY] = {
    editor,
    requestedAt: Date.now(),
    interactionRevision: bumpInteractionRevision(),
  };
};

const clearContextMenuOwner = (editor?: MonacoClipboardEditorLike): void => {
  const ownerScope = getContextMenuOwnerScope();
  const owner = ownerScope[CONTEXT_MENU_OWNER_KEY] as MonacoClipboardContextMenuOwner | undefined;
  if (!editor || owner?.editor === editor) {
    delete ownerScope[CONTEXT_MENU_OWNER_KEY];
  }
};

let monacoClipboardInternalsPromise: Promise<MonacoClipboardInternals | null> | null = null;

const getBrowserClipboardReader = (scope: MonacoClipboardScope): ClipboardReadText | undefined => {
  try {
    const clipboard = scope.navigator?.clipboard;
    return typeof clipboard?.readText === 'function' ? clipboard.readText.bind(clipboard) : undefined;
  } catch {
    return undefined;
  }
};

const getClipboardReaders = (scope: MonacoClipboardScope): {
  primaryReadText?: ClipboardReadText;
  fallbackReadText?: ClipboardReadText;
  source: 'wails' | 'browser';
} => {
  const wailsReadText = scope.window?.runtime?.ClipboardGetText;
  const browserReadText = getBrowserClipboardReader(scope);
  if (typeof wailsReadText === 'function') {
    return {
      primaryReadText: wailsReadText.bind(scope.window?.runtime),
      fallbackReadText: browserReadText,
      source: 'wails',
    };
  }
  return {
    primaryReadText: browserReadText,
    source: 'browser',
  };
};

const loadMonacoClipboardInternals = (): Promise<MonacoClipboardInternals | null> => {
  if (!monacoClipboardInternalsPromise) {
    monacoClipboardInternalsPromise = Promise.all([
      import('monaco-editor/esm/vs/editor/contrib/clipboard/browser/clipboard.js'),
      import('monaco-editor/esm/vs/editor/browser/controller/editContext/clipboardUtils.js'),
    ]).then(([clipboardModule, clipboardUtilsModule]) => {
      // Monaco 0.55.1 ships these symbols without public declarations. The main editor bundle
      // imports both modules, so these are the same instances used by Monaco's default action.
      const pasteAction = (clipboardModule as unknown as {
        PasteAction?: MonacoClipboardPasteActionLike;
      }).PasteAction;
      const metadataManager = (clipboardUtilsModule as unknown as {
        InMemoryClipboardMetadataManager?: { INSTANCE?: MonacoClipboardMetadataManagerLike };
      }).InMemoryClipboardMetadataManager?.INSTANCE;

      return metadataManager ? { pasteAction, metadataManager } : null;
    }).catch(() => null);
  }

  return monacoClipboardInternalsPromise;
};

const createPastePayload = (
  monaco: MonacoClipboardApiLike,
  editor: MonacoClipboardEditorLike,
  text: string,
  metadataManager: MonacoClipboardMetadataManagerLike,
) => {
  // This is Monaco's own text-keyed fallback for data that cannot carry custom clipboard MIME types.
  const metadata = metadataManager.get(text);
  const emptySelectionClipboard = monaco.editor?.EditorOption?.emptySelectionClipboard;
  const pasteOnNewLine = emptySelectionClipboard !== undefined
    && editor.getOption?.(emptySelectionClipboard) === true
    && metadata?.isFromEmptySelection === true;

  return {
    text,
    pasteOnNewLine,
    // Wails only exposes text. Never reconstruct multicursorText from arbitrary line breaks.
    multicursorText: metadata && typeof metadata.multicursorText !== 'undefined'
      ? metadata.multicursorText
      : null,
    mode: metadata?.mode ?? null,
  };
};

const installPasteImplementation = (
  monaco: MonacoClipboardApiLike,
  editor: MonacoClipboardEditorLike,
  scope: MonacoClipboardScope,
  internals: MonacoClipboardInternals,
  onReadFailure?: (failure: MonacoClipboardReadFailure) => void,
): (() => void) => {
  const pasteAction = internals.pasteAction;
  if (!pasteAction?.addImplementation) {
    return noop;
  }

  let released = false;
  const editorDomNode = editor.getDomNode?.();
  const handleContextMenu = () => {
    setContextMenuOwner(editor);
  };
  const handleEditorInteraction = (event?: unknown) => {
    const domEvent = event as MonacoClipboardDomEventLike | undefined;
    const eventPath = domEvent?.composedPath?.() ?? [];
    const isMonacoMenuInteraction = [domEvent?.target, ...eventPath].some((node) => {
      const target = node as MonacoClipboardDomEventLike['target'];
      return Boolean(target?.closest?.('.monaco-menu-container'));
    });
    if (isMonacoMenuInteraction) {
      return;
    }
    bumpInteractionRevision();
    clearContextMenuOwner();
  };
  const interactionEventTarget = editorDomNode?.ownerDocument ?? editorDomNode;
  editorDomNode?.addEventListener?.('contextmenu', handleContextMenu);
  interactionEventTarget?.addEventListener?.('keydown', handleEditorInteraction, true);
  interactionEventTarget?.addEventListener?.('pointerdown', handleEditorInteraction, true);
  const implementationDisposable = pasteAction.addImplementation(
    MONACO_PASTE_IMPLEMENTATION_PRIORITY,
    'gonavi-wails-sql-editor',
    () => {
      const contextMenuOwner = getContextMenuOwner();
      const ownsContextMenu = contextMenuOwner?.editor === editor;
      if (
        !ownsContextMenu
        || editor.hasModel?.() === false
        || editor.getRawOptions?.().readOnly === true
        || typeof editor.trigger !== 'function'
      ) {
        // Keyboard paste and other editors must keep Monaco's native implementation.
        return false;
      }

      clearContextMenuOwner(editor);
      const { primaryReadText, fallbackReadText, source } = getClipboardReaders(scope);
      if (!primaryReadText) {
        return false;
      }
      const requestRevision = contextMenuOwner.interactionRevision;

      return (async () => {
        let text: string;
        try {
          text = await readClipboardTextWithFallback(primaryReadText, fallbackReadText);
        } catch (error) {
          onReadFailure?.({ source, error });
          return;
        }
        if (
          released
          || requestRevision !== getInteractionRevision()
          || !text
          || editor.hasModel?.() === false
          || editor.getRawOptions?.().readOnly === true
          || typeof editor.trigger !== 'function'
        ) {
          return;
        }

        editor.trigger('keyboard', 'paste', createPastePayload(monaco, editor, text, internals.metadataManager));
      })();
    },
  );

  let editorDisposeDisposable: DisposableLike | undefined;
  const release = () => {
    if (released) return;
    released = true;
    clearContextMenuOwner(editor);
    implementationDisposable.dispose();
    editorDomNode?.removeEventListener?.('contextmenu', handleContextMenu);
    interactionEventTarget?.removeEventListener?.('keydown', handleEditorInteraction, true);
    interactionEventTarget?.removeEventListener?.('pointerdown', handleEditorInteraction, true);
    editorDisposeDisposable?.dispose();
  };
  editorDisposeDisposable = editor.onDidDispose?.(release);

  return release;
};

export const readClipboardTextWithFallback = async (
  primaryReadText: ClipboardReadText,
  fallbackReadText?: ClipboardReadText,
): Promise<string> => {
  try {
    return String(await primaryReadText() ?? '');
  } catch (primaryError) {
    if (!fallbackReadText) {
      throw primaryError;
    }
    return String(await fallbackReadText() ?? '');
  }
};

export const installWailsMonacoClipboardPasteHandler = (
  monaco: MonacoClipboardApiLike,
  editor: MonacoClipboardEditorLike,
  scope: MonacoClipboardScope = globalThis as unknown as MonacoClipboardScope,
  internals?: MonacoClipboardInternals,
  onReadFailure?: (failure: MonacoClipboardReadFailure) => void,
): (() => void) => {
  if (internals) {
    return installPasteImplementation(monaco, editor, scope, internals, onReadFailure);
  }

  let released = false;
  let installedCleanup = noop;
  void loadMonacoClipboardInternals().then((loadedInternals) => {
    if (!released && loadedInternals) {
      installedCleanup = installPasteImplementation(monaco, editor, scope, loadedInternals, onReadFailure);
    }
  });

  return () => {
    if (released) return;
    released = true;
    installedCleanup();
  };
};
