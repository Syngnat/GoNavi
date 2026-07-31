import { describe, expect, it } from 'vitest';

import { parseMCPCommandDraft } from './mcpCommandDraft';
import { buildMCPQuickAddServerSeed, buildMCPServerDraftSeed } from './mcpServerDraftSeed';

describe('mcpServerDraftSeed', () => {
  it('builds an editable draft seed from a parsed uvx command with env vars', () => {
    const parsed = parseMCPCommandDraft('$env:GITHUB_TOKEN=***; uvx mcp-server-github --stdio');

    expect(parsed.ok).toBe(true);
    const seed = buildMCPQuickAddServerSeed(parsed.draft!);

    expect(seed).toMatchObject({
      name: 'mcp-server-github',
      transport: 'stdio',
      command: 'uvx',
      args: ['mcp-server-github', '--stdio'],
      env: { GITHUB_TOKEN: '***' },
      enabled: true,
      timeoutSeconds: 20,
    });
  });

  it('uses a wider default timeout and image-based name for docker drafts', () => {
    const parsed = parseMCPCommandDraft('docker run --rm -i -e API_KEY=*** mcp/server-fetch:latest');

    expect(parsed.ok).toBe(true);
    const seed = buildMCPQuickAddServerSeed(parsed.draft!);

    expect(seed).toMatchObject({
      name: 'server-fetch:latest',
      command: 'docker',
      args: ['run', '--rm', '-i', '-e', 'API_KEY=***', 'mcp/server-fetch:latest'],
      timeoutSeconds: 45,
    });
  });

  it('respects explicit draft names and timeouts for inspection snapshots', () => {
    const seed = buildMCPServerDraftSeed({
      name: 'GitHub MCP',
      command: 'uvx',
      args: ['mcp-server-github', '--stdio'],
      timeoutSeconds: 60,
      env: { GITHUB_TOKEN: '***' },
    });

    expect(seed).toMatchObject({
      name: 'GitHub MCP',
      command: 'uvx',
      timeoutSeconds: 60,
      env: { GITHUB_TOKEN: '***' },
    });
  });

  it('localizes the fallback service name when no raw name candidate is available', () => {
    const seed = buildMCPServerDraftSeed(
      { command: '', args: [] },
      (key) => key === 'ai_settings.mcp_server.draft.default_name' ? 'T:MCP default service' : key,
    );

    expect(seed.name).toBe('T:MCP default service');
  });
});
