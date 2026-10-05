import { isPerfDataGridHarness } from '../devHarnessMode';
import { createBrowserMockAiServiceMethods } from './browserMockAiServiceMethods';
import { createBrowserMockAppMethods } from './browserMockAppMethods';
import { createBrowserMockConnectionStore } from './browserMockConnectionStore';
import { createBrowserMockMcp } from './browserMockMcp';
import { createBrowserMockAgentRuntime } from './browserMockAgentRuntime';

export const installBrowserMockRuntime = () => {
    const existingRuntime = (window as any).runtime || {};
    const existingEnvironment = existingRuntime.Environment;
    const existingEventsOnMultiple = existingRuntime.EventsOnMultiple;
    const existingEventsEmit = existingRuntime.EventsEmit;
    const localRuntimeEventListeners = new Map<string, Set<(...args: any[]) => void>>();
    const emitLocalRuntimeEvent = (eventName: string, ...args: any[]) => {
        for (const listener of [...(localRuntimeEventListeners.get(eventName) || [])]) {
            listener(...args);
        }
    };
    const subscribeLocalRuntimeEvent = (
        eventName: string,
        callback: (...args: any[]) => void,
        maxCallbacks: number,
    ) => {
        let remaining = maxCallbacks;
        const listener = (...args: any[]) => {
            callback(...args);
            if (remaining > 0) {
                remaining -= 1;
                if (remaining === 0) {
                    localRuntimeEventListeners.get(eventName)?.delete(listener);
                }
            }
        };
        const listeners = localRuntimeEventListeners.get(eventName) || new Set();
        listeners.add(listener);
        localRuntimeEventListeners.set(eventName, listeners);
        return () => {
            listeners.delete(listener);
            if (listeners.size === 0) localRuntimeEventListeners.delete(eventName);
        };
    };
    (window as any).runtime = {
        ...existingRuntime,
        Environment: async () => {
            const detected = typeof existingEnvironment === 'function'
                ? await existingEnvironment()
                : {};
            if (String(detected?.buildType || '').trim()) {
                return detected;
            }
            return { ...detected, platform: 'browser', buildType: 'web' };
        },
        EventsOnMultiple: (eventName: string, callback: (...args: any[]) => void, maxCallbacks = -1) => {
            const offExisting = typeof existingEventsOnMultiple === 'function'
                ? existingEventsOnMultiple(eventName, callback, maxCallbacks)
                : undefined;
            const offLocal = subscribeLocalRuntimeEvent(eventName, callback, maxCallbacks);
            return () => {
                offLocal();
                if (typeof offExisting === 'function') offExisting();
            };
        },
        EventsOff: (eventName: string, ...additionalEventNames: string[]) => {
            existingRuntime.EventsOff?.(eventName, ...additionalEventNames);
            for (const name of [eventName, ...additionalEventNames]) {
                localRuntimeEventListeners.delete(name);
            }
        },
        EventsOffAll: () => {
            existingRuntime.EventsOffAll?.();
            localRuntimeEventListeners.clear();
        },
        EventsEmit: (eventName: string, ...args: any[]) => {
            existingEventsEmit?.(eventName, ...args);
            emitLocalRuntimeEvent(eventName, ...args);
        },
    };

    const mockConnections: any[] = isPerfDataGridHarness ? [{
        id: 'perf-conn',
        name: 'Perf Data Grid',
        config: {
            id: 'perf-conn',
            type: 'mysql',
            host: '127.0.0.1',
            port: 3306,
            user: 'root',
            database: 'perf_lab',
        },
    }] : [];
    const mockConnectionSidebarLayoutRef: { current: any } = { current: {
        initialized: false,
        revision: 0,
        connectionTags: [],
        sidebarRootOrder: [],
        rootSortMode: 'manual',
        rootConnectionSortMode: 'createdAt',
    } };
    const mockSavedQueries: any[] = [];
    const mockSavedQueryGroups: any[] = [];
    const mockQueryTables = [
        { table_name: 'videos', table_comment: 'sample video records' },
        { table_name: 'users', table_comment: 'sample users' },
        ...(isPerfDataGridHarness ? [{ table_name: 'perf_grid', table_comment: 'data grid performance harness' }] : []),
    ];
    const mockQueryColumns = [
        { tableName: 'videos', name: 'id', type: 'bigint', comment: 'primary key' },
        { tableName: 'videos', name: 'code', type: 'varchar', comment: 'video code' },
        { tableName: 'videos', name: 'title', type: 'varchar', comment: 'video title' },
        { tableName: 'users', name: 'id', type: 'bigint', comment: 'primary key' },
        { tableName: 'users', name: 'name', type: 'varchar', comment: 'display name' },
        ...(isPerfDataGridHarness ? [
            { tableName: 'perf_grid', name: 'id', type: 'bigint', comment: 'primary key' },
            { tableName: 'perf_grid', name: 'created_at', type: 'datetime', comment: 'created time' },
            { tableName: 'perf_grid', name: 'updated_at', type: 'timestamp', comment: 'updated time' },
            { tableName: 'perf_grid', name: 'register_date', type: 'date', comment: 'date with preserved time' },
            { tableName: 'perf_grid', name: 'status', type: 'varchar', comment: 'record status' },
        ] : []),
    ];
    const mockConnectionSecrets = new Map<string, any>();
    const mockProviders: any[] = [];
    const mockProviderSecrets = new Map<string, string>();
    const mockActiveProviderIdRef = { current: '' };
    const mockAISafetyLevelRef = { current: 'readonly' };
    const mockAIResultMaskingSettingsRef = { current: {
        enabled: false,
        fullMaskFields: [] as string[],
        partialMaskFields: [] as string[],
    } };
    const mockMaskFieldEquals = (left: string, right: string) => {
        const escaped = left.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(`^(?:${escaped})$`, 'iu').test(right);
    };
    const normalizeMockMaskFields = (fields: unknown, excluded: string[] = []) => {
        const seen = [...excluded];
        return (Array.isArray(fields) ? fields : []).reduce<string[]>((result, value) => {
            const field = String(value || '').trim();
            if (!field || seen.some((existing) => mockMaskFieldEquals(existing, field))) return result;
            seen.push(field);
            result.push(field);
            return result;
        }, []);
    };
    const mockAIContextLevelRef = { current: 'schema_only' };
    const mockAIUserPromptSettingsRef: { current: any } = { current: {
        global: '',
        database: '',
        jvm: '',
        jvmDiagnostic: '',
    } };
    const mockAgentSessions = new Map<string, any>();
    const mockAgentRuns = new Map<string, any>();
    const mockWorkspaceSnapshots = new Map<string, any>();
    const mockAgentSequenceRef = { current: 0 };
    const mockAgentSessionSequenceRef = { current: 0 };
    const mockRunPolicyRef: { current: any } = { current: {
        schemaVersion: 1,
        revision: 1,
        policy: {
            defaultDispatchMode: 'queue',
            softToolRoundLimit: 10,
            maxToolRounds: 15,
            maxConsecutiveFailedToolRounds: 3,
            maxToolNudges: 2,
            maxModelRetriesPerTurn: 1,
            maxActiveDuration: '30m',
            modelTurnTimeout: '0s',
            modelIdleTimeout: '0s',
            defaultToolTimeout: '0s',
            maxTotalTokens: 0,
            maxToolResultBytes: 1048576,
        },
        // Go's time.Duration is encoded as nanoseconds by the Wails binding.
        // Keep the browser mock in the same shape so settings and lease
        // renewal code exercise the real serialization contract.
        runtime: {
            controlPollInterval: 200_000_000,
            workspaceSnapshotRenewInterval: 5_000_000_000,
            workspaceSnapshotLeaseDuration: 15_000_000_000,
            policyWatchInterval: 500_000_000,
        },
    } };
    const {
        mockAgentNow, cloneMockAgentSession, submitMockAgentInput, controlMockAgentRun,
    } = createBrowserMockAgentRuntime({
        mockAgentRuns, emitLocalRuntimeEvent, mockAgentSessions, mockAgentSessionSequenceRef,
        mockAgentSequenceRef,
    });
    const {
        mockMCPServersRef, mockMCPHTTPServerStatusRef, mockMCPClientStatusesRef,
        requireBrowserMockMCPClientDetected, installBrowserMockMCPClient,
    } = createBrowserMockMcp();
    const mockSkillsRef: { current: any[] } = { current: [] };
    const mockGlobalProxyRef: { current: any } = { current: { enabled: false, type: 'socks5', host: '', port: 1080, user: '', password: '', hasPassword: false } };
    const mockDownloadSourceRef: { current: 'cst' | 'bero' | 'github' } = { current: 'cst' };
    const mockUpdateChannelRef: { current: 'latest' | 'dev' } = { current: 'latest' };
    const mockReleasePublishedAt = '2026-07-08T11:15:00Z';
    const buildMockUpdateInfo = () => ({
        hasUpdate: false,
        channel: mockUpdateChannelRef.current,
        currentVersion: '0.0.0',
        latestVersion: mockUpdateChannelRef.current === 'dev' ? 'dev-browser-mock' : '0.0.0',
        releaseName: mockUpdateChannelRef.current === 'dev' ? 'Dev Build (dev-browser-mock)' : 'Browser Mock Release',
        releasePublishedAt: mockReleasePublishedAt,
        releaseNotesUrl: mockUpdateChannelRef.current === 'dev'
            ? 'https://github.com/Syngnat/GoNavi/releases/tag/dev-latest'
            : 'https://github.com/Syngnat/GoNavi/releases/latest',
        releaseNotes: mockUpdateChannelRef.current === 'dev'
            ? '## 🧪 测试版本 (Dev Build)\n\n## ✨ 新功能\n\n- 浏览器 mock：dev 通道更新日志样例\n'
            : '## ✨ 新功能\n\n- 浏览器 mock：latest 通道更新日志样例\n\n## 🐛 问题修复\n\n- 示例修复项\n',
    });
    const mockDataRootInfoRef: { current: any } = { current: {
        path: 'C:/mock/.gonavi',
        defaultPath: 'C:/mock/.gonavi',
        driverPath: 'C:/mock/.gonavi/drivers',
        isDefaultPath: true,
        bootstrapPath: 'C:/mock/.gonavi/storage_root.json',
        logDirectory: 'C:/Users/mock/.GoNavi/Logs',
        activeLogDirectory: 'C:/Users/mock/.GoNavi/Logs',
        logFilePath: 'C:/Users/mock/.GoNavi/Logs/gonavi.log',
        defaultLogDirectory: 'C:/Users/mock/.GoNavi/Logs',
        logDirectorySource: 'default',
        logDirectoryEditable: true,
        logDirectoryRestartRequired: false,
        savedQueryDirectory: 'C:/mock/.gonavi/saved_queries',
        defaultSavedQueryDirectory: 'C:/mock/.gonavi/saved_queries',
        savedQueryDirectorySource: 'default',
    } };
    const mockAgentDataDirectoryRef = { current: mockDataRootInfoRef.current.path };
    const mockAgentDataRestartRequiredRef = { current: false };
    const mockAgentDataStats = () => ({
        fileBytes: 4096 + mockAgentSessions.size * 2048 + mockWorkspaceSnapshots.size * 1024,
        walBytes: 0,
        allocatedBytes: 4096 + mockAgentSessions.size * 2048 + mockWorkspaceSnapshots.size * 1024,
        freeBytes: 0,
        sessionCount: mockAgentSessions.size,
        runCount: mockAgentRuns.size,
        snapshotCount: mockWorkspaceSnapshots.size,
        activeRunCount: [...mockAgentRuns.values()].filter((run) => (
            !['completed', 'failed', 'canceled', 'exhausted'].includes(run.snapshot.state)
        )).length,
    });
    const mockAgentDataInfo = () => ({
        directory: mockAgentDataDirectoryRef.current,
        defaultDirectory: mockDataRootInfoRef.current.path,
        source: mockAgentDataDirectoryRef.current === mockDataRootInfoRef.current.path ? 'default' : 'custom',
        restartRequired: mockAgentDataRestartRequiredRef.current,
        stats: mockAgentDataStats(),
    });

    const {
        saveMockConnection, updateMockConnectionVisibility, saveMockQuery, uniqueMockStringArray,
        saveMockSavedQueryGroup, deleteMockSavedQueryGroup, saveMockGlobalProxy, saveMockProvider,
    } = createBrowserMockConnectionStore({
        mockConnections, mockConnectionSecrets, mockSavedQueries, mockSavedQueryGroups,
        mockGlobalProxyRef, mockProviders, mockProviderSecrets, mockActiveProviderIdRef,
    });

    const { mockAppMethods } = createBrowserMockAppMethods({
        mockConnections, mockConnectionSidebarLayoutRef, mockConnectionSecrets, saveMockConnection,
        updateMockConnectionVisibility, mockQueryTables, mockQueryColumns, mockSavedQueries,
        mockSavedQueryGroups, saveMockQuery, mockDataRootInfoRef, saveMockSavedQueryGroup,
        uniqueMockStringArray, deleteMockSavedQueryGroup, buildMockUpdateInfo, mockUpdateChannelRef,
        mockGlobalProxyRef, mockDownloadSourceRef, saveMockGlobalProxy,
    });

    const { mockAiServiceMethods } = createBrowserMockAiServiceMethods({
        mockProviders, mockProviderSecrets, saveMockProvider, mockActiveProviderIdRef,
        mockAISafetyLevelRef, mockAIResultMaskingSettingsRef, mockAIContextLevelRef,
        mockAIUserPromptSettingsRef, mockAgentDataInfo, mockAgentDataDirectoryRef,
        mockDataRootInfoRef, mockAgentDataRestartRequiredRef, mockAgentDataStats,
        mockWorkspaceSnapshots, mockAgentSessions, mockAgentRuns, submitMockAgentInput,
        controlMockAgentRun, cloneMockAgentSession, mockAgentNow, mockRunPolicyRef,
        mockMCPClientStatusesRef, mockMCPHTTPServerStatusRef, mockMCPServersRef,
        requireBrowserMockMCPClientDetected, installBrowserMockMCPClient, mockSkillsRef,
        normalizeMockMaskFields,
    });

    const mockGo = {
        app: {
            App: mockAppMethods,
        },
        aiservice: {
            Service: mockAiServiceMethods,
        },
    };
    const existingGo = (window as any).go || {};
    (window as any).go = {
        ...mockGo,
        ...existingGo,
        app: {
            ...mockGo.app,
            ...(existingGo.app || {}),
            App: {
                ...mockGo.app.App,
                ...(existingGo.app?.App || {}),
            },
        },
        aiservice: {
            ...mockGo.aiservice,
            ...(existingGo.aiservice || {}),
            Service: {
                ...mockGo.aiservice.Service,
                ...(existingGo.aiservice?.Service || {}),
            },
        },
    };
};
