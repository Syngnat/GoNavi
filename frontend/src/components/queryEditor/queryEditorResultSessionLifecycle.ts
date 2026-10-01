import { useEffect, useLayoutEffect, type MutableRefObject } from 'react';

import { useStore } from '../../store';
import {
  saveQueryEditorResultSessionForOpenTab,
  type QueryEditorResultSessionSnapshot,
} from '../../utils/queryEditorResultSessionCache';

type QueryEditorResultSessionRefs = {
  resultSetsRef: MutableRefObject<QueryEditorResultSessionSnapshot['resultSets']>;
  activeResultKeyRef: MutableRefObject<string>;
  isResultPanelVisibleRef: MutableRefObject<boolean>;
  editorRef: MutableRefObject<unknown>;
};

export const readQueryEditorViewState = (
  editor: unknown,
): unknown | undefined => {
  try {
    const saveViewState = (editor as { saveViewState?: unknown } | null)?.saveViewState;
    return typeof saveViewState === 'function' ? saveViewState.call(editor) ?? undefined : undefined;
  } catch {
    return undefined;
  }
};

export const restoreQueryEditorViewState = (
  editor: unknown,
  state: unknown,
): boolean => {
  const restoreViewState = (editor as { restoreViewState?: unknown } | null)?.restoreViewState;
  if (typeof restoreViewState !== 'function' || state === undefined || state === null) return false;
  try {
    restoreViewState.call(editor, state);
    return true;
  } catch {
    return false;
  }
};

const notedViewStates = new Map<string, unknown>();

export const noteQueryEditorViewState = (tabId: string, state: unknown): void => {
  const id = String(tabId || '').trim();
  if (!id || state == null) return;
  notedViewStates.set(id, state);
};

// A hidden tab pane is display:none before it unmounts. Monaco then lays out
// at zero height and reports a top scroll position. That report must not
// replace the position the user actually left.
export const queryEditorCanReportViewState = (editor: unknown): boolean => {
  const getDomNode = (editor as { getDomNode?: unknown } | null)?.getDomNode;
  if (typeof getDomNode !== 'function') return true;
  try {
    const node = getDomNode.call(editor) as { getClientRects?: () => { length: number } } | null;
    if (!node || typeof node.getClientRects !== 'function') return true;
    return node.getClientRects().length > 0;
  } catch {
    return false;
  }
};

const resolveQueryEditorViewState = (
  tabId: string,
  editor: unknown,
  consumeNote: boolean,
): unknown => {
  const id = String(tabId || '').trim();
  const noted = id ? notedViewStates.get(id) : undefined;
  if (consumeNote && id) notedViewStates.delete(id);
  // The note is the last position captured while the editor was still visible.
  // Unmount often runs after the pane is hidden, when Monaco reports the top.
  if (consumeNote && noted != null) return noted;
  const live = queryEditorViewStateIsStable(editor)
    ? readQueryEditorViewState(editor)
    : undefined;
  return live ?? noted;
};

const MIN_STABLE_VIEWPORT_HEIGHT = 40;

export const queryEditorViewportHeight = (editor: unknown): number => {
  const getLayoutInfo = (editor as { getLayoutInfo?: unknown } | null)?.getLayoutInfo;
  if (typeof getLayoutInfo !== 'function') return Number.POSITIVE_INFINITY;
  try {
    const height = Number(getLayoutInfo.call(editor)?.height);
    return Number.isFinite(height) ? height : 0;
  } catch {
    return 0;
  }
};

const queryEditorViewStateIsStable = (editor: unknown): boolean => (
  queryEditorCanReportViewState(editor)
  && queryEditorViewportHeight(editor) >= MIN_STABLE_VIEWPORT_HEIGHT
);

const captureQueryEditorViewState = (tabId: string, editor: unknown): void => {
  if (!queryEditorViewStateIsStable(editor)) return;
  const viewState = readQueryEditorViewState(editor);
  if (viewState == null) return;
  const readScroll = (editor as { getScrollTop?: unknown; getScrollLeft?: unknown }).getScrollTop;
  if (typeof readScroll !== 'function') {
    noteQueryEditorViewState(tabId, viewState);
    return;
  }
  noteQueryEditorViewState(tabId, {
    viewState,
    scrollTop: Number(readScroll.call(editor) || 0),
    scrollLeft: Number(
      typeof (editor as { getScrollLeft?: unknown }).getScrollLeft === 'function'
        ? (editor as { getScrollLeft: () => number }).getScrollLeft()
        : 0,
    ),
  });
};

