import { t as catalogTranslate } from '../../i18n/catalog';
import type { I18nParams } from '../../i18n/types';
import type { AIContextItem, AIProviderConfig } from '../../types';
import { isLocalCLISubscriptionProvider } from '../../utils/aiProviderPresets';
import { isBuiltinAIProvider } from './builtinAILogin';

export type AIChatReadinessActionKey = 'open-settings' | 'reload-models' | 'builtin-login';

export type AIChatReadinessStatus =
  | 'missing_provider'
  | 'login_required'
  | 'provider_incomplete'
  | 'missing_model'
  | 'loading_models'
  | 'ready';

export type AIChatReadinessIssue =
  | 'missing_secret'
  | 'missing_base_url'
  | 'missing_selected_model';

export interface AIChatReadinessSnapshot {
  status: AIChatReadinessStatus;
  ready: boolean;
  severity: 'success' | 'warning' | 'error' | 'info';
  label: string;
  title: string;
  description: string;
  providerCount: number;
  hasActiveProvider: boolean;
  hasConnectionContext: boolean;
  contextAttachedCount: number;
  selectableModelCount: number;
  issues: AIChatReadinessIssue[];
  action?: {
    key: AIChatReadinessActionKey;
    label: string;
  };
  activeProvider: null | {
    id: string;
    name: string;
    type: string;
    model: string;
    baseUrl: string;
    baseUrlHost: string;
    hasSecret: boolean;
    declaredModelCount: number;
    dynamicModelCount: number;
  };
  message: string;
}

type AIChatReadinessTranslate = (key: string, params?: I18nParams) => string;

const defaultTranslate: AIChatReadinessTranslate = (key, params) =>
  catalogTranslate('en-US', key, params);

const joinIssueLabels = (
  labels: string[],
  translate: AIChatReadinessTranslate,
): string => labels.join(translate('ai_chat.input.status.issue.separator'));

const trimText = (value: unknown): string => String(value || '').trim();

const getProviderHost = (baseUrl: string): string => {
  const normalized = trimText(baseUrl);
  if (!normalized) {
    return '';
  }
  try {
    return new URL(normalized).host;
  } catch {
    return '';
  }
};

const hasProviderSecret = (provider: AIProviderConfig): boolean =>
  provider.hasSecret ?? Boolean(provider.secretRef || provider.apiKey);

const isLocalCLIProvider = (provider: AIProviderConfig): boolean =>
  isLocalCLISubscriptionProvider(provider);

const isBaseURLOptionalProvider = (provider: AIProviderConfig): boolean =>
  isLocalCLIProvider(provider)
  || (provider.type === 'custom' && trimText(provider.apiFormat) === 'codebuddy-cli');

const isModelOptionalProvider = (provider: AIProviderConfig): boolean =>
  isLocalCLIProvider(provider)
  || (provider.type === 'custom' && ['codebuddy-cli', 'cursor-agent'].includes(trimText(provider.apiFormat)));

const getSelectedProvider = (params: {
  providers?: AIProviderConfig[];
  activeProvider?: AIProviderConfig | null;
  activeProviderId?: string | null;
}): AIProviderConfig | null => {
  if (params.activeProvider) {
    return params.activeProvider;
  }
  const providers = Array.isArray(params.providers) ? params.providers : [];
  const activeProviderId = trimText(params.activeProviderId);
  if (!activeProviderId) {
    return null;
  }
  return providers.find((provider) => provider.id === activeProviderId) || null;
};

export const formatAIChatProviderIssueLabels = (
  issues: AIChatReadinessIssue[],
  translate: AIChatReadinessTranslate = defaultTranslate,
): string[] => {
  const issueLabels: Record<AIChatReadinessIssue, string> = {
    missing_secret: translate('ai_chat.input.status.issue.missing_secret'),
    missing_base_url: translate('ai_chat.input.status.issue.missing_base_url'),
    missing_selected_model: translate('ai_chat.input.status.issue.missing_selected_model'),
  };
  return issues
    .map((issue) => issueLabels[issue])
    .filter(Boolean);
};

