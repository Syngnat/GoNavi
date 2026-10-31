const providerID = /^[a-z][a-z0-9_.-]{0,63}$/;
const modelID = /^[A-Za-z0-9][A-Za-z0-9_.:/@+-]{0,127}$/;
const providerIcon = /\.(png|jpe?g|webp|gif)$/i;
export interface AIProviderDeclaration {
  id: string; name: string; command: string; icon?: string; supportsImages: boolean;
  models: { id: string; name: string; contextWindow: number; maxOutputTokens: number }[];
}
function validProviderIcon(icon: string): boolean {
  if (icon.length === 0 || icon.length > 256 || !providerIcon.test(icon) || icon.startsWith('/') || /[\\\u0000]/.test(icon)) return false;
  return icon.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}
export function validateAIProvider(provider: AIProviderDeclaration): void {
  if (!providerID.test(provider.id) || provider.name.trim() === '' || new TextEncoder().encode(provider.name).length > 256 || provider.name.includes('\u0000') || provider.command === '') {
    throw new Error('invalid ai provider identity');
  }
  if (provider.icon !== undefined && !validProviderIcon(provider.icon)) throw new Error('invalid ai provider icon');
  if (provider.supportsImages !== false) throw new Error('ai provider images are unsupported');
  if (provider.models.length < 1 || provider.models.length > 32) throw new Error('ai provider must declare one to 32 models');
  const seen = new Set<string>();
  for (const model of provider.models) {
    if (!modelID.test(model.id) || seen.has(model.id) || model.name.trim() === '' || new TextEncoder().encode(model.name).length > 256 || model.name.includes('\u0000')) throw new Error('invalid ai model');
    if (!Number.isInteger(model.contextWindow) || model.contextWindow < 1024 || model.contextWindow > 262144
      || !Number.isInteger(model.maxOutputTokens) || model.maxOutputTokens < 1 || model.maxOutputTokens > 65536 || model.maxOutputTokens > model.contextWindow) {
      throw new Error('invalid ai model token limits');
    }
    seen.add(model.id);
  }
}
