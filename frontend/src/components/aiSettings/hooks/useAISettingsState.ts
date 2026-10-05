import { useMemo, useState, useCallback, useRef, useEffect } from 'react';
import { Form, message as antdMessage } from 'antd';
import { useI18n } from '../../../i18n/provider';
import type {
  AIMCPHTTPServerStatus,
  AIProviderConfig,
  AISafetyLevel,
  AIResultMaskingSettings,
  AIContextLevel,
  AIMCPServerConfig,
  AIMCPToolDescriptor,
  AISkillConfig,
  AIUserPromptSettings,
} from '../../../types';
import {
  DEFAULT_MCP_HTTP_SERVER_STATUS,
  DEFAULT_AI_RESULT_MASKING_SETTINGS,
  DEFAULT_MCP_HTTP_SERVER_DRAFT,
  buildMCPHTTPServerDraftFromStatus,
} from '../aiSettingsDefaults';
import {
  type AIRunPolicy,
  DEFAULT_AI_RUN_POLICY,
  type AIRunRuntimeConfig,
  DEFAULT_AI_RUN_RUNTIME_CONFIG,
  normalizeAIRunPolicySnapshot,
} from '../../ai/aiRunPolicy';
import { type AgentLedgerState, normalizeAgentLedgerState } from '../../ai/aiRunHarnessClient';
import type { AIMCPHTTPServerDraft } from '../../ai/AIMCPHTTPServerPanel';
import {
  type ProviderCheckResult,
  providerDraftFingerprint,
  getCLIConfigPrefill,
} from '../../../utils/aiProviderManagement';
import {
  EMPTY_AI_USER_PROMPT_SETTINGS,
  localizeProviderPresets,
  PROVIDER_PRESETS,
  localizeProviderPreset,
  findPreset,
  matchProviderPreset,
  waitForAIService,
} from '../../ai/aiSettingsModalConfig';
import type { AISettingsSectionKey } from '../../ai/AISettingsSidebar';
import type { ai } from '../../../../wailsjs/go/models';
import { useStore } from '../../../store';
import Modal from '../../common/ResizableDraggableModal';
import type { ProviderPresetCandidate } from '../../../utils/aiProviderPresets';
import { BUILTIN_AI_TOOL_INFO } from '../../../utils/aiToolRegistry';
import { useAIMCPClientInstaller } from '../../ai/useAIMCPClientInstaller';
import {
  type ProviderEditorSession,
  buildClosedProviderEditorSession,
} from '../../../utils/aiProviderEditorState';
import type { AISettingsContentProps } from '../../AISettingsModal';

export interface UseAISettingsStateInput {
  section: AISettingsContentProps['section'];
  onSectionChange: AISettingsContentProps['onSectionChange'];
  active: AISettingsContentProps['active'];
  darkMode: AISettingsContentProps['darkMode'];
  onBeforeExternalMCPUse: AISettingsContentProps['onBeforeExternalMCPUse'];
}