type RememberedQueryEditorScroll = {
  viewState: unknown;
  scrollTop: number | null;
  scrollLeft: number;
};

const readRememberedQueryEditorScroll = (remembered: unknown): RememberedQueryEditorScroll => {
  if (
    remembered
    && typeof remembered === 'object'
    && 'viewState' in remembered
    && 'scrollTop' in remembered
    && typeof (remembered as { scrollTop?: unknown }).scrollTop === 'number'
  ) {
    const stored = remembered as { viewState: unknown; scrollTop: number; scrollLeft?: unknown };
    return {
      viewState: stored.viewState,
      scrollTop: stored.scrollTop,
      scrollLeft: typeof stored.scrollLeft === 'number' ? stored.scrollLeft : 0,
    };
  }
  return { viewState: remembered, scrollTop: null, scrollLeft: 0 };
};

const applyRememberedQueryEditorScroll = (
  editor: unknown,
  remembered: RememberedQueryEditorScroll,
): void => {
  restoreQueryEditorViewState(editor, remembered.viewState);
  if (remembered.scrollTop == null) return;
  const setScrollTop = (editor as { setScrollTop?: unknown }).setScrollTop;
  const setScrollLeft = (editor as { setScrollLeft?: unknown }).setScrollLeft;
  if (typeof setScrollTop === 'function') {
    setScrollTop.call(editor, remembered.scrollTop);
  }
  if (typeof setScrollLeft === 'function') {
    setScrollLeft.call(editor, remembered.scrollLeft);
  }
};

const HOLD_QUERY_EDITOR_SCROLL_MS = 800;

const peekNotedQueryEditorViewState = (tabId: string): unknown => {
  const id = String(tabId || '').trim();
  return id ? notedViewStates.get(id) : undefined;
};

// Monaco often accepts setScrollTop and then clamps it back to 0 on the next
// layout. Keep applying the saved position until that layout has settled.
export const holdQueryEditorScroll = (
  editor: unknown,
  remembered: unknown,
  now: () => number = Date.now,
): void => {
  const target = readRememberedQueryEditorScroll(remembered);
  if (target.scrollTop == null && target.viewState == null) return;
  const deadline = now() + HOLD_QUERY_EDITOR_SCROLL_MS;
  const apply = () => {
    if (now() > deadline || !queryEditorViewStateIsStable(editor)) return;
    applyRememberedQueryEditorScroll(editor, target);
  };
  apply();
  const onDidLayoutChange = (editor as { onDidLayoutChange?: unknown } | null)?.onDidLayoutChange;
  if (typeof onDidLayoutChange === 'function') {
    onDidLayoutChange.call(editor, apply);
  }
  let frames = 0;
  const pump = () => {
    apply();
    if (now() > deadline || frames >= 48) return;
    frames += 1;
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(pump);
    }
  };
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(pump);
  }
};

// Hidden query tabs are unmounted. Restore once the editor exists, then again
// after layout: the first pass can be clamped while the viewport height is 0.
export const restoreQueryEditorViewStateWhenReady = (
  editor: unknown,
  state: unknown,
  schedule: (callback: () => void) => void = (callback) => {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(callback);
      return;
    }
    callback();
  },
): boolean => {
  if (!restoreQueryEditorViewState(editor, state)) return false;
  schedule(() => {
    restoreQueryEditorViewState(editor, state);
  });
  return true;
};

export const installQueryEditorViewStateMemory = (
  tabId: string,
  editor: unknown,
  remembered: unknown,
): void => {
  holdQueryEditorScroll(editor, remembered);
  const remember = () => {
    const readScroll = (editor as { getScrollTop?: unknown }).getScrollTop;
    if (typeof readScroll === 'function') {
      const nextTop = Number(readScroll.call(editor) || 0);
      const notedTop = readRememberedQueryEditorScroll(peekNotedQueryEditorViewState(tabId)).scrollTop;
      if (notedTop != null && notedTop > 1 && nextTop <= 1) return;
    }
    captureQueryEditorViewState(tabId, editor);
  };
  const onDidScrollChange = (editor as { onDidScrollChange?: unknown } | null)?.onDidScrollChange;
  if (typeof onDidScrollChange === 'function') {
    onDidScrollChange.call(editor, remember);
  }
  const onDidChangeCursorPosition = (editor as { onDidChangeCursorPosition?: unknown } | null)?.onDidChangeCursorPosition;
  if (typeof onDidChangeCursorPosition === 'function') {
    onDidChangeCursorPosition.call(editor, remember);
  }
};

