import React from 'react';
import { Button, Dropdown, Form, Input, Popconfirm, Select, Tooltip } from 'antd';
import { CheckOutlined, CloseOutlined, DownOutlined, EditOutlined, EyeInvisibleOutlined, EyeOutlined, InfoCircleOutlined, LeftOutlined, LoadingOutlined, PlusOutlined, RightOutlined, SearchOutlined, SyncOutlined } from '@ant-design/icons';
import type { FormInstance } from 'antd/es/form';

import type { AIProviderConfig } from '../../types';
import { buildProviderModelOptions, filterProviders, parseCLIModelCatalog, type CLIModelCatalog, type ProviderCheckResult } from '../../utils/aiProviderManagement';
import AIProviderModelSelect from './AIProviderModelSelect';
import { readCachedCLIModelCatalog, writeCachedCLIModelCatalog } from './cliModelCatalogCache';
import { applyPresetOrder, movePresetWithinGroup } from './providerPresetOrder';
import { AIProviderSortableGroup, AIProviderSortableItem } from './AIProviderSortable';
import { passThroughHintTooltip } from '../common/tooltipTiming';
import { useAIProviderLayout, workspaceClassName } from './useAIProviderLayout';
import './AISettingsProvidersSection.css';
import { getProviderEndpointType, getProviderEndpointTypes, type ProviderEndpointType } from '../../utils/aiProviderEndpoints';
import { t as catalogTranslate } from '../../i18n/catalog';
import { useOptionalI18n } from '../../i18n/provider';
import {
  isLocalCLISubscriptionProvider,
  getSingletonCLIIdentity,
  type ProviderPresetCandidate,
  type ProviderPresetEndpoint,
  type ProviderPresetMode,
} from '../../utils/aiProviderPresets';
import { isProviderSecretRequirementSatisfied } from '../../utils/providerSecretDraft';
import { recordFromRows } from '../../utils/aiProviderKeyValue';
import { AIGetCLICapabilities, AIGetCLIModelCatalog } from '../../../wailsjs/go/aiservice/Service';
import { BrowserOpenURL } from '../../../wailsjs/runtime';
import type { ai } from '../../../wailsjs/go/models';
import type { OverlayWorkbenchTheme } from '../../utils/overlayWorkbenchTheme';
import AIProviderPresetSelect from './AIProviderPresetSelect';
import AIProviderKeyValueRows from './AIProviderKeyValueRows';

// A rejected add or save often marks a field below the fold, which reads as
// "nothing happened". Both antd field errors and the standalone alerts are matched,
// so whichever appears first in the form is the one brought into view.
export const REVEAL_ERROR_SELECTOR = '.ant-form-item-has-error, [role="alert"]';

interface RevealTarget { getBoundingClientRect(): { top: number; height: number } }
interface RevealContainer {
  scrollTop: number;
  clientHeight: number;
  querySelector(selector: string): RevealTarget | null;
  getBoundingClientRect(): { top: number };
  scrollTo?: (options: ScrollToOptions) => void;
}

// scrollIntoView also scrolls every scrollable ancestor — including panes whose
// overflow is hidden, which then have no scrollbar to put them back and leave the
// settings header clipped. Only this container's own scrollTop is moved instead, so
// the field list travels and nothing around it does.
export const revealFirstErrorIn = (container?: RevealContainer | null): boolean => {
  const target = container?.querySelector(REVEAL_ERROR_SELECTOR);
  if (!container || !target) return false;
  const { top: targetTop, height: targetHeight } = target.getBoundingClientRect();
  const centred = (container.clientHeight - targetHeight) / 2;
  const next = Math.max(0, container.scrollTop + targetTop - container.getBoundingClientRect().top - Math.max(0, centred));
  if (container.scrollTo) container.scrollTo({ top: next, behavior: 'smooth' });
  else container.scrollTop = next;
  return true;
};

export interface AISettingsProviderPresetOption {
  key: string;
  label: string;
  icon: React.ReactNode;
  desc: string;
  defaultBaseUrl: string;
  endpoints?: ProviderPresetEndpoint[];
  defaultModel?: string;
  models?: string[];
  authMode?: AIProviderConfig['authMode'];
  backendType?: AIProviderConfig['type'];
  fixedApiFormat?: string;
  defaultApiFormat?: string;
  modeLabelKey?: string;
  defaultModeKey?: string;
  modes?: ProviderPresetMode[];
}

interface MatchedProviderPreset {
  key: string;
  label: string;
  icon: React.ReactNode;
}

interface AISettingsProvidersSectionProps {
  providers: AIProviderConfig[];
  activeProviderId: string;
  pendingProviderId?: string;
  providersLoading?: boolean;
  loadError?: string;
  onReloadProviders?: () => void;
  editingProvider: AIProviderConfig | null;
  editorSessionKey?: number;
  isEditing: boolean;
  form: FormInstance;
  providerPresets: AISettingsProviderPresetOption[];
  watchedPresetKey?: string;
  watchedApiFormat?: string;
  loading: boolean;
  testing?: boolean;
  testStatus: 'idle' | 'success' | 'error';
  testResult?: ProviderCheckResult | null;
  onValuesChange?: (changed: Record<string, unknown>) => void;
  onCLIDefaults?: (capability: ai.CLICapabilityView) => void;
  primaryPasswordVisible: boolean;
  darkMode: boolean;
  overlayTheme: OverlayWorkbenchTheme;
  cardBg: string;
  cardBorder: string;
  onPrimaryPasswordVisibleChange: (visible: boolean) => void;
  resolveProviderPreset: (provider: ProviderPresetCandidate) => MatchedProviderPreset;
  resolvePresetByKey: (presetKey: string) => AISettingsProviderPresetOption;
  onAddProvider: (presetKey?: string, endpointType?: ProviderEndpointType) => void;
  onEditProvider: (provider: AIProviderConfig) => void;
  onDeleteProvider: (id: string) => void;
  onSetActiveProvider: (id: string) => void;
  onCancelEdit: () => void;
  onPresetChange: (presetKey: string, endpointType?: ProviderEndpointType) => void;
  onConnectionModeChange?: (modeKey: string) => void;
  onCopyPartnerCode?: (code: string) => Promise<void>;
  onApplyPartnerBaseUrl?: (baseUrl: string, label: string) => void | Promise<void>;
  onSyncProviderModels?: () => Promise<string[]>;
  onAuthModeChange: (authMode: NonNullable<AIProviderConfig['authMode']>) => void;
  onTestProvider: () => void;
  onSaveProvider: () => void;
  onSaveProviderAsCopy?: () => void;
  saveMode?: 'save' | 'copy';
  dirty?: boolean;
  treeHostedView?: 'workspace' | 'connected';
  onOpenWorkspaceView?: () => void;
  onCloseHost?: () => void;
}

