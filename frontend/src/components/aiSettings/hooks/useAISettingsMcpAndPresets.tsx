import React from 'react';
import { isValidAIRunRuntimeConfig, normalizeAIRunPolicySnapshot } from '../../ai/aiRunPolicy';
import type { AIMCPServerConfig, AISkillConfig, AIProviderConfig } from '../../../types';
import {
  EMPTY_MCP_SERVER,
  EMPTY_SKILL,
  normalizeProviderPresetKey,
  findPreset,
  getProviderPresetMode,
} from '../../ai/aiSettingsModalConfig';
import {
  DEFAULT_MCP_HTTP_SERVER_STATUS,
  normalizeMCPHTTPAuthorizationToken,
  buildMCPHTTPServerDraftFromStatus,
} from '../aiSettingsDefaults';
import type { AIMCPHTTPServerDraft } from '../../ai/AIMCPHTTPServerPanel';
import {
  parseProviderCheckResult,
  normalizeProviderModels,
} from '../../../utils/aiProviderManagement';
import {
  type ProviderEndpointType,
  getProviderEndpointTypes,
  resolveProviderEndpointConnection,
  getProviderEndpointType,
} from '../../../utils/aiProviderEndpoints';
import {
  getSingletonCLIIdentity,
  resolvePresetModelSelection,
  resolveProviderPresetModeKey,
} from '../../../utils/aiProviderPresets';
import { type AISettingsSectionKey, AI_SETTINGS_NAV_ITEMS } from '../../ai/AISettingsSidebar';
import type { AISettingsStateApi } from './useAISettingsState';
import type { AISettingsProviderEditingApi } from './useAISettingsProviderEditing';
import type { AISettingsContentProps } from '../../AISettingsModal';

export interface UseAISettingsMcpAndPresetsInput {
  runPolicySaving: AISettingsStateApi['runPolicySaving'];
  setRunPolicySaving: AISettingsStateApi['setRunPolicySaving'];
  setRunPolicyError: AISettingsStateApi['setRunPolicyError'];
  resolveAIService: AISettingsStateApi['resolveAIService'];
  t: AISettingsStateApi['t'];
  runPolicyRevision: AISettingsStateApi['runPolicyRevision'];
  setRunPolicyRevision: AISettingsStateApi['setRunPolicyRevision'];
  runRuntime: AISettingsStateApi['runRuntime'];
  setRunRuntime: AISettingsStateApi['setRunRuntime'];
  runPolicy: AISettingsStateApi['runPolicy'];
  setRunPolicy: AISettingsStateApi['setRunPolicy'];
  mountedRef: AISettingsStateApi['mountedRef'];
  activeRef: AISettingsStateApi['activeRef'];
  messageApi: AISettingsStateApi['messageApi'];
  setLoading: AISettingsStateApi['setLoading'];
  userPromptSettings: AISettingsStateApi['userPromptSettings'];
  setUserPromptSettings: AISettingsStateApi['setUserPromptSettings'];
  setMCPServers: AISettingsStateApi['setMCPServers'];
  loadConfig: AISettingsStateApi['loadConfig'];
  setMCPTools: AISettingsStateApi['setMCPTools'];
  onBeforeExternalMCPUse: AISettingsContentProps['onBeforeExternalMCPUse'];
  setMCPHTTPServerLoading: AISettingsStateApi['setMCPHTTPServerLoading'];
  mcpHTTPServerDraft: AISettingsStateApi['mcpHTTPServerDraft'];
  setMCPHTTPServerDraft: AISettingsStateApi['setMCPHTTPServerDraft'];
  defaultMCPHTTPServerStatus: AISettingsStateApi['defaultMCPHTTPServerStatus'];
  setMCPHTTPServerStatus: AISettingsStateApi['setMCPHTTPServerStatus'];
  mcpHTTPServerStatus: AISettingsStateApi['mcpHTTPServerStatus'];
  copyTextToClipboard: AISettingsStateApi['copyTextToClipboard'];
  setSkills: AISettingsStateApi['setSkills'];
  editorSessionRef: AISettingsStateApi['editorSessionRef'];
  configRevisionRef: AISettingsStateApi['configRevisionRef'];
  testRequestRef: AISettingsStateApi['testRequestRef'];
  setProviderTesting: AISettingsStateApi['setProviderTesting'];
  setTestStatus: AISettingsStateApi['setTestStatus'];
  setTestResult: AISettingsStateApi['setTestResult'];
  form: AISettingsStateApi['form'];
  buildProviderPayload: AISettingsProviderEditingApi['buildProviderPayload'];
  editingProvider: AISettingsStateApi['editingProvider'];
  providers: AISettingsStateApi['providers'];
  invalidateProviderTest: AISettingsStateApi['invalidateProviderTest'];
  refreshProviderDirty: AISettingsStateApi['refreshProviderDirty'];
  editedFieldsRef: AISettingsStateApi['editedFieldsRef'];
  hideSidebar: Exclude<AISettingsContentProps['hideSidebar'], undefined>;
  overlayTheme: AISettingsContentProps['overlayTheme'];
  activeSection: AISettingsStateApi['activeSection'];
}

