import { cloneBrowserMockValue } from '../../utils/browserMockConnections';
import { t } from '../../i18n';

export interface CreateBrowserMockAiServiceMethodsInput {
    mockProviders: any[];
    mockProviderSecrets: Map<string, string>;
    saveMockProvider: (input: any) => any;
    mockActiveProviderIdRef: { current: string; };
    mockAISafetyLevelRef: { current: string; };
    mockAIResultMaskingSettingsRef: { current: { enabled: boolean; fullMaskFields: string[]; partialMaskFields: string[]; }; };
    mockAIContextLevelRef: { current: string; };
    mockAIUserPromptSettingsRef: { current: any; };
    mockAgentDataInfo: () => { directory: any; defaultDirectory: any; source: string; restartRequired: boolean; stats: { fileBytes: number; walBytes: number; allocatedBytes: number; freeBytes: number; sessionCount: number; runCount: number; snapshotCount: number; activeRunCount: number; }; };
    mockAgentDataDirectoryRef: { current: any; };
    mockDataRootInfoRef: { current: any; };
    mockAgentDataRestartRequiredRef: { current: boolean; };
    mockAgentDataStats: () => { fileBytes: number; walBytes: number; allocatedBytes: number; freeBytes: number; sessionCount: number; runCount: number; snapshotCount: number; activeRunCount: number; };
    mockWorkspaceSnapshots: Map<string, any>;
    mockAgentSessions: Map<string, any>;
    mockAgentRuns: Map<string, any>;
    submitMockAgentInput: (request: any) => Promise<{ requestId: string; sessionId: string; runId: any; disposition: string; revision: any; state: any; }>;
    controlMockAgentRun: (request: any) => Promise<any>;
    cloneMockAgentSession: (session: any, includeMessages?: boolean) => { messages?: any; sessionId: any; title: any; revision: any; generation: any; archived: boolean; createdAt: any; updatedAt: any; runs: any[]; };
    mockAgentNow: () => string;
    mockRunPolicyRef: { current: any; };
    mockMCPClientStatusesRef: { current: any[]; };
    mockMCPHTTPServerStatusRef: { current: any; };
    mockMCPServersRef: { current: any[]; };
    requireBrowserMockMCPClientDetected: (client: string, displayName: string) => void;
    installBrowserMockMCPClient: (client: string, displayName: string, configPath: string) => { success: boolean; client: string; message: string; configPath: string; command: string; args: string[]; };
    mockSkillsRef: { current: any[]; };
    normalizeMockMaskFields: (fields: unknown, excluded?: string[]) => string[];
}

