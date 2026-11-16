import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useRedisViewerImportExport, type RedisViewerImportExportApi } from './useRedisViewerImportExport';

const backend = vi.hoisted(() => ({
    CancelExportFile: vi.fn(),
    CancelImportJob: vi.fn(),
}));

vi.mock('../../../wailsjs/go/app/App', () => backend);
vi.mock('antd', () => ({
    message: {
        error: vi.fn(),
        info: vi.fn(),
        success: vi.fn(),
        warning: vi.fn(),
    },
}));

const flushEffects = async () => {
    await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
    });
};

describe('useRedisViewerImportExport progress', () => {
    let api: RedisViewerImportExportApi;
    let renderer: ReactTestRenderer;
    let eventHandlers: Map<string, (event: any) => void>;
    let resolveImport: ((value: unknown) => void) | null;
    let resolveExport: ((value: unknown) => void) | null;

    beforeEach(() => {
        vi.clearAllMocks();
        eventHandlers = new Map();
        resolveImport = null;
        resolveExport = null;
        const RedisImportKeys = vi.fn(() => new Promise((resolve) => {
            resolveImport = resolve;
        }));
        const RedisExportKeys = vi.fn(() => new Promise((resolve) => {
            resolveExport = resolve;
        }));

        const runtimeWindow = {
            runtime: {
                EventsOnMultiple: vi.fn((name: string, handler: (event: any) => void) => {
                    eventHandlers.set(name, handler);
                    return vi.fn();
                }),
            },
            go: {
                app: {
                    App: { RedisExportKeys, RedisImportKeys },
                },
            },
        };
        vi.stubGlobal('window', runtimeWindow);
        backend.CancelImportJob.mockResolvedValue({
            success: true,
            message: 'cancel requested',
        });

        const Harness = () => {
            const [importingKeys, setImportingKeys] = React.useState(false);
            api = useRedisViewerImportExport({
                getConfig: () => ({ type: 'redis', host: '127.0.0.1', port: 6379, redisDB: 0 }) as any,
                selectedKeys: [],
                tr: (key: string) => key,
                setExportingScope: vi.fn(),
                searchPattern: '*',
                setImportModalOpen: vi.fn(),
                setImportPreview: vi.fn(),
                setImportSelectedKeys: vi.fn(),
                setImportPreviewLoading: vi.fn(),
                setImportConflictMode: vi.fn(),
                redisDB: 0,
                importPreview: {
                    file: 'redis-keys.json',
                    database: 0,
                    total: 3,
                    keys: [
                        { key: 'a', type: 'string', ttl: -1 },
                        { key: 'b', type: 'string', ttl: -1 },
                        { key: 'c', type: 'string', ttl: -1 },
                    ],
                },
                importSelectedKeys: ['a', 'b', 'c'],
                confirmRedisMutation: vi.fn().mockResolvedValue(true),
                importingKeys,
                setImportingKeys,
                importConflictMode: 'overwrite',
                setSelectedKeys: vi.fn(),
                setSelectedKey: vi.fn(),
                setKeyValue: vi.fn(),
                setListSortOrder: vi.fn(),
                setCursor: vi.fn(),
                loadKeys: vi.fn().mockResolvedValue(undefined),
                redisTopology: 'single',
                searchMode: 'prefix',
                setKeys: vi.fn(),
            });
            return null;
        };

        renderer = create(<Harness />);
    });

    it('filters import progress by job, cancels the backend job, and keeps partial counts', async () => {
        await act(async () => {
            void api.handleConfirmImportKeys();
        });
        await flushEffects();

        const options = (window as any).go.app.App.RedisImportKeys.mock.calls[0][1];
        expect(options.jobId).toEqual(expect.any(String));
        expect(api.importProgress).toEqual(expect.objectContaining({
            current: 0,
            total: 3,
            status: 'running',
        }));

        await act(async () => {
            eventHandlers.get('import:progress')?.({
                jobId: 'other-job',
                current: 3,
                total: 3,
                success: 3,
            });
        });
        expect(api.importProgress?.current).toBe(0);

        await act(async () => {
            eventHandlers.get('import:progress')?.({
                jobId: options.jobId,
                current: 2,
                total: 3,
                success: 1,
                skipped: 1,
                stage: 'Importing Keys',
            });
        });
        expect(api.importProgress).toEqual(expect.objectContaining({
            current: 2,
            total: 3,
            success: 1,
            skipped: 1,
            stage: 'Importing Keys',
            status: 'running',
        }));

        await act(async () => {
            await api.handleCancelImport();
        });
        expect(backend.CancelImportJob).toHaveBeenCalledWith(options.jobId);
        expect(api.importProgress?.status).toBe('cancelling');

        await act(async () => {
            resolveImport?.({
                success: false,
                message: 'Redis import canceled',
                data: { canceled: true, imported: 1, skipped: 2, total: 3 },
            });
        });
        await flushEffects();

        expect(api.importProgress).toEqual(expect.objectContaining({
            current: 3,
            total: 3,
            success: 1,
            skipped: 2,
            status: 'cancelled',
        }));

        renderer.unmount();
    });

    it('renders export progress for the generated job id', async () => {
        await act(async () => {
            void api.handleExportKeys('all');
        });
        await flushEffects();

        const options = (window as any).go.app.App.RedisExportKeys.mock.calls[0][1];
        expect(options.jobId).toEqual(expect.any(String));

        await act(async () => {
            eventHandlers.get('export:progress')?.({
                jobId: options.jobId,
                status: 'running',
                stage: 'Exporting Keys',
                current: 1,
                total: 2,
                totalRowsKnown: true,
            });
        });
        expect(api.exportProgressState).toEqual(expect.objectContaining({
            jobId: options.jobId,
            status: 'running',
            current: 1,
            total: 2,
            totalRowsKnown: true,
        }));

        await act(async () => {
            resolveExport?.({ success: true, data: { exported: 2 } });
        });
        await flushEffects();
        expect(api.exportProgressState.status).toBe('done');

        renderer.unmount();
    });
});