export const useAISettingsMcpAndPresets = ({
  runPolicySaving, setRunPolicySaving, setRunPolicyError, resolveAIService, t, runPolicyRevision,
  setRunPolicyRevision, runRuntime, setRunRuntime, runPolicy, setRunPolicy, mountedRef, activeRef,
  messageApi, setLoading, userPromptSettings, setUserPromptSettings, setMCPServers, loadConfig,
  setMCPTools, onBeforeExternalMCPUse, setMCPHTTPServerLoading, mcpHTTPServerDraft,
  setMCPHTTPServerDraft, defaultMCPHTTPServerStatus, setMCPHTTPServerStatus, mcpHTTPServerStatus,
  copyTextToClipboard, setSkills, editorSessionRef, configRevisionRef, testRequestRef,
  setProviderTesting, setTestStatus, setTestResult, form, buildProviderPayload, editingProvider,
  providers, invalidateProviderTest, refreshProviderDirty, editedFieldsRef, hideSidebar,
  overlayTheme, activeSection,
}: UseAISettingsMcpAndPresetsInput) => {
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
                  schemaOnly: false,
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

  const handleSyncProviderModels = async (): Promise<string[]> => {
      const session = editorSessionRef.current;
      const revision = configRevisionRef.current;
      const isCurrent = () => mountedRef.current && activeRef.current
          && session === editorSessionRef.current && revision === configRevisionRef.current;
      try {
          await form.validateFields(['baseUrl', 'apiKey']);
          if (!isCurrent()) return [];
          const payload = buildProviderPayload({}, 'test');
          const Service = await resolveAIService();
          if (!isCurrent()) return [];
          if (typeof Service?.AIListProviderModels !== 'function') throw new Error(t('ai_settings.message.bridge_unavailable'));
          const response = await Service.AIListProviderModels(payload);
          if (!isCurrent()) return [];
          if (!response || response.success !== true) {
              throw new Error(response?.error || t('ai_settings.models.sync_failed'));
          }
          const models = normalizeProviderModels(response.models);
          if (!models.length) throw new Error(t('ai_settings.models.sync_empty'));
          void messageApi.success(t('ai_settings.models.sync_success', { count: models.length }));
          return models;
      } catch (error: any) {
          if (isCurrent() && !error?.errorFields) {
              void messageApi.error(error?.message || t('ai_settings.models.sync_failed'));
          }
          throw error;
      }
  };

  const handlePresetChange = (presetKey: string, endpointType?: ProviderEndpointType) => {
      const normalizedPresetKey = normalizeProviderPresetKey(presetKey);
      const preset = findPreset(normalizedPresetKey);
      const currentMode = normalizedPresetKey === form.getFieldValue('presetKey')
          ? getProviderPresetMode(preset, form.getFieldValue('connectionMode'))
          : undefined;
      const requestedMode = (presetKey !== normalizedPresetKey ? preset.modes?.find((mode) => mode.legacyPresetKey === presetKey) : undefined)
          || (currentMode && (!endpointType || getProviderEndpointTypes({ ...currentMode, key: `${preset.key}:${currentMode.key}` }).includes(endpointType)) ? currentMode : undefined)
          || (endpointType ? preset.modes?.find((mode) => getProviderEndpointTypes({ ...mode, key: `${preset.key}:${mode.key}` }).includes(endpointType)) : undefined)
          || getProviderPresetMode(preset);
      const connectionPreset = requestedMode || preset;
      const samePreset = normalizedPresetKey === normalizeProviderPresetKey(form.getFieldValue('presetKey'));
      const sameConnectionMode = samePreset && requestedMode?.key === currentMode?.key;
      const connection = resolveProviderEndpointConnection(connectionPreset, endpointType || getProviderEndpointType({
          type: connectionPreset.backendType, apiFormat: connectionPreset.fixedApiFormat || connectionPreset.defaultApiFormat,
      }) || 'openai', samePreset ? form.getFieldValue('baseUrl') : undefined);
      if (!connection) return;
      const identity = getSingletonCLIIdentity({ type: connectionPreset.backendType, apiFormat: connectionPreset.fixedApiFormat, authMode: connectionPreset.authMode });
      if (identity && (!editingProvider?.id || getSingletonCLIIdentity(editingProvider) !== identity)
          && providers.some((provider) => provider.id !== editingProvider?.id && getSingletonCLIIdentity(provider) === identity)) {
          void messageApi.error(t('ai_settings.provider.duplicate_cli'));
          return;
      }
      invalidateProviderTest();
      if (sameConnectionMode && endpointType) {
          // Changing protocol within one vendor keeps the user's alias,
          // credentials, model choices and generation settings intact.
          form.setFieldsValue(connection);
          refreshProviderDirty();
          return;
      }
      editedFieldsRef.current.delete('model');
      editedFieldsRef.current.delete('effort');
      const authMode = connectionPreset.authMode || 'api-key';
      const resolutionKey = requestedMode?.legacyPresetKey || normalizedPresetKey;
      const { model: presetModel } = resolvePresetModelSelection({
          presetKey: resolutionKey,
          presetDefaultModel: connectionPreset.defaultModel || '',
          presetModels: connectionPreset.models || [],
          customModels: connectionPreset.models || [],
      });
      form.setFieldsValue({
          presetKey: normalizedPresetKey,
          connectionMode: requestedMode?.key || '',
          ...connection,
          model: presetModel,
          models: undefined,
          disabledModels: [],
          customModels: [],
          inlineCompletionModel: '',
          effort: undefined,
          authMode,
          apiKey: '',
          headerRows: [],
          cliEnvRows: [],
          cliPath: '',
          contextWindow: undefined,
          maxTokens: undefined,
      });
      refreshProviderDirty();
  };

  const handleProviderConnectionModeChange = (modeKey: string) => {
      const preset = findPreset(form.getFieldValue('presetKey') || 'openai');
      const mode = getProviderPresetMode(preset, modeKey);
      if (!mode) return;
      const previousModeKey = resolveProviderPresetModeKey(preset, {
          type: form.getFieldValue('type') || preset.backendType,
          apiFormat: form.getFieldValue('apiFormat'),
          authMode: form.getFieldValue('authMode'),
          baseUrl: form.getFieldValue('baseUrl') || '',
          apiKey: form.getFieldValue('apiKey'),
          hasSecret: editingProvider?.hasSecret,
          secretRef: editingProvider?.secretRef,
      });
      const endpointType = getProviderEndpointType({ type: mode.backendType, apiFormat: mode.fixedApiFormat || mode.defaultApiFormat }) || 'openai';
      const connection = resolveProviderEndpointConnection(mode, endpointType);
      if (!connection) return;
      const identity = getSingletonCLIIdentity({ type: mode.backendType, apiFormat: mode.fixedApiFormat, authMode: mode.authMode });
      if (identity && (!editingProvider?.id || getSingletonCLIIdentity(editingProvider) !== identity)
          && providers.some((provider) => provider.id !== editingProvider?.id && getSingletonCLIIdentity(provider) === identity)) {
          form.setFieldValue('connectionMode', previousModeKey);
          void messageApi.error(t('ai_settings.provider.duplicate_cli'));
          return;
      }
      invalidateProviderTest();
      editedFieldsRef.current.delete('model');
      editedFieldsRef.current.delete('effort');
      const authMode = mode.authMode || 'api-key';
      const { model } = resolvePresetModelSelection({
          presetKey: mode.legacyPresetKey || preset.key,
          presetDefaultModel: mode.defaultModel,
          presetModels: mode.models,
          customModels: mode.models,
      });
      const crossingLocalBoundary = authMode === 'local-cli' || form.getFieldValue('authMode') === 'local-cli';
      form.setFieldsValue({
          connectionMode: mode.key,
          ...connection,
          authMode,
          model,
          disabledModels: [],
          customModels: [],
          inlineCompletionModel: '',
          effort: undefined,
          ...(crossingLocalBoundary ? { apiKey: '', headerRows: [], cliPath: '', cliEnvRows: [] } : {}),
      });
      refreshProviderDirty();
  };

  const handleProviderAuthModeChange = (authMode: NonNullable<AIProviderConfig['authMode']>) => {
      const presetKey = form.getFieldValue('presetKey') || 'openai';
      invalidateProviderTest();
      editedFieldsRef.current.add('authMode');
      if (presetKey !== 'openai') {
          form.setFieldValue('authMode', authMode);
          refreshProviderDirty();
          return;
      }

      if (authMode === 'local-cli') {
          const identity = 'codex-cli';
          if ((!editingProvider?.id || getSingletonCLIIdentity(editingProvider) !== identity)
              && providers.some((provider) => provider.id !== editingProvider?.id && getSingletonCLIIdentity(provider) === identity)) {
              form.setFieldValue('authMode', 'api-key');
              void messageApi.error(t('ai_settings.provider.duplicate_cli'));
              refreshProviderDirty();
              return;
          }
          editedFieldsRef.current.delete('model');
          editedFieldsRef.current.delete('effort');
          form.setFieldsValue({
              authMode: 'local-cli',
              type: 'custom',
              apiFormat: 'codex-cli',
              baseUrl: '',
              apiKey: '',
              headerRows: [],
              model: '',
              effort: undefined,
          });
      } else {
          const preset = findPreset('openai');
          const connection = resolveProviderEndpointConnection(preset, 'openai');
          form.setFieldsValue({
              authMode: 'api-key',
              type: connection?.type || 'openai',
              apiFormat: connection?.apiFormat || 'openai',
              baseUrl: connection?.baseUrl || preset.defaultBaseUrl,
              cliPath: '',
              cliEnvRows: [],
              effort: undefined,
              model: form.getFieldValue('model') || preset.defaultModel,
          });
      }
      refreshProviderDirty();
  };

  const renderSectionPanel = (sectionKey: AISettingsSectionKey, content: React.ReactNode) => {
      const sectionMeta = AI_SETTINGS_NAV_ITEMS.find((item) => item.key === sectionKey) ?? AI_SETTINGS_NAV_ITEMS[0]!;
      return (
          <section
              key={sectionKey}
              id={`gonavi-ai-settings-panel-${sectionKey}`}
              role={hideSidebar ? undefined : 'tabpanel'}
              aria-labelledby={hideSidebar ? undefined : `gonavi-ai-settings-tab-${sectionKey}`}
              hidden={activeSection !== sectionKey}
              className={sectionKey === 'providers'
                  ? 'gonavi-ai-settings-panel-providers'
                  : sectionKey === 'request_events'
                      ? 'gonavi-ai-settings-panel-request-events'
                      : undefined}
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
  return {
    handleSaveRunPolicy, handleSaveUserPromptSettings, updateMCPServerDraft, handleAddMCPServer,
    handleSaveMCPServer, handleDeleteMCPServer, handleTestMCPServer, handleToggleMCPHTTPServer,
    handleUpdateMCPHTTPServerDraft, handleCopyMCPHTTPServerURL,
    handleCopyMCPHTTPServerAuthorization, updateSkillDraft, handleAddSkill, handleSaveSkill,
    handleDeleteSkill, handleTestProvider, handleSyncProviderModels, handlePresetChange,
    handleProviderConnectionModeChange, handleProviderAuthModeChange, renderSectionPanel,
  };
};

export type AISettingsMcpAndPresetsApi = ReturnType<typeof useAISettingsMcpAndPresets>;
