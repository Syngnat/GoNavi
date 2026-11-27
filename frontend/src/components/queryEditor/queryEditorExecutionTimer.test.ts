import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import {
    formatQueryExecutionElapsed,
    resolveQueryExecutionLifecycleTimerHint,
    resolveReportedQueryDurationMs,
    shouldShowQueryExecutionElapsed,
    useQueryExecutionElapsed,
} from './queryEditorExecutionTimer';
import { createIdleQueryEditorExecutionLifecycle } from './queryEditorExecutionLifecycle';

describe('query editor execution timer', () => {
    it('shows the reported driver duration with the same text the log row uses', () => {
        const durationMs = resolveReportedQueryDurationMs({ durationMs: 228 }, 2_370);
        expect(durationMs).toBe(228);
        expect(formatQueryExecutionElapsed(durationMs)).toBe('228ms');
    });

    it('ticks only during pure SQL execution, pauses while connecting, and freezes before result transfer', () => {
        vi.useFakeTimers();
        vi.setSystemTime(10_000);
        let elapsedMs = -1;
        let showTimer = false;
        let renderer: ReactTestRenderer | null = null;

        const Harness: React.FC<{
            loading: boolean;
            timingActive: boolean;
            runToken: number;
            completedMs?: number | null;
            lifecycle?: ReturnType<typeof createIdleQueryEditorExecutionLifecycle>;
            awaitBackendEvents?: boolean;
        }> = ({
            loading,
            timingActive,
            runToken,
            completedMs = null,
            lifecycle = createIdleQueryEditorExecutionLifecycle(),
            awaitBackendEvents = true,
        }) => {
            const hint = resolveQueryExecutionLifecycleTimerHint(lifecycle);
            elapsedMs = useQueryExecutionElapsed(timingActive && loading, runToken, completedMs, hint);
            showTimer = shouldShowQueryExecutionElapsed({
                loading,
                timingActive,
                completedElapsedMs: completedMs,
                elapsedMs,
                lifecycleHint: hint,
                awaitBackendEvents,
            });
            return null;
        };

        try {
            // 1. 预处理阶段：未进入连接与 SQL 执行，计时器隐藏。
            act(() => {
                renderer = create(React.createElement(Harness, { loading: true, timingActive: false, runToken: 1 }));
            });
            expect(showTimer).toBe(false);
            expect(elapsedMs).toBe(0);

            // 2. 建连阶段（starting）：等待建连期间计时器隐藏且不累加。
            act(() => {
                renderer?.update(
                    React.createElement(Harness, {
                        loading: true,
                        timingActive: true,
                        runToken: 1,
                        lifecycle: {
                            ...createIdleQueryEditorExecutionLifecycle(),
                            queryId: 'query-1',
                            status: 'running',
                            stage: 'starting',
                            elapsedMs: 0,
                            backendAlive: true,
                        },
                    }),
                );
            });
            act(() => {
                vi.advanceTimersByTime(1_200);
            });
            expect(showTimer).toBe(false);
            expect(elapsedMs).toBe(0);

            // 3. 进入真正 SQL 执行阶段（executing）：立即显示并每 100ms 跳动。
            act(() => {
                renderer?.update(
                    React.createElement(Harness, {
                        loading: true,
                        timingActive: true,
                        runToken: 1,
                        lifecycle: {
                            ...createIdleQueryEditorExecutionLifecycle(),
                            queryId: 'query-1',
                            status: 'running',
                            stage: 'executing',
                            elapsedMs: 0,
                            backendAlive: true,
                        },
                    }),
                );
            });
            expect(showTimer).toBe(true);
            act(() => {
                vi.advanceTimersByTime(350);
            });
            expect(elapsedMs).toBe(300);

            // 4. 缓存连接重建（再次回到 starting）：暂停在已执行耗时，等待期间不涨。
            act(() => {
                renderer?.update(
                    React.createElement(Harness, {
                        loading: true,
                        timingActive: true,
                        runToken: 1,
                        lifecycle: {
                            ...createIdleQueryEditorExecutionLifecycle(),
                            queryId: 'query-1',
                            status: 'running',
                            stage: 'starting',
                            elapsedMs: 350,
                            backendAlive: true,
                        },
                    }),
                );
            });
            expect(showTimer).toBe(false);
            act(() => {
                vi.advanceTimersByTime(1_000);
            });
            expect(elapsedMs).toBe(350);

            // 5. 重连完成后恢复 executing：从 350ms 继续累加。
            act(() => {
                renderer?.update(
                    React.createElement(Harness, {
                        loading: true,
                        timingActive: true,
                        runToken: 1,
                        lifecycle: {
                            ...createIdleQueryEditorExecutionLifecycle(),
                            queryId: 'query-1',
                            status: 'running',
                            stage: 'executing',
                            elapsedMs: 350,
                            backendAlive: true,
                        },
                    }),
                );
            });
            expect(showTimer).toBe(true);
            act(() => {
                vi.advanceTimersByTime(200);
            });
            expect(elapsedMs).toBe(550);

            // 6. 后端 SQL 执行完毕但结果集仍在编码/IPC 传输（loading=true, timingActive=true）：立即定格在纯 SQL 耗时。
            act(() => {
                renderer?.update(
                    React.createElement(Harness, {
                        loading: true,
                        timingActive: true,
                        runToken: 1,
                        lifecycle: {
                            ...createIdleQueryEditorExecutionLifecycle(),
                            queryId: 'query-1',
                            status: 'done',
                            stage: 'completed',
                            elapsedMs: 562,
                            durationMs: 562,
                            hasDurationMs: true,
                            backendAlive: false,
                        },
                    }),
                );
            });
            expect(showTimer).toBe(true);
            expect(elapsedMs).toBe(562);
            act(() => {
                vi.advanceTimersByTime(3_000);
            });
            expect(elapsedMs).toBe(562);

            // 7. 前端接收与渲染完成（loading=false）：数值与传输定格值完全一致，无跳变。
            act(() => {
                renderer?.update(
                    React.createElement(Harness, {
                        loading: false,
                        timingActive: false,
                        runToken: 1,
                        completedMs: 562,
                        lifecycle: {
                            ...createIdleQueryEditorExecutionLifecycle(),
                            queryId: 'query-1',
                            status: 'done',
                            stage: 'completed',
                            elapsedMs: 562,
                            durationMs: 562,
                            hasDurationMs: true,
                            backendAlive: false,
                        },
                    }),
                );
            });
            expect(showTimer).toBe(true);
            expect(elapsedMs).toBe(562);

            // 8. 无后端进度事件路径（如 ES 控制台）：执行中立即显示本地计时。
            act(() => {
                renderer?.update(
                    React.createElement(Harness, {
                        loading: true,
                        timingActive: true,
                        runToken: 2,
                        awaitBackendEvents: false,
                    }),
                );
            });
            expect(showTimer).toBe(true);
            act(() => {
                vi.advanceTimersByTime(250);
            });
            expect(elapsedMs).toBe(200);

            // 9. 建连阶段直接失败（无 SQL 执行耗时）：loading 期间不显示虚假的 0ms。
            act(() => {
                renderer?.update(
                    React.createElement(Harness, {
                        loading: true,
                        timingActive: true,
                        runToken: 3,
                        lifecycle: {
                            ...createIdleQueryEditorExecutionLifecycle(),
                            queryId: 'query-3',
                            status: 'error',
                            stage: 'failed',
                            elapsedMs: 0,
                            durationMs: null,
                            hasDurationMs: false,
                            backendAlive: false,
                        },
                    }),
                );
            });
            expect(showTimer).toBe(false);
        } finally {
            act(() => {
                renderer?.unmount();
            });
            vi.useRealTimers();
        }
    });
});