export const useAISettingsState = ({ section, onSectionChange, active, darkMode, onBeforeExternalMCPUse }: UseAISettingsStateInput) => {
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
  const [resultMaskingSettings, setResultMaskingSettings] = useState<AIResultMaskingSettings>(DEFAULT_AI_RESULT_MASKING_SETTINGS);
  const [resultMaskingLoading, setResultMaskingLoading] = useState(false);
  const [resultMaskingSaving, setResultMaskingSaving] = useState(false);
  const [resultMaskingLoadError, setResultMaskingLoadError] = useState('');
  const [resultMaskingSaveError, setResultMaskingSaveError] = useState('');
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
  const isSectionControlled = section !== undefined;
  const [internalSection, setInternalSection] = useState<AISettingsSectionKey>('providers');
  const activeSection = isSectionControlled ? section : internalSection;
  const applySection = useCallback((next: AISettingsSectionKey) => {
      onSectionChange?.(next);
      if (!isSectionControlled) {
          setInternalSection(next);
      }
  }, [isSectionControlled, onSectionChange]);
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
  const openedFocusProviderRef = useRef('');
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

  const copyTextToClipboard = useCallback(async (text: string, successMessage?: string) => {
      if (typeof navigator?.clipboard?.writeText !== 'function') {
          throw new Error(t('ai_settings.clipboard.error.unsupported'));
      }
      await navigator.clipboard.writeText(text);
      if (successMessage) void messageApi.success(successMessage);
  }, [messageApi, t]);

  const {
      handleCopySelectedMCPConfigPath,
      handleCopySelectedMCPLaunchCommand,
      handleInstallSelectedMCPClient,
      handleUpdateStaleMCPClients,
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
      if (activeSection === 'providers' || activeSection === 'tools' || activeSection === 'analysis' || activeSection === 'request_events') return;
      const sequence = ++sectionLoadSequenceRef.current;
      const isCurrent = () => mountedRef.current && sequence === sectionLoadSequenceRef.current;
      if (activeSection === 'safety' && isCurrent()) {
          setResultMaskingLoading(true);
          setResultMaskingLoadError('');
          setResultMaskingSaveError('');
      }
      const Service = await resolveAIService();
      if (!Service) {
          if (activeSection === 'safety' && isCurrent()) {
              setResultMaskingLoadError(t('ai_settings.result_masking.load_failed'));
              setResultMaskingLoading(false);
          }
          return;
      }
      const callOrFallback = async <T,>(loader: (() => Promise<T> | undefined), fallback: T): Promise<T> => {
          try { return (await loader()) ?? fallback; }
          catch (error) { console.warn('[AI] settings load fallback', error); return fallback; }
      };
      switch (activeSection) {
          case 'safety': {
              const value = await callOrFallback<AISafetyLevel>(() => Service.AIGetSafetyLevel?.(), 'readonly');
              let masking: AIResultMaskingSettings | undefined;
              let maskingError = '';
              try {
                  if (typeof Service.AIGetResultMaskingSettings !== 'function') {
                      throw new Error(t('ai_settings.result_masking.load_failed'));
                  }
                  masking = await Service.AIGetResultMaskingSettings();
              } catch (error: any) {
                  maskingError = error?.message || String(error) || t('ai_settings.result_masking.load_failed');
              }
              if (isCurrent()) {
                  setSafetyLevel(value);
                  if (masking) setResultMaskingSettings({ ...DEFAULT_AI_RESULT_MASKING_SETTINGS, ...masking });
                  setResultMaskingLoadError(maskingError);
                  setResultMaskingLoading(false);
              }
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
  return {
    t, defaultMCPHTTPServerStatus, providers, activeProviderId, setActiveProviderId,
    pendingProviderId, setPendingProviderId, providersLoading, setProvidersLoading,
    providersLoadError, safetyLevel, setSafetyLevel, resultMaskingSettings,
    setResultMaskingSettings, resultMaskingLoading, resultMaskingSaving, setResultMaskingSaving,
    resultMaskingLoadError, resultMaskingSaveError, setResultMaskingSaveError, contextLevel,
    setContextLevel, runPolicy, setRunPolicy, runRuntime, setRunRuntime, runPolicyRevision,
    setRunPolicyRevision, runPolicyLoading, runPolicySaving, setRunPolicySaving, runPolicyError,
    setRunPolicyError, ledgerState, mcpServers, setMCPServers, mcpTools, setMCPTools,
    mcpHTTPServerStatus, setMCPHTTPServerStatus, mcpHTTPServerDraft, setMCPHTTPServerDraft,
    mcpHTTPServerLoading, setMCPHTTPServerLoading, skills, setSkills, editingProvider,
    setEditingProvider, isEditing, loading, setLoading, testStatus, setTestStatus, testResult,
    setTestResult, providerTesting, setProviderTesting, providerSaving, setProviderSaving,
    providerSaveMode, setProviderSaveMode, providerDirty, builtinPrompts, userPromptSettings,
    setUserPromptSettings, activeSection, applySection, primaryPasswordVisible,
    setPrimaryPasswordVisible, form, modalBodyRef, settingsContentScrollRef, mountedRef, activeRef,
    committedProviderRef, switchTargetRef, switchRunningRef, providerLoadSequenceRef,
    editorSessionRef, openedFocusProviderRef, configRevisionRef, testRequestRef, saveRunningRef,
    editedFieldsRef, providerDirtyRef, providerBaselineRef, discardConfirmationRef,
    cancelDiscardRef, invalidateProviderTest, refreshProviderDirty, handleProviderValuesChange,
    handleCLIDefaults, aiChatOpenMode, setAIChatOpenMode, messageApi, messageContextHolder,
    modalApi, modalContextHolder, cardBg, cardBorder, inputBg, watchedPresetKey, watchedApiFormat,
    localizedProviderPresets, findLocalizedPreset, matchLocalizedProviderPreset,
    skillRequiredToolOptions, resolveAIService, copyTextToClipboard,
    handleCopySelectedMCPConfigPath, handleCopySelectedMCPLaunchCommand,
    handleInstallSelectedMCPClient, handleUpdateStaleMCPClients, handleSelectMCPClient,
    loadMCPClientStatuses, mcpClientStatusLoading, mcpClientStatuses, selectedMCPClient,
    selectedMCPClientCommandText, selectedMCPClientStatus, loadProviders, loadConfig,
    applyProviderEditorSession, resetProviderEditorSession,
  };
};

export type AISettingsStateApi = ReturnType<typeof useAISettingsState>;
