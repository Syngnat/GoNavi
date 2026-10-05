import React, { useCallback, useEffect } from 'react';
import {
    clampQueryEditorEditorHeight,
    resolveQueryEditorEditorHeightFromRatio,
    setQueryEditorTabSplitRatio,
    resolveQueryEditorEditorHeightRatio,
} from '../../../utils/queryEditorSplitLayout';
import type { QueryEditorCoreStateApi } from './useQueryEditorCoreState';
import type { QueryEditorConnectionContextApi } from './useQueryEditorConnectionContext';
import type { QueryEditorShortcutsAndSnippetsApi } from './useQueryEditorShortcutsAndSnippets';
import type { QueryEditorProps } from '../../QueryEditor';

export interface UseQueryEditorEditorSplitInput {
    currentQueryIdRef: QueryEditorCoreStateApi['currentQueryIdRef'];
    setCurrentQueryId: QueryEditorCoreStateApi['setCurrentQueryId'];
    queryEditorRootRef: QueryEditorCoreStateApi['queryEditorRootRef'];
    editorPaneRef: QueryEditorCoreStateApi['editorPaneRef'];
    editorStageRef: QueryEditorCoreStateApi['editorStageRef'];
    editorShellRef: QueryEditorCoreStateApi['editorShellRef'];
    dragRef: QueryEditorCoreStateApi['dragRef'];
    queryEditorEditorHeightRatio: QueryEditorConnectionContextApi['queryEditorEditorHeightRatio'];
    pendingEditorHeightRef: QueryEditorCoreStateApi['pendingEditorHeightRef'];
    setEditorHeight: QueryEditorCoreStateApi['setEditorHeight'];
    isActive: Exclude<QueryEditorProps['isActive'], undefined>;
    tab: QueryEditorProps['tab'];
    editorFullscreen: QueryEditorShortcutsAndSnippetsApi['editorFullscreen'];
    isResultPanelVisible: QueryEditorConnectionContextApi['isResultPanelVisible'];
    editorRef: QueryEditorCoreStateApi['editorRef'];
    resizeFrameRef: QueryEditorCoreStateApi['resizeFrameRef'];
    editorHeight: QueryEditorCoreStateApi['editorHeight'];
}

