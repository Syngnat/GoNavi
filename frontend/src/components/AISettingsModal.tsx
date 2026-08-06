import Modal from './common/ResizableDraggableModal';
import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Form, message as antdMessage } from 'antd';
import { RobotOutlined } from '@ant-design/icons';
import type { AIProviderConfig, AIProviderType, AISafetyLevel, AIContextLevel, AIUserPromptSettings, AIMCPServerConfig, AIMCPToolDescriptor, AIMCPClientInstallStatus, AIMCPHTTPServerStatus, AISkillConfig } from '../types';
import {
    resolvePresetBaseURL,
    resolvePresetModelSelection,
    resolvePresetTransport,
    type ProviderPresetCandidate,
} from '../utils/aiProviderPresets';
import {
    canRetainExistingProviderSecret,
    isProviderSecretRequirementSatisfied,
    resolveProviderSecretDraft,
} from '../utils/providerSecretDraft';
import { buildAddProviderEditorSession, buildClosedProviderEditorSession, buildEditProviderEditorSession, type ProviderEditorSession } from '../utils/aiProviderEditorState';
import type { OverlayWorkbenchTheme } from '../utils/overlayWorkbenchTheme';
import { useI18n } from '../i18n/provider';
import { BUILTIN_AI_TOOL_INFO } from '../utils/aiToolRegistry';
import { EMPTY_MCP_CLIENT_STATUSES } from '../utils/mcpClientInstallStatus';
import AIBuiltinToolsCatalog from './ai/AIBuiltinToolsCatalog';
import AISettingsMCPSection from './ai/AISettingsMCPSection';
import type { AIMCPHTTPServerDraft } from './ai/AIMCPHTTPServerPanel';
import AISettingsSidebar, { AI_SETTINGS_NAV_ITEMS, type AISettingsSectionKey } from './ai/AISettingsSidebar';
import AISettingsSafetySection from './ai/AISettingsSafetySection';
import AISettingsContextSection from './ai/AISettingsContextSection';
import AISettingsProvidersSection from './ai/AISettingsProvidersSection';
import AISettingsPromptsSection from './ai/AISettingsPromptsSection';
import AISettingsSkillsSection from './ai/AISettingsSkillsSection';
import { useAIMCPClientInstaller } from './ai/useAIMCPClientInstaller';
import {
    EMPTY_AI_USER_PROMPT_SETTINGS,
    EMPTY_MCP_SERVER,
    EMPTY_SKILL,
    PROVIDER_PRESETS,
    findPreset,
    localizeProviderPreset,
    localizeProviderPresets,
    matchProviderPreset,
    waitForAIService,
} from './ai/aiSettingsModalConfig';
import { useStore } from '../store';
interface AISettingsModalProps {
    open: boolean;
    onClose: () => void;
    darkMode: boolean;
    overlayTheme: OverlayWorkbenchTheme;
    focusProviderId?: string;
    onBeforeExternalMCPUse?: () => Promise<void>;
}

export interface AISettingsContentProps {
    active: boolean;
    darkMode: boolean;
    overlayTheme: OverlayWorkbenchTheme;
    focusProviderId?: string;
    onBeforeExternalMCPUse?: () => Promise<void>;
}

const DEFAULT_MCP_HTTP_SERVER_STATUS: AIMCPHTTPServerStatus = {
    enabled: false,
    running: false,
    addr: '127.0.0.1:8765',
    path: '/mcp',
    url: 'http://127.0.0.1:8765/mcp',
    // 默认允许 execute_sql 查少量数据
    schemaOnly: false,
    message: '',
};

const DEFAULT_MCP_HTTP_SERVER_DRAFT: AIMCPHTTPServerDraft = {
    addr: DEFAULT_MCP_HTTP_SERVER_STATUS.addr,
    path: DEFAULT_MCP_HTTP_SERVER_STATUS.path,
    authorizationHeader: '',
    schemaOnly: false,
};

const buildMCPHTTPServerDraftFromStatus = (
    status: AIMCPHTTPServerStatus,
    fallback: AIMCPHTTPServerDraft = DEFAULT_MCP_HTTP_SERVER_DRAFT,
): AIMCPHTTPServerDraft => ({
    addr: String(status.addr || fallback.addr || DEFAULT_MCP_HTTP_SERVER_STATUS.addr).trim(),
    path: String(status.path || fallback.path || DEFAULT_MCP_HTTP_SERVER_STATUS.path).trim(),
    authorizationHeader: String(
        status.authorizationHeader ||
        (status.token ? `Bearer ${status.token}` : '') ||
        fallback.authorizationHeader ||
        '',
    ).trim(),
    // 运行中用状态；未运行保留草稿选择
    schemaOnly: typeof status.schemaOnly === 'boolean'
        ? status.schemaOnly
        : (typeof fallback.schemaOnly === 'boolean' ? fallback.schemaOnly : false),
});

const normalizeMCPHTTPAuthorizationToken = (value: string): string => {
    const trimmed = String(value || '').trim();
    if (!trimmed) return '';
    const withoutHeaderName = trimmed.replace(/^Authorization\s*:\s*/i, '').trim();
    return withoutHeaderName.replace(/^Bearer\s+/i, '').trim();
};

