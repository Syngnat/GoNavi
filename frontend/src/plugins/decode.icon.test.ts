import { describe, expect, it } from 'vitest';
import { PluginAPIError } from './apiResult';
import { decodeManifest } from './decode';

const base = { schemaVersion: 1, apiVersion: 1, id: 'example.icon', name: 'Icon', version: '1.0.0', permissions: [] };
const provider = {
  id: 'chat', name: 'Chat', command: 'run', supportsTools: true, supportsImages: false,
  models: [{ id: 'm1', name: 'M1', contextWindow: 8192, maxOutputTokens: 1024 }],
};
const contributes = { commands: [{ id: 'run', title: 'Run' }], aiProviders: [provider] };

// 清单顶层 icon 是宿主读取的包内光栅图路径；SDK 已允许声明，前端白名单必须同步接受。
describe('manifest icon decoding', () => {
  it('accepts a packaged raster logo at both levels', () => {
    const manifest = decodeManifest({ ...base, icon: 'icons/logo.PNG' });
    expect(manifest.icon).toBe('icons/logo.PNG');
    const withProvider = decodeManifest({ ...base, permissions: ['ai.providers'], contributes: { ...contributes, aiProviders: [{ ...provider, icon: 'icons/chat.webp' }] } });
    expect(withProvider.contributes?.aiProviders?.[0].icon).toBe('icons/chat.webp');
  });

  it('rejects paths and formats the host never accepts', () => {
    for (const icon of ['icons/logo.svg', '/icons/logo.png', '../logo.png', 'icons\\logo.png', 'icons/./logo.png', 'icons/logo.png ', 'a'.repeat(253) + '.png', 7]) {
      expect(() => decodeManifest({ ...base, icon })).toThrow(PluginAPIError);
    }
  });
});