export const useQueryEditorEditorSplit = ({
    currentQueryIdRef, setCurrentQueryId, queryEditorRootRef, editorPaneRef, editorStageRef,
    editorShellRef, dragRef, queryEditorEditorHeightRatio, pendingEditorHeightRef, setEditorHeight,
    isActive, tab, editorFullscreen, isResultPanelVisible, editorRef, resizeFrameRef, editorHeight,
}: UseQueryEditorEditorSplitInput) => {
    // Query ID management helpers
    const setQueryId = (id: string) => {
        currentQueryIdRef.current = id;
        setCurrentQueryId(id);
    };

    const clearQueryId = () => {
        currentQueryIdRef.current = '';
        setCurrentQueryId('');
    };

    const resolveEditorSplitAvailableHeight = useCallback(() => {
        const rootRect = queryEditorRootRef.current?.getBoundingClientRect?.();
        const paneRect = editorPaneRef.current?.getBoundingClientRect?.();
        const editorContainerRect = (editorStageRef.current || editorShellRef.current)?.getBoundingClientRect?.();
        const rootHeight = Number(rootRect?.height || 0);
        const paneHeight = Number(paneRect?.height || 0);
        const editorContainerHeight = Number(editorContainerRect?.height || 0);
        if (!Number.isFinite(rootHeight) || rootHeight <= 0) {
            return 0;
        }
        const nonEditorPaneHeight = paneHeight > 0 && editorContainerHeight > 0
            ? Math.max(0, paneHeight - editorContainerHeight)
            : 0;
        const availableHeight = rootHeight - nonEditorPaneHeight;
        return Number.isFinite(availableHeight) && availableHeight > 0 ? availableHeight : 0;
    }, []);

    const clampEditorHeight = useCallback((height: number) => {
        const availableHeight = resolveEditorSplitAvailableHeight();
        if (availableHeight > 0) {
            return clampQueryEditorEditorHeight(height, availableHeight);
        }
        const viewportHeight = Number.isFinite(window.innerHeight) ? window.innerHeight : 800;
        const maxHeight = Math.max(100, viewportHeight - 200);
        return Math.max(100, Math.min(maxHeight, height));
    }, [resolveEditorSplitAvailableHeight]);

    const applyEditorHeightRatio = useCallback(() => {
        const availableHeight = resolveEditorSplitAvailableHeight();
        if (availableHeight <= 0 || dragRef.current) return;
        const nextHeight = resolveQueryEditorEditorHeightFromRatio(
            queryEditorEditorHeightRatio,
            availableHeight,
        );
        pendingEditorHeightRef.current = nextHeight;
        setEditorHeight(previousHeight => previousHeight === nextHeight ? previousHeight : nextHeight);
    }, [queryEditorEditorHeightRatio, resolveEditorSplitAvailableHeight]);

    useEffect(() => {
        if (editorFullscreen.active || !isResultPanelVisible || !isActive) return;
        let frame: number | null = null;
        const requestFrame = typeof window.requestAnimationFrame === 'function'
            ? window.requestAnimationFrame.bind(window)
            : (callback: FrameRequestCallback) => window.setTimeout(() => callback(Date.now()), 16);
        const cancelFrame = typeof window.cancelAnimationFrame === 'function'
            ? window.cancelAnimationFrame.bind(window)
            : window.clearTimeout.bind(window);
        const scheduleApply = () => {
            if (frame !== null) return;
            frame = requestFrame(() => {
                frame = null;
                applyEditorHeightRatio();
            });
        };

        scheduleApply();
        const ResizeObserverCtor = typeof ResizeObserver === 'function' ? ResizeObserver : null;
        const resizeObserver = ResizeObserverCtor ? new ResizeObserverCtor(scheduleApply) : null;
        if (resizeObserver) {
            if (queryEditorRootRef.current) resizeObserver.observe(queryEditorRootRef.current);
            if (editorPaneRef.current) resizeObserver.observe(editorPaneRef.current);
        }
        window.addEventListener('resize', scheduleApply);
        return () => {
            if (frame !== null) {
                cancelFrame(frame);
                frame = null;
            }
            resizeObserver?.disconnect();
            window.removeEventListener('resize', scheduleApply);
        };
    }, [applyEditorHeightRatio, editorFullscreen.active, isActive, isResultPanelVisible, tab.id]);

    const applyEditorHeightToDom = useCallback(() => {
        const nextHeight = pendingEditorHeightRef.current;
        const editorContainer = editorStageRef.current || editorShellRef.current;
        if (editorContainer) {
            editorContainer.style.height = `${nextHeight}px`;
        }
        editorRef.current?.layout?.();
    }, []);

    const cancelEditorResizeFrame = useCallback(() => {
        if (resizeFrameRef.current === null) return;
        if (typeof window.cancelAnimationFrame === 'function') {
            window.cancelAnimationFrame(resizeFrameRef.current);
        } else {
            window.clearTimeout(resizeFrameRef.current);
        }
        resizeFrameRef.current = null;
    }, []);

    const scheduleEditorHeightDomUpdate = useCallback((height: number) => {
        pendingEditorHeightRef.current = height;
        if (resizeFrameRef.current !== null) return;

        const requestFrame = typeof window.requestAnimationFrame === 'function'
            ? window.requestAnimationFrame.bind(window)
            : (callback: FrameRequestCallback) => window.setTimeout(() => callback(Date.now()), 16);

        resizeFrameRef.current = requestFrame(() => {
            resizeFrameRef.current = null;
            applyEditorHeightToDom();
        });
    }, [applyEditorHeightToDom]);

    // Handle Resizing
    const handleMouseMove = useCallback((e: MouseEvent) => {
        if (!dragRef.current) return;
        const delta = e.clientY - dragRef.current.startY;
        const newHeight = clampEditorHeight(dragRef.current.startHeight + delta);
        dragRef.current.currentHeight = newHeight;
        scheduleEditorHeightDomUpdate(newHeight);
    }, [clampEditorHeight, scheduleEditorHeightDomUpdate]);

    const handleMouseUp = useCallback(() => {
        const finalHeight = dragRef.current?.currentHeight;
        dragRef.current = null;
        cancelEditorResizeFrame();
        if (typeof finalHeight === 'number') {
            pendingEditorHeightRef.current = finalHeight;
            applyEditorHeightToDom();
            setEditorHeight(finalHeight);
            const availableHeight = resolveEditorSplitAvailableHeight();
            if (availableHeight > 0) {
                setQueryEditorTabSplitRatio(tab.id, resolveQueryEditorEditorHeightRatio(
                    finalHeight,
                    availableHeight,
                ));
            }
        }
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
    }, [applyEditorHeightToDom, cancelEditorResizeFrame, handleMouseMove, resolveEditorSplitAvailableHeight, tab.id]);

    const handleMouseDown = useCallback((e: React.MouseEvent) => {
        e.preventDefault();
        const currentEditorHeight = Number((editorStageRef.current || editorShellRef.current)?.getBoundingClientRect?.().height || editorHeight);
        const startHeight = Number.isFinite(currentEditorHeight) && currentEditorHeight > 0 ? currentEditorHeight : editorHeight;
        dragRef.current = { startY: e.clientY, startHeight, currentHeight: startHeight };
        pendingEditorHeightRef.current = startHeight;
        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', handleMouseUp);
    }, [editorHeight, handleMouseMove, handleMouseUp]);

    const abortEditorSplitDrag = useCallback(() => {
        dragRef.current = null;
        cancelEditorResizeFrame();
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
    }, [cancelEditorResizeFrame, handleMouseMove, handleMouseUp]);

    useEffect(() => () => abortEditorSplitDrag(), [abortEditorSplitDrag]);

    // 进入全屏时中止拖拽：监听在 document 上，残留 mousemove 会写内联 height 并在 mouseup 改写进入前比例。
    useEffect(() => {
        if (editorFullscreen.active) abortEditorSplitDrag();
    }, [abortEditorSplitDrag, editorFullscreen.active]);
    return { setQueryId, clearQueryId, handleMouseDown };
};

export type QueryEditorEditorSplitApi = ReturnType<typeof useQueryEditorEditorSplit>;