const AISettingsProvidersSection: React.FC<AISettingsProvidersSectionProps> = ({
  providers,
  activeProviderId,
  pendingProviderId,
  providersLoading = false,
  loadError,
  onReloadProviders,
  editingProvider,
  editorSessionKey = 0,
  isEditing,
  form,
  providerPresets,
  watchedPresetKey,
  watchedApiFormat,
  loading,
  testing = false,
  testStatus,
  testResult,
  onValuesChange,
  onCLIDefaults,
  primaryPasswordVisible,
  darkMode,
  overlayTheme,
  cardBorder,
  onPrimaryPasswordVisibleChange,
  resolveProviderPreset,
  resolvePresetByKey,
  onAddProvider,
  onEditProvider,
  onDeleteProvider,
  onSetActiveProvider,
  onPresetChange,
  onConnectionModeChange,
  onCopyPartnerCode,
  onApplyPartnerBaseUrl,
  onSyncProviderModels,
  onAuthModeChange,
  onTestProvider,
  onSaveProvider,
  onSaveProviderAsCopy,
  treeHostedView,
  onOpenWorkspaceView,
  onCloseHost: _onCloseHost,
  saveMode = 'save',
  dirty = false,
}) => {
  const i18n = useOptionalI18n();
  const copy = (key: string, params?: Record<string, string | number>) => i18n ? i18n.t(key, params) : catalogTranslate('en-US', key, params);
  const presetKeyFromForm = watchedPresetKey || (editingProvider as (AIProviderConfig & { presetKey?: string }) | null)?.presetKey || 'openai';
  const presetFromForm = providerPresets.find((preset) => preset.key === presetKeyFromForm);
  const watchedConnectionMode = Form.useWatch('connectionMode', { form, preserve: true });
  const activePresetMode = presetFromForm?.modes?.find((mode) => mode.key === watchedConnectionMode)
    || presetFromForm?.modes?.find((mode) => mode.key === presetFromForm.defaultModeKey)
    || presetFromForm?.modes?.[0];
  const activePresetConnection = activePresetMode || presetFromForm;
  const watchedType = Form.useWatch('type', form);
  const currentEndpointType = getProviderEndpointType({
    type: watchedType || activePresetConnection?.backendType,
    apiFormat: watchedApiFormat || activePresetConnection?.fixedApiFormat || activePresetConnection?.defaultApiFormat,
  });
  const editorScope = `${editorSessionKey}:${editingProvider?.id || 'new'}:${presetKeyFromForm}:${isEditing}`;
  const selectedEndpointType = currentEndpointType;
  const editorReady = Boolean(isEditing && presetFromForm);
  const endpointOptions = (activePresetConnection?.endpoints || []).filter((endpoint) => getProviderEndpointType({ type: endpoint.backendType }) === selectedEndpointType);
  const watchedAuthMode = Form.useWatch('authMode', { form, preserve: true });
  const usesLocalCLI = activePresetConnection?.authMode === 'local-cli'
    || (presetKeyFromForm === 'openai' && watchedAuthMode === 'local-cli');
  // A saved configuration is reusable; it is not proof of a current login or
  // model response. Match transport/auth presets, never aliases or CLI names.
  const providersByPreset = new Map<string, AIProviderConfig[]>();
  providers.forEach((provider) => {
    const key = resolveProviderPreset(provider).key;
    providersByPreset.set(key, [...(providersByPreset.get(key) || []), provider]);
  });
  const existingProviders = providersByPreset.get(presetKeyFromForm) || [];
  const currentConfigSaved = existingProviders.some((provider) => provider.id === editingProvider?.id);
  const presetCLIIdentity = (preset: AISettingsProviderPresetOption) => getSingletonCLIIdentity({
    type: preset.backendType || 'custom', apiFormat: preset.fixedApiFormat, authMode: preset.authMode,
  });
  const canSelectPreset = (preset: AISettingsProviderPresetOption, editingId?: string) => {
    const identity = presetCLIIdentity(preset);
    if (!identity) return true;
    // Existing duplicates are not deleted or made uneditable. Only additional
    // records and conversions into another configured CLI are excluded.
    if (editingId && providers.some((provider) => provider.id === editingId && getSingletonCLIIdentity(provider) === identity)) return true;
    return !providers.some((provider) => getSingletonCLIIdentity(provider) === identity);
  };
  const currentCLIIdentity = usesLocalCLI ? getSingletonCLIIdentity({
    type: watchedType || 'custom',
    apiFormat: watchedApiFormat || presetFromForm?.fixedApiFormat,
    authMode: 'local-cli',
  }) : '';
  const duplicateCLI = Boolean(currentCLIIdentity
    && (!editingProvider?.id || getSingletonCLIIdentity(editingProvider) !== currentCLIIdentity)
    && providers.some((provider) => provider.id !== editingProvider?.id && getSingletonCLIIdentity(provider) === currentCLIIdentity));
  // A singleton CLI preset reuses one machine login, so a second copy would be a
  // duplicate of the same connection. Only multi-instance providers expose the
  // save-as entry, and it lives in the save button's dropdown rather than beside it.
  const singletonCLIPreset = Boolean(currentCLIIdentity || (presetFromForm && presetCLIIdentity(presetFromForm)));
  const canSaveAsCopy = Boolean(editingProvider?.id) && !singletonCLIPreset && Boolean(onSaveProviderAsCopy);
  const [search, setSearch] = React.useState('');
  const [catalogSearch, setCatalogSearch] = React.useState('');
  const [modelManagementRequest, setModelManagementRequest] = React.useState({ scope: '', request: 0 });
  const layout = useAIProviderLayout();
  const hiddenKeys = new Set(layout.preferences.hiddenPresetKeys);
  const orderedPresets = applyPresetOrder(providerPresets, layout.preferences.presetOrder);
  const displayedPresets = orderedPresets.filter((preset) => !hiddenKeys.has(preset.key));
  const hiddenPresets = orderedPresets.filter((preset) => hiddenKeys.has(preset.key));
  const movePreset = (groupKeys: string[]) => (activeKey: string, overKey: string) =>
    layout.setPreference('presetOrder', movePresetWithinGroup(orderedPresets.map((preset) => preset.key), groupKeys, activeKey, overKey));
  // Expansion is session-only: hidden choices stay folded on re-entry and when
  // moving another choice into this folder. Provider configurations are untouched.
  const [hiddenExpanded, setHiddenExpanded] = React.useState(false);
  const hiddenToggleRef = React.useRef<HTMLButtonElement>(null);
  const visibilityButtons = React.useRef(new Map<string, HTMLButtonElement>());
  const visibilityFocus = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!visibilityFocus.current) return;
    const target = visibilityButtons.current.get(visibilityFocus.current) || hiddenToggleRef.current;
    target?.focus({ preventScroll: true });
    visibilityFocus.current = null;
  }, [layout.preferences.hiddenPresetKeys]);
  const catalogToggleRef = React.useRef<HTMLButtonElement>(null);
  const editorScrollRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (editorScrollRef.current) editorScrollRef.current.scrollTop = 0;
  }, [editorScope]);
  // A rejected add or save often lands on a field below the fold, which reads as
  // "nothing happened". Bring the first error into view instead.
  const revealFirstError = React.useCallback(() => revealFirstErrorIn(editorScrollRef.current), []);
  // Validation messages mount after the attempt resolves, so check once on the next
  // frame and once more shortly after for validators that resolve asynchronously.
  const revealFirstErrorSoon = React.useCallback(() => {
    // Guarded: non-DOM render hosts supply only a partial window.
    if (typeof window === 'undefined') return;
    window.requestAnimationFrame?.(revealFirstError);
    window.setTimeout?.(revealFirstError, 200);
  }, [revealFirstError]);
  React.useEffect(() => {
    if (duplicateCLI || testStatus === 'error') revealFirstError();
  }, [duplicateCLI, testStatus, revealFirstError]);
  const rowButtons = React.useRef(new Map<string, HTMLButtonElement>());
  const visibleProviders = filterProviders(providers, search, (provider) => resolveProviderPreset(provider).label);
  // 档位的合法值域由目标 CLI 决定；前端只做投影，不维护副本。
  const cliScope = `${editorScope}:${editorReady}:${usesLocalCLI}:${duplicateCLI}`;
  const [cliCapabilityResponse, setCLICapabilityResponse] = React.useState<{ scope: string; views: ai.CLICapabilityView[] }>({ scope: '', views: [] });
  const cliCapabilities = cliCapabilityResponse.scope === cliScope ? cliCapabilityResponse.views : [];
  React.useEffect(() => {
    if (!editorReady || !usesLocalCLI || duplicateCLI) {
      setCLICapabilityResponse({ scope: '', views: [] });
      return;
    }
    let cancelled = false;
    Promise.resolve().then(() => AIGetCLICapabilities())
      .then((views) => { if (!cancelled) setCLICapabilityResponse({ scope: cliScope, views: views || [] }); })
      .catch(() => { if (!cancelled) setCLICapabilityResponse({ scope: cliScope, views: [] }); });
    return () => { cancelled = true; };
  }, [cliScope, editorReady, usesLocalCLI, duplicateCLI]);
  const activeCLICapability = usesLocalCLI
    ? cliCapabilities.find((item) => item.apiFormat === String(watchedApiFormat || '').trim().toLowerCase())
    : undefined;
  React.useEffect(() => {
    if (editorReady && !duplicateCLI && activeCLICapability) onCLIDefaults?.(activeCLICapability);
  }, [editorReady, duplicateCLI, activeCLICapability, onCLIDefaults]);
  // The backend distinguishes aliases, caches and CLI enumeration. Do not gate Codex's
  // local catalog on supportsModelDiscovery, which describes a CLI command.
  const watchedCLIPath = String(Form.useWatch('cliPath', form) || '').trim();
  // Capability data is authoritative once the desktop bridge responds. The
  // format-derived fallback keeps the provider name useful during loading and
  // in browser previews where the Wails bridge is unavailable.
  const cliCommand = activeCLICapability?.command
    || String(watchedApiFormat || '').trim().replace(/-cli$/i, '')
    || 'CLI';
  const cliPathIsManual = watchedCLIPath !== '';
  const watchedCLIEnvRows = Form.useWatch('cliEnvRows', { form, preserve: true });
  const watchedCLIEnv = recordFromRows(Array.isArray(watchedCLIEnvRows) ? watchedCLIEnvRows : []);
  const cliExecutionScope = JSON.stringify({ path: watchedCLIPath, env: Object.entries(watchedCLIEnv || {}).sort(([a], [b]) => a.localeCompare(b)) });
  const hasCustomCLIExecution = watchedCLIPath !== '' || Boolean(watchedCLIEnv && Object.keys(watchedCLIEnv).length);
  const catalogScope = `${cliScope}:${watchedApiFormat || ''}:${cliExecutionScope}`;
  const [catalogRefresh, setCatalogRefresh] = React.useState(0);
  // Set by the enabled-count button: the next effect run bypasses the cached
  // catalog and shells out to the CLI again.
  const catalogRefreshForced = React.useRef(false);
  const [catalogResponse, setCatalogResponse] = React.useState<{ scope: string; cliScope: string; catalog: CLIModelCatalog } | null>(null);
  // A refresh keeps the current list until the new result lands, but only within
  // the same editor session; another provider's catalog must never show through.
  const modelCatalog = catalogResponse?.scope === catalogScope ? catalogResponse.catalog : null;
  const [modelsLoading, setModelsLoading] = React.useState(false);
  const [modelDiscoveryError, setModelDiscoveryError] = React.useState(false);
  React.useEffect(() => {
    setModelDiscoveryError(false);
    setModelsLoading(false);
    if (!editorReady || !usesLocalCLI || duplicateCLI || !watchedApiFormat) return;
    const forced = catalogRefreshForced.current;
    catalogRefreshForced.current = false;
    // Entering the editor reuses the last usable catalog; only the count button refreshes.
    const cached = forced || hasCustomCLIExecution ? null : readCachedCLIModelCatalog(watchedApiFormat);
    if (cached) { setCatalogResponse({ scope: catalogScope, cliScope, catalog: cached }); return; }
    let cancelled = false;
    setModelsLoading(true);
    Promise.resolve().then(() => AIGetCLIModelCatalog({
      id: editingProvider?.id || '', type: 'custom', name: '', apiKey: '', baseUrl: '', model: '', maxTokens: 0, temperature: 0,
      apiFormat: watchedApiFormat, authMode: 'local-cli', cliPath: watchedCLIPath, cliEnv: watchedCLIEnv,
    } as ai.ProviderConfig))
      .then((value) => {
        if (cancelled) return;
        const catalog = parseCLIModelCatalog(value);
        if (!catalog) throw new Error('Invalid model catalog');
        if (!hasCustomCLIExecution) writeCachedCLIModelCatalog(watchedApiFormat, catalog);
        setCatalogResponse({ scope: catalogScope, cliScope, catalog });
        setModelDiscoveryError(catalog.stale || (catalog.source !== 'none' && !catalog.models.length));
      })
      .catch(() => {
        if (cancelled) return;
        setModelDiscoveryError(true);
        setCatalogResponse((previous) => (previous?.scope === catalogScope ? previous : null));
      })
      .finally(() => { if (!cancelled) setModelsLoading(false); });
    return () => { cancelled = true; };
  }, [catalogScope, cliScope, catalogRefresh, editorReady, usesLocalCLI, duplicateCLI, watchedApiFormat, watchedCLIPath, hasCustomCLIExecution, editingProvider?.id]);
  const supportsAdvancedEndpoint = presetKeyFromForm === 'custom' || presetKeyFromForm === 'ollama' || presetKeyFromForm === 'codebuddy' || presetKeyFromForm === 'cursor';
  const codeBuddyUsesOptionalSecret = presetKeyFromForm === 'codebuddy';
  const watchedModel = Form.useWatch('model', form);
  const watchedEffort = Form.useWatch('effort', { form, preserve: true });
  const watchedInlineCompletionModel = Form.useWatch('inlineCompletionModel', form);
  const watchedDisabledModels = Form.useWatch('disabledModels', { form, preserve: true }) || [];
  const watchedCustomModels = Form.useWatch('customModels', { form, preserve: true }) || [];
  const watchedBaseUrl = String(Form.useWatch('baseUrl', { form, preserve: true }) || '').trim();
  const watchedApiKey = String(Form.useWatch('apiKey', { form, preserve: true }) || '');
  const watchedHeaderRows = Form.useWatch('headerRows', { form, preserve: true }) || [];
  const upstreamScope = JSON.stringify({ editorScope, type: watchedType, apiFormat: watchedApiFormat, authMode: watchedAuthMode,
    baseUrl: watchedBaseUrl, apiKey: watchedApiKey, headerRows: watchedHeaderRows });
  const upstreamScopeRef = React.useRef(upstreamScope);
  upstreamScopeRef.current = upstreamScope;
  const upstreamRequestRef = React.useRef(0);
  const [upstreamModelResponse, setUpstreamModelResponse] = React.useState<{ scope: string; models: string[] } | null>(null);
  const [upstreamModelsLoading, setUpstreamModelsLoading] = React.useState(false);
  const upstreamModels = upstreamModelResponse?.scope === upstreamScope ? upstreamModelResponse.models : [];
  React.useEffect(() => {
    upstreamRequestRef.current += 1;
    setUpstreamModelsLoading(false);
  }, [upstreamScope]);
  const supportsUpstreamModelSync = Boolean(onSyncProviderModels && !usesLocalCLI && selectedEndpointType !== 'cli'
    && String(watchedApiFormat || '').trim().toLowerCase() !== 'codebuddy-cli');
  const syncUpstreamModels = async () => {
    if (!supportsUpstreamModelSync || upstreamModelsLoading || !onSyncProviderModels) return;
    const request = ++upstreamRequestRef.current;
    const scope = upstreamScope;
    setUpstreamModelsLoading(true);
    try {
      const models = await onSyncProviderModels();
      if (request === upstreamRequestRef.current && scope === upstreamScopeRef.current) {
        setUpstreamModelResponse({ scope, models });
      }
    } catch {
      // The owner reports the localized error. Keep the prior catalog visible.
    } finally {
      if (request === upstreamRequestRef.current) setUpstreamModelsLoading(false);
    }
  };
  React.useEffect(() => () => { upstreamRequestRef.current += 1; }, []);
  const modelOptions = buildProviderModelOptions(
    modelCatalog?.models,
    upstreamModels,
    [watchedModel, watchedInlineCompletionModel, activeCLICapability?.defaultModel,
      ...(usesLocalCLI ? [] : [activePresetConnection?.defaultModel])],
    usesLocalCLI ? [] : activePresetConnection?.models,
    watchedCustomModels,
    watchedDisabledModels,
  );
  const disabledModels = new Set<string>(watchedDisabledModels);
  const enabledModelOptions = modelOptions.filter((option) => !disabledModels.has(option.value));
  const activeCatalogModel = String(watchedModel || modelCatalog?.defaultModel || '').trim();
  const activeModelCapability = activeCatalogModel ? modelCatalog?.modelCapabilities?.[activeCatalogModel] : undefined;
  const activeEffortValues = activeModelCapability?.effortValues?.length
    ? activeModelCapability.effortValues
    : (activeCLICapability?.effortValues || []);
  React.useEffect(() => {
    const effort = String(watchedEffort || '').trim().toLowerCase();
    if (!usesLocalCLI || !activeModelCapability || !effort || activeEffortValues.includes(effort)) return;
    form.setFieldValue('effort', undefined);
    onValuesChange?.({ effort: undefined });
  }, [activeEffortValues, activeModelCapability, form, onValuesChange, usesLocalCLI, watchedEffort]);
  const patchModels = (patch: Record<string, string[]>) => { form.setFieldsValue(patch); onValuesChange?.(patch); };
  const modelSourceKey = modelCatalog?.stale ? 'ai_settings.form.model_catalog.stale'
    : modelDiscoveryError ? 'ai_settings.form.models_manual_fallback'
      : upstreamModels.length ? 'ai_settings.form.model_catalog.upstream'
      : !usesLocalCLI ? 'ai_settings.form.model_catalog.saved'
        : `ai_settings.form.model_catalog.${modelCatalog?.source || 'none'}`;
  const fieldLabel = (key: string) => <span style={{ fontWeight: 500, color: overlayTheme.titleText }}>{copy(key)}</span>;
  const endpointLabel = (endpoint: ProviderEndpointType) => copy(`ai_settings.endpoint.${endpoint}.label`);
  const chooseCatalogPreset = (key: string) => {
    const preset = providerPresets.find((item) => item.key === key);
    if (!preset) return;
    const configured = providersByPreset.get(key) || [];
    if (presetCLIIdentity(preset) && configured.length) {
      onEditProvider(configured.find((provider) => provider.id === editingProvider?.id) || configured[0]);
    } else if (canSelectPreset(preset)) onAddProvider(key);
    layout.closeDrawer();
  };
  const matchesCatalogSearch = (preset: AISettingsProviderPresetOption) => [preset.label, preset.key, preset.desc]
    .join(' ').toLocaleLowerCase().includes(catalogSearch.trim().toLocaleLowerCase());
  const visiblePresets = displayedPresets.filter(matchesCatalogSearch);
  const matchingHiddenPresets = hiddenPresets.filter(matchesCatalogSearch);
  const hidePreset = (key: string) => {
    const index = visiblePresets.findIndex((preset) => preset.key === key);
    const next = visiblePresets[index + 1] || visiblePresets[index - 1];
    visibilityFocus.current = next ? `visible:${next.key}` : 'folder';
    layout.setPresetHidden(key, true);
  };
  const restorePreset = (key: string) => {
    const remaining = matchingHiddenPresets.filter((preset) => preset.key !== key);
    visibilityFocus.current = remaining[0] ? `hidden:${remaining[0].key}` : `visible:${key}`;
    if (!remaining.length) setHiddenExpanded(false);
    layout.setPresetHidden(key, false);
  };
  const saveActionLabel = copy(editingProvider?.id ? 'ai_settings.provider.save_changes' : 'ai_settings.provider.action.add');
  const handleSaveProvider = () => { onSaveProvider(); revealFirstErrorSoon(); };
  const handleTestProvider = () => { onTestProvider(); revealFirstErrorSoon(); };
  const currentName = providers.find((provider) => provider.id === activeProviderId)?.name;
  const rootStyle = {
    '--provider-muted': overlayTheme.mutedText, '--provider-text': overlayTheme.titleText,
    '--provider-line': cardBorder, '--provider-active': overlayTheme.selectedText,
    '--provider-active-bg': overlayTheme.selectedBg, '--provider-bg': overlayTheme.shellBg,
    '--provider-catalog-width': `${layout.catalogWidth}px`,
  } as React.CSSProperties;
  const requiredModelRule = { validator: (_: unknown, value: string) => disabledModels.has(value)
    ? Promise.reject(new Error(copy('ai_settings.models.default_required'))) : Promise.resolve() };
  const showAuthMethod = presetKeyFromForm === 'openai' || (!usesLocalCLI && (
    presetKeyFromForm === 'anthropic'
    || selectedEndpointType === 'anthropic'
    || (presetKeyFromForm === 'custom' && String(watchedApiFormat || '').toLowerCase() === 'anthropic')
  ));
  const cliChipHint = (provider: AIProviderConfig) => {
    const preset = resolveProviderPreset(provider);
    const lines = [
      copy('ai_settings.provider.local_cli_reuse'),
      provider.apiFormat === 'cursor-cli' && copy('ai_settings.form.local_cli.cursor_boundary'),
      copy(provider.apiFormat === 'codex-cli' ? 'ai_settings.form.local_cli.codex_hint' : preset.key === 'grok' ? 'ai_settings.form.local_cli.grok_hint' : provider.apiFormat === 'cursor-cli' ? 'ai_settings.form.local_cli.cursor_hint' : 'ai_settings.form.local_cli.claude_hint'),
    ].filter(Boolean);
    return <div className="gonavi-ai-provider-hint-body">{lines.map((line, index) => <div key={index}>{line}</div>)}</div>;
  };
  const catalogSearching = Boolean(catalogSearch.trim());
  // Floating copy shown under the pointer while a catalog card or hidden row is
  // dragged; the original stays in place as the faded placeholder.
  const presetDragOverlay = (variant: 'card' | 'row') => (key: string) => {
    const preset = orderedPresets.find((item) => item.key === key);
    if (!preset) return null;
    return variant === 'card'
      ? <div className="gonavi-ai-provider-catalog-entry is-drag-overlay"><span className="gonavi-ai-provider-catalog-card">
        <span className="gonavi-ai-provider-catalog-top"><span className="gonavi-ai-provider-icon" aria-hidden="true">{preset.icon}</span></span>
        <span className="gonavi-ai-provider-catalog-label">{preset.label}</span></span></div>
      : <div className="gonavi-ai-provider-hidden-row is-drag-overlay"><span className="gonavi-ai-provider-hidden-choose">
        <span className="gonavi-ai-provider-icon" aria-hidden="true">{preset.icon}</span>
        <span className="gonavi-ai-provider-hidden-label">{preset.label}</span></span></div>;
  };
  const catalogEntry = (preset: AISettingsProviderPresetOption) => {
    const configured = providersByPreset.get(preset.key) || [];
    const connectedCLI = Boolean(presetCLIIdentity(preset) && configured.length);
    const selected = isEditing && preset.key === presetKeyFromForm;
    return <AIProviderSortableItem id={preset.key} className="gonavi-ai-provider-catalog-entry" key={preset.key} disabled={catalogSearching}>
      <Tooltip {...passThroughHintTooltip} title={<div><strong>{preset.label}</strong><div>{preset.desc}</div>
        <div>{getProviderEndpointTypes(preset).map(endpointLabel).join(' · ')}</div>
        {connectedCLI && <div>{copy('ai_settings.provider.local_cli_reuse')}</div>}</div>} trigger={['hover', 'focus']}>
      <button type="button" className={`gonavi-ai-provider-catalog-card${selected ? ' is-editing' : ''}`} aria-pressed={selected}
        aria-label={`${preset.label}${connectedCLI ? ` · ${copy('ai_settings.provider.configured')}` : ''}`}
        disabled={providersLoading || Boolean(loadError) || loading} onClick={() => chooseCatalogPreset(preset.key)}>
        <span className="gonavi-ai-provider-catalog-top">
          <span className="gonavi-ai-provider-icon" aria-hidden="true">{preset.icon}</span>
        </span>
        <span className="gonavi-ai-provider-catalog-label">{preset.label}</span>
      </button>
      </Tooltip>
      {connectedCLI && <Tooltip {...passThroughHintTooltip} title={copy('ai_settings.models.enabled')}>
        <span className="gonavi-ai-provider-catalog-check" aria-hidden="true"><CheckOutlined /></span>
      </Tooltip>}
      <Tooltip {...passThroughHintTooltip} title={copy('ai_settings.provider.hide')}>
        <button type="button" className="gonavi-ai-provider-visibility" aria-label={`${copy('ai_settings.provider.hide')}: ${preset.label}`}
          ref={(node) => { if (node) visibilityButtons.current.set(`visible:${preset.key}`, node); else visibilityButtons.current.delete(`visible:${preset.key}`); }}
          onClick={() => hidePreset(preset.key)}><EyeInvisibleOutlined /></button>
      </Tooltip>
    </AIProviderSortableItem>;
  };

  const openProviderInWorkspace = (provider: AIProviderConfig) => {
    if (treeHostedView === 'connected') {
      onOpenWorkspaceView?.();
    }
    onEditProvider(provider);
  };
  const hideCatalog = Boolean(treeHostedView);

  return <div className={`gonavi-ai-provider-management${treeHostedView === 'connected' ? ' is-connected-only' : ''}`} style={rootStyle}>
    {treeHostedView === 'connected' ? null : <div className="gonavi-ai-provider-heading">
      <span className="gonavi-ai-provider-heading-copy">{copy('ai_settings.nav.providers.description')}</span>
      <AIProviderPresetSelect
        className="gonavi-ai-provider-add gonavi-ai-provider-add-preset-select"
        value={isEditing ? presetKeyFromForm : null}
        presets={providerPresets}
        canSelect={(preset) => {
          const full = providerPresets.find((item) => item.key === preset.key);
          return full ? canSelectPreset(full, editingProvider?.id) && (!hiddenKeys.has(full.key) || full.key === presetKeyFromForm) : false;
        }}
        disabled={providersLoading || Boolean(loadError) || loading}
        dark={darkMode}
        builtinLabel={copy('ai_settings.provider.builtin')}
        partnerLabel={copy('ai_settings.provider.partners')}
        partnerPromoLabel={copy('ai_settings.provider.partner.promo_label')}
        partnerPromoCopyingLabel={copy('ai_settings.provider.partner.copying')}
        partnerPromoCopyFailedLabel={copy('ai_settings.provider.partner.copy_failed')}
        partnerPromoCopyActionLabel={copy('ai_settings.provider.partner.copy_action')}
        partnerApplyBaseUrlActionLabel={copy('ai_settings.provider.partner.apply_base_url_action')}
        partnerVisitActionLabel={copy('ai_settings.provider.partner.visit_action')}
        partners={[{
          key: 'hualong',
          label: copy('app.about.project.hualong.title'),
          logoSrc: '/sponsors/hualong-icon.png',
          url: 'https://api.hualong.online/register?promo=GONAVI%26HUALONG',
          baseUrl: 'https://api.hualong.online/v1',
          benefit: copy('ai_settings.provider.partner.hualong.benefit'),
          promoCode: 'GONAVI&HUALONG',
        }]}
        onCopyPartnerCode={onCopyPartnerCode}
        onApplyPartnerBaseUrl={onApplyPartnerBaseUrl}
        onOpenPartner={(url) => {
          try { BrowserOpenURL(url); } catch { window.open(url, '_blank', 'noopener,noreferrer'); }
        }}
        ariaLabel={copy(isEditing ? 'ai_settings.form.provider' : 'ai_settings.provider.action.add')}
        placeholder={<span><PlusOutlined /> {copy('ai_settings.provider.action.add')}</span>}
        onChange={(key) => {
          if (isEditing) onPresetChange(key);
          else { onAddProvider(key); layout.closeDrawer(); }
        }}
      />
    </div>}
    {treeHostedView !== 'workspace' ? <div className="gonavi-ai-provider-list" data-density={layout.preferences.density}>
      <div className="gonavi-ai-provider-toolbar">
        {treeHostedView === 'connected' ? null : <button type="button" className="gonavi-ai-provider-collapse" aria-expanded={!layout.preferences.savedCollapsed}
          aria-controls="gonavi-ai-provider-chips" onClick={() => layout.setPreference('savedCollapsed', !layout.preferences.savedCollapsed)}>
          <span className="gonavi-ai-provider-caret" aria-hidden="true">{layout.preferences.savedCollapsed ? <RightOutlined /> : <DownOutlined />}</span>
          {copy('ai_settings.provider.configured')} <small>{providers.length}</small>
        </button>}
        {treeHostedView !== 'connected' && layout.preferences.savedCollapsed ? <span className="gonavi-ai-provider-collapsed-default">{currentName && `${copy('ai_settings.provider.default')}: ${currentName}`}</span> : <div className="gonavi-ai-provider-toolbar-end">
          <div className="gonavi-ai-provider-density" role="group" aria-label={copy('ai_settings.provider.density')}>
            {(['compact', 'normal'] as const).map((density) => <button key={density} type="button"
              aria-pressed={layout.preferences.density === density} onClick={() => layout.setPreference('density', density)}>{copy(`ai_settings.provider.${density}`)}</button>)}
          </div>
          <Input className="gonavi-ai-provider-saved-search" aria-label={copy('ai_settings.provider.search')} placeholder={copy('ai_settings.provider.search_short')}
            prefix={<SearchOutlined />} allowClear value={search} onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'ArrowDown' && visibleProviders.length) { event.preventDefault(); rowButtons.current.get(visibleProviders[0].id)?.focus(); } }} />
        </div>}
      </div>
      {loadError && <div role="alert">{loadError} <Button type="link" onClick={onReloadProviders}>{copy('ai_settings.provider.retry')}</Button></div>}
      {providersLoading && <div role="status"><LoadingOutlined /> {copy('ai_settings.provider.loading')}</div>}
      <div id="gonavi-ai-provider-chips" className="gonavi-ai-provider-chips" role="radiogroup"
        aria-label={copy('ai_settings.provider.default_label')} hidden={treeHostedView !== 'connected' && layout.preferences.savedCollapsed}>
        {!providersLoading && !loadError && providers.length === 0 && <span className="gonavi-ai-provider-empty">{copy('ai_settings.provider.empty.title')}</span>}
        {providers.length > 0 && visibleProviders.length === 0 && <span role="status">{copy('ai_settings.provider.no_matches')}</span>}
        {visibleProviders.map((provider, index) => {
          const matchedPreset = resolveProviderPreset(provider);
          const isActive = provider.id === activeProviderId;
          const isPending = provider.id === pendingProviderId;
          const name = provider.name || matchedPreset.label;
          const modelLabel = provider.model || (isLocalCLISubscriptionProvider(provider) || provider.apiFormat === 'codebuddy-cli' || provider.apiFormat === 'cursor-agent'
            ? copy('ai_settings.provider.auto_model') : copy('ai_settings.provider.no_model'));
          const tooltip = <div><strong>{name}</strong><div>{matchedPreset.label}</div><div>{modelLabel}{provider.effort && ` · ${provider.effort}`}</div>
            {isActive && <div>{copy('ai_settings.provider.default_label')}</div>}
            {Boolean(provider.disabledModels?.length) && <div>{copy('ai_settings.models.disabled_count', { count: provider.disabledModels!.length })}</div>}
          </div>;
          return <div className={`gonavi-ai-provider-row gonavi-ai-provider-chip${isActive ? ' is-active' : ''}`} key={provider.id}>
            <Tooltip {...passThroughHintTooltip} title={tooltip} trigger={['hover', 'focus']}>
              <button className="gonavi-ai-provider-select" type="button" role="radio" aria-checked={isActive}
                aria-label={`${copy('ai_settings.provider.set_default')}: ${name}`} aria-busy={isPending}
                tabIndex={isActive || (!visibleProviders.some((item) => item.id === activeProviderId) && index === 0) ? 0 : -1}
                ref={(node) => { if (node) rowButtons.current.set(provider.id, node); else rowButtons.current.delete(provider.id); }}
                onClick={() => onSetActiveProvider(provider.id)}
                onKeyDown={(event) => {
                  if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
                  event.preventDefault();
                  const next = event.key === 'Home' ? 0 : event.key === 'End' ? visibleProviders.length - 1
                    : (index + (event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : -1) + visibleProviders.length) % visibleProviders.length;
                  rowButtons.current.get(visibleProviders[next].id)?.focus(); onSetActiveProvider(visibleProviders[next].id);
                }}>
                <span className="gonavi-ai-provider-radio" aria-hidden="true">{isPending ? <LoadingOutlined /> : isActive ? <CheckOutlined /> : null}</span>
                <span className="gonavi-ai-provider-chip-content"><span className="gonavi-ai-provider-name">{name}</span>
                  {layout.preferences.density === 'normal' && <span className="gonavi-ai-provider-chip-model">{modelLabel}{provider.effort && ` · ${provider.effort}`}</span>}
                </span>
                {isActive && <span className="gonavi-ai-provider-current">{copy('ai_settings.provider.default')}</span>}
              </button>
            </Tooltip>
            {isEditing && editingProvider?.id === provider.id && isLocalCLISubscriptionProvider(provider) && <Tooltip {...passThroughHintTooltip} title={cliChipHint(provider)}>
              <button type="button" className="gonavi-ai-provider-chip-hint" aria-label={copy('ai_settings.form.local_cli.title')}
                onClick={(event) => { event.preventDefault(); event.stopPropagation(); }}>
                <InfoCircleOutlined aria-hidden="true" />
              </button>
            </Tooltip>}
            <Tooltip {...passThroughHintTooltip} title={copy('ai_settings.provider.action.edit')}><Button type="text" size="small" icon={<EditOutlined />}
              aria-label={`${copy('ai_settings.provider.action.edit')}: ${name}`} onClick={() => openProviderInWorkspace(provider)} /></Tooltip>
            {/* Removing a configuration is destructive, so the corner control still
                confirms before it deletes; it only appears on hover or focus. */}
            <Popconfirm title={copy('ai_settings.provider.confirm_delete')} onConfirm={() => onDeleteProvider(provider.id)}
              disabled={Boolean(pendingProviderId) || loading} okButtonProps={{ danger: true }}
              okText={copy('ai_settings.provider.action.delete')} cancelText={copy('common.cancel')}>
              <button type="button" className="gonavi-ai-provider-chip-remove" disabled={Boolean(pendingProviderId) || loading}
                aria-label={`${copy('ai_settings.provider.action.delete')}: ${name}`}><CloseOutlined aria-hidden="true" /></button>
            </Popconfirm>
          </div>;
        })}
      </div>
    </div> : null}
    {treeHostedView === 'connected' ? null : <>
    {hideCatalog ? null : <div className="gonavi-ai-provider-workspace-toolbar">
      <button type="button" ref={catalogToggleRef} className="gonavi-ai-provider-catalog-toggle" aria-expanded={layout.catalogVisible}
        aria-controls="gonavi-ai-provider-catalog" onClick={layout.toggleCatalog}>
        <span className="gonavi-ai-provider-caret" aria-hidden="true">{layout.catalogVisible ? <LeftOutlined /> : <RightOutlined />}</span>{copy('ai_settings.provider.catalog')} <small>{displayedPresets.length}</small>
      </button>
      {layout.catalogVisible && <Input className="gonavi-ai-provider-catalog-search" prefix={<SearchOutlined />} allowClear value={catalogSearch}
        onChange={(event) => setCatalogSearch(event.target.value)}
        placeholder={copy('ai_settings.provider.catalog_search')} aria-label={copy('ai_settings.provider.catalog_search')} />}
      {usesLocalCLI && currentConfigSaved && <span className="gonavi-ai-provider-catalog-hint">{copy('ai_settings.provider.catalog_hint')}</span>}
    </div>}
    <div ref={layout.workspaceRef} className={`${workspaceClassName(layout.narrow, hideCatalog ? false : layout.catalogVisible, layout.dragging)}${hideCatalog ? ' is-editor-only' : ''}`}
      onKeyDown={(event) => { if (event.key === 'Escape' && !hideCatalog && layout.narrow && layout.catalogVisible) { event.stopPropagation(); layout.closeDrawer(); catalogToggleRef.current?.focus(); } }}>
      {!hideCatalog && layout.narrow && layout.catalogVisible && <button className="gonavi-ai-provider-scrim" type="button" aria-label={copy('ai_settings.provider.close_catalog')}
        onClick={() => { layout.closeDrawer(); catalogToggleRef.current?.focus(); }} />}
      {hideCatalog ? null : <aside id="gonavi-ai-provider-catalog" ref={layout.catalogRef}
        className={`gonavi-ai-provider-catalog${layout.hiddenPaneHeight != null ? ' is-hidden-pinned' : ''}`}
        style={layout.hiddenPaneHeight != null ? { ['--provider-hidden-pane' as string]: `${layout.hiddenPaneHeight}px` } : undefined}
        hidden={!layout.catalogVisible} aria-label={copy('ai_settings.provider.catalog')}>
        <div className="gonavi-ai-provider-catalog-scroll"><div className="gonavi-ai-provider-catalog-grid">
          <AIProviderSortableGroup layout="grid" items={visiblePresets.map((preset) => preset.key)} disabled={catalogSearching} overlayStyle={rootStyle}
            onMove={movePreset(visiblePresets.map((preset) => preset.key))} renderOverlay={presetDragOverlay('card')}>
            {visiblePresets.map((preset) => catalogEntry(preset))}
          </AIProviderSortableGroup>
        </div>{!visiblePresets.length && <div className="gonavi-ai-provider-catalog-empty" role="status">{copy(
          matchingHiddenPresets.length ? 'ai_settings.provider.hidden_matches' : 'ai_settings.provider.no_matches',
          { count: matchingHiddenPresets.length })}</div>}
        </div>
        <div className="gonavi-ai-provider-catalog-footer">
          {hiddenPresets.length > 0 && <div {...layout.hiddenSplitProps} className="gonavi-ai-provider-hidden-split"
            aria-label={copy('ai_settings.provider.resize_hidden')} aria-controls="gonavi-ai-provider-hidden-list"><span aria-hidden="true">⋯</span></div>}
          {hiddenPresets.length > 0 && <section className="gonavi-ai-provider-hidden">
            <button type="button" ref={hiddenToggleRef} className="gonavi-ai-provider-hidden-toggle" aria-expanded={hiddenExpanded}
              aria-controls="gonavi-ai-provider-hidden-list" title={copy('ai_settings.provider.hidden_hint')}
              onClick={() => setHiddenExpanded((expanded) => !expanded)}>
              <span className="gonavi-ai-provider-caret" aria-hidden="true">{hiddenExpanded ? <DownOutlined /> : <RightOutlined />}</span><EyeInvisibleOutlined aria-hidden="true" />
              {copy('ai_settings.provider.hidden_catalog')} <small>{catalogSearch.trim() ? `${matchingHiddenPresets.length} / ` : ''}{hiddenPresets.length}</small>
            </button>
            {hiddenExpanded && <div id="gonavi-ai-provider-hidden-list" className="gonavi-ai-provider-hidden-list">
              <AIProviderSortableGroup layout="list" items={matchingHiddenPresets.map((preset) => preset.key)} disabled={catalogSearching} overlayStyle={rootStyle}
                onMove={movePreset(matchingHiddenPresets.map((preset) => preset.key))} renderOverlay={presetDragOverlay('row')}>
              {matchingHiddenPresets.map((preset) => <AIProviderSortableItem id={preset.key} className="gonavi-ai-provider-hidden-row" key={preset.key} disabled={catalogSearching}>
                <Tooltip {...passThroughHintTooltip} title={<div><strong>{preset.label}</strong><div>{preset.desc}</div></div>} trigger={['hover', 'focus']}>
                  <button type="button" className="gonavi-ai-provider-hidden-choose"
                    aria-label={`${copy(presetCLIIdentity(preset) && (providersByPreset.get(preset.key) || []).length ? 'ai_settings.provider.action.edit' : 'ai_settings.provider.action.add')}: ${preset.label}`}
                    disabled={providersLoading || Boolean(loadError) || loading}
                    onClick={() => chooseCatalogPreset(preset.key)}>
                    <span className="gonavi-ai-provider-icon" aria-hidden="true">{preset.icon}</span>
                    <span className="gonavi-ai-provider-hidden-label">{preset.label}</span>
                  </button>
                </Tooltip>
                <Tooltip {...passThroughHintTooltip} title={copy('ai_settings.provider.restore')}>
                  <button type="button" className="gonavi-ai-provider-hidden-restore" aria-label={`${copy('ai_settings.provider.restore')}: ${preset.label}`}
                    ref={(node) => { if (node) visibilityButtons.current.set(`hidden:${preset.key}`, node); else visibilityButtons.current.delete(`hidden:${preset.key}`); }}
                    onClick={() => restorePreset(preset.key)}><EyeOutlined /></button>
                </Tooltip>
              </AIProviderSortableItem>)}
              </AIProviderSortableGroup>
              {!matchingHiddenPresets.length && <div className="gonavi-ai-provider-catalog-empty" role="status">{copy('ai_settings.provider.no_matches')}</div>}
            </div>}
          </section>}
        </div>
      </aside>}
      {!hideCatalog && layout.catalogVisible && !layout.narrow && <div {...layout.resizerProps} className="gonavi-ai-provider-resizer"
        aria-label={copy('ai_settings.provider.resize')} aria-controls="gonavi-ai-provider-catalog"><span aria-hidden="true">⋮</span></div>}
      <div className="gonavi-ai-provider-editor">
        {!editorReady ? <>
          <div className="gonavi-ai-provider-editor-empty">{copy('ai_settings.provider.choose_configuration')}</div>
        </> : <Form form={form}
          layout="vertical" size="small" onValuesChange={onValuesChange} className="gonavi-ai-provider-form">
          <div ref={editorScrollRef} className="gonavi-ai-provider-editor-scroll">
            <Form.Item name="presetKey" hidden><Input /></Form.Item><Form.Item name="type" hidden><Input /></Form.Item>
            {!presetFromForm?.modes?.length && <Form.Item name="connectionMode" hidden><Input /></Form.Item>}
            {!showAuthMethod && <Form.Item name="authMode" hidden><Input /></Form.Item>}
            <Form.Item name="apiFormat" hidden><Input /></Form.Item>
            {!usesLocalCLI && <Form.Item name="effort" hidden><Input /></Form.Item>}
            {duplicateCLI && <div role="alert">{copy('ai_settings.provider.duplicate_cli')}</div>}
            {Boolean(presetFromForm?.modes?.length) && <Form.Item className="gonavi-ai-provider-auth-method"
              label={fieldLabel(presetFromForm?.modeLabelKey || 'ai_settings.form.section.service_type')} name="connectionMode">
              <Select size="middle" popupMatchSelectWidth={false} classNames={{ popup: { root: 'gonavi-ai-provider-form-popup' } }}
                options={(presetFromForm?.modes || []).map((mode) => ({ value: mode.key, label: mode.label }))}
                onChange={(modeKey) => onConnectionModeChange?.(modeKey)} />
            </Form.Item>}
            {presetKeyFromForm === 'openai' && <Form.Item className="gonavi-ai-provider-auth-method" label={fieldLabel('ai_settings.form.auth_method')} name="authMode">
              <Select size="middle" popupMatchSelectWidth={false} classNames={{ popup: { root: 'gonavi-ai-provider-form-popup' } }}
                options={[
                  { value: 'api-key', label: copy('ai_settings.form.auth_api_key') },
                  { value: 'local-cli', label: copy('ai_settings.form.auth_codex_subscription') },
                ]}
                onChange={onAuthModeChange} />
            </Form.Item>}
            <div className={`gonavi-ai-provider-field-grid gonavi-ai-provider-basic-fields${usesLocalCLI ? ' has-effort' : ''}`}>
              <Form.Item label={fieldLabel('ai_settings.form.display_name')} name="name"><Input placeholder={copy('ai_settings.form.provider_name_placeholder')} size="middle" /></Form.Item>
              <Form.Item name="model" rules={[requiredModelRule]} label={<span className="gonavi-ai-provider-model-label">
                <span className="gonavi-ai-provider-model-title">{fieldLabel('ai_settings.form.default_model')}</span>
                <span className="gonavi-ai-provider-model-meta">
                  {supportsUpstreamModelSync && <button type="button" className="gonavi-ai-provider-model-sync"
                    disabled={upstreamModelsLoading} aria-busy={upstreamModelsLoading}
                    onClick={(event) => { event.preventDefault(); event.stopPropagation(); void syncUpstreamModels(); }}>
                    <SyncOutlined spin={upstreamModelsLoading} aria-hidden="true" />
                    <span>{copy('ai_settings.models.sync_upstream')}</span>
                  </button>}
                  <button type="button" className="gonavi-ai-provider-model-count" aria-haspopup="dialog" onClick={(event) => {
                    event.preventDefault(); event.stopPropagation();
                    if (usesLocalCLI) { catalogRefreshForced.current = true; setCatalogRefresh((value) => value + 1); }
                    setModelManagementRequest((previous) => ({ scope: editorScope, request: previous.request + 1 }));
                  }}
                    aria-label={copy('ai_settings.models.manage')}>{copy('ai_settings.models.enabled_count', { enabled: enabledModelOptions.length, total: modelOptions.length })}</button>
                </span></span>}>
                <AIProviderModelSelect key={`${editorScope}:default`} label={copy('ai_settings.form.default_model')}
                  placeholder={copy(usesLocalCLI || codeBuddyUsesOptionalSecret ? 'ai_settings.form.default_model_placeholder.local_cli' : 'ai_settings.form.default_model_placeholder')}
                  customLabel={copy('ai_settings.form.model_use_custom')} options={modelOptions} loading={modelsLoading || upstreamModelsLoading}
                  managementRequest={modelManagementRequest.scope === editorScope ? modelManagementRequest.request : 0}
                  management={{ disabledModels: watchedDisabledModels, defaultModel: watchedModel || '', completionModel: watchedInlineCompletionModel || '',
                    allowDefaultFallback: Boolean(usesLocalCLI || codeBuddyUsesOptionalSecret), source: copy(modelSourceKey), copy,
                    onToggle: (model, enabled) => patchModels({ disabledModels: enabled ? watchedDisabledModels.filter((item: string) => item !== model) : [...new Set([...watchedDisabledModels, model])] }),
                    onAdd: (model) => patchModels({ customModels: [...new Set([...watchedCustomModels, model])] }),
                  }} />
              </Form.Item>
              <Form.Item name="inlineCompletionModel" rules={[requiredModelRule]} label={fieldLabel('ai_settings.form.inline_completion_model')}>
                <AIProviderModelSelect label={copy('ai_settings.form.inline_completion_model')} placeholder={copy('ai_settings.form.inline_completion_model_placeholder')}
                  customLabel={copy('ai_settings.form.model_use_custom')} options={modelOptions} disabledModels={watchedDisabledModels} />
              </Form.Item>
              {usesLocalCLI && <Form.Item label={fieldLabel('ai_settings.form.effort')} name="effort">
                {activeCLICapability?.supportsEffort ? <Select allowClear size="middle" placeholder={copy('ai_settings.form.effort_placeholder_empty')}
                  popupMatchSelectWidth={false} classNames={{ popup: { root: 'gonavi-ai-provider-form-popup' } }}
                  options={activeEffortValues.map((value) => ({ label: value, value }))} />
                  : <Input size="middle" disabled placeholder={copy(activeCLICapability?.supportsEffort === false ? 'ai_settings.form.effort_unsupported' : 'ai_settings.form.effort_placeholder_empty')} />}
              </Form.Item>}
            </div>
            {usesLocalCLI ? <>
                <div className="gonavi-ai-provider-field-grid gonavi-ai-provider-connection-fields">
                  <Form.Item className="gonavi-ai-provider-cli-path-field" name="cliPath"
                    label={<span className="gonavi-ai-provider-cli-path-label">
                      {fieldLabel('ai_settings.form.cli_path')}
                      <span className={`gonavi-ai-provider-cli-path-mode ${cliPathIsManual ? 'is-manual' : 'is-auto'}`}>
                        {copy(cliPathIsManual ? 'ai_settings.form.cli_path_manual' : 'ai_settings.form.cli_path_auto')}
                      </span>
                    </span>}
                    extra={<span className="gonavi-ai-provider-cli-path-help">
                      {copy(cliPathIsManual ? 'ai_settings.form.cli_path_hint_manual' : 'ai_settings.form.cli_path_hint', { command: cliCommand })}
                    </span>}>
                    <Input size="middle" placeholder={copy('ai_settings.form.cli_path_placeholder', { command: cliCommand })} />
                  </Form.Item>
                </div>
                <Form.Item label={fieldLabel('ai_settings.form.cli_env')} name="cliEnvRows">
                  <AIProviderKeyValueRows
                    namePlaceholder={copy('ai_settings.form.custom_headers_name')}
                    valuePlaceholder={copy('ai_settings.form.custom_headers_value')}
                    addLabel={copy('ai_settings.form.cli_env_add')}
                    removeLabel={copy('common.cancel')}
                  />
                </Form.Item>
              </> : <>
              <div className="gonavi-ai-provider-field-grid gonavi-ai-provider-connection-fields">
                {showAuthMethod && presetKeyFromForm !== 'openai' && <Form.Item label={fieldLabel('ai_settings.form.auth_method')} name="authMode">
                  <Select size="middle" popupMatchSelectWidth={false} classNames={{ popup: { root: 'gonavi-ai-provider-form-popup' } }}
                    options={[
                      { value: 'api-key', label: copy('ai_settings.form.auth_api_key') },
                      { value: 'bearer', label: copy('ai_settings.form.auth_bearer') },
                    ]}
                    onChange={onAuthModeChange} />
                </Form.Item>}
                <Form.Item className="gonavi-ai-provider-field-url" label={fieldLabel('ai_settings.form.api_endpoint')} name="baseUrl"
                  rules={codeBuddyUsesOptionalSecret ? [] : [{ required: true, message: copy('ai_settings.form.api_endpoint_required') }]}>
                  {endpointOptions.length > 0 ? <Select showSearch optionFilterProp="label" size="middle" popupMatchSelectWidth={false}
                    classNames={{ popup: { root: 'gonavi-ai-provider-form-popup' } }}
                    options={endpointOptions.map((endpoint) => ({ label: endpoint.baseUrl, value: endpoint.baseUrl }))}
                    onChange={(baseUrl) => { const endpoint = endpointOptions.find((item) => item.baseUrl === baseUrl); if (endpoint) form.setFieldValue('type', endpoint.backendType); }} />
                    : <Input size="middle" readOnly={!supportsAdvancedEndpoint} placeholder={codeBuddyUsesOptionalSecret ? copy('ai_settings.form.api_endpoint_placeholder.codebuddy') : presetFromForm?.defaultBaseUrl || 'https://...'} />}
                </Form.Item>
                <Form.Item className="gonavi-ai-provider-field-key" label={fieldLabel(codeBuddyUsesOptionalSecret ? 'ai_settings.form.api_key.codebuddy_optional' : 'ai_settings.form.api_key')} name="apiKey"
                  rules={[{ validator: (_, value) => isProviderSecretRequirementSatisfied({ apiKeyInput: value, currentAuthMode: 'api-key', editingProvider,
                    allowEmptySecret: codeBuddyUsesOptionalSecret }) ? Promise.resolve() : Promise.reject(new Error(copy('ai_settings.form.api_key_required'))) }]}>
                  <Input.Password size="middle" placeholder={copy(codeBuddyUsesOptionalSecret ? 'ai_settings.form.api_key_placeholder.codebuddy' : 'ai_settings.form.api_key_placeholder')}
                    visibilityToggle={{ visible: primaryPasswordVisible, onVisibleChange: onPrimaryPasswordVisibleChange }} />
                </Form.Item>
                <Form.Item className="gonavi-ai-provider-field-format" label={fieldLabel('ai_settings.form.api_format')}>
                  {getProviderEndpointTypes(activePresetConnection!).length <= 1
                    ? <Input className="gonavi-ai-provider-fixed-value" size="middle" readOnly tabIndex={-1} aria-label={copy('ai_settings.form.api_format')}
                      value={endpointLabel(getProviderEndpointTypes(activePresetConnection!)[0] || selectedEndpointType)} />
                    : <Select className="gonavi-ai-provider-endpoint-select" aria-label={copy('ai_settings.form.api_format')} size="middle"
                      popupMatchSelectWidth={false} classNames={{ popup: { root: 'gonavi-ai-provider-form-popup' } }}
                      value={selectedEndpointType} disabled={loading} options={getProviderEndpointTypes(activePresetConnection!).map((endpoint) => ({ value: endpoint, label: endpointLabel(endpoint) }))}
                      onChange={(endpoint) => onPresetChange(presetKeyFromForm, endpoint)} />}
                </Form.Item>
              </div>
              <Form.Item label={fieldLabel('ai_settings.form.custom_headers')} name="headerRows" extra={copy('ai_settings.form.custom_headers_hint')}>
                <AIProviderKeyValueRows
                  namePlaceholder={copy('ai_settings.form.custom_headers_name')}
                  valuePlaceholder={copy('ai_settings.form.custom_headers_value')}
                  addLabel={copy('ai_settings.form.custom_headers_add')}
                  removeLabel={copy('common.cancel')}
                />
              </Form.Item>
              </>}
          </div>
          <div className="gonavi-ai-provider-actions">
            <div className="gonavi-ai-provider-check-action"><Button size="middle" onClick={handleTestProvider} loading={testing} disabled={duplicateCLI}>{copy('ai_settings.action.test')}</Button>
              <small>{copy(dirty ? 'ai_settings.provider.unsaved' : 'ai_settings.provider.saved')}</small></div>
            <div className="gonavi-ai-provider-test-result" role={testStatus === 'error' ? 'alert' : 'status'} data-error={testStatus === 'error'}>
              {testResult && (testResult.success ? <><CheckOutlined /> {copy(`ai_settings.test.${testResult.checkKind}`)}</> : testResult.message)}
            </div>
            <div className="gonavi-ai-provider-save-actions">{canSaveAsCopy
              ? <Dropdown.Button size="middle" type="primary" onClick={handleSaveProvider} icon={<DownOutlined />}
                loading={loading && saveMode === 'save'} disabled={duplicateCLI || loading && saveMode === 'copy'}
                placement="topRight" trigger={['click']} arrow overlayClassName="gonavi-ai-provider-save-as-menu"
                getPopupContainer={() => document.body}
                menu={{ items: [{ key: 'save-as', label: <span className="gonavi-ai-provider-save-as-item">
                  <strong>{copy('ai_settings.provider.save_as')}</strong><small>{copy('ai_settings.provider.copy_hint')}</small>
                </span> }], onClick: () => onSaveProviderAsCopy?.() }}>
                {saveActionLabel}</Dropdown.Button>
              : <Button size="middle" type="primary" onClick={handleSaveProvider}
                loading={loading && saveMode === 'save'} disabled={duplicateCLI || loading && saveMode === 'copy'}>{saveActionLabel}</Button>}
            </div>
          </div>
        </Form>}
      </div>
    </div>
    </>}
  </div>;
};

export default AISettingsProvidersSection;
