import { useEffect } from 'react';
import { withAISettingsLeaveGuard } from '../../../utils/aiSettingsLeaveGuard';
import { getProviderPresetMode, matchProviderPreset } from '../../ai/aiSettingsModalConfig';
import { getSingletonCLIIdentity, resolveProviderPresetModeKey, resolvePresetTransport } from '../../../utils/aiProviderPresets';
import { buildEditProviderEditorSession } from '../../../utils/aiProviderEditorState';
import type { AIProviderConfig } from '../../../types';
import { rowsFromRecord } from '../../../utils/aiProviderKeyValue';
import type { AISettingsLeaveGuard } from '../../../utils/aiSettingsLeaveGuard';
import { isPluginAIProviderNamespace } from '../../../plugins/aiProvider/identity';
import { pluginProviderEditorSession } from '../../../plugins/aiProvider/editor';
import { usePluginProviderCatalog } from '../../../plugins/aiProvider/context';
import type { UseAISettingsProviderEditingInput } from './useAISettingsProviderEditing';

export function useAISettingsProviderEdit(input: UseAISettingsProviderEditingInput, confirmProviderLeave: AISettingsLeaveGuard) {
  const { messageApi, t, mountedRef, activeRef, active, providers, applyProviderEditorSession, editorSessionRef, invalidateProviderTest, resolveAIService, focusProviderId, openedFocusProviderRef, applySection } = input;
  // Catalog entry carries the shipped gateway so an empty saved baseUrl still opens prefilled.
  const pluginCatalog = usePluginProviderCatalog();
  const handleEditProvider = (p: AIProviderConfig) => withAISettingsLeaveGuard(confirmProviderLeave, async () => {
      if (isPluginAIProviderNamespace(p.type) && p.id === 'gonavi-ai') { void messageApi.error(t('plugin.ai_provider.error.reserved_id')); return; }
      const session = ++editorSessionRef.current;
      invalidateProviderTest();
      try {
          const Service = await resolveAIService();
          if (!mountedRef.current || !activeRef.current || session !== editorSessionRef.current) return;
          const editableProvider = typeof Service?.AIGetEditableProvider === 'function'
              ? await Service.AIGetEditableProvider(p.id)
              : p;
          if (!mountedRef.current || !activeRef.current || session !== editorSessionRef.current) return;
          if (isPluginAIProviderNamespace(p.type) || isPluginAIProviderNamespace(editableProvider.type)) {
              if (isPluginAIProviderNamespace(p.type) && p.type !== editableProvider.type) throw new Error(t('plugin.ai_provider.error.unavailable'));
              applyProviderEditorSession(pluginProviderEditorSession(editableProvider, pluginCatalog?.find(editableProvider.type) ?? undefined)); return;
          }
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
  return { handleEditProvider };
}