export const buildAIChatReadinessSnapshot = (params: {
  providers?: AIProviderConfig[];
  activeProvider?: AIProviderConfig | null;
  activeProviderId?: string | null;
  dynamicModels?: string[];
  loadingModels?: boolean;
  activeContext?: { connectionId?: string | null; dbName?: string | null } | null;
  activeContextItems?: AIContextItem[];
  translate?: AIChatReadinessTranslate;
}): AIChatReadinessSnapshot => {
  const translate = params.translate || defaultTranslate;
  const providers = Array.isArray(params.providers) ? params.providers : [];
  const activeProvider = getSelectedProvider(params);
  const providerCount = providers.length > 0 ? providers.length : (activeProvider ? 1 : 0);
  const dynamicModels = (Array.isArray(params.dynamicModels) ? params.dynamicModels : [])
    .map((item) => trimText(item))
    .filter(Boolean);
  const activeContextItems = Array.isArray(params.activeContextItems) ? params.activeContextItems : [];
  const declaredModels = activeProvider?.models?.map((item) => trimText(item)).filter(Boolean) || [];
  const selectableModelCount = dynamicModels.length > 0 ? dynamicModels.length : declaredModels.length;
  const hasConnectionContext = Boolean(trimText(params.activeContext?.connectionId));
  const contextAttachedCount = activeContextItems.length;
  const fallbackProviderName = translate('ai_chat.input.status.provider_fallback_name');

  if (!activeProvider) {
    const title = providers.length > 0
      ? translate('ai_chat.input.status.missing_provider.title.unselected')
      : translate('ai_chat.input.status.missing_provider.title.none');
    const description = providers.length > 0
      ? translate('ai_chat.input.status.missing_provider.description.unselected')
      : translate('ai_chat.input.status.missing_provider.description.none');
    return {
      status: 'missing_provider',
      ready: false,
      severity: 'warning',
      label: translate('ai_chat.input.status.label.not_ready'),
      title,
      description,
      providerCount,
      hasActiveProvider: false,
      hasConnectionContext,
      contextAttachedCount,
      selectableModelCount: 0,
      issues: [],
      action: {
        key: 'open-settings',
        label: translate('ai_chat.input.status.action.open_settings'),
      },
      activeProvider: null,
      message: [title, description].filter(Boolean).join(' '),
    };
  }

  const issues: AIChatReadinessIssue[] = [];
  if (!isLocalCLIProvider(activeProvider) && !hasProviderSecret(activeProvider)) {
    issues.push('missing_secret');
  }
  if (!isBaseURLOptionalProvider(activeProvider) && !trimText(activeProvider.baseUrl)) {
    issues.push('missing_base_url');
  }
  if (!isModelOptionalProvider(activeProvider) && !trimText(activeProvider.model)) {
    issues.push('missing_selected_model');
  }

  const providerSummary = {
    id: activeProvider.id,
    name: trimText(activeProvider.name),
    type: activeProvider.type,
    model: trimText(activeProvider.model),
    baseUrl: trimText(activeProvider.baseUrl),
    baseUrlHost: getProviderHost(activeProvider.baseUrl),
    hasSecret: hasProviderSecret(activeProvider),
    declaredModelCount: declaredModels.length,
    dynamicModelCount: dynamicModels.length,
  };

  // The built-in provider has no key to fill in: the actionable state is "sign
  // in", never "missing secret" / "missing address".
  if (isBuiltinAIProvider(activeProvider) && !providerSummary.hasSecret) {
    const title = translate('ai_chat.input.status.builtin_login.title');
    const description = translate('ai_chat.input.status.builtin_login.description');
    return {
      status: 'login_required',
      ready: false,
      severity: 'warning',
      label: translate('ai_chat.input.status.label.login_required'),
      title,
      description,
      providerCount,
      hasActiveProvider: true,
      hasConnectionContext,
      contextAttachedCount,
      selectableModelCount,
      issues: ['missing_secret'],
      action: {
        key: 'builtin-login',
        label: translate('ai_chat.input.status.action.builtin_login'),
      },
      activeProvider: providerSummary,
      message: [title, description].filter(Boolean).join(' '),
    };
  }

  const blockingProviderIssues = issues.filter((issue) => issue !== 'missing_selected_model');
  if (blockingProviderIssues.length > 0) {
    const missingLabels = formatAIChatProviderIssueLabels(blockingProviderIssues, translate);
    const title = translate('ai_chat.input.status.provider_incomplete.title', {
      provider: providerSummary.name || providerSummary.id || fallbackProviderName,
      issues: joinIssueLabels(missingLabels, translate),
    });
    const description = translate('ai_chat.input.status.provider_incomplete.description');
    return {
      status: 'provider_incomplete',
      ready: false,
      severity: 'error',
      label: translate('ai_chat.input.status.label.needs_fix'),
      title,
      description,
      providerCount,
      hasActiveProvider: true,
      hasConnectionContext,
      contextAttachedCount,
      selectableModelCount,
      issues,
      action: {
        key: 'open-settings',
        label: translate('ai_chat.input.status.action.fix_provider'),
      },
      activeProvider: providerSummary,
      message: [title, description].filter(Boolean).join(' '),
    };
  }

  if (!providerSummary.model && !isModelOptionalProvider(activeProvider)) {
    const title = params.loadingModels
      ? translate('ai_chat.input.status.missing_model.title.loading', {
        provider: providerSummary.name || providerSummary.id || fallbackProviderName,
      })
      : translate('ai_chat.input.status.missing_model.title.select', {
        provider: providerSummary.name || providerSummary.id || fallbackProviderName,
      });
    const description = selectableModelCount > 0
      ? translate('ai_chat.input.status.missing_model.description.available', { count: selectableModelCount })
      : translate('ai_chat.input.status.missing_model.description.empty');
    return {
      status: params.loadingModels ? 'loading_models' : 'missing_model',
      ready: false,
      severity: params.loadingModels ? 'info' : 'warning',
      label: params.loadingModels
        ? translate('ai_chat.input.status.label.loading')
        : translate('ai_chat.input.status.label.model_required'),
      title,
      description,
      providerCount,
      hasActiveProvider: true,
      hasConnectionContext,
      contextAttachedCount,
      selectableModelCount,
      issues,
      action: {
        key: 'reload-models',
        label: translate('ai_chat.input.status.action.reload_models'),
      },
      activeProvider: providerSummary,
      message: [title, description].filter(Boolean).join(' '),
    };
  }

  const title = translate('ai_chat.input.status.ready.title', {
    provider: providerSummary.name || providerSummary.id || fallbackProviderName,
    model: providerSummary.model || (isModelOptionalProvider(activeProvider) ? translate('ai_chat.input.status.ready.auto_model') : ''),
  });
  const description = contextAttachedCount > 0
    ? translate('ai_chat.input.status.ready.description.with_context', { count: contextAttachedCount })
    : hasConnectionContext
      ? translate('ai_chat.input.status.ready.description.with_connection')
      : translate('ai_chat.input.status.ready.description.no_context');

  return {
    status: 'ready',
    ready: true,
    severity: 'success',
    label: translate('ai_chat.input.status.label.ready'),
    title,
    description,
    providerCount,
    hasActiveProvider: true,
    hasConnectionContext,
    contextAttachedCount,
    selectableModelCount,
    issues: [],
    activeProvider: providerSummary,
    message: [title, description].filter(Boolean).join(' '),
  };
};
