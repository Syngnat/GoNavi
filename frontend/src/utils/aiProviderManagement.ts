import type { AIProviderConfig } from '../types';
import type { ai } from '../../wailsjs/go/models';

export type ProviderCheckKind = 'none' | 'endpoint' | 'local-auth' | 'model-list' | 'model-response';

export interface ProviderCheckResult {
  success: boolean;
  message: string;
  checkKind: ProviderCheckKind;
  modelVerified: boolean;
}

export interface CLIModelCatalog {
  models: string[];
  source: 'none' | 'cache' | 'cli' | 'aliases';
  stale: boolean;
}

export const parseCLIModelCatalog = (value: unknown): CLIModelCatalog | null => {
  if (!value || typeof value !== 'object') return null;
  const result = value as CLIModelCatalog;
  if (!Array.isArray(result.models) || result.models.some((model) => typeof model !== 'string')
    || !['none', 'cache', 'cli', 'aliases'].includes(result.source) || typeof result.stale !== 'boolean') return null;
  return { ...result, models: result.stale ? [] : result.models };
};

// Every model control shares this candidate pool; changing suggestions must not
// write the default, favorites, or completion model back into the form.
export const buildProviderModelOptions = (...groups: Array<Array<unknown> | undefined>) => {
  const models = new Set<string>();
  groups.forEach((group) => group?.forEach((value) => {
    if (typeof value === 'string' && value.trim()) models.add(value.trim());
  }));
  return Array.from(models, (value) => ({ value, label: value }));
};

export const normalizeProviderModels = (values: unknown): string[] =>
  buildProviderModelOptions(Array.isArray(values) ? values : []).map(({ value }) => value);

export const enabledProviderModels = (models: string[], disabledModels?: string[]): string[] => {
  const disabled = new Set(normalizeProviderModels(disabledModels));
  return normalizeProviderModels(models).filter((model) => !disabled.has(model));
};

// A copy only needs a distinguishing suffix when its name would collide with an
// existing provider. A draft the user already renamed keeps that name untouched:
// appending the suffix anyway would silently overwrite a deliberate choice.
export const providerCopyName = (name: string, names: string[], suffix: string): string => {
  const trimmed = name.trim();
  const used = new Set(names);
  if (trimmed && !used.has(trimmed)) return trimmed;
  const base = trimmed ? `${trimmed} · ${suffix}` : suffix;
  if (!used.has(base)) return base;
  let ordinal = 2;
  while (used.has(`${base} ${ordinal}`)) ordinal++;
  return `${base} ${ordinal}`;
};

// Stable field comparison avoids touching normal save payloads just to track UI dirtiness.
export const providerDraftFingerprint = (value: unknown): string => {
  const draft = value && typeof value === 'object' && !Array.isArray(value)
    ? { ...value } as Record<string, unknown> : value;
  // Empty optional preferences mean the same as absent legacy fields. Only
  // normalize the comparison; leave the form and save payload unchanged.
  if (draft && typeof draft === 'object' && !Array.isArray(draft)) {
    for (const key of ['disabledModels', 'customModels']) {
      const models = (draft as Record<string, unknown>)[key];
      if (Array.isArray(models) && models.length === 0) delete (draft as Record<string, unknown>)[key];
    }
  }
  const stable = (item: any): any => {
    if (Array.isArray(item)) return item.map(stable);
    if (item && typeof item === 'object') return Object.fromEntries(Object.keys(item).sort()
      .filter((key) => item[key] !== undefined).map((key) => [key, stable(item[key])]));
    return item;
  };
  return JSON.stringify(stable(draft));
};

// Older desktop bridges only returned success/message. Do not silently promote
// that legacy success to a verified check when the loaded binary is out of date.
export const parseProviderCheckResult = (value: unknown): ProviderCheckResult | null => {
  if (!value || typeof value !== 'object') return null;
  const result = value as ProviderCheckResult;
  if (typeof result.success !== 'boolean' || typeof result.message !== 'string'
    || typeof result.modelVerified !== 'boolean'
    || !['none', 'endpoint', 'local-auth', 'model-list', 'model-response'].includes(result.checkKind)) return null;
  if (result.success && result.checkKind === 'none') return null;
  if (result.modelVerified !== (result.success && result.checkKind === 'model-response')) return null;
  return result;
};

export const filterProviders = (
  providers: AIProviderConfig[],
  query: string,
  presetLabel: (provider: AIProviderConfig) => string,
): AIProviderConfig[] => {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return providers;
  return providers.filter((provider) => {
    const text = [provider.name, provider.type, provider.apiFormat, presetLabel(provider), provider.model,
      ...(provider.models || []), provider.inlineCompletionModel].filter(Boolean).join(' ').toLocaleLowerCase();
    return terms.every((term) => text.includes(term));
  });
};

export const getCLIConfigPrefill = (
  capability: ai.CLICapabilityView,
  values: { model?: string; effort?: string },
  editedFields: ReadonlySet<string>,
  isNew: boolean,
): { model?: string; effort?: string } => {
  if (!isNew) return {};
  const patch: { model?: string; effort?: string } = {};
  if (!editedFields.has('model') && !values.model && capability.defaultModel) patch.model = capability.defaultModel;
  if (!editedFields.has('effort') && !values.effort && capability.supportsEffort
    && capability.defaultEffort && capability.effortValues?.includes(capability.defaultEffort)) {
    patch.effort = capability.defaultEffort;
  }
  return patch;
};
