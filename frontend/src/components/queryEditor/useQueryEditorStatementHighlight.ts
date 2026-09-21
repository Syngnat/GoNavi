import { useCallback, useEffect, useRef } from 'react';

import { getNormalizedOffsetAtPosition } from './QueryEditorHelpers';
import {
  buildStatementHighlightKey,
  buildStatementOverlayRects,
  buildWrappedStatementPolygon,
  getStatementLineSlices,
  resolveHighlightableStatementRange,
  resolveRunShortcutAction,
  shouldDisarmArmedHighlightOnClick,
  type OverlayRect,
  type RunShortcutAction,
  type StatementHighlightMode,
} from './queryEditorStatementHighlight';
import type { SqlStatementRange } from '../../utils/sqlStatementSelection';
import './queryEditorStatementHighlight.css';

const OVERLAY_CLASS = 'gonavi-query-editor-statement-frame';
const MONACO_ESCAPE_KEY_CODE = 9;

export type StatementHighlightEditor = {
  getDomNode?: () => HTMLElement | null;
  getModel?: () => StatementHighlightModel | null;
  getPosition?: () => { lineNumber: number; column: number } | null;
  getSelection?: () => {
    isEmpty?: () => boolean;
    startLineNumber?: number;
    startColumn?: number;
    endLineNumber?: number;
    endColumn?: number;
  } | null;
  getScrolledVisiblePosition?: (position: { lineNumber: number; column: number }) => {
    left: number;
    top: number;
    height: number;
  } | null;
  onMouseMove?: (listener: (event: { target?: { position?: { lineNumber: number; column: number } | null } }) => void) => { dispose: () => void };
  onDidScrollChange?: (listener: () => void) => { dispose: () => void };
  onDidChangeModelContent?: (listener: () => void) => { dispose: () => void };
  onDidChangeCursorPosition?: (listener: () => void) => { dispose: () => void };
  onKeyDown?: (listener: (event: { keyCode?: number; preventDefault?: () => void }) => void) => { dispose: () => void };
  onMouseDown?: (listener: (event: { target?: { position?: { lineNumber: number; column: number } | null } }) => void) => { dispose: () => void };
};

type StatementHighlightModel = {
  getValue?: () => string;
  getValueInRange?: (range: {
    startLineNumber: number;
    startColumn: number;
    endLineNumber: number;
    endColumn: number;
  }) => string;
};

type UseQueryEditorStatementHighlightArgs = {
  editorRef: { current: StatementHighlightEditor | null };
  enabled: boolean;
  /** When off, the run shortcut highlights and executes in the same press. */
  requireConfirm: boolean;
  isActive: boolean;
  isRunning: boolean;
  isElasticsearchMode: boolean;
  dbType: string;
};

type OverlayRefs = {
  overlay: SVGSVGElement | null;
  armedKey: string | null;
  armedRange: SqlStatementRange | null;
  hoverRange: SqlStatementRange | null;
};

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Test doubles and non-DOM hosts may expose a document without SVG support. */
const createSvgNode = <K extends keyof SVGElementTagNameMap>(tag: K): SVGElementTagNameMap[K] | null => (
  typeof document !== 'undefined' && typeof document.createElementNS === 'function'
    ? document.createElementNS(SVG_NS, tag)
    : null
);

const applyOverlayPolygon = (
  svg: SVGSVGElement,
  rects: OverlayRect[],
  mode: StatementHighlightMode,
) => {
  svg.setAttribute('class', `${OVERLAY_CLASS}${mode === 'armed' ? ' is-armed' : ''}`);
  svg.style.display = 'block';
  let polygon = svg.querySelector('polygon');
  if (!polygon) {
    polygon = createSvgNode('polygon');
    if (!polygon) {
      return;
    }
    svg.appendChild(polygon);
  }
  polygon.setAttribute(
    'points',
    buildWrappedStatementPolygon(rects).map((point) => `${point.x},${point.y}`).join(' '),
  );
};

const hideOverlayNode = (node: SVGSVGElement | null) => {
  if (node) {
    node.style.display = 'none';
  }
};

const readEditorSql = (editor: StatementHighlightEditor | null): string => (
  String(editor?.getModel?.()?.getValue?.() ?? '').replace(/\r\n/g, '\n')
);

const editorHasNonEmptySelection = (editor: StatementHighlightEditor | null): boolean => {
  const selection = editor?.getSelection?.();
  if (!selection || selection.isEmpty?.()) {
    return false;
  }
  const model = editor?.getModel?.();
  if (!model?.getValueInRange) {
    return false;
  }
  return Boolean(model.getValueInRange({
    startLineNumber: Number(selection.startLineNumber || 1),
    startColumn: Number(selection.startColumn || 1),
    endLineNumber: Number(selection.endLineNumber || 1),
    endColumn: Number(selection.endColumn || 1),
  }).trim());
};

const resolveRangeAtPosition = (
  editor: StatementHighlightEditor | null,
  position: { lineNumber: number; column: number } | null,
  dbType: string,
): SqlStatementRange | null => {
  if (!editor || !position) {
    return null;
  }
  const sql = readEditorSql(editor);
  const offset = getNormalizedOffsetAtPosition(sql, position);
  return resolveHighlightableStatementRange(sql, offset, dbType);
};

