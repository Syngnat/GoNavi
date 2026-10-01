import { describe, expect, it } from 'vitest';

import {
    createIdleQueryEditorExecutionLifecycle,
    isQueryEditorAwaitingDriver,
    isQueryEditorCancelledRpcError,
    markQueryEditorExecutionStalled,
    queryEditorExecutionStatusI18nKey,
    queryEditorExecutionTimerStatusI18nKey,
    reduceQueryEditorExecutionLifecycle,
    shouldApplyQueryExecutionProgressEvent,
    shouldFinishQueryEditorRunAfterCancelMiss,
    shouldRetainQueryEditorRun,
    shouldRetainQueryEditorRunAfterRpc,
    shouldRetainQueryEditorRunAfterRpcFailure,
    resolveVisibleQueryEditorExecutionLifecycle,
} from './queryEditorExecutionLifecycle';

describe('query editor execution lifecycle', () => {
    it('reduces start, heartbeat, and done events for a DELETE', () => {
        const started = reduceQueryEditorExecutionLifecycle(
            createIdleQueryEditorExecutionLifecycle(),
            { queryId: 'query-1', status: 'running', stage: 'starting', elapsedMs: 12, cancellable: true },
            1_000,
        );
        expect(started).toMatchObject({
            queryId: 'query-1',
            status: 'running',
            backendAlive: true,
            cancellable: true,
        });

        const heartbeating = reduceQueryEditorExecutionLifecycle(
            started,
            { queryId: 'query-1', status: 'running', stage: 'executing', elapsedMs: 1500 },
            2_500,
        );
        expect(heartbeating.stage).toBe('executing');
        expect(heartbeating.lastEventAt).toBe(2_500);

        const done = reduceQueryEditorExecutionLifecycle(
            heartbeating,
            {
                queryId: 'query-1',
                status: 'done',
                stage: 'completed',
                elapsedMs: 8_000,
                hasAffectedRows: true,
                affectedRows: 100000,
            },
            9_000,
        );
        expect(done).toMatchObject({
            status: 'done',
            hasAffectedRows: true,
            affectedRows: 100000,
            backendAlive: false,
        });
        expect(shouldRetainQueryEditorRun(done)).toBe(false);
    });

    it('keeps a live DELETE after a transport failure but not after a local abort', () => {
        const running = reduceQueryEditorExecutionLifecycle(
            createIdleQueryEditorExecutionLifecycle(),
            { queryId: 'query-1', status: 'running', stage: 'executing' },
            1_000,
        );
        expect(shouldRetainQueryEditorRunAfterRpcFailure(new Error('Failed to fetch'), running)).toBe(true);
        expect(shouldRetainQueryEditorRunAfterRpcFailure({
            name: 'AbortError',
            code: 'WEB_RPC_ABORTED',
            dispatchState: 'possibly_dispatched',
            message: 'Web RPC request was aborted',
        }, running)).toBe(true);
        expect(shouldRetainQueryEditorRunAfterRpcFailure({
            name: 'AbortError',
            code: 'WEB_RPC_ABORTED',
            dispatchState: 'not_started',
            message: 'Web RPC request was aborted',
        }, running)).toBe(false);
    });

    it('marks a running query stalled after the heartbeat gap and recovers on the next event', () => {
        const running = reduceQueryEditorExecutionLifecycle(
            createIdleQueryEditorExecutionLifecycle(),
            { queryId: 'query-1', status: 'running', stage: 'executing' },
            1_000,
        );
        const stalled = markQueryEditorExecutionStalled(running, 7_000);
        expect(stalled.status).toBe('stalled');
        expect(shouldRetainQueryEditorRun(stalled)).toBe(true);
        expect(queryEditorExecutionStatusI18nKey(stalled.status)).toBe('query_editor.execution.status.stalled');

        const recovered = reduceQueryEditorExecutionLifecycle(
            stalled,
            { queryId: 'query-1', status: 'running', stage: 'executing', elapsedMs: 7000 },
            7_050,
        );
        expect(recovered.status).toBe('running');
    });

    it('ignores a late heartbeat after the DELETE has already completed', () => {
        const done = reduceQueryEditorExecutionLifecycle(
            createIdleQueryEditorExecutionLifecycle(),
            {
                queryId: 'query-1',
                status: 'done',
                stage: 'completed',
                hasAffectedRows: true,
                affectedRows: 10,
            },
            1_000,
        );
        const late = reduceQueryEditorExecutionLifecycle(
            done,
            { queryId: 'query-1', status: 'running', stage: 'executing', elapsedMs: 1100 },
            1_100,
        );
        expect(late.status).toBe('done');
        expect(late.affectedRows).toBe(10);
    });

    it('treats context canceled RPC errors as cancellation', () => {
        expect(isQueryEditorCancelledRpcError(new Error('context canceled'))).toBe(true);
        expect(isQueryEditorCancelledRpcError(new Error('connection refused'))).toBe(false);
    });

    it('shows a starting lifecycle while the editor is waiting for the first heartbeat', () => {
        const visible = resolveVisibleQueryEditorExecutionLifecycle(true, createIdleQueryEditorExecutionLifecycle());
        expect(visible?.status).toBe('starting');
        expect(visible?.backendAlive).toBe(true);
        expect(resolveVisibleQueryEditorExecutionLifecycle(false, createIdleQueryEditorExecutionLifecycle())).toBeNull();
    });

    it('hides a stale running banner after the SQL RPC has already returned rows', () => {
        const running = reduceQueryEditorExecutionLifecycle(
            createIdleQueryEditorExecutionLifecycle(),
            { queryId: 'query-1', status: 'running', stage: 'executing', cancellable: true },
            1_000,
        );
        expect(resolveVisibleQueryEditorExecutionLifecycle(true, running)?.status).toBe('running');
        expect(resolveVisibleQueryEditorExecutionLifecycle(false, running)).toBeNull();

        const done = reduceQueryEditorExecutionLifecycle(
            running,
            { queryId: 'query-1', status: 'done', stage: 'completed' },
            1_100,
        );
        expect(resolveVisibleQueryEditorExecutionLifecycle(true, done)).toBeNull();
        expect(resolveVisibleQueryEditorExecutionLifecycle(false, done)).toBeNull();
    });

    it('does not keep loading after a successful RPC just because heartbeats are still live', () => {
        const running = reduceQueryEditorExecutionLifecycle(
            createIdleQueryEditorExecutionLifecycle(),
            { queryId: 'query-1', status: 'running', stage: 'executing' },
            1_000,
        );
        expect(shouldRetainQueryEditorRun(running)).toBe(true);
        expect(shouldRetainQueryEditorRunAfterRpc(false, running)).toBe(false);
        expect(shouldRetainQueryEditorRunAfterRpc(true, running)).toBe(true);
    });

    it('clears a stuck editor when stop misses a query that already left the registry', () => {
        expect(shouldFinishQueryEditorRunAfterCancelMiss({ success: false }, true)).toBe(true);
        expect(shouldFinishQueryEditorRunAfterCancelMiss({ success: false }, false)).toBe(false);
        expect(shouldFinishQueryEditorRunAfterCancelMiss({
            success: false,
            cancellationState: 'unsupported',
        }, true)).toBe(false);
        expect(shouldFinishQueryEditorRunAfterCancelMiss({ success: true }, true)).toBe(false);
    });

    it('does not attach another tab\'s progress to an editor that has not started a run', () => {
        expect(shouldApplyQueryExecutionProgressEvent('', 'query-1')).toBe(false);
        expect(shouldApplyQueryExecutionProgressEvent('query-1', 'query-2')).toBe(false);
        expect(shouldApplyQueryExecutionProgressEvent('query-1', 'query-1')).toBe(true);
        const leaked = {
            ...createIdleQueryEditorExecutionLifecycle(),
            queryId: 'query-other',
            status: 'running' as const,
            backendAlive: true,
        };
        expect(queryEditorExecutionTimerStatusI18nKey(false, leaked)).toBe('');
        expect(queryEditorExecutionTimerStatusI18nKey(true, leaked)).toBe('query_editor.execution.status.running');
    });

    it('holds the timer and shows connecting only while the backend reports the starting stage', () => {
        const starting = reduceQueryEditorExecutionLifecycle(
            createIdleQueryEditorExecutionLifecycle(),
            { queryId: 'query-1', status: 'running', stage: 'starting' },
            1_000,
        );
        expect(isQueryEditorAwaitingDriver(starting)).toBe(true);
        expect(queryEditorExecutionTimerStatusI18nKey(true, starting)).toBe('query_editor.execution.status.connecting');

        const executing = reduceQueryEditorExecutionLifecycle(
            starting,
            { queryId: 'query-1', status: 'running', stage: 'executing' },
            2_000,
        );
        expect(isQueryEditorAwaitingDriver(executing)).toBe(false);
        expect(queryEditorExecutionTimerStatusI18nKey(true, executing)).toBe('query_editor.execution.status.running');

        // 没有任何后端事件的执行路径不能被误判为建连中，否则计时会一直停在 0。
        expect(isQueryEditorAwaitingDriver(createIdleQueryEditorExecutionLifecycle())).toBe(false);
        expect(isQueryEditorAwaitingDriver(null)).toBe(false);
    });

    // 原第 12 个用例读 QueryEditor.tsx 源码断言 shouldRetainQueryEditorRunAfterRpc /
    // shouldFinishQueryEditorRunAfterCancelMiss 出现在文本里。该断言不执行任何被测代码，
    // 且其行为语义已由上面的 'does not keep loading after a successful RPC just because
    // heartbeats are still live' 与 'clears a stuck editor when stop misses a query that
    // already left the registry' 两个用例直接覆盖，故按 testPolicy 守卫撤销。
});
