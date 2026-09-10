import { useCallback, useEffect, useRef, useState } from 'react';

import type {
  AIMCPToolDescriptor,
  AIProviderConfig,
  AISkillConfig,
  AIUserPromptSettings,
} from '../../types';
import type { AIComposerNotice, AIComposerNoticeAction } from '../../utils/aiComposerNotice';
import { buildModelFetchFailedNotice } from '../../utils/aiComposerNotice';
import { parseCLIModelCatalog, type CLIModelCatalog } from '../../utils/aiProviderManagement';
import { isLocalCLISubscriptionProvider } from '../../utils/aiProviderPresets';
import { readCachedCLIModelCatalog, writeCachedCLIModelCatalog } from './cliModelCatalogCache';

interface AIChatRuntimeService {
  AIGetProviders?: () => Promise<AIProviderConfig[]>;
  AIGetActiveProvider?: () => Promise<string>;
  AIGetUserPromptSettings?: () => Promise<Partial<AIUserPromptSettings>>;
  AIListMCPTools?: () => Promise<AIMCPToolDescriptor[]>;
  AIGetSkills?: () => Promise<AISkillConfig[]>;
  AISaveProvider?: (provider: AIProviderConfig & { apiKey?: string; hasSecret?: boolean }) => Promise<unknown>;
  AISetActiveProvider?: (providerId: string) => Promise<unknown>;
  AIListModels?: () => Promise<{ success?: boolean; models?: string[]; error?: string } | undefined>;
  AIListProviderModels?: (provider: AIProviderConfig) => Promise<{ success?: boolean; models?: string[]; error?: string } | undefined>;
  AIGetCLIModelCatalog?: (provider: AIProviderConfig) => Promise<unknown>;
  AIGetCLICapabilities?: () => Promise<CLIThinkingCapability[]>;
}

export interface CLIThinkingCapability {
  apiFormat: string;
  supportsEffort: boolean;
  effortValues: string[];
  defaultEffort?: string;
}

interface UseAIChatRuntimeResourcesOptions {
  onOpenSettings?: (providerId?: string) => void;
}

export const EMPTY_AI_USER_PROMPT_SETTINGS: AIUserPromptSettings = {
  global: '',
  database: '',
  jvm: '',
  jvmDiagnostic: '',
};