const ensureOverlayNode = (
  editor: StatementHighlightEditor,
  current: SVGSVGElement | null,
): SVGSVGElement | null => {
  const host = editor.getDomNode?.();
  if (!host) {
    return current;
  }
  if (current && current.parentElement === host) {
    return current;
  }
  current?.remove();
  const node = createSvgNode('svg');
  if (!node) {
    return null;
  }
  node.setAttribute('class', OVERLAY_CLASS);
  node.style.display = 'none';
  host.appendChild(node);
  return node;
};

const paintStatementFrame = (
  editor: StatementHighlightEditor | null,
  refs: OverlayRefs,
  canPaint: boolean,
): SVGSVGElement | null => {
  if (!editor || !canPaint) {
    hideOverlayNode(refs.overlay);
    return refs.overlay;
  }
  const overlay = ensureOverlayNode(editor, refs.overlay);
  if (!overlay) {
    return refs.overlay;
  }
  const range = refs.armedRange || refs.hoverRange;
  if (!range) {
    hideOverlayNode(overlay);
    return overlay;
  }
  const rects = buildStatementOverlayRects(
    getStatementLineSlices(readEditorSql(editor), range),
    (lineNumber, column) => editor.getScrolledVisiblePosition?.({ lineNumber, column }) || null,
  );
  if (rects.length === 0) {
    hideOverlayNode(overlay);
    return overlay;
  }
  applyOverlayPolygon(overlay, rects, refs.armedRange ? 'armed' : 'hover');
  return overlay;
};

const bindStatementHighlightEditor = ({
  editor,
  getDbType,
  getCanInteract,
  getCanPaint,
  refs,
  onOverlay,
  onDisarm,
}: {
  editor: StatementHighlightEditor;
  getDbType: () => string;
  getCanInteract: () => boolean;
  getCanPaint: () => boolean;
  refs: OverlayRefs;
  onOverlay: (overlay: SVGSVGElement | null) => void;
  onDisarm: () => void;
}): Array<{ dispose: () => void }> => {
  const paint = () => onOverlay(paintStatementFrame(editor, refs, getCanPaint()));
  const handleMouseMove = (event: { target?: { position?: { lineNumber: number; column: number } | null } }) => {
    if (!getCanInteract() || refs.armedKey) {
      return;
    }
    refs.hoverRange = resolveRangeAtPosition(editor, event.target?.position || null, getDbType());
    paint();
  };
  const handleContentChange = () => {
    onDisarm();
    refs.hoverRange = null;
    paint();
  };
  const handleEscape = (event: { keyCode?: number; preventDefault?: () => void }) => {
    if (event.keyCode !== MONACO_ESCAPE_KEY_CODE || !refs.armedKey) {
      return;
    }
    onDisarm();
    paint();
    event.preventDefault?.();
  };
  const handleMouseDown = (event: { target?: { position?: { lineNumber: number; column: number } | null } }) => {
    if (!refs.armedRange) {
      return;
    }
    const position = event.target?.position || null;
    const sql = readEditorSql(editor);
    const clickOffset = position ? getNormalizedOffsetAtPosition(sql, position) : null;
    if (!shouldDisarmArmedHighlightOnClick({ armedRange: refs.armedRange, clickOffset })) {
      return;
    }
    onDisarm();
    refs.hoverRange = resolveRangeAtPosition(editor, position, getDbType());
    paint();
  };
  const disposables: Array<{ dispose: () => void }> = [];
  const host = editor.getDomNode?.();
  const handleMouseLeave = () => {
    if (refs.armedKey) {
      return;
    }
    refs.hoverRange = null;
    paint();
  };
  host?.addEventListener('mouseleave', handleMouseLeave);
  if (editor.onMouseMove) disposables.push(editor.onMouseMove(handleMouseMove));
  if (editor.onMouseDown) disposables.push(editor.onMouseDown(handleMouseDown));
  if (editor.onDidScrollChange) disposables.push(editor.onDidScrollChange(paint));
  if (editor.onDidChangeModelContent) disposables.push(editor.onDidChangeModelContent(handleContentChange));
  if (editor.onDidChangeCursorPosition) disposables.push(editor.onDidChangeCursorPosition(handleContentChange));
  if (editor.onKeyDown) disposables.push(editor.onKeyDown(handleEscape));
  disposables.push({ dispose: () => host?.removeEventListener('mouseleave', handleMouseLeave) });
  paint();
  return disposables;
};