export const AISettingsContent: React.FC<AISettingsContentProps> = ({ active, darkMode, overlayTheme, focusProviderId, onBeforeExternalMCPUse }) => {
    const { t } = useI18n();
    const defaultMCPHTTPServerStatus = useMemo<AIMCPHTTPServerStatus>(() => ({
        ...DEFAULT_MCP_HTTP_SERVER_STATUS,
        message: t('ai_settings.mcp_http.status.not_running'),
    }), [t]);
    const [providers, setProviders] = useState<AIProviderConfig[]>([]);
    const [activeProviderId, setActiveProviderId] = useState<string>('');
    const [safetyLevel, setSafetyLevel] = useState<AISafetyLevel>('readonly');
    const [contextLevel, setContextLevel] = useState<AIContextLevel>('schema_only');
    const [mcpServers, setMCPServers] = useState<AIMCPServerConfig[]>([]);
    const [mcpTools, setMCPTools] = useState<AIMCPToolDescriptor[]>([]);
    const [mcpHTTPServerStatus, setMCPHTTPServerStatus] = useState<AIMCPHTTPServerStatus>(() => defaultMCPHTTPServerStatus);
    const [mcpHTTPServerDraft, setMCPHTTPServerDraft] = useState<AIMCPHTTPServerDraft>(DEFAULT_MCP_HTTP_SERVER_DRAFT);
    const [mcpHTTPServerLoading, setMCPHTTPServerLoading] = useState(false);
    const [skills, setSkills] = useState<AISkillConfig[]>([]);
    const [editingProvider, setEditingProvider] = useState<AIProviderConfig | null>(null);
    const [isEditing, setIsEditing] = useState(false);
    const [loading, setLoading] = useState(false);
    const [testStatus, setTestStatus] = useState<'idle' | 'success' | 'error'>('idle');
    const [builtinPrompts, setBuiltinPrompts] = useState<Record<string, string>>({});
    const [userPromptSettings, setUserPromptSettings] = useState<AIUserPromptSettings>(EMPTY_AI_USER_PROMPT_SETTINGS);
    const [activeSection, setActiveSection] = useState<AISettingsSectionKey>('providers');
    const [primaryPasswordVisible, setPrimaryPasswordVisible] = useState(false);
    const [form] = Form.useForm();
    const modalBodyRef = useRef<HTMLDivElement>(null);
    const settingsContentScrollRef = useRef<HTMLDivElement>(null);
    const missingAIServiceWarnedRef = useRef(false);
    const aiChatOpenMode = useStore((state) => state.aiChatOpenMode);
    const setAIChatOpenMode = useStore((state) => state.setAIChatOpenMode);

    // Modal 内部 toast 通知
    const [messageApi, messageContextHolder] = antdMessage.useMessage({ getContainer: () => modalBodyRef.current || document.body });

    // 主题色
    const cardBg = darkMode ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.02)';
    const cardBorder = darkMode ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)';
    const cardHoverBg = darkMode ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.03)';
    const inputBg = darkMode ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.02)';
    // Hook 必须在组件顶层调用，不能在条件分支内
    const watchedType = Form.useWatch('type', form);
    const watchedPresetKey = Form.useWatch('presetKey', form);
    const watchedApiFormat = Form.useWatch('apiFormat', form) || 'openai';
    const localizedProviderPresets = useMemo(
        () => localizeProviderPresets(PROVIDER_PRESETS, t),
        [t],
    );
    const findLocalizedPreset = useCallback(
        (key: string) => localizeProviderPreset(findPreset(key), t),
        [t],
    );
    const matchLocalizedProviderPreset = useCallback(
        (provider: ProviderPresetCandidate) =>
            localizeProviderPreset(matchProviderPreset(provider), t),
        [t],
    );
    const skillRequiredToolOptions = useMemo(() => ([
        ...BUILTIN_AI_TOOL_INFO.map((tool) => ({
            label: `${tool.name} · ${t('ai_settings.tools.builtin_tool_label')}`,
            value: tool.name,
        })),
        ...mcpTools.map((tool) => ({
            label: `${tool.alias} · ${tool.serverName}`,
            value: tool.alias,
        })),
    ]), [mcpTools, t]);

    const resolveAIService = useCallback(async () => {
        const service = await waitForAIService();
        if (service) {
            missingAIServiceWarnedRef.current = false;
            return service;
        }
        if (!missingAIServiceWarnedRef.current) {
            console.warn('[AI] Service not found on window.go');
            missingAIServiceWarnedRef.current = true;
        }
        return null;
    }, []);

    const copyTextToClipboard = useCallback(async (text: string, successMessage: string) => {
        if (typeof navigator?.clipboard?.writeText !== 'function') {
            throw new Error(t('ai_settings.clipboard.error.unsupported'));
        }
        await navigator.clipboard.writeText(text);
        void messageApi.success(successMessage);
    }, [messageApi, t]);

    const {
        handleCopySelectedMCPConfigPath,
        handleCopySelectedMCPLaunchCommand,
        handleInstallSelectedMCPClient,
        handleSelectMCPClient,
        loadMCPClientStatuses,
        mcpClientStatusLoading,
        mcpClientStatuses,
        resetMCPClientSelectionTouched,
        selectedMCPClient,
        selectedMCPClientCommandText,
        selectedMCPClientStatus,
        syncMCPClientStatuses,
    } = useAIMCPClientInstaller({
        resolveAIService,
        messageApi,
        copyTextToClipboard,
        onBeforeInstall: async () => {
            setLoading(true);
            await onBeforeExternalMCPUse?.();
        },
        onAfterInstall: () => setLoading(false),
        onConfigChanged: () => window.dispatchEvent(new CustomEvent('gonavi:ai:config-changed')),
        translate: t,
    });

    const loadConfig = useCallback(async () => {
        try {
            const Service = await resolveAIService();
            if (!Service) {
                return;
            }
            const callOrFallback = async <T,>(loader: (() => Promise<T>) | undefined, fallback: T): Promise<T> => {
                if (typeof loader !== 'function') {
                    return fallback;
                }
                try {
                    return await loader();
                } catch (error) {
                    console.warn('[AI] settings load fallback', error);
                    return fallback;
                }
            };
            const [provRes, safeRes, ctxRes, promptsRes, userPromptsRes, mcpServersRes, mcpToolsRes, mcpHTTPServerStatusRes, skillsRes, mcpClientStatusesRes] = await Promise.all([
                callOrFallback(() => Service.AIGetProviders?.(), []),
                callOrFallback<AISafetyLevel>(() => Service.AIGetSafetyLevel?.(), 'readonly'),
                callOrFallback<AIContextLevel>(() => Service.AIGetContextLevel?.(), 'schema_only'),
                callOrFallback(() => Service.AIGetBuiltinPrompts?.(), {}),
                callOrFallback(() => Service.AIGetUserPromptSettings?.(), EMPTY_AI_USER_PROMPT_SETTINGS),
                callOrFallback(() => Service.AIGetMCPServers?.(), []),
                callOrFallback(() => Service.AIListMCPTools?.(), []),
                callOrFallback<AIMCPHTTPServerStatus>(() => Service.AIGetMCPHTTPServerStatus?.(), defaultMCPHTTPServerStatus),
                callOrFallback(() => Service.AIGetSkills?.(), []),
                callOrFallback<AIMCPClientInstallStatus[]>(() => Service.AIGetMCPClientInstallStatuses?.(), EMPTY_MCP_CLIENT_STATUSES),
            ]);
            if (Array.isArray(provRes)) {
                setProviders(provRes);
                const activeRes = await Service.AIGetActiveProvider?.();
                if (activeRes) setActiveProviderId(activeRes);
            }
            if (safeRes) setSafetyLevel(safeRes);
            if (ctxRes) setContextLevel(ctxRes);
            if (promptsRes) setBuiltinPrompts(promptsRes);
            if (userPromptsRes) {
                setUserPromptSettings({
                    ...EMPTY_AI_USER_PROMPT_SETTINGS,
                    ...userPromptsRes,
                });
            }
            if (Array.isArray(mcpServersRes)) setMCPServers(mcpServersRes);
            if (Array.isArray(mcpToolsRes)) setMCPTools(mcpToolsRes);
            if (mcpHTTPServerStatusRes) {
                const nextStatus = {
                    ...defaultMCPHTTPServerStatus,
                    ...mcpHTTPServerStatusRes,
                };
                setMCPHTTPServerStatus(nextStatus);
                setMCPHTTPServerDraft((prev) => buildMCPHTTPServerDraftFromStatus(nextStatus, prev));
            }
            if (Array.isArray(skillsRes)) setSkills(skillsRes);
            if (Array.isArray(mcpClientStatusesRes)) {
                syncMCPClientStatuses(mcpClientStatusesRes);
            }
        } catch (e) { console.warn('Failed to load AI config', e); }
    }, [defaultMCPHTTPServerStatus, resolveAIService, syncMCPClientStatuses]);

    useEffect(() => { if (active) void loadConfig(); }, [active, loadConfig]);

    useEffect(() => {
        const scrollRegion = settingsContentScrollRef.current;
        if (!scrollRegion) return;
        scrollRegion.scrollTop = 0;
        scrollRegion.scrollLeft = 0;
    }, [activeSection]);

    useEffect(() => {
        if (active) {
            resetMCPClientSelectionTouched();
        }
    }, [active, resetMCPClientSelectionTouched]);

    useEffect(() => {
        if (!active || !focusProviderId) {
            return;
        }
        if (!providers.some((provider) => provider.id === focusProviderId)) {
            return;
        }
        setActiveSection('providers');
        setActiveProviderId(focusProviderId);
    }, [active, focusProviderId, providers]);

    const applyProviderEditorSession = useCallback((session: ProviderEditorSession) => {
        setEditingProvider(session.editingProvider as AIProviderConfig | null);
        setIsEditing(session.isEditing);
        setTestStatus(session.testStatus);
        setPrimaryPasswordVisible(false);
        form.resetFields();
        if (session.formValues) {
            form.setFieldsValue(session.formValues);
        }
    }, [form]);

    const resetProviderEditorSession = useCallback(() => {
        applyProviderEditorSession(buildClosedProviderEditorSession());
    }, [applyProviderEditorSession]);

    useEffect(() => {
        if (!active) {
            resetProviderEditorSession();
        }
    }, [active, resetProviderEditorSession]);
    const handleAddProvider = () => {
        const preset = findPreset('openai');
        applyProviderEditorSession(buildAddProviderEditorSession({
            presetKey: 'openai',
            presetBackendType: preset.backendType,
            presetBaseUrl: preset.defaultBaseUrl,
            presetModel: preset.defaultModel,
            presetModels: preset.models,
            apiFormat: 'openai',
            authMode: preset.authMode || 'api-key',
        }));
    };

    const handleEditProvider = async (p: AIProviderConfig) => {
        try {
            const Service = (window as any).go?.aiservice?.Service;
            const editableProvider = typeof Service?.AIGetEditableProvider === 'function'
                ? await Service.AIGetEditableProvider(p.id)
                : p;
            // 尝试根据 baseUrl 和 type 推断 preset
            const matchedPreset = matchProviderPreset(editableProvider);
            const resolvedTransport = resolvePresetTransport({
                presetKey: matchedPreset.key,
                presetBackendType: matchedPreset.backendType,
                presetFixedApiFormat: matchedPreset.fixedApiFormat,
                presetEndpoints: matchedPreset.endpoints,
                valuesBaseUrl: editableProvider.baseUrl,
                valuesApiFormat: editableProvider.apiFormat,
            });
            applyProviderEditorSession(buildEditProviderEditorSession({
                provider: { ...editableProvider, presetKey: matchedPreset.key } as any,
                formValues: {
                    ...editableProvider,
                    type: resolvedTransport.type,
                    models: editableProvider.models || [],
                    presetKey: matchedPreset.key,
                    apiFormat: resolvedTransport.apiFormat || editableProvider.apiFormat || 'openai',
                    authMode: matchedPreset.authMode || editableProvider.authMode || 'api-key',
                },
            }));
        } catch (e: any) {
            void messageApi.error(e?.message || t('ai_settings.message.load_provider_failed'));
        }
    };

    const handleDeleteProvider = async (id: string) => {
        try {
            const Service = (window as any).go?.aiservice?.Service;
            const wasActive = id === activeProviderId;
            await Service?.AIDeleteProvider?.(id);
            await loadConfig();
            // 合并提示：删除的是当前激活的供应商时，附带自动切换信息
            if (wasActive) {
                const newProviders: any[] = await Service?.AIGetProviders?.() || [];
                if (newProviders.length > 0) {
                    const newActiveName = newProviders[0]?.name || t('ai_settings.provider.next_provider');
                    void messageApi.success(t('ai_settings.message.deleted_and_switched', { name: newActiveName }));
                } else {
                    void messageApi.success(t('ai_settings.message.deleted'));
                }
            } else {
                void messageApi.success(t('ai_settings.message.deleted'));
            }
            window.dispatchEvent(new CustomEvent('gonavi:ai:provider-changed'));
        } catch (e: any) { void messageApi.error(e?.message || t('ai_settings.message.delete_failed')); }
    };

    const handleSaveProvider = async () => {
        try {
            const values = await form.validateFields();
            setLoading(true);
            const Service = (window as any).go?.aiservice?.Service;
            
            // 构建 payload，处理 model/models 逻辑
            const preset = findPreset(values.presetKey);
            const localizedPreset = localizeProviderPreset(preset, t);
            const authMode = preset.authMode || 'api-key';
            const usesLocalCLI = authMode === 'local-cli';
            const isCustomLike = ['custom', 'ollama', 'codebuddy', 'cursor'].includes(values.presetKey);
            const { model: finalModel, models: resolvedModels } = resolvePresetModelSelection({
                presetKey: values.presetKey,
                presetDefaultModel: preset.defaultModel,
                presetModels: preset.models,
                valuesModel: values.model,
                customModels: values.models,
            });
            const inlineCompletionModel = String(values.inlineCompletionModel || '').trim();
            // 内置供应商自动使用 preset label 作为名称
            const finalName = isCustomLike ? (values.name || localizedPreset.label) : localizedPreset.label;
            
            const finalBaseUrl = resolvePresetBaseURL({
                presetKey: values.presetKey,
                presetDefaultBaseUrl: preset.defaultBaseUrl,
                presetEndpoints: preset.endpoints,
                valuesBaseUrl: values.baseUrl,
            });
            const resolvedTransport = resolvePresetTransport({
                presetKey: values.presetKey,
                presetBackendType: preset.backendType,
                presetFixedApiFormat: preset.fixedApiFormat,
                presetEndpoints: preset.endpoints,
                valuesBaseUrl: finalBaseUrl,
                valuesApiFormat: values.apiFormat,
            });
            const apiKeyInput = usesLocalCLI ? '' : values.apiKey;
            const allowEmptySecret = values.presetKey === 'codebuddy';
            if (!isProviderSecretRequirementSatisfied({
                apiKeyInput,
                currentAuthMode: authMode,
                editingProvider,
                allowEmptySecret,
            })) {
                throw new Error(t('ai_settings.form.api_key_required'));
            }
            const retainExistingSecret = !String(apiKeyInput || '').trim()
                && canRetainExistingProviderSecret({ currentAuthMode: authMode, editingProvider });
            const secretDraft = resolveProviderSecretDraft({
                apiKeyInput,
                retainExistingSecret,
            });
            const payload = { 
                ...editingProvider, 
                ...values, 
                ...resolvedTransport,
                name: finalName,
                apiKey: secretDraft.apiKey,
                hasSecret: secretDraft.hasSecret,
                authMode,
                model: finalModel,
                inlineCompletionModel,
                models: resolvedModels,
                baseUrl: finalBaseUrl,
                apiFormat: resolvedTransport.apiFormat,
            };
            // 后端 AISaveProvider 统一处理新增和更新，返回 void，失败抛异常
            await Service?.AISaveProvider?.(payload);
            void messageApi.success(t('ai_settings.message.saved')); resetProviderEditorSession(); void loadConfig();
            window.dispatchEvent(new CustomEvent('gonavi:ai:provider-changed'));
        } catch (e: any) {
            if (e?.errorFields) { /* antd form validation error, ignore */ }
            else void messageApi.error(e?.message || t('ai_settings.message.save_failed'));
        } finally { setLoading(false); }
    };

    const handleSetActive = async (id: string) => {
        try {
            const Service = (window as any).go?.aiservice?.Service;
            await Service?.AISetActiveProvider?.(id);
            setActiveProviderId(id); void messageApi.success(t('ai_settings.message.switched'));
            window.dispatchEvent(new CustomEvent('gonavi:ai:provider-changed'));
        } catch (e: any) { void messageApi.error(e?.message || t('ai_settings.message.switch_failed')); }
    };

    const handleSafetyChange = async (level: AISafetyLevel) => {
        try {
            const Service = (window as any).go?.aiservice?.Service;
            await Service?.AISetSafetyLevel?.(level);
            setSafetyLevel(level);
        } catch (e) { /* ignore */ }
    };

    const handleContextChange = async (level: AIContextLevel) => {
        try {
            const Service = (window as any).go?.aiservice?.Service;
            await Service?.AISetContextLevel?.(level);
            setContextLevel(level);
        } catch (e) { /* ignore */ }
    };

    const handleSaveUserPromptSettings = async () => {
        try {
            setLoading(true);
            const Service = (window as any).go?.aiservice?.Service;
            const payload = {
                global: String(userPromptSettings.global || ''),
                database: String(userPromptSettings.database || ''),
                jvm: String(userPromptSettings.jvm || ''),
                jvmDiagnostic: String(userPromptSettings.jvmDiagnostic || ''),
            };
            await Service?.AISaveUserPromptSettings?.(payload);
            setUserPromptSettings(payload);
            void messageApi.success(t('ai_settings.prompts.message.saved'));
            window.dispatchEvent(new CustomEvent('gonavi:ai:config-changed'));
        } catch (e: any) {
            void messageApi.error(e?.message || t('ai_settings.prompts.message.save_failed'));
        } finally {
            setLoading(false);
        }
    };

    const updateMCPServerDraft = (id: string, patch: Partial<AIMCPServerConfig>) => {
        setMCPServers((prev) => prev.map((item) => item.id === id ? { ...item, ...patch } : item));
    };

    const handleAddMCPServer = (seed?: Partial<AIMCPServerConfig>) => {
        setMCPServers((prev) => [...prev, EMPTY_MCP_SERVER(seed)]);
    };

    const handleSaveMCPServer = async (server: AIMCPServerConfig) => {
        try {
            setLoading(true);
            const Service = (window as any).go?.aiservice?.Service;
            await Service?.AISaveMCPServer?.(server);
            await loadConfig();
            void messageApi.success(t('ai_settings.mcp_server.message.saved'));
            window.dispatchEvent(new CustomEvent('gonavi:ai:config-changed'));
        } catch (e: any) {
            void messageApi.error(e?.message || t('ai_settings.mcp_server.message.save_failed'));
        } finally {
            setLoading(false);
        }
    };

    const handleDeleteMCPServer = async (id: string) => {
        try {
            setLoading(true);
            const Service = (window as any).go?.aiservice?.Service;
            if (typeof Service?.AIDeleteMCPServer === 'function' && !String(id).startsWith('mcp-draft-')) {
                await Service.AIDeleteMCPServer(id);
                await loadConfig();
                window.dispatchEvent(new CustomEvent('gonavi:ai:config-changed'));
            } else {
                setMCPServers((prev) => prev.filter((item) => item.id !== id));
            }
            void messageApi.success(t('ai_settings.mcp_server.message.deleted'));
        } catch (e: any) {
            void messageApi.error(e?.message || t('ai_settings.mcp_server.message.delete_failed'));
        } finally {
            setLoading(false);
        }
    };

    const handleTestMCPServer = async (server: AIMCPServerConfig) => {
        try {
            setLoading(true);
            const Service = (window as any).go?.aiservice?.Service;
            const res = await Service?.AITestMCPServer?.(server);
            if (res?.success) {
                void messageApi.success(res?.message || t('ai_settings.mcp_server.message.test_success'));
                if (typeof Service?.AIListMCPTools === 'function') {
                    const nextTools = await Service.AIListMCPTools();
                    if (Array.isArray(nextTools)) setMCPTools(nextTools);
                } else if (Array.isArray(res?.tools)) {
                    setMCPTools(res.tools);
                }
            } else {
                void messageApi.error(res?.message || t('ai_settings.mcp_server.message.test_failed'));
            }
        } catch (e: any) {
            void messageApi.error(e?.message || t('ai_settings.mcp_server.message.test_request_failed'));
        } finally {
            setLoading(false);
        }
    };

    const handleToggleMCPHTTPServer = async (checked: boolean) => {
        let Service: any;
        try {
            setMCPHTTPServerLoading(true);
            Service = await resolveAIService();
            if (!Service) {
                throw new Error(t('ai_settings.mcp_http.error.control_unsupported_runtime'));
            }
            if (checked && typeof Service.AIStartMCPHTTPServer !== 'function') {
                throw new Error(t('ai_settings.mcp_http.error.start_unsupported_version'));
            }
            if (!checked && typeof Service.AIStopMCPHTTPServer !== 'function') {
                throw new Error(t('ai_settings.mcp_http.error.stop_unsupported_version'));
            }
            if (checked) {
                await onBeforeExternalMCPUse?.();
            }
            const nextStatus = checked
                ? await Service.AIStartMCPHTTPServer({
                    addr: mcpHTTPServerDraft.addr || DEFAULT_MCP_HTTP_SERVER_STATUS.addr,
                    path: mcpHTTPServerDraft.path || DEFAULT_MCP_HTTP_SERVER_STATUS.path,
                    token: normalizeMCPHTTPAuthorizationToken(mcpHTTPServerDraft.authorizationHeader),
                    schemaOnly: mcpHTTPServerDraft.schemaOnly === true,
                })
                : await Service.AIStopMCPHTTPServer();
            if (nextStatus) {
                const normalizedStatus = {
                    ...defaultMCPHTTPServerStatus,
                    ...nextStatus,
                };
                setMCPHTTPServerStatus(normalizedStatus);
                setMCPHTTPServerDraft((prev) => buildMCPHTTPServerDraftFromStatus(normalizedStatus, prev));
            }
            void messageApi.success(checked ? t('ai_settings.mcp_http.message.started') : t('ai_settings.mcp_http.message.stopped'));
        } catch (e: any) {
            try {
                const refreshedStatus = await Service?.AIGetMCPHTTPServerStatus?.();
                if (refreshedStatus) {
                    const normalizedStatus = {
                        ...defaultMCPHTTPServerStatus,
                        ...refreshedStatus,
                    };
                    setMCPHTTPServerStatus(normalizedStatus);
                    setMCPHTTPServerDraft((prev) => buildMCPHTTPServerDraftFromStatus(normalizedStatus, prev));
                }
            } catch {
                // 状态回填仅用于反映已持久化的开关意图，保留原始操作错误提示。
            }
            void messageApi.error(e?.message || t('ai_settings.mcp_http.message.toggle_failed'));
        } finally {
            setMCPHTTPServerLoading(false);
        }
    };

    const handleUpdateMCPHTTPServerDraft = (patch: Partial<AIMCPHTTPServerDraft>) => {
        setMCPHTTPServerDraft((prev) => ({
            ...prev,
            ...patch,
        }));
    };

    const handleCopyMCPHTTPServerURL = async () => {
        const url = String(mcpHTTPServerStatus.url || '').trim();
        if (!url) {
            void messageApi.error(t('ai_settings.mcp_http.message.url_unavailable'));
            return;
        }
        await copyTextToClipboard(url, t('ai_settings.mcp_http.message.url_copied'));
    };

    const handleCopyMCPHTTPServerAuthorization = async () => {
        const authorizationHeader = String(mcpHTTPServerStatus.authorizationHeader || '').trim();
        if (!authorizationHeader) {
            void messageApi.error(t('ai_settings.mcp_http.message.authorization_header_required'));
            return;
        }
        await copyTextToClipboard(`Authorization: ${authorizationHeader}`, t('ai_settings.mcp_http.message.authorization_header_copied'));
    };

    const updateSkillDraft = (id: string, patch: Partial<AISkillConfig>) => {
        setSkills((prev) => prev.map((item) => item.id === id ? { ...item, ...patch } : item));
    };

    const handleAddSkill = () => {
        setSkills((prev) => [...prev, EMPTY_SKILL()]);
    };

    const handleSaveSkill = async (skill: AISkillConfig) => {
        try {
            setLoading(true);
            const Service = (window as any).go?.aiservice?.Service;
            await Service?.AISaveSkill?.(skill);
            await loadConfig();
            void messageApi.success(t('ai_settings.skill.message.saved'));
            window.dispatchEvent(new CustomEvent('gonavi:ai:config-changed'));
        } catch (e: any) {
            void messageApi.error(e?.message || t('ai_settings.skill.message.save_failed'));
        } finally {
            setLoading(false);
        }
    };

    const handleDeleteSkill = async (id: string) => {
        try {
            setLoading(true);
            const Service = (window as any).go?.aiservice?.Service;
            if (typeof Service?.AIDeleteSkill === 'function' && !String(id).startsWith('skill-draft-')) {
                await Service.AIDeleteSkill(id);
                await loadConfig();
                window.dispatchEvent(new CustomEvent('gonavi:ai:config-changed'));
            } else {
                setSkills((prev) => prev.filter((item) => item.id !== id));
            }
            void messageApi.success(t('ai_settings.skill.message.deleted'));
        } catch (e: any) {
            void messageApi.error(e?.message || t('ai_settings.skill.message.delete_failed'));
        } finally {
            setLoading(false);
        }
    };

    const handleTestProvider = async () => {
        try {
            const values = await form.validateFields();
            setLoading(true);
            setTestStatus('idle');
            const Service = (window as any).go?.aiservice?.Service;
            const preset = findPreset(values.presetKey || 'openai');
            const authMode = preset.authMode || 'api-key';
            const usesLocalCLI = authMode === 'local-cli';
            const finalBaseUrl = resolvePresetBaseURL({
                presetKey: values.presetKey || 'openai',
                presetDefaultBaseUrl: preset.defaultBaseUrl,
                presetEndpoints: preset.endpoints,
                valuesBaseUrl: values.baseUrl,
            });
            const { model: finalModel, models: resolvedModels } = resolvePresetModelSelection({
                presetKey: values.presetKey || 'openai',
                presetDefaultModel: preset.defaultModel,
                presetModels: preset.models,
                valuesModel: values.model,
                customModels: values.models,
            });
            const resolvedTransport = resolvePresetTransport({
                presetKey: values.presetKey || 'openai',
                presetBackendType: preset.backendType,
                presetFixedApiFormat: preset.fixedApiFormat,
                presetEndpoints: preset.endpoints,
                valuesBaseUrl: finalBaseUrl,
                valuesApiFormat: values.apiFormat,
            });
            const allowEmptySecret = values.presetKey === 'codebuddy';
            const apiKeyInput = usesLocalCLI ? '' : values.apiKey;
            if (!isProviderSecretRequirementSatisfied({
                apiKeyInput,
                currentAuthMode: authMode,
                editingProvider,
                allowEmptySecret,
            })) {
                throw new Error(t('ai_settings.message.test_requires_new_api_key'));
            }
            const retainExistingSecret = !String(apiKeyInput || '').trim()
                && canRetainExistingProviderSecret({ currentAuthMode: authMode, editingProvider });
            const secretDraft = resolveProviderSecretDraft({
                apiKeyInput,
                retainExistingSecret,
            });
            const res = await Service?.AITestProvider?.({
                ...editingProvider,
                ...values,
                ...resolvedTransport,
                apiKey: secretDraft.apiKey,
                hasSecret: secretDraft.hasSecret,
                authMode,
                baseUrl: finalBaseUrl,
                model: finalModel,
                inlineCompletionModel: String(values.inlineCompletionModel || '').trim(),
                models: resolvedModels,
                maxTokens: Number(values.maxTokens) || 4096,
                temperature: Number(values.temperature) ?? 0.7,
                apiFormat: resolvedTransport.apiFormat,
            });
            if (res?.success) { setTestStatus('success'); void messageApi.success(t('ai_settings.message.test_success')); }
            else { setTestStatus('error'); void messageApi.error(res?.message || t('ai_settings.message.test_failed')); }
        } catch (e: any) { setTestStatus('error'); void messageApi.error(e?.message || t('ai_settings.message.test_failed')); }
        finally { setLoading(false); }
    };

    const handlePresetChange = (presetKey: string) => {
        const preset = findPreset(presetKey);
        const authMode = preset.authMode || 'api-key';
        const resolvedTransport = resolvePresetTransport({
            presetKey,
            presetBackendType: preset.backendType,
            presetFixedApiFormat: preset.fixedApiFormat,
            presetEndpoints: preset.endpoints,
            valuesBaseUrl: preset.defaultBaseUrl,
            valuesApiFormat: form.getFieldValue('apiFormat'),
        });
        const { model: presetModel, models: presetModels } = resolvePresetModelSelection({
            presetKey,
            presetDefaultModel: preset.defaultModel,
            presetModels: preset.models,
            customModels: preset.models,
        });
        form.setFieldsValue({
            presetKey,
            type: resolvedTransport.type,
            apiFormat: resolvedTransport.apiFormat || 'openai',
            baseUrl: preset.defaultBaseUrl,
            model: presetModel,
            models: presetModels,
            inlineCompletionModel: '',
            authMode,
            ...(authMode === 'local-cli' ? { apiKey: '' } : {}),
        });
    };

    const renderSectionPanel = (sectionKey: AISettingsSectionKey, content: React.ReactNode) => {
        const sectionMeta = AI_SETTINGS_NAV_ITEMS.find((item) => item.key === sectionKey) ?? AI_SETTINGS_NAV_ITEMS[0]!;
        return (
            <section
                key={sectionKey}
                id={`gonavi-ai-settings-panel-${sectionKey}`}
                role="tabpanel"
                aria-labelledby={`gonavi-ai-settings-tab-${sectionKey}`}
                hidden={activeSection !== sectionKey}
            >
                <div style={{ paddingBottom: 12, marginBottom: 2 }}>
                    <div style={{ fontSize: 'var(--gn-font-size, 14px)', fontWeight: 700, color: overlayTheme.titleText }}>
                        {t(sectionMeta.titleKey)}
                    </div>
                    <div style={{ marginTop: 3, fontSize: 'var(--gn-font-size-sm, 12px)', lineHeight: 1.55, color: overlayTheme.mutedText }}>
                        {t(sectionMeta.descriptionKey)}
                    </div>
                </div>
                {content}
            </section>
        );
    };

    return (
        <div ref={modalBodyRef} className="ai-settings-body gonavi-ai-settings-flat" style={{ display: 'grid', gridTemplateColumns: '168px minmax(0, 1fr)', gap: 0, padding: '10px 0', height: '100%', minHeight: 0, overflow: 'hidden', alignItems: 'stretch', position: 'relative', boxSizing: 'border-box' }}>
            {messageContextHolder}
            <AISettingsSidebar
                activeSection={activeSection}
                darkMode={darkMode}
                overlayTheme={overlayTheme}
                onSelectSection={setActiveSection}
            />
            <div
                ref={settingsContentScrollRef}
                className="gonavi-ai-settings-content"
                style={{ minWidth: 0, minHeight: 0, height: '100%', overflowY: 'auto', overflowX: 'hidden', overscrollBehavior: 'contain', padding: '0 6px 24px 22px' }}
            >
                {renderSectionPanel('providers', (
                    <AISettingsProvidersSection
                        providers={providers}
                        activeProviderId={activeProviderId}
                        editingProvider={editingProvider}
                        isEditing={isEditing}
                        form={form}
                        providerPresets={localizedProviderPresets}
                        watchedPresetKey={watchedPresetKey}
                        watchedApiFormat={watchedApiFormat}
                        loading={loading}
                        testStatus={testStatus}
                        primaryPasswordVisible={primaryPasswordVisible}
                        darkMode={darkMode}
                        overlayTheme={overlayTheme}
                        cardBg={cardBg}
                        cardBorder={cardBorder}
                        inputBg={inputBg}
                        onPrimaryPasswordVisibleChange={setPrimaryPasswordVisible}
                        resolveProviderPreset={matchLocalizedProviderPreset}
                        resolvePresetByKey={findLocalizedPreset}
                        onAddProvider={handleAddProvider}
                        onEditProvider={handleEditProvider}
                        onDeleteProvider={handleDeleteProvider}
                        onSetActiveProvider={handleSetActive}
                        onCancelEdit={resetProviderEditorSession}
                        onPresetChange={handlePresetChange}
                        onTestProvider={handleTestProvider}
                        onSaveProvider={handleSaveProvider}
                    />
                ))}
                {renderSectionPanel('safety', (
                    <AISettingsSafetySection
                        safetyLevel={safetyLevel}
                        darkMode={darkMode}
                        overlayTheme={overlayTheme}
                        cardBg={cardBg}
                        cardBorder={cardBorder}
                        onChange={handleSafetyChange}
                    />
                ))}
                {renderSectionPanel('context', (
                    <AISettingsContextSection
                        contextLevel={contextLevel}
                        openMode={aiChatOpenMode}
                        darkMode={darkMode}
                        overlayTheme={overlayTheme}
                        cardBg={cardBg}
                        cardBorder={cardBorder}
                        onChange={handleContextChange}
                        onOpenModeChange={(mode) => {
                            setAIChatOpenMode(mode);
                            void messageApi.success(
                                mode === 'detached'
                                    ? t('ai_settings.open_mode.message.detached')
                                    : t('ai_settings.open_mode.message.dock'),
                            );
                        }}
                    />
                ))}
                {renderSectionPanel('mcp', (
                    <AISettingsMCPSection
                        mcpClientStatuses={mcpClientStatuses}
                        selectedMCPClient={selectedMCPClient}
                        selectedMCPClientStatus={selectedMCPClientStatus}
                        selectedMCPClientCommandText={selectedMCPClientCommandText}
                        mcpHTTPServerStatus={mcpHTTPServerStatus}
                        mcpHTTPServerDraft={mcpHTTPServerDraft}
                        mcpServers={mcpServers}
                        mcpTools={mcpTools}
                        darkMode={darkMode}
                        overlayTheme={overlayTheme}
                        cardBg={cardBg}
                        cardBorder={cardBorder}
                        inputBg={inputBg}
                        loading={loading}
                        mcpClientStatusLoading={mcpClientStatusLoading}
                        mcpHTTPServerLoading={mcpHTTPServerLoading}
                        onUpdateHTTPServerDraft={handleUpdateMCPHTTPServerDraft}
                        onToggleHTTPServer={handleToggleMCPHTTPServer}
                        onCopyHTTPServerURL={() => void handleCopyMCPHTTPServerURL()}
                        onCopyHTTPServerAuthorization={() => void handleCopyMCPHTTPServerAuthorization()}
                        onSelectClient={handleSelectMCPClient}
                        onRefreshStatus={() => void loadMCPClientStatuses()}
                        onCopyConfigPath={() => void handleCopySelectedMCPConfigPath()}
                        onCopyLaunchCommand={() => void handleCopySelectedMCPLaunchCommand()}
                        onInstallSelectedClient={handleInstallSelectedMCPClient}
                        onAddServer={handleAddMCPServer}
                        onUpdateServerDraft={updateMCPServerDraft}
                        onTestServer={handleTestMCPServer}
                        onSaveServer={handleSaveMCPServer}
                        onDeleteServer={handleDeleteMCPServer}
                    />
                ))}
                {renderSectionPanel('skills', (
                    <AISettingsSkillsSection
                        skills={skills}
                        skillRequiredToolOptions={skillRequiredToolOptions}
                        overlayTheme={overlayTheme}
                        cardBg={cardBg}
                        cardBorder={cardBorder}
                        inputBg={inputBg}
                        loading={loading}
                        onAddSkill={handleAddSkill}
                        onUpdateSkillDraft={updateSkillDraft}
                        onSaveSkill={handleSaveSkill}
                        onDeleteSkill={handleDeleteSkill}
                    />
                ))}
                {renderSectionPanel('tools', (
                    <AIBuiltinToolsCatalog
                        darkMode={darkMode}
                        overlayTheme={overlayTheme}
                        cardBg={cardBg}
                        cardBorder={cardBorder}
                    />
                ))}
                {renderSectionPanel('prompts', (
                    <AISettingsPromptsSection
                        builtinPrompts={builtinPrompts}
                        userPromptSettings={userPromptSettings}
                        overlayTheme={overlayTheme}
                        cardBg={cardBg}
                        cardBorder={cardBorder}
                        inputBg={inputBg}
                        darkMode={darkMode}
                        loading={loading}
                        onChangeUserPrompt={(key, value) => setUserPromptSettings((prev) => ({
                            ...prev,
                            [key]: value,
                        }))}
                        onSave={handleSaveUserPromptSettings}
                    />
                ))}
            </div>
        </div>
    );
};

