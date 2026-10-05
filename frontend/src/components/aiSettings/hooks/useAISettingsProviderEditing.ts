import { useCallback, useEffect } from 'react';
import { v4 as uuidv4 } from 'uuid';
import {
  type AISettingsLeaveGuard,
  withAISettingsLeaveGuard,
} from '../../../utils/aiSettingsLeaveGuard';
import {
  type ProviderEndpointType,
  getProviderEndpointTypes,
  resolveProviderEndpointConnection,
  getProviderEndpointType,
} from '../../../utils/aiProviderEndpoints';
import {
  normalizeProviderPresetKey,
  findPreset,
  getProviderPresetMode,
  matchProviderPreset,
  localizeProviderPreset,
} from '../../ai/aiSettingsModalConfig';
import {
  getSingletonCLIIdentity,
  resolveProviderPresetModeKey,
  resolvePresetTransport,
  resolvePresetModelSelection,
  resolvePresetBaseURL,
} from '../../../utils/aiProviderPresets';
import {
  buildAddProviderEditorSession,
  buildEditProviderEditorSession,
} from '../../../utils/aiProviderEditorState';
import type { AIProviderConfig, AISafetyLevel, AIContextLevel } from '../../../types';
import { rowsFromRecord, recordFromRows } from '../../../utils/aiProviderKeyValue';
import {
  isProviderSecretRequirementSatisfied,
  resolveProviderSecretDraft,
  canRetainExistingProviderSecret,
} from '../../../utils/providerSecretDraft';
import { normalizeProviderModels, providerCopyName } from '../../../utils/aiProviderManagement';
import type { AISettingsStateApi } from './useAISettingsState';
import type { AISettingsContentProps } from '../../AISettingsModal';

export interface UseAISettingsProviderEditingInput {
  confirmationZIndex: Exclude<AISettingsContentProps['confirmationZIndex'], undefined>;
  saveRunningRef: AISettingsStateApi['saveRunningRef'];
  messageApi: AISettingsStateApi['messageApi'];
  t: AISettingsStateApi['t'];
  providerDirtyRef: AISettingsStateApi['providerDirtyRef'];
  discardConfirmationRef: AISettingsStateApi['discardConfirmationRef'];
  mountedRef: AISettingsStateApi['mountedRef'];
  activeRef: AISettingsStateApi['activeRef'];
  resetProviderEditorSession: AISettingsStateApi['resetProviderEditorSession'];
  cancelDiscardRef: AISettingsStateApi['cancelDiscardRef'];
  modalApi: AISettingsStateApi['modalApi'];
  onLeaveGuardChange: AISettingsContentProps['onLeaveGuardChange'];
  active: AISettingsContentProps['active'];
  providers: AISettingsStateApi['providers'];
  applyProviderEditorSession: AISettingsStateApi['applyProviderEditorSession'];
  editorSessionRef: AISettingsStateApi['editorSessionRef'];
  invalidateProviderTest: AISettingsStateApi['invalidateProviderTest'];
  resolveAIService: AISettingsStateApi['resolveAIService'];
  focusProviderId: AISettingsContentProps['focusProviderId'];
  openedFocusProviderRef: AISettingsStateApi['openedFocusProviderRef'];
  applySection: AISettingsStateApi['applySection'];
  committedProviderRef: AISettingsStateApi['committedProviderRef'];
  editingProvider: AISettingsStateApi['editingProvider'];
  loadProviders: AISettingsStateApi['loadProviders'];
  form: AISettingsStateApi['form'];
  configRevisionRef: AISettingsStateApi['configRevisionRef'];
  setProviderSaveMode: AISettingsStateApi['setProviderSaveMode'];
  setProviderSaving: AISettingsStateApi['setProviderSaving'];
  setEditingProvider: AISettingsStateApi['setEditingProvider'];
  providerBaselineRef: AISettingsStateApi['providerBaselineRef'];
  refreshProviderDirty: AISettingsStateApi['refreshProviderDirty'];
  switchRunningRef: AISettingsStateApi['switchRunningRef'];
  switchTargetRef: AISettingsStateApi['switchTargetRef'];
  setPendingProviderId: AISettingsStateApi['setPendingProviderId'];
  providerLoadSequenceRef: AISettingsStateApi['providerLoadSequenceRef'];
  setProvidersLoading: AISettingsStateApi['setProvidersLoading'];
  setActiveProviderId: AISettingsStateApi['setActiveProviderId'];
  setSafetyLevel: AISettingsStateApi['setSafetyLevel'];
  resultMaskingLoadError: AISettingsStateApi['resultMaskingLoadError'];
  resultMaskingSaving: AISettingsStateApi['resultMaskingSaving'];
  setResultMaskingSaving: AISettingsStateApi['setResultMaskingSaving'];
  setResultMaskingSaveError: AISettingsStateApi['setResultMaskingSaveError'];
  resultMaskingSettings: AISettingsStateApi['resultMaskingSettings'];
  setContextLevel: AISettingsStateApi['setContextLevel'];
  setRunPolicyError: AISettingsStateApi['setRunPolicyError'];
  loadConfig: AISettingsStateApi['loadConfig'];
}

