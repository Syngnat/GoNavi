import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { QUERY_PROGRESS_EVENT_NAME } from './queryEditorExecutionLifecycle';
import { useQueryEditorExecutionLifecycle } from './useQueryEditorExecutionLifecycle';

const runtimeApi = vi.hoisted(() => {
    let progressHandler: ((event: unknown) => void) | null = null;
    return {
        EventsOn: vi.fn((eventName: string, handler: (event: unknown) => void) => {
            if (eventName === QUERY_PROGRESS_EVENT_NAME) {
                progressHandler = handler;
            }
            return () => {
                if (progressHandler === handler) {
                    progressHandler = null;
                }
            };
        }),
        emitProgress: (event: unknown) => {
            progressHandler?.(event);
        },
        reset: () => {
            progressHandler = null;
        },
    };
});

vi.mock('../../../wailsjs/runtime/runtime', () => runtimeApi);

describe('useQueryEditorExecutionLifecycle', () => {
    let renderer: ReactTestRenderer | null = null;
    let latest: ReturnType<typeof useQueryEditorExecutionLifecycle> | null = null;
    const onTerminal = vi.fn();

    const Harness = ({ queryId, loading }: { queryId: string; loading: boolean }) => {
        latest = useQueryEditorExecutionLifecycle({ queryId, loading, onTerminal });
        return null;
    };

    beforeEach(() => {
        latest = null;
        renderer = null;
        onTerminal.mockReset();
        runtimeApi.reset();
        runtimeApi.EventsOn.mockClear();
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-17T02:00:00.000Z'));
    });

    afterEach(() => {
        act(() => {
            renderer?.unmount();
        });
        vi.useRealTimers();
    });

    it('tracks matching query progress and notifies when the DELETE completes', () => {
        act(() => {
            renderer = create(<Harness queryId="query-1" loading />);
        });

        act(() => {
            runtimeApi.emitProgress({
                queryId: 'query-other',
                status: 'running',
                stage: 'executing',
            });
            runtimeApi.emitProgress({
                queryId: 'query-1',
                status: 'running',
                stage: 'executing',
                elapsedMs: 1200,
                cancellable: true,
            });
        });
        expect(latest).toMatchObject({
            queryId: 'query-1',
            status: 'running',
            backendAlive: true,
        });

        act(() => {
            runtimeApi.emitProgress({
                queryId: 'query-1',
                status: 'done',
                stage: 'completed',
                hasAffectedRows: true,
                affectedRows: 100000,
            });
        });
        expect(latest).toMatchObject({
            status: 'done',
            affectedRows: 100000,
            hasAffectedRows: true,
        });
        expect(onTerminal).toHaveBeenCalledWith(expect.objectContaining({
            status: 'done',
            affectedRows: 100000,
        }));
    });

    it('ignores progress until this editor owns a query id', () => {
        act(() => {
            renderer = create(<Harness queryId="" loading={false} />);
        });
        act(() => {
            runtimeApi.emitProgress({
                queryId: 'query-1',
                status: 'running',
                stage: 'executing',
            });
        });
        expect(latest).toMatchObject({
            queryId: '',
            status: 'idle',
        });
    });

    it('captures early progress via queryIdRef before React commits the queryId prop', () => {
        const externalQueryIdRef = { current: 'query-early-1' };
        let currentLoading = false;
        const RefHarness = ({ queryId, loading }: { queryId: string; loading: boolean }) => {
            latest = useQueryEditorExecutionLifecycle({
                queryId,
                queryIdRef: externalQueryIdRef,
                loading,
                onTerminal,
            });
            return null;
        };

        act(() => {
            renderer = create(<RefHarness queryId="" loading={currentLoading} />);
        });
        act(() => {
            runtimeApi.emitProgress({
                queryId: 'query-early-1',
                status: 'running',
                stage: 'executing',
                elapsedMs: 25,
            });
        });
        expect(latest).toMatchObject({
            queryId: 'query-early-1',
            status: 'running',
            stage: 'executing',
            elapsedMs: 25,
        });

        // loading 刚翻为 true 时，已属于当前 queryIdRef 的早期事件不能被重置清掉。
        currentLoading = true;
        act(() => {
            renderer?.update(<RefHarness queryId="" loading={currentLoading} />);
        });
        expect(latest).toMatchObject({
            queryId: 'query-early-1',
            status: 'running',
            stage: 'executing',
            elapsedMs: 25,
        });
    });
});