const AISettingsModal: React.FC<AISettingsModalProps> = ({ open, onClose, darkMode, overlayTheme, focusProviderId, onBeforeExternalMCPUse }) => {
    const { t } = useI18n();
    const modalShellStyle = {
        background: overlayTheme.shellBg, border: overlayTheme.shellBorder,
        boxShadow: overlayTheme.shellShadow, backdropFilter: overlayTheme.shellBackdropFilter,
    };

    return (
        <Modal
            title={
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                    <div style={{
                        width: 38, height: 38, borderRadius: 12, display: 'grid', placeItems: 'center',
                        background: overlayTheme.iconBg, color: overlayTheme.iconColor, fontSize: 18, flexShrink: 0,
                    }}>
                        <RobotOutlined />
                    </div>
                    <div>
                        <div style={{ fontSize: 16, fontWeight: 800, color: overlayTheme.titleText }}>{t('ai_settings.title')}</div>
                        <div style={{ marginTop: 3, color: overlayTheme.mutedText, fontSize: 12 }}>
                            {t('ai_settings.subtitle')}
                        </div>
                    </div>
                </div>
            }
            open={open}
            onCancel={onClose}
            footer={null}
            width={820}
            styles={{
                content: modalShellStyle,
                header: { background: 'transparent', borderBottom: 'none', paddingBottom: 8 },
                body: { paddingTop: 8, height: 620, overflow: 'hidden' },
            }}
        >
              <AISettingsContent
                active={open}
                darkMode={darkMode}
                overlayTheme={overlayTheme}
                focusProviderId={focusProviderId}
                onBeforeExternalMCPUse={onBeforeExternalMCPUse}
              />
        </Modal>
    );
};

export default AISettingsModal;