export const useAISettingsProviderEditing = ({
  confirmationZIndex, saveRunningRef, messageApi, t, providerDirtyRef, discardConfirmationRef,
  mountedRef, activeRef, resetProviderEditorSession, cancelDiscardRef, modalApi, onLeaveGuardChange,
  active, providers, applyProviderEditorSession, editorSessionRef, invalidateProviderTest,
  resolveAIService, focusProviderId, openedFocusProviderRef, applySection, committedProviderRef,
  editingProvider, loadProviders, form, configRevisionRef, setProviderSaveMode, setProviderSaving,
  setEditingProvider, providerBaselineRef, refreshProviderDirty, switchRunningRef, switchTargetRef,
  setPendingProviderId, providerLoadSequenceRef, setProvidersLoading, setActiveProviderId,
  setSafetyLevel, resultMaskingLoadError, resultMaskingSaving, setResultMaskingSaving,
  setResultMaskingSaveError, resultMaskingSettings, setContextLevel, setRunPolicyError, loadConfig,
}: UseAISettingsProviderEditingInput) => {
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
      const normalizedPresetKey = normalizeProviderPresetKey(presetKey);
      const preset = findPreset(normalizedPresetKey);
      const requestedMode = (presetKey !== normalizedPresetKey ? preset.modes?.find((mode) => mode.legacyPresetKey === presetKey) : undefined)
          || (endpointType ? preset.modes?.find((mode) => getProviderEndpointTypes({ ...mode, key: `${preset.key}:${mode.key}` }).includes(endpointType)) : undefined)
          || getProviderPresetMode(preset);
      const connectionPreset = requestedMode || preset;
      const connection = resolveProviderEndpointConnection(connectionPreset, endpointType || getProviderEndpointType({
          type: connectionPreset.backendType, apiFormat: connectionPreset.fixedApiFormat || connectionPreset.defaultApiFormat,
      }) || 'openai');
      if (!connection) return;
      const identity = getSingletonCLIIdentity({ type: connectionPreset.backendType, apiFormat: connectionPreset.fixedApiFormat, authMode: connectionPreset.authMode });
      if (identity && providers.some((provider) => getSingletonCLIIdentity(provider) === identity)) {
          void messageApi.error(t('ai_settings.provider.duplicate_cli'));
          return;
      }
      applyProviderEditorSession(buildAddProviderEditorSession({
          presetKey: normalizedPresetKey,
          presetBackendType: connection.type,
          presetBaseUrl: connection.baseUrl,
          presetModel: connectionPreset.defaultModel || '',
          apiFormat: connection.apiFormat,
          authMode: connectionPreset.authMode || 'api-key',
          connectionMode: requestedMode?.key,
      }));
  });

  const handleApplyPartnerBaseUrl = (baseUrl: string, label: string) => withAISettingsLeaveGuard(confirmProviderLeave, () => {
      const preset = findPreset('custom');
      const session = buildAddProviderEditorSession({
          presetKey: preset.key,
          presetBackendType: preset.backendType,
          presetBaseUrl: baseUrl,
          presetModel: '',
          apiFormat: 'openai',
          authMode: 'api-key',
      });
      if (session.formValues) session.formValues = { ...session.formValues, name: label };
      applyProviderEditorSession(session);
      void messageApi.success(t('ai_settings.provider.partner.base_url_applied'));
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
          const matchedModeKey = resolveProviderPresetModeKey(matchedPreset, editableProvider);
          const matchedConnection = getProviderPresetMode(matchedPreset, matchedModeKey) || matchedPreset;
          const isOpenAICodexSubscription = matchedPreset.key === 'openai'
              && getSingletonCLIIdentity(editableProvider) === 'codex-cli';
          const resolvedTransport = resolvePresetTransport({
              presetKey: matchedPreset.key,
              presetBackendType: matchedConnection.backendType,
              presetFixedApiFormat: matchedConnection.fixedApiFormat,
              presetDefaultApiFormat: matchedConnection.defaultApiFormat,
              presetEndpoints: matchedConnection.endpoints,
              valuesBaseUrl: editableProvider.baseUrl,
              valuesApiFormat: editableProvider.apiFormat,
              valuesModel: editableProvider.model,
          });
          const { models: _removedModels, maxTokens: _removedMaxTokens, ...editableFields } = editableProvider;
          applyProviderEditorSession(buildEditProviderEditorSession({
              provider: { ...editableProvider, presetKey: matchedPreset.key } as any,
              formValues: {
                  ...editableFields,
                  type: isOpenAICodexSubscription ? 'custom' : resolvedTransport.type,
                  presetKey: matchedPreset.key,
                  connectionMode: matchedModeKey,
                  apiFormat: isOpenAICodexSubscription
                      ? 'codex-cli'
                      : resolvedTransport.apiFormat || (resolvedTransport.type === 'custom' ? editableProvider.apiFormat || 'openai' : resolvedTransport.type),
                  authMode: isOpenAICodexSubscription ? 'local-cli' : matchedConnection.authMode || editableProvider.authMode || 'api-key',
                  headerRows: rowsFromRecord(editableProvider.headers),
                  cliEnvRows: rowsFromRecord(editableProvider.cliEnv),
                  cliPath: editableProvider.cliPath || '',
              },
          }));
      } catch (e: any) {
          if (session === editorSessionRef.current && activeRef.current) void messageApi.error(e?.message || t('ai_settings.message.load_provider_failed'));
      }
  });

  useEffect(() => {
      const requestedProviderId = String(focusProviderId || '').trim();
      if (!active || !requestedProviderId) {
          openedFocusProviderRef.current = '';
          return;
      }
      if (openedFocusProviderRef.current === requestedProviderId) return;
      const requestedProvider = providers.find((provider) => provider.id === requestedProviderId);
      if (!requestedProvider) return;
      openedFocusProviderRef.current = requestedProviderId;
      applySection('providers');
      void handleEditProvider(requestedProvider);
  }, [active, applySection, focusProviderId, handleEditProvider, providers]);

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
      // validateFields only returns mounted fields. Removed controls must not
      // leak legacy values back into a saved provider.
      values = { ...form.getFieldsValue(true), ...values };
      const { headerRows, cliEnvRows, models: _removedModels, maxTokens: _removedMaxTokens, ...formFields } = values;
      const presetKey = normalizeProviderPresetKey(values.presetKey || 'openai');
      const preset = findPreset(presetKey);
      const selectedMode = getProviderPresetMode(preset, formFields.connectionMode);
      const connectionPreset = selectedMode || preset;
      const resolutionKey = selectedMode?.legacyPresetKey || presetKey;
      const openAICodexSubscription = presetKey === 'openai' && formFields.authMode === 'local-cli';
      const authMode = openAICodexSubscription || connectionPreset.authMode === 'local-cli'
          ? 'local-cli'
          : (formFields.authMode === 'bearer' ? 'bearer' : 'api-key');
      const { model } = resolvePresetModelSelection({
          presetKey: openAICodexSubscription ? 'codex' : resolutionKey,
          presetDefaultModel: connectionPreset.defaultModel || '',
          presetModels: connectionPreset.models || [],
          valuesModel: values.model,
          customModels: [],
      });
      const baseUrl = openAICodexSubscription ? '' : resolvePresetBaseURL({
          presetKey: resolutionKey,
          presetDefaultBaseUrl: connectionPreset.defaultBaseUrl,
          presetEndpoints: connectionPreset.endpoints,
          valuesBaseUrl: values.baseUrl,
      });
      const transport = openAICodexSubscription ? { type: 'custom' as const, apiFormat: 'codex-cli' } : resolvePresetTransport({
          presetKey: resolutionKey,
          presetBackendType: connectionPreset.backendType,
          presetFixedApiFormat: connectionPreset.fixedApiFormat,
          presetDefaultApiFormat: connectionPreset.defaultApiFormat,
          presetEndpoints: connectionPreset.endpoints,
          valuesBaseUrl: baseUrl,
          valuesApiFormat: values.apiFormat,
          valuesModel: model,
      });
      const apiKeyInput = authMode === 'local-cli' ? '' : values.apiKey;
      if (!isProviderSecretRequirementSatisfied({ apiKeyInput, currentAuthMode: authMode, editingProvider, allowEmptySecret: presetKey === 'codebuddy' || presetKey === 'gonavi-ai' })) {
          throw new Error(t(purpose === 'test' ? 'ai_settings.message.test_requires_new_api_key' : 'ai_settings.form.api_key_required'));
      }
      const secret = resolveProviderSecretDraft({
          apiKeyInput,
          retainExistingSecret: !String(apiKeyInput || '').trim() && canRetainExistingProviderSecret({ currentAuthMode: authMode, editingProvider }),
      });
      const payload = {
          ...editingProvider,
          ...formFields,
          ...transport,
          name: String(values.name || '').trim() ? values.name : localizeProviderPreset(preset, t).label,
          apiKey: secret.apiKey,
          hasSecret: secret.hasSecret,
          authMode,
          baseUrl,
          model,
          models: [],
          disabledModels: normalizeProviderModels(values.disabledModels),
          customModels: normalizeProviderModels(values.customModels),
          effort: authMode === 'local-cli' ? String(values.effort || '') : '',
          inlineCompletionModel: String(values.inlineCompletionModel || '').trim(),
          maxTokens: 0,
          temperature: Number.isFinite(Number(values.temperature)) ? Number(values.temperature) : 0.7,
          // 供应商的上下文档位：按当前模型校验，落不到可选档位就回默认（0）
          contextWindow: Math.max(0, Math.trunc(Number(values.contextWindow) || 0)),
          headers: authMode === 'local-cli' ? {} : recordFromRows(headerRows),
          cliPath: authMode === 'local-cli' ? String(values.cliPath || '').trim() : '',
          cliEnv: authMode === 'local-cli' ? recordFromRows(cliEnvRows) : {},
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

  const handleSaveResultMasking = async () => {
      if (resultMaskingLoadError || resultMaskingSaving) return;
      setResultMaskingSaving(true);
      setResultMaskingSaveError('');
      try {
          const Service = await resolveAIService();
          if (typeof Service?.AISaveResultMaskingSettings !== 'function') {
              throw new Error(t('ai_settings.result_masking.save_failed'));
          }
          await Service.AISaveResultMaskingSettings(resultMaskingSettings);
          if (mountedRef.current) void messageApi.success(t('ai_settings.result_masking.saved'));
      } catch (error: any) {
          const detail = error?.message || String(error) || t('ai_settings.result_masking.save_failed');
          if (mountedRef.current) {
              setResultMaskingSaveError(detail);
              void messageApi.error(detail);
          }
      } finally {
          if (mountedRef.current) setResultMaskingSaving(false);
      }
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
  return {
    confirmProviderLeave, handleCancelProviderEdit, handleAddProvider, handleApplyPartnerBaseUrl,
    handleEditProvider, handleDeleteProvider, buildProviderPayload, handleSaveProvider,
    handleSetActive, handleSafetyChange, handleSaveResultMasking, handleContextChange,
    handleReloadRunPolicy,
  };
};

export type AISettingsProviderEditingApi = ReturnType<typeof useAISettingsProviderEditing>;