export const createBrowserMockAiServiceMethods = ({
    mockProviders, mockProviderSecrets, saveMockProvider, mockActiveProviderIdRef,
    mockAISafetyLevelRef, mockAIResultMaskingSettingsRef, mockAIContextLevelRef,
    mockAIUserPromptSettingsRef, mockAgentDataInfo, mockAgentDataDirectoryRef, mockDataRootInfoRef,
    mockAgentDataRestartRequiredRef, mockAgentDataStats, mockWorkspaceSnapshots, mockAgentSessions,
    mockAgentRuns, submitMockAgentInput, controlMockAgentRun, cloneMockAgentSession, mockAgentNow,
    mockRunPolicyRef, mockMCPClientStatusesRef, mockMCPHTTPServerStatusRef, mockMCPServersRef,
    requireBrowserMockMCPClientDetected, installBrowserMockMCPClient, mockSkillsRef,
    normalizeMockMaskFields,
}: CreateBrowserMockAiServiceMethodsInput) => {
    const mockAiServiceMethods = {
        AIGetProviders: async () => cloneBrowserMockValue(mockProviders),
        AIGetEditableProvider: async (id: string) => {
            const existing = mockProviders.find((item) => item.id === id);
            if (!existing) {
                throw new Error(`provider not found: ${id}`);
            }
            return cloneBrowserMockValue({
                ...existing,
                apiKey: mockProviderSecrets.get(id) || '',
            });
        },
        AISaveProvider: async (input: any) => saveMockProvider(input),
        AIDeleteProvider: async (id: string) => {
            const index = mockProviders.findIndex((item) => item.id === id);
            if (index >= 0) {
                mockProviders.splice(index, 1);
            }
            mockProviderSecrets.delete(id);
            if (mockActiveProviderIdRef.current === id) {
                mockActiveProviderIdRef.current = mockProviders[0]?.id || '';
            }
            return null;
        },
        AIGetActiveProvider: async () => mockActiveProviderIdRef.current,
        AISetActiveProvider: async (id: string) => {
            if (!mockProviders.some((item) => item.id === id)) throw new Error(`provider not found: ${id}`);
            mockActiveProviderIdRef.current = id;
        },
        AIGetCLICapabilities: async () => [],
        AIGetModelContextProfile: async (provider: { model?: string }) => (
            String(provider?.model || '').toLowerCase().includes('gpt-5')
                ? { defaultWindow: 1000000, options: [500000, 1000000] }
                : { defaultWindow: 258000, options: [128000, 200000, 258000, 500000, 1000000, 2000000] }
        ),
        AIGetCLIModelCatalog: async () => ({ models: [], source: 'none', stale: false }),
        AIListCLIModels: async () => [],
        AIGetSafetyLevel: async () => mockAISafetyLevelRef.current,
        AIGetResultMaskingSettings: async () => cloneBrowserMockValue(mockAIResultMaskingSettingsRef.current),
        AIGetContextLevel: async () => mockAIContextLevelRef.current,
        AIGetBuiltinPrompts: async () => ({}),
        AIGetUserPromptSettings: async () => cloneBrowserMockValue(mockAIUserPromptSettingsRef.current),
        AIGetAgentDataDirectoryInfo: async () => cloneBrowserMockValue(mockAgentDataInfo()),
        AISelectAgentDataDirectory: async (current: string) => (
            String(current || mockAgentDataDirectoryRef.current).replace(/[\\/]$/, '') + '/ai-assistant-data'
        ),
        AIApplyAgentDataDirectory: async (directory: string) => {
            mockAgentDataDirectoryRef.current = String(directory || mockDataRootInfoRef.current.path);
            mockAgentDataRestartRequiredRef.current = true;
            return cloneBrowserMockValue(mockAgentDataInfo());
        },
        AIOpenAgentDataDirectory: async () => null,
        AIOptimizeAgentData: async () => {
            const before = mockAgentDataStats();
            const newestSnapshots = new Map(mockWorkspaceSnapshots);
            mockWorkspaceSnapshots.clear();
            newestSnapshots.forEach((value, key) => mockWorkspaceSnapshots.set(key, value));
            return cloneBrowserMockValue({
                info: mockAgentDataInfo(),
                maintenance: { before, after: mockAgentDataStats(), removedSnapshots: 0, removedSessions: 0 },
            });
        },
        AIClearAgentData: async () => {
            const before = mockAgentDataStats();
            mockAgentSessions.clear();
            mockAgentRuns.clear();
            mockWorkspaceSnapshots.clear();
            return cloneBrowserMockValue({
                info: mockAgentDataInfo(),
                maintenance: {
                    before,
                    after: mockAgentDataStats(),
                    removedSnapshots: before.snapshotCount,
                    removedSessions: before.sessionCount,
                },
            });
        },
        AISubmitAgentInput: async (request: any) => submitMockAgentInput(request),
        AIControlAgentRun: async (request: any) => controlMockAgentRun(request),
        AIReadAgentRun: async (request: any) => {
            const run = mockAgentRuns.get(String(request?.runId || '').trim());
            if (!run) throw new Error('run not found');
            const afterSequence = Math.max(0, Number(request?.afterSequence || 0));
            const limit = Math.max(1, Math.min(1000, Number(request?.limit || 100)));
            const events = run.events
                .filter((event: any) => event.sequence > afterSequence)
                .slice(0, limit);
            const lastSequence = events.length > 0
                ? events[events.length - 1].sequence
                : afterSequence;
            return {
                run: cloneBrowserMockValue(run.snapshot),
                events: cloneBrowserMockValue(events),
                nextSequence: run.snapshot.nextSequence,
                hasMore: run.events.some((event: any) => event.sequence > lastSequence),
            };
        },
        AIListAgentSessions: async (request: any = {}) => {
            const offset = Math.max(0, Number(request?.offset || 0));
            const limit = Math.max(1, Math.min(1000, Number(request?.limit || 100)));
            const sessions = [...mockAgentSessions.values()]
                .filter((session) => request?.activeOnly !== true || !session.archived)
                .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
            return {
                sessions: sessions.slice(offset, offset + limit).map((session) => cloneMockAgentSession(session, false)),
                total: sessions.length,
            };
        },
        AIReadAgentSession: async (request: any) => {
            const session = mockAgentSessions.get(String(request?.sessionId || '').trim());
            if (!session) throw new Error('session not found');
            const limit = Math.max(1, Math.min(10000, Number(request?.limit || 10000)));
            const projection = cloneMockAgentSession(session, true);
            projection.messages = projection.messages.slice(-limit);
            return projection;
        },
        AIMutateAgentSession: async (request: any) => {
            const session = mockAgentSessions.get(String(request?.sessionId || '').trim());
            if (!session) throw new Error('session not found');
            if (Number(request?.expectedRevision || 0) > 0 && Number(request.expectedRevision) !== session.revision) {
                throw new Error('revision_conflict');
            }
            if (Object.prototype.hasOwnProperty.call(request || {}, 'title')) {
                session.title = String(request.title || '').trim();
            }
            if (Object.prototype.hasOwnProperty.call(request || {}, 'archived')) {
                session.archived = request.archived === true;
            }
            session.revision += 1;
            session.updatedAt = mockAgentNow();
            return cloneMockAgentSession(session, false);
        },
        AIUpdateWorkspaceSnapshot: async (snapshot: any) => {
            const sourceId = String(snapshot?.sourceId || '').trim();
            const sourceInstanceId = String(snapshot?.sourceInstanceId || '').trim();
            const revision = Number(snapshot?.revision || 0);
            if (!sourceId || !sourceInstanceId || revision < 1) {
                throw new Error('workspace snapshot sourceId, sourceInstanceId, and revision are required');
            }
            const key = `${sourceId}:${sourceInstanceId}`;
            const previous = mockWorkspaceSnapshots.get(key);
            if (previous && revision < previous.revision) throw new Error('revision_conflict');
            const content = JSON.stringify(snapshot);
            const contentHash = `browser-mock-${content.length.toString(16)}-${revision}`;
            mockWorkspaceSnapshots.set(key, { revision, contentHash, snapshot: cloneBrowserMockValue(snapshot) });
            return { sourceId, revision, contentHash, accepted: true };
        },
        AIGetRunPolicy: async () => cloneBrowserMockValue(mockRunPolicyRef.current),
        AIGetAgentLedgerStatus: async () => ({ state: 'ready' }),
        AISaveRunPolicy: async (request: any) => {
            const expectedRevision = Number(request?.expectedRevision || 0);
            if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1 || expectedRevision !== mockRunPolicyRef.current.revision) {
                throw new Error('revision_conflict');
            }
            mockRunPolicyRef.current = {
                schemaVersion: 1,
                revision: mockRunPolicyRef.current.revision + 1,
                policy: cloneBrowserMockValue(request?.policy || {}),
                runtime: cloneBrowserMockValue(request?.runtime || mockRunPolicyRef.current.runtime),
            };
            return cloneBrowserMockValue(mockRunPolicyRef.current);
        },
        AISaveUserPromptSettings: async (input: any) => {
            mockAIUserPromptSettingsRef.current = {
                global: String(input?.global || ''),
                database: String(input?.database || ''),
                jvm: String(input?.jvm || ''),
                jvmDiagnostic: String(input?.jvmDiagnostic || ''),
            };
            return null;
        },
        AIGetMCPClientInstallStatuses: async () => cloneBrowserMockValue(mockMCPClientStatusesRef.current),
        AIGetMCPHTTPServerStatus: async () => cloneBrowserMockValue(mockMCPHTTPServerStatusRef.current),
        AIStartMCPHTTPServer: async (input: any) => {
            const addr = String(input?.addr || '127.0.0.1:8765');
            const path = String(input?.path || '/mcp').startsWith('/') ? String(input?.path || '/mcp') : `/${String(input?.path || '/mcp')}`;
            const token = String(input?.token || 'gnv_browser_mock_token').trim() || 'gnv_browser_mock_token';
            mockMCPHTTPServerStatusRef.current = {
                running: true,
                enabled: true,
                addr,
                path,
                url: `http://${addr}${path}`,
                schemaOnly: Boolean(input?.schemaOnly),
                token,
                authorizationHeader: `Bearer ${token}`,
                startedAt: Date.now(),
                message: t('app.browser_mock.mcp_http.started'),
            };
            return cloneBrowserMockValue(mockMCPHTTPServerStatusRef.current);
        },
        AIStopMCPHTTPServer: async () => {
            mockMCPHTTPServerStatusRef.current = {
                ...mockMCPHTTPServerStatusRef.current,
                enabled: false,
                running: false,
                message: t('app.browser_mock.mcp_http.stopped'),
            };
            return cloneBrowserMockValue(mockMCPHTTPServerStatusRef.current);
        },
        AIGetMCPServers: async () => cloneBrowserMockValue(mockMCPServersRef.current),
        AIInstallClaudeCodeMCP: async () => {
            requireBrowserMockMCPClientDetected('claude-code', 'Claude Code');
            mockMCPClientStatusesRef.current = mockMCPClientStatusesRef.current.map((item) => item.client === 'claude-code'
                ? {
                    ...item,
                    installed: true,
                    matchesCurrent: true,
                    message: t('app.browser_mock.mcp_client.claude_code.installed'),
                    command: 'C:/Program Files/GoNavi/GoNavi.exe',
                    args: ['mcp-server'],
                }
                : item);
            return {
                success: true,
                client: 'claude-code',
                message: t('app.browser_mock.mcp_client.claude_code.installed'),
                configPath: 'C:/Users/mock/.claude.json',
                command: 'C:/Program Files/GoNavi/GoNavi.exe',
                args: ['mcp-server'],
            };
        },
        AIInstallCodexMCP: async () => {
            requireBrowserMockMCPClientDetected('codex', 'Codex');
            mockMCPClientStatusesRef.current = mockMCPClientStatusesRef.current.map((item) => item.client === 'codex'
                ? {
                    ...item,
                    installed: true,
                    matchesCurrent: true,
                    message: t('app.browser_mock.mcp_client.codex.installed'),
                    command: 'C:/Program Files/GoNavi/GoNavi.exe',
                    args: ['mcp-server'],
                }
                : item);
            return {
                success: true,
                client: 'codex',
                message: t('app.browser_mock.mcp_client.codex.installed'),
                configPath: 'C:/Users/mock/.codex/config.toml',
                command: 'C:/Program Files/GoNavi/GoNavi.exe',
                args: ['mcp-server'],
            };
        },
        AIInstallOpenCodeMCP: async () => {
            requireBrowserMockMCPClientDetected('opencode', 'OpenCode');
            mockMCPClientStatusesRef.current = mockMCPClientStatusesRef.current.map((item) => item.client === 'opencode'
                ? {
                    ...item,
                    installed: true,
                    matchesCurrent: true,
                    message: t('app.browser_mock.mcp_client.opencode.installed'),
                    command: 'C:/Program Files/GoNavi/GoNavi.exe',
                    args: ['mcp-server'],
                }
                : item);
            return {
                success: true,
                client: 'opencode',
                message: t('app.browser_mock.mcp_client.opencode.installed'),
                configPath: 'C:/Users/mock/.config/opencode/opencode.json',
                command: 'C:/Program Files/GoNavi/GoNavi.exe',
                args: ['mcp-server'],
            };
        },
        AIInstallZCodeMCP: async () => installBrowserMockMCPClient('zcode', 'ZCode', 'C:/Users/mock/.zcode/cli/config.json'),
        AIInstallCursorMCP: async () => installBrowserMockMCPClient('cursor', 'Cursor', 'C:/Users/mock/.cursor/mcp.json'),
        AIInstallDeepSeekHarnessMCP: async () => installBrowserMockMCPClient('deepseek-harness', 'DeepSeek Harness', 'C:/Users/mock/.dsh/cordis.patch.yml'),
        AIInstallKimiMCP: async () => installBrowserMockMCPClient('kimi', 'Kimi Code', 'C:/Users/mock/.kimi-code/mcp.json'),
        AIInstallGrokBuildMCP: async () => installBrowserMockMCPClient('grok-build', 'Grok Build', 'C:/Users/mock/.grok/config.toml'),
        AISaveMCPServer: async (input: any) => {
            const next = {
                id: String(input?.id || `mcp-${Date.now()}`),
                name: String(input?.name || ''),
                transport: 'stdio',
                command: String(input?.command || ''),
                args: Array.isArray(input?.args) ? [...input.args] : [],
                env: { ...(input?.env || {}) },
                enabled: input?.enabled !== false,
                timeoutSeconds: Number(input?.timeoutSeconds) || 20,
            };
            const index = mockMCPServersRef.current.findIndex((item) => item.id === next.id);
            if (index >= 0) mockMCPServersRef.current[index] = next;
            else mockMCPServersRef.current.push(next);
            return null;
        },
        AIDeleteMCPServer: async (id: string) => {
            mockMCPServersRef.current = mockMCPServersRef.current.filter((item) => item.id !== id);
            return null;
        },
        AITestMCPServer: async (input: any) => ({
            success: String(input?.command || '').trim() !== '',
            message: String(input?.command || '').trim() !== ''
                ? t('app.browser_mock.mcp_server.test_success')
                : t('app.browser_mock.mcp_server.command_required'),
            tools: [],
        }),
        AIListMCPTools: async () => [],
        AICallMCPTool: async (_alias: string, _argumentsJSON: string) => ({
            alias: _alias,
            serverId: '',
            serverName: '',
            originalName: _alias,
            content: t('app.browser_mock.mcp_tool.unavailable'),
            isError: true,
        }),
        AIGetSkills: async () => cloneBrowserMockValue(mockSkillsRef.current),
        AISaveSkill: async (input: any) => {
            const next = {
                id: String(input?.id || `skill-${Date.now()}`),
                name: String(input?.name || ''),
                description: String(input?.description || ''),
                systemPrompt: String(input?.systemPrompt || ''),
                enabled: input?.enabled !== false,
                scopes: Array.isArray(input?.scopes) ? [...input.scopes] : ['global'],
                requiredTools: Array.isArray(input?.requiredTools) ? [...input.requiredTools] : [],
            };
            const index = mockSkillsRef.current.findIndex((item) => item.id === next.id);
            if (index >= 0) mockSkillsRef.current[index] = next;
            else mockSkillsRef.current.push(next);
            return null;
        },
        AIDeleteSkill: async (id: string) => {
            mockSkillsRef.current = mockSkillsRef.current.filter((item) => item.id !== id);
            return null;
        },
        AITestProvider: async () => ({
            success: false,
            checkKind: 'none',
            modelVerified: false,
            message: t('ai_settings.message.preview_check_unavailable'),
        }),
        AISetSafetyLevel: async (level: string) => {
            mockAISafetyLevelRef.current = String(level || 'readonly');
            return null;
        },
        AISaveResultMaskingSettings: async (settings: any) => {
            const fullMaskFields = normalizeMockMaskFields(settings?.fullMaskFields);
            mockAIResultMaskingSettingsRef.current = {
                enabled: settings?.enabled === true,
                fullMaskFields,
                partialMaskFields: normalizeMockMaskFields(settings?.partialMaskFields, fullMaskFields),
            };
            return null;
        },
        AISetContextLevel: async (level: string) => {
            mockAIContextLevelRef.current = String(level || 'schema_only');
            return null;
        },
        AISetLanguage: async () => null,
    };
    return { mockAiServiceMethods };
};
