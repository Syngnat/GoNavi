import { useCallback, useEffect, useRef, useState } from 'react';

import { EventsOn } from '../../../wailsjs/runtime/runtime';
import {
    QUERY_EXECUTION_STALL_MS,
    QUERY_PROGRESS_EVENT_NAME,
    createIdleQueryEditorExecutionLifecycle,
    markQueryEditorExecutionStalled,
    reduceQueryEditorExecutionLifecycle,
    shouldApplyQueryExecutionProgressEvent,
    type QueryEditorExecutionLifecycleState,
    type QueryExecutionProgressEvent,
} from './queryEditorExecutionLifecycle';

type UseQueryEditorExecutionLifecycleOptions = {
    queryId: string;
    queryIdRef?: { current: string };
    loading: boolean;
    onTerminal?: (state: QueryEditorExecutionLifecycleState) => void;
};

export const useQueryEditorExecutionLifecycle = ({
    queryId,
    queryIdRef: externalQueryIdRef,
    loading,
    onTerminal,
}: UseQueryEditorExecutionLifecycleOptions): QueryEditorExecutionLifecycleState => {
    const [state, setState] = useState<QueryEditorExecutionLifecycleState>(
        createIdleQueryEditorExecutionLifecycle,
    );
    const stateRef = useRef(state);
    stateRef.current = state;
    const queryIdRef = useRef(queryId);
    queryIdRef.current = queryId;
    const externalQueryIdRefHolder = useRef(externalQueryIdRef);
    externalQueryIdRefHolder.current = externalQueryIdRef;
    const onTerminalRef = useRef(onTerminal);
    onTerminalRef.current = onTerminal;

    const wasLoadingRef = useRef(false);

    useEffect(() => {
        if (loading && !wasLoadingRef.current) {
            const activeQueryId = String(externalQueryIdRefHolder.current?.current || queryIdRef.current || '').trim();
            if (stateRef.current.queryId === '' || stateRef.current.queryId !== activeQueryId) {
                const idle = createIdleQueryEditorExecutionLifecycle();
                stateRef.current = idle;
                setState(idle);
            }
        }
        wasLoadingRef.current = loading;
    }, [loading]);

    useEffect(() => {
        let unsubscribe: (() => void) | undefined;
        try {
            unsubscribe = EventsOn(QUERY_PROGRESS_EVENT_NAME, (payload: unknown) => {
                const now = Date.now();
                const event = payload as QueryExecutionProgressEvent;
                const ownedQueryId = externalQueryIdRefHolder.current?.current || queryIdRef.current;
                if (!shouldApplyQueryExecutionProgressEvent(ownedQueryId, event?.queryId)) {
                    return;
                }
                const next = reduceQueryEditorExecutionLifecycle(stateRef.current, payload, now);
                stateRef.current = next;
                setState(next);
                if (next.status === 'done' || next.status === 'cancelled' || next.status === 'error') {
                    onTerminalRef.current?.(next);
                }
            });
        } catch {
            return undefined;
        }
        return () => {
            unsubscribe?.();
        };
    }, []);

    const refreshStall = useCallback(() => {
        const next = markQueryEditorExecutionStalled(stateRef.current, Date.now(), QUERY_EXECUTION_STALL_MS);
        if (next === stateRef.current) {
            return;
        }
        stateRef.current = next;
        setState(next);
    }, []);

    useEffect(() => {
        if (!loading) {
            return;
        }
        const timer = globalThis.setInterval(refreshStall, 1000);
        return () => globalThis.clearInterval(timer);
    }, [loading, refreshStall]);

    return state;
};
