import Modal from './common/ResizableDraggableModal';
import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Form, message as antdMessage } from 'antd';
import { RobotOutlined } from '@ant-design/icons';
import { v4 as uuidv4 } from 'uuid';
import type { AIProviderConfig, AIProviderType, AISafetyLevel, AIContextLevel, AIUserPromptSettings, AIMCPServerConfig, AIMCPToolDescriptor, AIMCPHTTPServerStatus, AISkillConfig } from '../types';
import type { ai } from '../../wailsjs/go/models';
import { getCLIConfigPrefill, normalizeProviderModels, parseProviderCheckResult, providerCopyName, providerDraftFingerprint, type ProviderCheckResult } from '../utils/aiProviderManagement';
import { withAISettingsLeaveGuard, type AISettingsLeaveGuard } from '../utils/aiSettingsLeaveGuard';
import { APP_STATIC_FEEDBACK_Z_INDEX_BASE } from '../utils/overlayZIndex';
import { getProviderEndpointType, resolveProviderEndpointConnection, type ProviderEndpointType } from '../utils/aiProviderEndpoints';
import {
    getSingletonCLIIdentity,
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
import AIBuiltinToolsCatalog from './ai/AIBuiltinToolsCatalog';
import AISettingsMCPSection from './ai/AISettingsMCPSection';
import type { AIMCPHTTPServerDraft } from './ai/AIMCPHTTPServerPanel';
import AISettingsSidebar, { AI_SETTINGS_NAV_ITEMS, type AISettingsSectionKey } from './ai/AISettingsSidebar';
import AISettingsSafetySection from './ai/AISettingsSafetySection';
import AISettingsContextSection from './ai/AISettingsContextSection';
import AISettingsRunPolicySection from './ai/AISettingsRunPolicySection';
import AISettingsProvidersSection from './ai/AISettingsProvidersSection';
import AISettingsPromptsSection from './ai/AISettingsPromptsSection';
import AISettingsSkillsSection from './ai/AISettingsSkillsSection';
import {
    DEFAULT_AI_RUN_POLICY,
    DEFAULT_AI_RUN_RUNTIME_CONFIG,
    isValidAIRunRuntimeConfig,
    normalizeAIRunPolicySnapshot,
    type AIRunPolicy,
    type AIRunRuntimeConfig,
} from './ai/aiRunPolicy';
import { normalizeAgentLedgerState, type AgentLedgerState } from './ai/aiRunHarnessClient';
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
    onLeaveGuardChange?: (guard: AISettingsLeaveGuard | null) => void;
    confirmationZIndex?: number;
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

export const AISettingsContent: React.FC<AISettingsContentProps> = ({ active, darkMode, overlayTheme, focusProviderId, onBeforeExternalMCPUse, onLeaveGuardChange, confirmationZIndex = APP_STATIC_FEEDBACK_Z_INDEX_BASE }) => {
    const { t } = useI18n();
    const defaultMCPHTTPServerStatus = useMemo<AIMCPHTTPServerStatus>(() => ({
        ...DEFAULT_MCP_HTTP_SERVER_STATUS,
        message: t('ai_settings.mcp_http.status.not_running'),
    }), [t]);
    const [providers, setProviders] = useState<AIProviderConfig[]>([]);
    const [activeProviderId, setActiveProviderId] = useState<string>('');
    const [pendingProviderId, setPendingProviderId] = useState<string>('');
    const [providersLoading, setProvidersLoading] = useState(false);
    const [providersLoadError, setProvidersLoadError] = useState('');
    const [safetyLevel, setSafetyLevel] = useState<AISafetyLevel>('readonly');
    const [contextLevel, setContextLevel] = useState<AIContextLevel>('schema_only');
    const [runPolicy, setRunPolicy] = useState<AIRunPolicy>(DEFAULT_AI_RUN_POLICY);
    const [runRuntime, setRunRuntime] = useState<AIRunRuntimeConfig>(DEFAULT_AI_RUN_RUNTIME_CONFIG);
    const [runPolicyRevision, setRunPolicyRevision] = useState<number>(0);
    const [runPolicyLoading, setRunPolicyLoading] = useState(false);
    const [runPolicySaving, setRunPolicySaving] = useState(false);
    const [runPolicyError, setRunPolicyError] = useState('');
    const [ledgerState, setLedgerState] = useState<AgentLedgerState>('unavailable');
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
    const [testResult, setTestResult] = useState<ProviderCheckResult | null>(null);
    const [providerTesting, setProviderTesting] = useState(false);
    const [providerSaving, setProviderSaving] = useState(false);
    const [providerSaveMode, setProviderSaveMode] = useState<'save' | 'copy'>('save');
    const [providerDirty, setProviderDirty] = useState(false);
    const [builtinPrompts, setBuiltinPrompts] = useState<Record<string, string>>({});
    const [userPromptSettings, setUserPromptSettings] = useState<AIUserPromptSettings>(EMPTY_AI_USER_PROMPT_SETTINGS);
    const [activeSection, setActiveSection] = useState<AISettingsSectionKey>('providers');
    const [primaryPasswordVisible, setPrimaryPasswordVisible] = useState(false);
    const [form] = Form.useForm();
    const modalBodyRef = useRef<HTMLDivElement>(null);
    const settingsContentScrollRef = useRef<HTMLDivElement>(null);
    const missingAIServiceWarnedRef = useRef(false);
    const mountedRef = useRef(true);
    const activeRef = useRef(active);
    activeRef.current = active;
    const committedProviderRef = useRef('');
    const switchTargetRef = useRef<string | null>(null);
    const switchRunningRef = useRef(false);
    const providerLoadSequenceRef = useRef(0);
    const sectionLoadSequenceRef = useRef(0);
    const editorSessionRef = useRef(0);
    const configRevisionRef = useRef(0);
    const testRequestRef = useRef(0);
    const saveRunningRef = useRef(false);
    const editedFieldsRef = useRef(new Set<string>());
    const providerDirtyRef = useRef(false);
    const providerBaselineRef = useRef<Record<string, unknown>>({});
    const discardConfirmationRef = useRef<Promise<boolean> | null>(null);
    const cancelDiscardRef = useRef<(() => void) | null>(null);

    useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
            editorSessionRef.current++;
            testRequestRef.current++;
            providerLoadSequenceRef.current++;
            sectionLoadSequenceRef.current++;
            switchTargetRef.current = null;
            cancelDiscardRef.current?.();
        };
    }, []);

    const invalidateProviderTest = useCallback(() => {
        configRevisionRef.current++;
        testRequestRef.current++;
        setTestStatus('idle');
        setTestResult(null);
        setProviderTesting(false);
    }, []);

    const refreshProviderDirty = useCallback(() => {
        const dirty = providerDraftFingerprint(form.getFieldsValue(true)) !== providerDraftFingerprint(providerBaselineRef.current);
        providerDirtyRef.current = dirty;
        setProviderDirty(dirty);
    }, [form]);

    const handleProviderValuesChange = useCallback((changed: Record<string, unknown>) => {
        Object.keys(changed).forEach((key) => editedFieldsRef.current.add(key));
        invalidateProviderTest();
        refreshProviderDirty();
    }, [invalidateProviderTest, refreshProviderDirty]);

    const handleCLIDefaults = useCallback((capability: ai.CLICapabilityView) => {
        if (capability.apiFormat !== form.getFieldValue('apiFormat')) return;
        const patch = getCLIConfigPrefill(capability, form.getFieldsValue(true), editedFieldsRef.current, isEditing && !editingProvider?.id);
        if (Object.keys(patch).length) {
            invalidateProviderTest();
            form.setFieldsValue(patch);
            // Automatic discovery is an initial value, not a user edit. Keep
            // any other edited fields dirty without overwriting their input.
            providerBaselineRef.current = { ...providerBaselineRef.current, ...patch };
            refreshProviderDirty();
        }
    }, [editingProvider?.id, form, invalidateProviderTest, isEditing, refreshProviderDirty]);
    const aiChatOpenMode = useStore((state) => state.aiChatOpenMode);
    const setAIChatOpenMode = useStore((state) => state.setAIChatOpenMode);

    // Modal 内部 toast 通知
    const [messageApi, messageContextHolder] = antdMessage.useMessage({ getContainer: () => modalBodyRef.current || document.body });
    const [modalApi, modalContextHolder] = Modal.useModal();

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
    const loadMCPClientStatusesRef = useRef(loadMCPClientStatuses);
    loadMCPClientStatusesRef.current = loadMCPClientStatuses;

    const loadProviders = useCallback(async () => {
        const sequence = ++providerLoadSequenceRef.current;
        setProvidersLoading(true);
        setProvidersLoadError('');
        try {
            const Service = await resolveAIService();
            if (typeof Service?.AIGetProviders !== 'function' || typeof Service?.AIGetActiveProvider !== 'function') {
                throw new Error(t('ai_settings.message.bridge_unavailable'));
            }
            const [list, current] = await Promise.all([Service.AIGetProviders(), Service.AIGetActiveProvider()]);
            if (!mountedRef.current || sequence !== providerLoadSequenceRef.current) return;
            if (!Array.isArray(list) || typeof current !== 'string') throw new Error(t('ai_settings.message.load_provider_failed'));
            setProviders(list);
            committedProviderRef.current = current;
            setActiveProviderId(current);
        } catch (error: any) {
            if (mountedRef.current && sequence === providerLoadSequenceRef.current) {
                setProvidersLoadError(error?.message || String(error));
            }
        } finally {
            if (mountedRef.current && sequence === providerLoadSequenceRef.current) setProvidersLoading(false);
        }
    }, [resolveAIService, t]);

    // Each section owns its reads. Opening providers never starts MCP inspection.
    const loadConfig = useCallback(async () => {
        if (activeSection === 'providers' || activeSection === 'tools') return;
        const sequence = ++sectionLoadSequenceRef.current;
        const Service = await resolveAIService();
        if (!Service) return;
        const isCurrent = () => mountedRef.current && sequence === sectionLoadSequenceRef.current;
        const callOrFallback = async <T,>(loader: (() => Promise<T> | undefined), fallback: T): Promise<T> => {
            try { return (await loader()) ?? fallback; }
            catch (error) { console.warn('[AI] settings load fallback', error); return fallback; }
        };
        switch (activeSection) {
            case 'safety': {
                const value = await callOrFallback<AISafetyLevel>(() => Service.AIGetSafetyLevel?.(), 'readonly');
                if (isCurrent()) setSafetyLevel(value);
                break;
            }
            case 'context': {
                const value = await callOrFallback<AIContextLevel>(() => Service.AIGetContextLevel?.(), 'schema_only');
                if (isCurrent()) setContextLevel(value);
                break;
            }
            case 'run_policy': {
                // Keep the health projection independent from policy loading:
                // a locked ledger must still be visible when policy reads fail.
                void (async () => {
                    try {
                        const status = typeof Service.AIGetAgentLedgerStatus === 'function'
                            ? await Service.AIGetAgentLedgerStatus()
                            : undefined;
                        if (isCurrent()) setLedgerState(normalizeAgentLedgerState(status));
                    } catch {
                        if (isCurrent()) setLedgerState('unavailable');
                    }
                })();
                if (typeof Service.AIGetRunPolicy !== 'function') {
                    if (isCurrent()) setRunPolicyError(t('ai_settings.run_policy.error.unavailable'));
                    break;
                }
                if (isCurrent()) {
                    setRunPolicyLoading(true);
                    setRunPolicyError('');
                }
                try {
                    const value = await Service.AIGetRunPolicy();
                    const snapshot = normalizeAIRunPolicySnapshot(value);
                    if (snapshot.revision < 1) {
                        throw new Error('run policy snapshot is missing a revision');
                    }
                    if (isCurrent()) {
                        setRunPolicy(snapshot.policy);
                        setRunRuntime(snapshot.runtime);
                        setRunPolicyRevision(snapshot.revision);
                    }
                } catch (error: any) {
                    if (isCurrent()) setRunPolicyError(error?.message || t('ai_settings.run_policy.error.load_failed'));
                } finally {
                    if (isCurrent()) setRunPolicyLoading(false);
                }
                break;
            }
            case 'prompts': {
                const [builtin, user] = await Promise.all([
                    callOrFallback(() => Service.AIGetBuiltinPrompts?.(), {}),
                    callOrFallback(() => Service.AIGetUserPromptSettings?.(), EMPTY_AI_USER_PROMPT_SETTINGS),
                ]);
                if (isCurrent()) {
                    setBuiltinPrompts(builtin);
                    setUserPromptSettings({ ...EMPTY_AI_USER_PROMPT_SETTINGS, ...user });
                }
                break;
            }
            case 'skills': {
                const [list, tools] = await Promise.all([
                    callOrFallback<AISkillConfig[]>(() => Service.AIGetSkills?.(), []),
                    callOrFallback<AIMCPToolDescriptor[]>(() => Service.AIListMCPTools?.(), []),
                ]);
                if (isCurrent()) { setSkills(list); setMCPTools(tools); }
                break;
            }
            case 'mcp': {
                // Client discovery may take seconds; it must not delay the other
                // MCP settings, nor any provider read or switch.
                void loadMCPClientStatusesRef.current();
                const [servers, tools, httpStatus] = await Promise.all([
                    callOrFallback<AIMCPServerConfig[]>(() => Service.AIGetMCPServers?.(), []),
                    callOrFallback<AIMCPToolDescriptor[]>(() => Service.AIListMCPTools?.(), []),
                    callOrFallback<AIMCPHTTPServerStatus>(() => Service.AIGetMCPHTTPServerStatus?.(), defaultMCPHTTPServerStatus),
                ]);
                if (isCurrent()) {
                    setMCPServers(servers);
                    setMCPTools(tools);
                    const nextStatus = { ...defaultMCPHTTPServerStatus, ...httpStatus };
                    setMCPHTTPServerStatus(nextStatus);
                    setMCPHTTPServerDraft((prev) => buildMCPHTTPServerDraftFromStatus(nextStatus, prev));
                }
                break;
            }
        }
    }, [activeSection, defaultMCPHTTPServerStatus, resolveAIService]);

    useEffect(() => {
        if (active) void loadProviders();
        return () => { providerLoadSequenceRef.current++; };
    }, [active, loadProviders]);
    useEffect(() => {
        if (active) void loadConfig();
        return () => { sectionLoadSequenceRef.current++; };
    }, [active, loadConfig]);

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
    }, [active, focusProviderId, providers]);

    const applyProviderEditorSession = useCallback((session: ProviderEditorSession) => {
        editorSessionRef.current++;
        editedFieldsRef.current.clear();
        invalidateProviderTest();
        setEditingProvider(session.editingProvider as AIProviderConfig | null);
        setIsEditing(session.isEditing);
        setPrimaryPasswordVisible(false);
        form.resetFields();
        if (session.formValues) {
            form.setFieldsValue(session.formValues);
        }
        providerBaselineRef.current = JSON.parse(providerDraftFingerprint(form.getFieldsValue(true)));
        providerDirtyRef.current = false;
        setProviderDirty(false);
    }, [form, invalidateProviderTest]);

    const resetProviderEditorSession = useCallback(() => {
        applyProviderEditorSession(buildClosedProviderEditorSession());
    }, [applyProviderEditorSession]);

    const confirmProviderLeave = useCallback<AISettingsLeaveGuard>(() => {
        if (saveRunningRef.current) {
            void messageApi.warning(t('ai_settings.provider.wait_for_save'));
            return false;
        }
        if (!providerDirtyRef.current) return true;
        if (discardConfirmationRef.current) return discardConfirmationRef.current;
        const confirmation = new Promise<boolean>((resolve) => {
            let settled = false;
            const finish = (discard: boolean) => {
                if (settled) return;
                settled = true;
                if (discard && mountedRef.current && activeRef.current) resetProviderEditorSession();
                cancelDiscardRef.current = null;
                resolve(discard && mountedRef.current && activeRef.current);
            };
            cancelDiscardRef.current = () => finish(false);
            modalApi.confirm({
                title: t('ai_settings.provider.discard_title'),
                content: t('ai_settings.provider.discard_hint'),
                centered: true,
                zIndex: confirmationZIndex,
                okText: t('ai_settings.provider.discard'),
                cancelText: t('ai_settings.provider.keep_editing'),
                onOk: () => finish(true),
                onCancel: () => finish(false),
                afterClose: () => finish(false),
            });
        }).finally(() => { discardConfirmationRef.current = null; });
        discardConfirmationRef.current = confirmation;
        return confirmation;
    }, [confirmationZIndex, messageApi, modalApi, resetProviderEditorSession, t]);

    useEffect(() => {
        onLeaveGuardChange?.(active ? confirmProviderLeave : null);
        return () => onLeaveGuardChange?.(null);
    }, [active, confirmProviderLeave, onLeaveGuardChange]);

    const handleCancelProviderEdit = () => withAISettingsLeaveGuard(confirmProviderLeave, resetProviderEditorSession);

    useEffect(() => {
        if (!active) {
            resetProviderEditorSession();
        }
    }, [active, resetProviderEditorSession]);
    const handleAddProvider = (presetKey = 'openai', endpointType?: ProviderEndpointType) => withAISettingsLeaveGuard(confirmProviderLeave, () => {
        const preset = findPreset(presetKey);
        const connection = resolveProviderEndpointConnection(preset, endpointType || getProviderEndpointType({
            type: preset.backendType, apiFormat: preset.fixedApiFormat || preset.defaultApiFormat,
        }) || 'openai');
        if (!connection) return;
        const identity = getSingletonCLIIdentity({ type: preset.backendType, apiFormat: preset.fixedApiFormat, authMode: preset.authMode });
        if (identity && providers.some((provider) => getSingletonCLIIdentity(provider) === identity)) {
            void messageApi.error(t('ai_settings.provider.duplicate_cli'));
            return;
        }
        applyProviderEditorSession(buildAddProviderEditorSession({
            presetKey,
            presetBackendType: connection.type,
            presetBaseUrl: connection.baseUrl,
            presetModel: preset.defaultModel,
            presetModels: preset.models,
            apiFormat: connection.apiFormat,
            authMode: preset.authMode || 'api-key',
        }));
    });

    const handleEditProvider = (p: AIProviderConfig) => withAISettingsLeaveGuard(confirmProviderLeave, async () => {
        const session = ++editorSessionRef.current;
        invalidateProviderTest();
        try {
            const Service = await resolveAIService();
            if (!mountedRef.current || !activeRef.current || session !== editorSessionRef.current) return;
            const editableProvider = typeof Service?.AIGetEditableProvider === 'function'
                ? await Service.AIGetEditableProvider(p.id)
                : p;
            if (!mountedRef.current || !activeRef.current || session !== editorSessionRef.current) return;
            // 尝试根据 baseUrl 和 type 推断 preset
            const matchedPreset = matchProviderPreset(editableProvider);
            const resolvedTransport = resolvePresetTransport({
                presetKey: matchedPreset.key,
                presetBackendType: matchedPreset.backendType,
                presetFixedApiFormat: matchedPreset.fixedApiFormat,
                presetDefaultApiFormat: matchedPreset.defaultApiFormat,
                presetEndpoints: matchedPreset.endpoints,
                valuesBaseUrl: editableProvider.baseUrl,
                valuesApiFormat: editableProvider.apiFormat,
                valuesModel: editableProvider.model,
            });
            applyProviderEditorSession(buildEditProviderEditorSession({
                provider: { ...editableProvider, presetKey: matchedPreset.key } as any,
                formValues: {
                    ...editableProvider,
                    type: resolvedTransport.type,
                    models: editableProvider.models || [],
                    presetKey: matchedPreset.key,
                    apiFormat: resolvedTransport.apiFormat || (resolvedTransport.type === 'custom' ? editableProvider.apiFormat || 'openai' : resolvedTransport.type),
                    authMode: matchedPreset.authMode || editableProvider.authMode || 'api-key',
                },
            }));
        } catch (e: any) {
            if (session === editorSessionRef.current && activeRef.current) void messageApi.error(e?.message || t('ai_settings.message.load_provider_failed'));
        }
    });

    const handleDeleteProvider = async (id: string) => {
        const session = editorSessionRef.current;
        try {
            const Service = await resolveAIService();
            if (typeof Service?.AIDeleteProvider !== 'function') throw new Error(t('ai_settings.message.bridge_unavailable'));
            const wasActive = id === committedProviderRef.current;
            await Service.AIDeleteProvider(id);
            if (session === editorSessionRef.current && editingProvider?.id === id) resetProviderEditorSession();
            await loadProviders();
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

    const buildProviderPayload = (values: Record<string, any>, purpose: 'save' | 'test'): AIProviderConfig => {
        // validateFields only returns mounted fields. Preserve stored options
        // that have no editor control (for example maxTokens and temperature).
        values = { ...form.getFieldsValue(true), ...values };
        const presetKey = values.presetKey || 'openai';
        const preset = findPreset(presetKey);
        const authMode = preset.authMode || 'api-key';
        const { model, models } = resolvePresetModelSelection({
            presetKey,
            presetDefaultModel: preset.defaultModel,
            presetModels: preset.models,
            valuesModel: values.model,
            customModels: values.models,
        });
        const baseUrl = resolvePresetBaseURL({
            presetKey,
            presetDefaultBaseUrl: preset.defaultBaseUrl,
            presetEndpoints: preset.endpoints,
            valuesBaseUrl: values.baseUrl,
        });
        const transport = resolvePresetTransport({
            presetKey,
            presetBackendType: preset.backendType,
            presetFixedApiFormat: preset.fixedApiFormat,
            presetDefaultApiFormat: preset.defaultApiFormat,
            presetEndpoints: preset.endpoints,
            valuesBaseUrl: baseUrl,
            valuesApiFormat: values.apiFormat,
            valuesModel: model,
        });
        const apiKeyInput = authMode === 'local-cli' ? '' : values.apiKey;
        if (!isProviderSecretRequirementSatisfied({ apiKeyInput, currentAuthMode: authMode, editingProvider, allowEmptySecret: presetKey === 'codebuddy' })) {
            throw new Error(t(purpose === 'test' ? 'ai_settings.message.test_requires_new_api_key' : 'ai_settings.form.api_key_required'));
        }
        const secret = resolveProviderSecretDraft({
            apiKeyInput,
            retainExistingSecret: !String(apiKeyInput || '').trim() && canRetainExistingProviderSecret({ currentAuthMode: authMode, editingProvider }),
        });
        const payload = {
            ...editingProvider,
            ...values,
            ...transport,
            name: String(values.name || '').trim() ? values.name : localizeProviderPreset(preset, t).label,
            apiKey: secret.apiKey,
            hasSecret: secret.hasSecret,
            authMode,
            baseUrl,
            model,
            models,
            disabledModels: normalizeProviderModels(values.disabledModels),
            customModels: normalizeProviderModels(values.customModels),
            effort: String(values.effort || ''),
            inlineCompletionModel: String(values.inlineCompletionModel || '').trim(),
            maxTokens: Number.isFinite(Number(values.maxTokens)) ? Number(values.maxTokens) : 4096,
            temperature: Number.isFinite(Number(values.temperature)) ? Number(values.temperature) : 0.7,
        } as AIProviderConfig;
        if (payload.disabledModels?.includes(model) || (payload.inlineCompletionModel && payload.disabledModels?.includes(payload.inlineCompletionModel))) {
            throw new Error(t('ai_settings.models.required_disabled'));
        }
        const identity = getSingletonCLIIdentity(payload);
        if (identity && (!editingProvider?.id || getSingletonCLIIdentity(editingProvider) !== identity)
            && providers.some((provider) => provider.id !== payload.id && getSingletonCLIIdentity(provider) === identity)) {
            throw new Error(t('ai_settings.provider.duplicate_cli'));
        }
        return payload;
    };

    const handleSaveProvider = async (mode: 'save' | 'copy' = 'save') => {
        if (saveRunningRef.current) return;
        saveRunningRef.current = true;
        const session = editorSessionRef.current;
        const revision = configRevisionRef.current;
        const isCurrent = () => mountedRef.current && activeRef.current && session === editorSessionRef.current;
        const draftUnchanged = () => {
            if (!isCurrent()) return false;
            if (revision === configRevisionRef.current) return true;
            void messageApi.warning(t('ai_settings.provider.draft_changed'));
            return false;
        };
        setProviderSaveMode(mode);
        setProviderSaving(true);
        try {
            const values = await form.validateFields();
            if (!draftUnchanged()) return;
            const draft = { ...form.getFieldsValue(true), ...values };
            let payload = buildProviderPayload(values, 'save');
            if (mode === 'copy' && (!editingProvider?.id || getSingletonCLIIdentity(payload))) {
                throw new Error(t('ai_settings.provider.copy_cli_unavailable'));
            }
            const Service = await resolveAIService();
            if (!draftUnchanged()) return;
            if (typeof Service?.AISaveProvider !== 'function') throw new Error(t('ai_settings.message.bridge_unavailable'));
            if (mode === 'copy') {
                // Secret metadata belongs to the old ID. Resolve it through the
                // existing editable-config interface before saving under a new
                // ID; never put credentials in browser storage or the clipboard.
                if (typeof Service.AIGetEditableProvider !== 'function') throw new Error(t('ai_settings.provider.copy_secret_unavailable'));
                const original = await Service.AIGetEditableProvider(editingProvider!.id);
                if (!draftUnchanged()) return;
                if (!original || original.id !== editingProvider!.id) throw new Error(t('ai_settings.provider.copy_secret_unavailable'));
                const apiKey = payload.apiKey || original.apiKey || '';
                if (payload.hasSecret && !apiKey) throw new Error(t('ai_settings.provider.copy_secret_unavailable'));
                payload = {
                    ...payload,
                    id: `provider-${uuidv4()}`,
                    name: providerCopyName(payload.name, providers.map((provider) => provider.name), t('ai_settings.provider.copy_suffix')),
                    apiKey,
                    headers: { ...original.headers, ...payload.headers },
                    secretRef: undefined,
                };
            } else if (!payload.id) payload = { ...payload, id: `provider-${uuidv4()}` };
            await Service.AISaveProvider(payload);
            if (isCurrent()) {
                if (revision === configRevisionRef.current) {
                    applyProviderEditorSession(buildEditProviderEditorSession({
                        provider: { ...payload, presetKey: draft.presetKey },
                        formValues: { ...draft, ...payload },
                    }));
                } else if (mode === 'save') {
                    // A newer draft remains editable after this snapshot saves.
                    // Adopt the new ID so retrying a first save cannot duplicate it.
                    setEditingProvider(payload);
                    form.setFieldValue('id', payload.id);
                    providerBaselineRef.current = { ...draft, id: payload.id };
                    refreshProviderDirty();
                    invalidateProviderTest();
                }
                void messageApi.success(t(mode === 'copy' ? 'ai_settings.provider.copied' : 'ai_settings.message.saved'));
            }
            if (mountedRef.current) void loadProviders();
            window.dispatchEvent(new CustomEvent('gonavi:ai:provider-changed'));
        } catch (error: any) {
            if (isCurrent() && !error?.errorFields) void messageApi.error(error?.message || String(error) || t('ai_settings.message.save_failed'));
        } finally {
            saveRunningRef.current = false;
            if (mountedRef.current) setProviderSaving(false);
        }
    };

    const handleSetActive = async (id: string) => {
        if (!switchRunningRef.current && id === committedProviderRef.current) return;
        switchTargetRef.current = id;
        setPendingProviderId(id);
        if (switchRunningRef.current) return;
        switchRunningRef.current = true;
        // Invalidate an older list read before any active-provider write starts.
        providerLoadSequenceRef.current++;
        setProvidersLoading(false);
        try {
            while (switchTargetRef.current !== null && mountedRef.current) {
                const target = switchTargetRef.current;
                switchTargetRef.current = null;
                if (target === committedProviderRef.current) continue;
                try {
                    const Service = await resolveAIService();
                    if (!mountedRef.current) break;
                    if (typeof Service?.AISetActiveProvider !== 'function') throw new Error(t('ai_settings.message.bridge_unavailable'));
                    await Service.AISetActiveProvider(target);
                    committedProviderRef.current = target;
                    providerLoadSequenceRef.current++;
                    if (mountedRef.current) {
                        setProvidersLoading(false);
                        setActiveProviderId(target);
                        if (switchTargetRef.current === null) void messageApi.success(t('ai_settings.message.switched'));
                    }
                    window.dispatchEvent(new CustomEvent('gonavi:ai:provider-changed'));
                } catch (error: any) {
                    if (mountedRef.current) void messageApi.error(error?.message || String(error) || t('ai_settings.message.switch_failed'));
                }
            }
        } finally {
            switchRunningRef.current = false;
            if (mountedRef.current) setPendingProviderId('');
        }
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

    const handleReloadRunPolicy = () => {
        setRunPolicyError('');
        void loadConfig();
    };

    const handleSaveRunPolicy = async () => {
        if (runPolicySaving) return;
        setRunPolicySaving(true);
        setRunPolicyError('');
        try {
            const Service = await resolveAIService();
            if (typeof Service?.AISaveRunPolicy !== 'function') {
                throw new Error(t('ai_settings.run_policy.error.unavailable'));
            }
            if (runPolicyRevision < 1) {
                throw new Error('run policy snapshot is missing a revision');
            }
            if (!isValidAIRunRuntimeConfig(runRuntime)) {
                throw new Error(t('ai_settings.run_policy.runtime.invalid'));
            }
            const saved = await Service.AISaveRunPolicy({
                expectedRevision: runPolicyRevision,
                policy: runPolicy,
                runtime: runRuntime,
            });
            const snapshot = normalizeAIRunPolicySnapshot(saved);
            if (snapshot.revision < 1) {
                throw new Error('run policy save returned an invalid revision');
            }
            if (!mountedRef.current || !activeRef.current) return;
            setRunPolicy(snapshot.policy);
            setRunRuntime(snapshot.runtime);
            setRunPolicyRevision(snapshot.revision);
            void messageApi.success(t('ai_settings.run_policy.message.saved'));
            window.dispatchEvent(new CustomEvent('gonavi:ai:config-changed'));
        } catch (error: any) {
            const detail = error?.message || t('ai_settings.run_policy.error.save_failed');
            if (mountedRef.current) {
                setRunPolicyError(detail);
                void messageApi.error(detail);
            }
        } finally {
            if (mountedRef.current) setRunPolicySaving(false);
        }
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
        const session = editorSessionRef.current;
        const revision = configRevisionRef.current;
        const request = ++testRequestRef.current;
        const isCurrent = () => mountedRef.current && activeRef.current
            && session === editorSessionRef.current && revision === configRevisionRef.current && request === testRequestRef.current;
        setProviderTesting(true);
        setTestStatus('idle');
        setTestResult(null);
        try {
            const values = await form.validateFields();
            if (!isCurrent()) return;
            const payload = buildProviderPayload(values, 'test');
            const Service = await resolveAIService();
            if (!isCurrent()) return;
            if (typeof Service?.AITestProvider !== 'function') throw new Error(t('ai_settings.message.bridge_unavailable'));
            const response = await Service.AITestProvider(payload);
            if (!isCurrent()) return;
            const result = parseProviderCheckResult(response);
            if (!result) throw new Error(t('ai_settings.message.test_scope_missing'));
            setTestResult(result);
            setTestStatus(result.success ? 'success' : 'error');
        } catch (error: any) {
            if (isCurrent() && !error?.errorFields) {
                setTestStatus('error');
                setTestResult({ success: false, checkKind: 'none', modelVerified: false, message: error?.message || String(error) || t('ai_settings.message.test_failed') });
            }
        } finally {
            if (isCurrent()) setProviderTesting(false);
        }
    };

    const handlePresetChange = (presetKey: string, endpointType?: ProviderEndpointType) => {
        const preset = findPreset(presetKey);
        const samePreset = presetKey === form.getFieldValue('presetKey');
        const connection = resolveProviderEndpointConnection(preset, endpointType || getProviderEndpointType({
            type: preset.backendType, apiFormat: preset.fixedApiFormat || preset.defaultApiFormat,
        }) || 'openai', samePreset ? form.getFieldValue('baseUrl') : undefined);
        if (!connection) return;
        const identity = getSingletonCLIIdentity({ type: preset.backendType, apiFormat: preset.fixedApiFormat, authMode: preset.authMode });
        if (identity && (!editingProvider?.id || getSingletonCLIIdentity(editingProvider) !== identity)
            && providers.some((provider) => provider.id !== editingProvider?.id && getSingletonCLIIdentity(provider) === identity)) {
            void messageApi.error(t('ai_settings.provider.duplicate_cli'));
            return;
        }
        invalidateProviderTest();
        if (samePreset && endpointType) {
            // Changing protocol within one vendor keeps the user's alias,
            // credentials, model choices and generation settings intact.
            form.setFieldsValue(connection);
            refreshProviderDirty();
            return;
        }
        editedFieldsRef.current.delete('model');
        editedFieldsRef.current.delete('effort');
        const authMode = preset.authMode || 'api-key';
        const { model: presetModel, models: presetModels } = resolvePresetModelSelection({
            presetKey,
            presetDefaultModel: preset.defaultModel,
            presetModels: preset.models,
            customModels: preset.models,
        });
        form.setFieldsValue({
            presetKey,
            ...connection,
            model: presetModel,
            models: presetModels,
            disabledModels: [],
            customModels: [],
            inlineCompletionModel: '',
            effort: undefined,
            authMode,
            ...(authMode === 'local-cli' ? { apiKey: '' } : {}),
        });
        refreshProviderDirty();
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
                className={sectionKey === 'providers' ? 'gonavi-ai-settings-panel-providers' : undefined}
            >
                {sectionKey !== 'providers' && <div style={{ paddingBottom: 12, marginBottom: 2 }}>
                    <div style={{ marginTop: 3, fontSize: 'var(--gn-font-size-sm, 12px)', lineHeight: 1.55, color: overlayTheme.mutedText }}>
                        {t(sectionMeta.descriptionKey)}
                    </div>
                </div>}
                {content}
            </section>
        );
    };

    return (
        <div ref={modalBodyRef} className="ai-settings-body gonavi-ai-settings-flat" style={{ display: 'flex', gap: 16, padding: '0', height: '100%', minHeight: 0, overflow: 'hidden', position: 'relative', boxSizing: 'border-box' }}>
            {messageContextHolder}
            {modalContextHolder}
            <AISettingsSidebar
                activeSection={activeSection}
                darkMode={darkMode}
                overlayTheme={overlayTheme}
                onSelectSection={(section) => {
                    if (section !== activeSection) withAISettingsLeaveGuard(confirmProviderLeave, () => setActiveSection(section));
                }}
            />
            <div
                ref={settingsContentScrollRef}
                className="gonavi-ai-settings-content"
                style={{ flex: 1, minWidth: 0, minHeight: 0, overflowY: activeSection === 'providers' ? 'hidden' : 'auto', overflowX: 'hidden', overscrollBehavior: 'contain', padding: '0 6px 8px 0' }}
            >
                {renderSectionPanel('providers', (
                    <AISettingsProvidersSection
                        providers={providers}
                        activeProviderId={activeProviderId}
                        pendingProviderId={pendingProviderId}
                        providersLoading={providersLoading}
                        loadError={providersLoadError}
                        onReloadProviders={() => void loadProviders()}
                        editingProvider={editingProvider}
                        editorSessionKey={editorSessionRef.current}
                        isEditing={isEditing}
                        form={form}
                        providerPresets={localizedProviderPresets}
                        watchedPresetKey={watchedPresetKey}
                        watchedApiFormat={watchedApiFormat}
                        loading={providerSaving}
                        testing={providerTesting}
                        testStatus={testStatus}
                        testResult={testResult}
                        onValuesChange={handleProviderValuesChange}
                        onCLIDefaults={handleCLIDefaults}
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
                        onCancelEdit={handleCancelProviderEdit}
                        onPresetChange={handlePresetChange}
                        onTestProvider={handleTestProvider}
                        onSaveProvider={() => handleSaveProvider()}
                        onSaveProviderAsCopy={() => handleSaveProvider('copy')}
                        saveMode={providerSaveMode}
                        dirty={providerDirty}
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
                {renderSectionPanel('run_policy', (
                    <AISettingsRunPolicySection
                        policy={runPolicy}
                        runtime={runRuntime}
                        loading={runPolicyLoading}
                        saving={runPolicySaving}
                        error={runPolicyError}
                        ledgerState={ledgerState}
                        overlayTheme={overlayTheme}
                        inputBg={inputBg}
                        onChange={setRunPolicy}
                        onRuntimeChange={setRunRuntime}
                        onReload={handleReloadRunPolicy}
                        onSave={() => void handleSaveRunPolicy()}
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
    const leaveGuardRef = useRef<AISettingsLeaveGuard | null>(null);
    const registerLeaveGuard = useCallback((guard: AISettingsLeaveGuard | null) => { leaveGuardRef.current = guard; }, []);
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
            onCancel={() => { void withAISettingsLeaveGuard(leaveGuardRef.current, onClose); }}
            footer={null}
            width={1080}
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
                onLeaveGuardChange={registerLeaveGuard}
              />
        </Modal>
    );
};

export default AISettingsModal;
