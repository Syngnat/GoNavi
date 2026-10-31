import { describe, expect, it } from 'vitest';
import { parsePluginInstallSpec } from './installSpec';

describe('parsePluginInstallSpec', () => {
  it('routes github references to the remote inspector', () => {
    expect(parsePluginInstallSpec('github:owner/repo')).toEqual({ kind: 'github', owner: 'owner', repo: 'repo', raw: 'github:owner/repo' });
    expect(parsePluginInstallSpec('  GitHub:owner/repo@v1.2.3 ')).toEqual({ kind: 'github', owner: 'owner', repo: 'repo', tag: 'v1.2.3', raw: 'GitHub:owner/repo@v1.2.3' });
  });

  it('keeps malformed github input on the remote path so the backend explains it', () => {
    expect(parsePluginInstallSpec('github:owner').kind).toBe('github');
  });

  it('routes pasted github.com links to the remote inspector', () => {
    expect(parsePluginInstallSpec('https://github.com/owner/repo').kind).toBe('github');
    expect(parsePluginInstallSpec('https://github.com/owner/repo/releases/tag/v1.0.0').kind).toBe('github');
    expect(parsePluginInstallSpec('https://github.com/owner/repo/releases/download/v1.0.0/gonavi-demo.zip').kind).toBe('github');
    expect(parsePluginInstallSpec('http://github.com/owner/repo').kind).toBe('github');
    expect(parsePluginInstallSpec('github.com/owner/repo').kind).toBe('github');
    expect(parsePluginInstallSpec('https://evil.example/github.com/owner/repo').kind).toBe('local');
  });

  it('parses npm names in plain, scoped and versioned forms', () => {
    expect(parsePluginInstallSpec('lodash')).toEqual({ kind: 'npm', name: 'lodash', raw: 'lodash' });
    expect(parsePluginInstallSpec('lodash@4.17.21')).toEqual({ kind: 'npm', name: 'lodash', version: '4.17.21', raw: 'lodash@4.17.21' });
    expect(parsePluginInstallSpec('@scope/pkg')).toEqual({ kind: 'npm', name: '@scope/pkg', raw: '@scope/pkg' });
    expect(parsePluginInstallSpec('@scope/pkg@1.0.0-beta.1')).toEqual({ kind: 'npm', name: '@scope/pkg', version: '1.0.0-beta.1', raw: '@scope/pkg@1.0.0-beta.1' });
  });

  it('keeps local paths on the local inspector', () => {
    expect(parsePluginInstallSpec('C:\\plugins\\demo.zip').kind).toBe('local');
    expect(parsePluginInstallSpec('C:/plugins/demo.tgz').kind).toBe('local');
    expect(parsePluginInstallSpec('./dist/plugin.zip').kind).toBe('local');
    expect(parsePluginInstallSpec('/tmp/plugin.zip').kind).toBe('local');
    expect(parsePluginInstallSpec('setup.zip').kind).toBe('local');
    expect(parsePluginInstallSpec('my plugin').kind).toBe('local');
    expect(parsePluginInstallSpec('dist/plugin.tgz').kind).toBe('local');
    expect(parsePluginInstallSpec('Lodash').kind).toBe('local');
  });
});
