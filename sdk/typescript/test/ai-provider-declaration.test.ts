import { describe, expect, it } from 'vitest';
import { validateAIProvider } from '../src/aiProviderDeclaration.js';
const provider = { id: 'chat', name: 'Chat', command: 'generate', supportsImages: false, models: [{ id: 'model', name: 'Model', contextWindow: 4096, maxOutputTokens: 512 }] };
describe('ai provider declaration', () => {
  it('rejects images and output above the context window', () => {
    expect(() => validateAIProvider(provider)).not.toThrow();
    expect(() => validateAIProvider({ ...provider, supportsImages: true })).toThrow(/images/);
    expect(() => validateAIProvider({ ...provider, models: [{ ...provider.models[0], contextWindow: 1024, maxOutputTokens: 9000 }] })).toThrow(/token limits/);
  });
  it('accepts only package-relative raster icons', () => {
    expect(() => validateAIProvider({ ...provider, icon: 'icons/provider.PNG' })).not.toThrow();
    for (const icon of ['icons/provider.svg', '/icons/provider.png', '../provider.png', 'icons\\provider.png']) {
      expect(() => validateAIProvider({ ...provider, icon })).toThrow(/icon/);
    }
  });
});
