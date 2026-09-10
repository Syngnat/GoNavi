import type { AIProviderType } from '../types';
import type { AIProviderConfig } from '../types';
import type { CLIModelCatalog } from './aiProviderManagement';

interface CLIThinkingCapability {
  supportsEffort?: boolean;
  effortValues?: string[];
  defaultEffort?: string;
}

export type ThinkingIntensityProfile = 'openai' | 'anthropic' | 'deepseek' | 'gemini' | 'generic';

export type ThinkingIntensityOption = {
  value: string;
  labelKey: string;
};

const OPENAI_OPTIONS: ThinkingIntensityOption[] = [
  { value: 'none', labelKey: 'ai_settings.form.thinking_intensity.none' },
  { value: 'minimal', labelKey: 'ai_settings.form.thinking_intensity.minimal' },
  { value: 'low', labelKey: 'ai_settings.form.thinking_intensity.low' },
  { value: 'medium', labelKey: 'ai_settings.form.thinking_intensity.medium' },
  { value: 'high', labelKey: 'ai_settings.form.thinking_intensity.high' },
  { value: 'xhigh', labelKey: 'ai_settings.form.thinking_intensity.xhigh' },
];

const ANTHROPIC_OPTIONS: ThinkingIntensityOption[] = [
  { value: 'off', labelKey: 'ai_settings.form.thinking_intensity.off' },
  { value: 'low', labelKey: 'ai_settings.form.thinking_intensity.low' },
  { value: 'medium', labelKey: 'ai_settings.form.thinking_intensity.medium' },
  { value: 'high', labelKey: 'ai_settings.form.thinking_intensity.high' },
  { value: 'xhigh', labelKey: 'ai_settings.form.thinking_intensity.xhigh' },
  { value: 'max', labelKey: 'ai_settings.form.thinking_intensity.max' },
];

const DEEPSEEK_OPTIONS: ThinkingIntensityOption[] = [
  { value: 'off', labelKey: 'ai_settings.form.thinking_intensity.off' },
  { value: 'low', labelKey: 'ai_settings.form.thinking_intensity.low' },
  { value: 'medium', labelKey: 'ai_settings.form.thinking_intensity.medium' },
  { value: 'high', labelKey: 'ai_settings.form.thinking_intensity.high' },
];

const GEMINI_OPTIONS: ThinkingIntensityOption[] = [
  { value: 'off', labelKey: 'ai_settings.form.thinking_intensity.off' },
  { value: 'minimal', labelKey: 'ai_settings.form.thinking_intensity.minimal' },
  { value: 'low', labelKey: 'ai_settings.form.thinking_intensity.low' },
  { value: 'medium', labelKey: 'ai_settings.form.thinking_intensity.medium' },
  { value: 'high', labelKey: 'ai_settings.form.thinking_intensity.high' },
];

const GENERIC_OPTIONS: ThinkingIntensityOption[] = [
  { value: 'off', labelKey: 'ai_settings.form.thinking_intensity.off' },
  { value: 'low', labelKey: 'ai_settings.form.thinking_intensity.low' },
  { value: 'medium', labelKey: 'ai_settings.form.thinking_intensity.medium' },
  { value: 'high', labelKey: 'ai_settings.form.thinking_intensity.high' },
];

const optionForValue = (value: string): ThinkingIntensityOption => ({
  value,
  labelKey: value === 'default'
    ? 'ai_settings.form.effort_placeholder_empty'
    : `ai_settings.form.thinking_intensity.${value}`,
});

export interface ProviderThinkingIntensityControl {
  options: ThinkingIntensityOption[];
  defaultValue: string;
}

export const resolveProviderThinkingIntensityControl = (
  provider: Pick<AIProviderConfig, 'type' | 'authMode' | 'apiFormat' | 'model' | 'effort'> & { baseUrl?: string },
  cliCapability?: CLIThinkingCapability,
  catalog?: CLIModelCatalog | null,
): ProviderThinkingIntensityControl => {
  const isLocalCLI = String(provider.authMode || '').toLowerCase() === 'local-cli'
    && String(provider.apiFormat || '').toLowerCase().endsWith('-cli');
  if (isLocalCLI) {
    const model = String(provider.model || catalog?.defaultModel || '').trim();
    const modelCapability = model ? catalog?.modelCapabilities?.[model] : undefined;
    const values = [...new Set((modelCapability?.effortValues || cliCapability?.effortValues || [])
      .map((value) => String(value).trim().toLowerCase()).filter(Boolean))];
    const configured = String(provider.effort || '').trim().toLowerCase();
    const fallback = String(modelCapability?.defaultEffort || cliCapability?.defaultEffort || '').trim().toLowerCase();
    return {
      options: [optionForValue('default'), ...values.map(optionForValue)],
      defaultValue: values.includes(configured) ? configured : (values.includes(fallback) ? fallback : 'default'),
    };
  }
  const profile = resolveThinkingIntensityProfile(provider);
  return {
    options: resolveThinkingIntensityOptions(profile),
    defaultValue: defaultThinkingIntensityForProfile(profile),
  };
};