export const useQueryEditorStatementHighlight = ({
  editorRef,
  enabled,
  requireConfirm,
  isActive,
  isRunning,
  isElasticsearchMode,
  dbType,
}: UseQueryEditorStatementHighlightArgs) => {
  const overlayRef = useRef<SVGSVGElement | null>(null);
  const armedKeyRef = useRef<string | null>(null);
  const armedRangeRef = useRef<SqlStatementRange | null>(null);
  const hoverRangeRef = useRef<SqlStatementRange | null>(null);
  const wasRunningRef = useRef(false);
  const dbTypeRef = useRef(dbType);
  const isRunningRef = useRef(isRunning);
  dbTypeRef.current = dbType;
  isRunningRef.current = isRunning;
  const featureOn = enabled && isActive && !isElasticsearchMode;
  const canPaint = featureOn && (!isRunning || Boolean(armedRangeRef.current));

  const snapshotRefs = useCallback((): OverlayRefs => ({
    overlay: overlayRef.current,
    armedKey: armedKeyRef.current,
    armedRange: armedRangeRef.current,
    hoverRange: hoverRangeRef.current,
  }), []);

  const clearArmed = useCallback(() => {
    armedKeyRef.current = null;
    armedRangeRef.current = null;
  }, []);

  const clearShortcutRunHighlight = useCallback(() => {
    clearArmed();
    hoverRangeRef.current = null;
    overlayRef.current = paintStatementFrame(editorRef.current, snapshotRefs(), false);
  }, [clearArmed, editorRef, snapshotRefs]);

  const tryArmOrRunFromShortcut = useCallback((): RunShortcutAction => {
    const editor = editorRef.current;
    if (!featureOn) {
      clearArmed();
      return 'run';
    }
    const range = resolveRangeAtPosition(editor, editor?.getPosition?.() || null, dbTypeRef.current);
    const hasSelection = editorHasNonEmptySelection(editor);
    const action = resolveRunShortcutAction({
      enabled: true,
      requireConfirm,
      hasSelection,
      statementKey: range ? buildStatementHighlightKey(range) : null,
      armedKey: armedKeyRef.current,
    });
    // Frame the resolved statement even when it runs right away, so a single
    // press still shows which statement was picked.
    if (range && !hasSelection) {
      armedKeyRef.current = buildStatementHighlightKey(range);
      armedRangeRef.current = range;
      hoverRangeRef.current = null;
      overlayRef.current = paintStatementFrame(editor, snapshotRefs(), true);
      return action;
    }
    clearArmed();
    overlayRef.current = paintStatementFrame(editor, snapshotRefs(), false);
    return 'run';
  }, [clearArmed, editorRef, featureOn, requireConfirm, snapshotRefs]);

  const runFromShortcut = useCallback(async (
    run: () => void | Promise<void>,
  ) => {
    if (tryArmOrRunFromShortcut() === 'arm') {
      return;
    }
    try {
      await run();
    } finally {
      clearShortcutRunHighlight();
    }
  }, [clearShortcutRunHighlight, tryArmOrRunFromShortcut]);

  useEffect(() => {
    const runCompleted = wasRunningRef.current && !isRunning;
    wasRunningRef.current = isRunning;
    if (runCompleted) {
      clearArmed();
    }
    if (!canPaint) {
      hoverRangeRef.current = null;
      clearArmed();
    }
    overlayRef.current = paintStatementFrame(editorRef.current, snapshotRefs(), canPaint);
  }, [canPaint, clearArmed, editorRef, isRunning]);

  useEffect(() => {
    if (!featureOn) {
      overlayRef.current?.remove();
      overlayRef.current = null;
      return undefined;
    }
    let disposed = false;
    let disposables: Array<{ dispose: () => void }> = [];
    let attachTimer: number | null = null;
    const detach = () => {
      disposables.forEach((item) => item.dispose());
      disposables = [];
    };
    const tryAttach = () => {
      const editor = editorRef.current;
      if (disposed || !editor) {
        return false;
      }
      detach();
      disposables = bindStatementHighlightEditor({
        editor,
        getDbType: () => dbTypeRef.current,
        getCanInteract: () => featureOn && !isRunningRef.current,
        getCanPaint: () => featureOn && (!isRunningRef.current || Boolean(armedRangeRef.current)),
        refs: {
          get overlay() { return overlayRef.current; },
          set overlay(value) { overlayRef.current = value; },
          get armedKey() { return armedKeyRef.current; },
          set armedKey(value) { armedKeyRef.current = value; },
          get armedRange() { return armedRangeRef.current; },
          set armedRange(value) { armedRangeRef.current = value; },
          get hoverRange() { return hoverRangeRef.current; },
          set hoverRange(value) { hoverRangeRef.current = value; },
        },
        onOverlay: (overlay) => {
          overlayRef.current = overlay;
        },
        onDisarm: clearArmed,
      });
      return true;
    };
    if (!tryAttach() && typeof window !== 'undefined' && typeof window.setInterval === 'function') {
      attachTimer = window.setInterval(() => {
        if (tryAttach() && attachTimer !== null) {
          window.clearInterval(attachTimer);
          attachTimer = null;
        }
      }, 40);
    }
    return () => {
      disposed = true;
      if (attachTimer !== null) {
        window.clearInterval(attachTimer);
      }
      detach();
      overlayRef.current?.remove();
      overlayRef.current = null;
    };
  }, [canPaint, clearArmed, editorRef, featureOn]);

  return { runFromShortcut, tryArmOrRunFromShortcut };
};