export const useQueryEditorResultSessionLifecycle = ({
  tabId,
  resultSets,
  activeResultKey,
  isResultPanelVisible,
  publishesDetachedResultSession,
  resultSetsRef,
  activeResultKeyRef,
  isResultPanelVisibleRef,
  editorRef,
  isActive = true,
}: QueryEditorResultSessionRefs & {
  tabId: string;
  resultSets: QueryEditorResultSessionSnapshot['resultSets'];
  activeResultKey: string;
  isResultPanelVisible: boolean;
  publishesDetachedResultSession: boolean;
  isActive?: boolean;
}): void => {
  useEffect(() => {
    return useStore.subscribe((state, previous) => {
      if (state.activeTabId === previous.activeTabId) return;
      const editor = editorRef.current as {
        updateOptions?: (options: { automaticLayout: boolean }) => void;
        layout?: () => void;
      } | null;
      if (previous.activeTabId === tabId) {
        editor?.updateOptions?.({ automaticLayout: false });
        captureQueryEditorViewState(tabId, editor);
        return;
      }
      if (state.activeTabId !== tabId || !editor) return;
      const remembered = peekNotedQueryEditorViewState(tabId);
      const restore = () => {
        if (editorRef.current !== editor) return;
        editor.updateOptions?.({ automaticLayout: true });
        editor.layout?.();
        if (remembered != null) holdQueryEditorScroll(editor, remembered);
      };
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => requestAnimationFrame(restore));
        return;
      }
      restore();
    });
  }, [editorRef, tabId]);

  useEffect(() => {
    if (isActive === false) return;
    const remembered = peekNotedQueryEditorViewState(tabId);
    const editor = editorRef.current as { updateOptions?: (options: { automaticLayout: boolean }) => void; layout?: () => void } | null;
    if (!editor || remembered == null) return;
    editor.updateOptions?.({ automaticLayout: true });
    editor.layout?.();
    holdQueryEditorScroll(editor, remembered);
  }, [editorRef, isActive, tabId]);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const captureSession = (event: Event) => {
      const requestedTabId = String((event as CustomEvent).detail?.tabId || '').trim();
      if (requestedTabId !== tabId) return;
      saveQueryEditorResultSessionForOpenTab(tabId, {
        resultSets: resultSetsRef.current,
        activeResultKey: activeResultKeyRef.current,
        isResultPanelVisible: isResultPanelVisibleRef.current,
        editorViewState: resolveQueryEditorViewState(tabId, editorRef.current, false),
      }, useStore.getState().tabs);
    };
    window.addEventListener('gonavi:capture-query-result-session', captureSession);
    return () => window.removeEventListener('gonavi:capture-query-result-session', captureSession);
  }, [activeResultKeyRef, editorRef, isResultPanelVisibleRef, resultSetsRef, tabId]);

  useLayoutEffect(() => () => {
    saveQueryEditorResultSessionForOpenTab(tabId, {
      resultSets: resultSetsRef.current,
      activeResultKey: activeResultKeyRef.current,
      isResultPanelVisible: isResultPanelVisibleRef.current,
      editorViewState: resolveQueryEditorViewState(tabId, editorRef.current, true),
    }, useStore.getState().tabs);
  }, [activeResultKeyRef, editorRef, isResultPanelVisibleRef, resultSetsRef, tabId]);

  useEffect(() => {
    if (!publishesDetachedResultSession) return;
    saveQueryEditorResultSessionForOpenTab(tabId, {
      resultSets,
      activeResultKey,
      isResultPanelVisible,
      editorViewState: resolveQueryEditorViewState(tabId, editorRef.current, false),
    }, useStore.getState().tabs);
  }, [activeResultKey, editorRef, isResultPanelVisible, publishesDetachedResultSession, resultSets, tabId]);
};