export const coerceThinkingIntensityForControl = (
  value: string | undefined,
  control: ProviderThinkingIntensityControl,
): string => {
  const normalized = String(value || '').trim().toLowerCase();
  return control.options.some((option) => option.value === normalized)
    ? normalized
    : control.defaultValue;
};

const getHostname = (raw?: string): string => {
  if (!raw) return '';
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return '';
  }
};

export const resolveThinkingIntensityProfile = (input: {
  type?: AIProviderType | string;
  apiFormat?: string;
  baseUrl?: string;
  model?: string;
}): ThinkingIntensityProfile => {
  const type = String(input.type || '').toLowerCase();
  const format = String(input.apiFormat || '').toLowerCase();
  const base = String(input.baseUrl || '').toLowerCase();
  const model = String(input.model || '').toLowerCase();
  const host = getHostname(input.baseUrl);

  if (host.includes('deepseek') || base.includes('deepseek') || model.includes('deepseek')) {
    return 'deepseek';
  }
  if (type === 'gemini' || format === 'gemini' || host.includes('googleapis.com')) {
    return 'gemini';
  }
  if (type === 'anthropic' || format === 'anthropic') {
    return 'anthropic';
  }
  if (type === 'openai' || format === 'openai' || format === 'openai-responses' || format === '') {
    return 'openai';
  }
  return 'generic';
};

export const resolveThinkingIntensityOptions = (
  profile: ThinkingIntensityProfile,
): ThinkingIntensityOption[] => {
  switch (profile) {
    case 'openai':
      return OPENAI_OPTIONS;
    case 'anthropic':
      return ANTHROPIC_OPTIONS;
    case 'deepseek':
      return DEEPSEEK_OPTIONS;
    case 'gemini':
      return GEMINI_OPTIONS;
    default:
      return GENERIC_OPTIONS;
  }
};

export const resolveThinkingIntensityHintKey = (profile: ThinkingIntensityProfile): string => {
  switch (profile) {
    case 'openai':
      return 'ai_settings.form.thinking_intensity_hint.openai';
    case 'anthropic':
      return 'ai_settings.form.thinking_intensity_hint.anthropic';
    case 'deepseek':
      return 'ai_settings.form.thinking_intensity_hint.deepseek';
    case 'gemini':
      return 'ai_settings.form.thinking_intensity_hint.gemini';
    default:
      return 'ai_settings.form.thinking_intensity_hint';
  }
};

/** 当切换服务商后，若当前值不在新档位集内，映射到最接近的默认值。 */
export const coerceThinkingIntensityForProfile = (
  value: string | undefined,
  profile: ThinkingIntensityProfile,
): string => {
  const options = resolveThinkingIntensityOptions(profile);
  const raw = String(value || '').trim().toLowerCase();
  if (options.some((item) => item.value === raw)) {
    return raw;
  }
  // 常见跨体系别名
  if (raw === 'off' || raw === 'disabled') {
    return profile === 'openai' ? 'none' : 'off';
  }
  if (raw === 'none') {
    return profile === 'openai' ? 'none' : 'off';
  }
  if (raw === 'minimal') {
    return options.some((item) => item.value === 'minimal') ? 'minimal' : 'low';
  }
  if (raw === 'xhigh' || raw === 'max') {
    if (options.some((item) => item.value === raw)) return raw;
    if (options.some((item) => item.value === 'xhigh')) return 'xhigh';
    if (options.some((item) => item.value === 'max')) return 'max';
    return 'high';
  }
  if (options.some((item) => item.value === 'medium')) return 'medium';
  return options[0]?.value || 'medium';
};

export const defaultThinkingIntensityForProfile = (profile: ThinkingIntensityProfile): string => {
  const options = resolveThinkingIntensityOptions(profile);
  if (options.some((item) => item.value === 'medium')) return 'medium';
  return options[0]?.value || 'medium';
};
