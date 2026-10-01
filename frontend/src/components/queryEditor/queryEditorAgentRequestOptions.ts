import type { AIProviderConfig } from '../../types';

export const buildQueryEditorAgentProviderOptions = (
    provider: AIProviderConfig,
    model: string,
    disableThinking = false,
) => ({
    provider: String(provider.id || '').trim() || undefined,
    model: String(model || '').trim() || undefined,
    // Inline SQL has a deliberately small visible-output budget; do not spend
    // the 192-token request on hidden reasoning.
    ...(disableThinking ? { thinking: 'none' as const } : {}),
});