export const useAIChatRuntimeResources = ({
  onOpenSettings,
}: UseAIChatRuntimeResourcesOptions) => {
  const [providers, setProviders] = useState<AIProviderConfig[]>([]);
  const [activeProvider, setActiveProvider] = useState<AIProviderConfig | null>(null);
  const [userPromptSettings, setUserPromptSettings] = useState<AIUserPromptSettings>(EMPTY_AI_USER_PROMPT_SETTINGS);
  const [mcpTools, setMcpTools] = useState<AIMCPToolDescriptor[]>([]);
  const [skills, setSkills] = useState<AISkillConfig[]>([]);
  const [dynamicModels, setDynamicModels] = useState<string[]>([]);
  const [providerModels, setProviderModels] = useState<Record<string, string[]>>({});
  const [providerCatalogs, setProviderCatalogs] = useState<Record<string, CLIModelCatalog>>({});
  const [cliCapabilities, setCLICapabilities] = useState<CLIThinkingCapability[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [composerNotice, setComposerNotice] = useState<AIComposerNotice | null>(null);

  const activeProviderIdRef = useRef<string | null>(null);
  const providerModelRequestsRef = useRef(new Set<string>());

  const getAIService = useCallback(
    () => {
      // Detached surfaces can be rendered in SSR/test environments before a
      // browser global (and therefore the Wails service) exists.
      if (typeof window === 'undefined') return undefined;
      return (window as any).go?.aiservice?.Service as AIChatRuntimeService | undefined;
    },
    [],
  );

  const loadActiveProvider = useCallback(async () => {
    try {
      const service = getAIService();
      if (!service) {
        setProviders([]);
        setActiveProvider(null);
        return;
      }
      const [providers, activeProviderId] = await Promise.all([
        service.AIGetProviders?.(),
        service.AIGetActiveProvider?.(),
      ]);
      const availableProviders = Array.isArray(providers) ? providers : [];
      setProviders(availableProviders);
      if (!activeProviderId) {
        setActiveProvider(null);
        return;
      }
      const current = availableProviders.find((item) => item.id === activeProviderId);
      setActiveProvider(current || null);
    } catch (error) {
      console.warn('Failed to load active provider', error);
      setProviders([]);
      setActiveProvider(null);
    }
  }, [getAIService]);

  useEffect(() => {
    void loadActiveProvider();
  }, [loadActiveProvider]);

  const loadUserPromptSettings = useCallback(async () => {
    try {
      const service = getAIService();
      if (!service?.AIGetUserPromptSettings) {
        setUserPromptSettings(EMPTY_AI_USER_PROMPT_SETTINGS);
        return;
      }
      const nextSettings = await service.AIGetUserPromptSettings();
      setUserPromptSettings({
        ...EMPTY_AI_USER_PROMPT_SETTINGS,
        ...nextSettings,
      });
    } catch (error) {
      console.warn('Failed to load user prompt settings', error);
      setUserPromptSettings(EMPTY_AI_USER_PROMPT_SETTINGS);
    }
  }, [getAIService]);

  const loadMCPTools = useCallback(async () => {
    try {
      const service = getAIService();
      if (!service?.AIListMCPTools) {
        setMcpTools([]);
        return;
      }
      const nextTools = await service.AIListMCPTools();
      setMcpTools(Array.isArray(nextTools) ? nextTools : []);
    } catch (error) {
      console.warn('Failed to load MCP tools', error);
      setMcpTools([]);
    }
  }, [getAIService]);

  const loadSkills = useCallback(async () => {
    try {
      const service = getAIService();
      if (!service?.AIGetSkills) {
        setSkills([]);
        return;
      }
      const nextSkills = await service.AIGetSkills();
      setSkills(Array.isArray(nextSkills) ? nextSkills : []);
    } catch (error) {
      console.warn('Failed to load skills', error);
      setSkills([]);
    }
  }, [getAIService]);

  const loadCLICapabilities = useCallback(async () => {
    try {
      const capabilities = await getAIService()?.AIGetCLICapabilities?.();
      setCLICapabilities(Array.isArray(capabilities) ? capabilities : []);
    } catch (error) {
      console.warn('Failed to load CLI capabilities', error);
      setCLICapabilities([]);
    }
  }, [getAIService]);

  useEffect(() => {
    void loadUserPromptSettings();
    void loadMCPTools();
    void loadSkills();
    void loadCLICapabilities();
    const handleAIConfigChanged = () => {
      providerModelRequestsRef.current.clear();
      setProviderModels({});
      setProviderCatalogs({});
      void loadUserPromptSettings();
      void loadMCPTools();
      void loadSkills();
      void loadCLICapabilities();
      void loadActiveProvider();
    };
    const browserWindow = typeof window === 'undefined' ? undefined : window;
    browserWindow?.addEventListener?.('gonavi:ai:config-changed', handleAIConfigChanged as EventListener);
    return () => {
      browserWindow?.removeEventListener?.('gonavi:ai:config-changed', handleAIConfigChanged as EventListener);
    };
  }, [loadActiveProvider, loadCLICapabilities, loadMCPTools, loadSkills, loadUserPromptSettings]);

  useEffect(() => {
    const handleProviderChanged = () => {
      setDynamicModels([]);
      setComposerNotice(null);
      activeProviderIdRef.current = null;
      void loadActiveProvider();
    };
    const browserWindow = typeof window === 'undefined' ? undefined : window;
    browserWindow?.addEventListener?.('gonavi:ai:provider-changed', handleProviderChanged);
    return () => browserWindow?.removeEventListener?.('gonavi:ai:provider-changed', handleProviderChanged);
  }, [loadActiveProvider]);

  const handleProviderModelChange = useCallback(async (providerId: string, model: string) => {
    const targetProvider = providers.find((provider) => provider.id === providerId);
    if (!targetProvider) return;
    try {
      const service = getAIService();
      const payload = {
        ...targetProvider,
        model,
        apiKey: targetProvider.apiKey || '',
        hasSecret: targetProvider.hasSecret ?? Boolean(targetProvider.secretRef),
      };
      const modelChanged = String(targetProvider.model || '').trim() !== model;
      const providerChanged = activeProvider?.id !== providerId;
      if (modelChanged) {
        if (typeof service?.AISaveProvider !== 'function') throw new Error('AI provider save bridge is unavailable');
        await service.AISaveProvider(payload);
      }
      if (providerChanged) {
        if (typeof service?.AISetActiveProvider !== 'function') throw new Error('AI provider switch bridge is unavailable');
        await service.AISetActiveProvider(providerId);
        setDynamicModels([]);
      }
      if (!modelChanged && !providerChanged) return;
      setProviders((current) => current.map((provider) => provider.id === providerId ? payload : provider));
      setProviderModels((current) => {
        const knownModels = current[providerId] || [];
        if (!model || knownModels.includes(model)) return current;
        return { ...current, [providerId]: [...knownModels, model] };
      });
      setActiveProvider(payload);
      setComposerNotice(null);
      const browserWindow = typeof window === 'undefined' ? undefined : window;
      if (browserWindow?.dispatchEvent && typeof CustomEvent !== 'undefined') {
        browserWindow.dispatchEvent(new CustomEvent('gonavi:ai:provider-changed'));
      }
    } catch (error) {
      console.warn('Failed to update provider and model', error);
    }
  }, [activeProvider?.id, getAIService, providers]);

  const handleModelChange = useCallback(async (model: string) => {
    if (!activeProvider) return;
    await handleProviderModelChange(activeProvider.id, model);
  }, [activeProvider, handleProviderModelChange]);

  useEffect(() => {
    if (activeProvider?.id && activeProvider.id !== activeProviderIdRef.current) {
      setDynamicModels([]);
      setComposerNotice(null);
      activeProviderIdRef.current = activeProvider.id;
    }
    if (!activeProvider) {
      setDynamicModels([]);
      setComposerNotice(null);
      activeProviderIdRef.current = null;
    }
  }, [activeProvider]);

  useEffect(() => {
    if (activeProvider?.model && String(activeProvider.model).trim()) {
      setComposerNotice(null);
    }
  }, [activeProvider?.model]);

  const fetchDynamicModels = useCallback(async () => {
    try {
      setLoadingModels(true);
      setComposerNotice(null);
      const service = getAIService();
      if (!service) {
        return;
      }
      const result = await service.AIListModels?.();
      if (result?.success && Array.isArray(result.models) && result.models.length > 0) {
        const sortedModels = [...result.models].sort((left, right) => left.localeCompare(right));
        setDynamicModels(sortedModels);
        setComposerNotice(null);
        return;
      }
      if (result && !result.success) {
        setDynamicModels([]);
        setComposerNotice(buildModelFetchFailedNotice(result.error));
      }
    } catch (error: any) {
      console.warn('Failed to fetch models', error);
      setDynamicModels([]);
      setComposerNotice(buildModelFetchFailedNotice(error?.message));
    } finally {
      setLoadingModels(false);
    }
  }, [getAIService]);

  const fetchProviderModels = useCallback(async (providerId: string) => {
    const targetProvider = providers.find((provider) => provider.id === providerId);
    if (!targetProvider || Object.prototype.hasOwnProperty.call(providerModels, providerId)
      || providerModelRequestsRef.current.has(providerId)) return;

    const apiFormat = String(targetProvider.apiFormat || '').trim();
    const usesLocalCLI = isLocalCLISubscriptionProvider(targetProvider);
    if (usesLocalCLI && apiFormat) {
      const cached = readCachedCLIModelCatalog(apiFormat);
      if (cached) {
        setProviderModels((current) => ({ ...current, [providerId]: cached.models }));
        setProviderCatalogs((current) => ({ ...current, [providerId]: cached }));
        return;
      }
    }

    const service = getAIService();
    const loader = usesLocalCLI ? service?.AIGetCLIModelCatalog : service?.AIListProviderModels;
    if (typeof loader !== 'function') return;
    providerModelRequestsRef.current.add(providerId);
    try {
      const result = await loader(targetProvider);
      if (usesLocalCLI) {
        const catalog = parseCLIModelCatalog(result);
        const models = catalog?.models || [];
        setProviderModels((current) => ({ ...current, [providerId]: models }));
        if (catalog) setProviderCatalogs((current) => ({ ...current, [providerId]: catalog }));
        if (catalog && apiFormat) writeCachedCLIModelCatalog(apiFormat, catalog);
        return;
      }
      const response = result as { success?: boolean; models?: string[] } | undefined;
      const models = response?.success && Array.isArray(response.models)
        ? [...new Set(response.models.map((model) => String(model).trim()).filter(Boolean))]
        : [];
      setProviderModels((current) => ({ ...current, [providerId]: models }));
    } catch (error) {
      console.warn('Failed to fetch provider models', error);
      setProviderModels((current) => ({ ...current, [providerId]: [] }));
    } finally {
      providerModelRequestsRef.current.delete(providerId);
    }
  }, [getAIService, providerModels, providers]);

  useEffect(() => {
    if (activeProvider && isLocalCLISubscriptionProvider(activeProvider)) {
      void fetchProviderModels(activeProvider.id);
    }
  }, [activeProvider, fetchProviderModels]);

  const handleOpenSettingsFromPanel = useCallback((providerId?: string) => {
    onOpenSettings?.(providerId);
    const browserWindow = typeof window === 'undefined' ? undefined : window;
    browserWindow?.setTimeout?.(() => {
      void loadActiveProvider();
    }, 500);
  }, [loadActiveProvider, onOpenSettings]);

  const handleComposerAction = useCallback((actionKey: AIComposerNoticeAction) => {
    if (actionKey === 'open-settings') {
      handleOpenSettingsFromPanel();
      return;
    }
    if (actionKey === 'reload-models') {
      void fetchDynamicModels();
    }
  }, [fetchDynamicModels, handleOpenSettingsFromPanel]);

  return {
    activeProvider,
    cliCapabilities,
    composerNotice,
    dynamicModels,
    fetchDynamicModels,
    fetchProviderModels,
    handleComposerAction,
    handleModelChange,
    handleProviderModelChange,
    handleOpenSettingsFromPanel,
    loadingModels,
    mcpTools,
    providers,
    providerModels,
    providerCatalogs,
    setComposerNotice,
    skills,
    userPromptSettings,
  };
};
