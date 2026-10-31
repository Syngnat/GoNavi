import { useEffect } from 'react';
import { parseProviderCheckResult, normalizeProviderModels } from '../../../utils/aiProviderManagement';
import { isPluginAIProviderNamespace } from '../../../plugins/aiProvider/identity';
import { usePluginProviderCatalog } from '../../../plugins/aiProvider/context';
import { pluginAIProviderSnapshotKey } from '../../../plugins/aiProvider/decode';
import { PluginAPIError } from '../../../plugins/apiResult';
import type { UseAISettingsMcpAndPresetsInput } from './useAISettingsMcpAndPresets';
export function useAISettingsProviderChecks(input: UseAISettingsMcpAndPresetsInput) {
  const { editorSessionRef, configRevisionRef, testRequestRef, mountedRef, activeRef, form, editingProvider,
    setProviderTesting, setTestStatus, setTestResult, buildProviderPayload, resolveAIService, t, messageApi } = input;
  const catalog = usePluginProviderCatalog();
  const currentType = String(form.getFieldValue('type') ?? editingProvider?.type ?? '');
  const authority = isPluginAIProviderNamespace(currentType) ? pluginAIProviderSnapshotKey(catalog?.find(currentType)) + ':' + catalog?.revision : '';
  useEffect(() => { if (isPluginAIProviderNamespace(currentType)) { testRequestRef.current++; setProviderTesting(false); setTestStatus('idle'); setTestResult(null); } }, [authority, currentType]);
  const handleTestProvider = async () => {
    const session = editorSessionRef.current; const revision = configRevisionRef.current; const request = ++testRequestRef.current;
    const plugin = isPluginAIProviderNamespace(currentType); const pin = plugin ? catalog?.capture(currentType) ?? null : null;
    const baseCurrent = () => mountedRef.current && activeRef.current && session === editorSessionRef.current
      && revision === configRevisionRef.current && request === testRequestRef.current;
    const isCurrent = () => baseCurrent() && (!plugin || Boolean(catalog?.isCurrent(pin)));
    setProviderTesting(true); setTestStatus('idle'); setTestResult(null);
    try {
      const values = await form.validateFields(); if (!baseCurrent()) return;
      const payload = buildProviderPayload(values, 'test');
      if (plugin && !pin) throw new PluginAPIError('plugin.ai_provider.error.unavailable');
      const service = await resolveAIService(); if (!isCurrent()) return;
      if (typeof service?.AITestProvider !== 'function') throw new Error(t('ai_settings.message.bridge_unavailable'));
      const response = await service.AITestProvider(payload); if (!isCurrent()) return;
      const result = parseProviderCheckResult(response);
      if (!result) throw new Error(t('ai_settings.message.test_scope_missing'));
      if (plugin && result.success && (result.checkKind !== 'model-response' || !result.modelVerified)) throw new PluginAPIError('plugin.ai_provider.error.unverified');
      setTestResult(plugin && !result.success ? { ...result, message: result.message || t('plugin.ai_provider.error.test_failed') } : result);
      setTestStatus(result.success ? 'success' : 'error');
    } catch (cause) {
      const error = cause as { errorFields?: unknown; message?: string };
      if (baseCurrent() && !error?.errorFields && (!plugin || !pin || catalog?.isCurrent(pin))) {
        setTestStatus('error'); setTestResult({ success: false, checkKind: 'none', modelVerified: false,
          message: cause instanceof PluginAPIError ? t(cause.key) : plugin ? error?.message || t('plugin.ai_provider.error.test_failed') : error?.message || String(cause) || t('ai_settings.message.test_failed') });
      }
    } finally { if (baseCurrent()) setProviderTesting(false); }
  };
  const handleSyncProviderModels = async (): Promise<string[]> => {
    if (isPluginAIProviderNamespace(currentType)) return catalog?.find(currentType)?.models.map((model) => model.id) ?? [];
    const session = editorSessionRef.current; const revision = configRevisionRef.current;
    const isCurrent = () => mountedRef.current && activeRef.current && session === editorSessionRef.current && revision === configRevisionRef.current;
    try {
      await form.validateFields(['baseUrl', 'apiKey']); if (!isCurrent()) return [];
      const payload = buildProviderPayload({}, 'test'); const service = await resolveAIService(); if (!isCurrent()) return [];
      if (typeof service?.AIListProviderModels !== 'function') throw new Error(t('ai_settings.message.bridge_unavailable'));
      const response = await service.AIListProviderModels(payload); if (!isCurrent()) return [];
      if (!response || response.success !== true) throw new Error(response?.error || t('ai_settings.models.sync_failed'));
      const models = normalizeProviderModels(response.models); if (!models.length) throw new Error(t('ai_settings.models.sync_empty'));
      void messageApi.success(t('ai_settings.models.sync_success', { count: models.length })); return models;
    } catch (cause) {
      const error = cause as { errorFields?: unknown; message?: string };
      if (isCurrent() && !error?.errorFields) void messageApi.error(error?.message || t('ai_settings.models.sync_failed'));
      throw cause;
    }
  };
  return { handleTestProvider, handleSyncProviderModels };
}
