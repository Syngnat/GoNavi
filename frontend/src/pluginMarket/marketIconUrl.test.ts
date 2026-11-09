import { describe, expect, it } from 'vitest';
import { githubIconCandidates } from './marketIconUrl';

describe('github market icon candidates', () => {
  it('uses the default branch and retries the frontend/public build path', () => {
    expect(githubIconCandidates('https://github.com/AutumnNazi/gonavi-ssh.git', 'frontend/icon.png')).toEqual([
      'https://raw.githubusercontent.com/AutumnNazi/gonavi-ssh/HEAD/frontend/icon.png',
      'https://raw.githubusercontent.com/AutumnNazi/gonavi-ssh/HEAD/frontend/public/icon.png',
    ]);
  });

  it('keeps the exact manifest path for other layouts', () => {
    expect(githubIconCandidates('https://github.com/AutumnNazi/gonavi-log2sql/', 'icons/log2sql.png')).toEqual([
      'https://raw.githubusercontent.com/AutumnNazi/gonavi-log2sql/HEAD/icons/log2sql.png',
    ]);
  });

  it('prefers the official monorepo directory for AI provider icons', () => {
    expect(githubIconCandidates('https://github.com/Syngnat/GoNavi-Plugin-Market', 'icons/provider.png', {
      official: true,
      pluginId: 'com.gonavi.hualong-ai',
      providerId: 'hualong',
    })).toEqual([
      'https://raw.githubusercontent.com/Syngnat/GoNavi-Plugin-Market/HEAD/plugins/hualong-ai-provider/icons/provider.png',
      'https://raw.githubusercontent.com/Syngnat/GoNavi-Plugin-Market/HEAD/plugins/hualong-ai/icons/provider.png',
      'https://raw.githubusercontent.com/Syngnat/GoNavi-Plugin-Market/HEAD/icons/provider.png',
    ]);
  });

  it('falls back to the plugin id directory for other official plugins', () => {
    expect(githubIconCandidates('https://github.com/Syngnat/GoNavi-Plugin-Market', 'icon.png', {
      official: true,
      pluginId: 'com.gonavi.background-image',
    })).toEqual([
      'https://raw.githubusercontent.com/Syngnat/GoNavi-Plugin-Market/HEAD/plugins/background-image/icon.png',
      'https://raw.githubusercontent.com/Syngnat/GoNavi-Plugin-Market/HEAD/icon.png',
    ]);
  });

  it('ignores unsafe monorepo directory segments', () => {
    expect(githubIconCandidates('https://github.com/Syngnat/GoNavi-Plugin-Market', 'icon.png', {
      official: true,
      pluginId: '../../other',
      providerId: 'a/b',
    })).toEqual([
      'https://raw.githubusercontent.com/Syngnat/GoNavi-Plugin-Market/HEAD/icon.png',
    ]);
  });

  it.each([
    ['https://example.com/author/repo', 'icon.png'],
    ['https://github.com/author/repo/tree/main', 'icon.png'],
    ['http://github.com/author/repo', 'icon.png'],
    ['https://github.com/author/repo', '../secret.png'],
    ['https://github.com/author/repo', '/absolute/icon.png'],
    ['https://github.com/author/repo', 'icons/%2e%2e/secret.png'],
    ['https://github.com/author/repo', ''],
  ])('rejects unsafe or unsupported metadata %s %s', (sourceUrl, icon) => {
    expect(githubIconCandidates(sourceUrl, icon)).toEqual([]);
  });
});
