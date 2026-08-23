import { describe, expect, it } from 'vitest';

import { buildMCPSetupSnapshot } from './aiMCPInsights';

describe('aiMCPInsights', () => {
  it('localizes mcp setup wrappers while keeping command, paths, and client messages raw', () => {
    const snapshot = buildMCPSetupSnapshot({
      mcpServers: [{
        id: 'server-1',
        name: 'Broken',
        transport: 'stdio',
        command: '',
        args: [],
        env: {},
        enabled: true,
        timeoutSeconds: 1,
      }],
      mcpClientStatuses: [{
        client: 'codex',
        displayName: 'Codex',
        installed: true,
        matchesCurrent: true,
        clientDetected: true,
        clientCommand: 'codex',
        clientPath: 'C:/Tools/codex.exe',
        configPath: 'C:/Users/demo/.codex/config.toml',
        command: 'gonavi-mcp-server',
        args: ['stdio'],
        message: '已接入当前 GoNavi MCP',
      }],
      mcpTools: [],
      translate: (key, params) => {
        const suffix = params
          ? ` ${Object.entries(params).map(([paramKey, value]) => `${paramKey}=${value}`).join(',')}`
          : '';
        return `T:${key}${suffix}`;
      },
    });

    expect(snapshot.warnings).toContain('T:ai_chat.inspection.mcp.warning.config_errors count=1');
    expect(snapshot.nextActions).toContain('T:ai_chat.inspection.mcp.next_action.fix_config_errors');
    expect(snapshot.message).toBe('T:ai_chat.inspection.mcp.message.with_issues serverCount=1,enabledCount=1,issueCount=2');
    expect(snapshot.clients[0].message).toBe('已接入当前 GoNavi MCP');
    expect(snapshot.clients[0].configPath).toBe('C:/Users/demo/.codex/config.toml');
  });

  it('builds a combined snapshot for local mcp servers, tools, and external client install state', () => {
    const snapshot = buildMCPSetupSnapshot({
      mcpServers: [
        {
          id: 'server-1',
          name: 'Browser',
          transport: 'stdio',
          command: 'uvx',
          args: ['mcp-server-browser'],
          env: {
            OPENAI_API_KEY: '***',
            BASE_URL: 'http://127.0.0.1',
          },
          enabled: true,
          timeoutSeconds: 20,
        },
      ],
      mcpClientStatuses: [
        {
          client: 'claude-code',
          displayName: 'Claude Code',
          installed: true,
          matchesCurrent: true,
          clientDetected: true,
          clientCommand: 'claude',
          clientPath: 'C:/Tools/claude.exe',
          configPath: 'C:/Users/demo/.claude/mcp.json',
          command: 'gonavi-mcp-server',
          args: ['stdio'],
          message: '已写入当前 GoNavi 路径',
        },
      ],
      mcpTools: [
        {
          alias: 'browser_open',
          originalName: 'browser_open',
          serverId: 'server-1',
          serverName: 'Browser',
          title: '打开页面',
        },
      ],
    });

    expect(snapshot.serverCount).toBe(1);
    expect(snapshot.enabledServerCount).toBe(1);
    expect(snapshot.discoveredMCPToolCount).toBe(1);
    expect(snapshot.serverConfigurationIssueCount).toBe(0);
    expect(snapshot.servers[0].launchCommandPreview).toBe('uvx mcp-server-browser');
    expect(snapshot.servers[0].configurationIssueCount).toBe(0);
    expect(snapshot.servers[0].envVarCount).toBe(2);
    expect(snapshot.servers[0].discoveredToolCount).toBe(1);
    expect(snapshot.clients[0].displayName).toBe('Claude Code');
    expect(snapshot.clients[0].launchCommandPreview).toBe('gonavi-mcp-server stdio');
    expect(snapshot.currentClientCount).toBe(1);
  });

  it('does not count a matching configuration as connected when its local client is not detected', () => {
    const snapshot = buildMCPSetupSnapshot({
      mcpClientStatuses: [{
        client: 'deepseek-harness',
        displayName: 'DeepSeek Harness',
        installMode: 'auto',
        installed: true,
        matchesCurrent: true,
        clientDetected: false,
        clientCommand: 'dsh',
        message: 'A GoNavi MCP configuration was found',
      }],
    });

    expect(snapshot.currentClientCount).toBe(0);
    expect(snapshot.clients[0].matchesCurrent).toBe(false);
  });

  it('surfaces saved mcp server launch validation issues for ai diagnostics', () => {
    const snapshot = buildMCPSetupSnapshot({
      mcpServers: [
        {
          id: 'server-1',
          name: 'Broken',
          transport: 'stdio',
          command: '',
          args: [],
          env: {},
          enabled: true,
          timeoutSeconds: 1,
        },
      ],
      mcpClientStatuses: [],
      mcpTools: [],
    });

    expect(snapshot.serverConfigurationIssueCount).toBe(2);
    expect(snapshot.serversWithConfigurationErrors).toBe(1);
    expect(snapshot.enabledServersWithConfigurationIssues).toBe(1);
    expect(snapshot.servers[0].configurationErrorCount).toBe(1);
    expect(snapshot.servers[0].configurationWarningCount).toBe(1);
    expect(snapshot.servers[0].configurationCanTest).toBe(false);
    expect(snapshot.servers[0].configurationIssues.map((issue) => issue.key)).toEqual([
      'command-missing',
      'timeout-out-of-range',
    ]);
    expect(snapshot.warnings).toContain('1 MCP server has launch configuration errors; testing and tool discovery may fail');
    expect(snapshot.nextActions).toContain('Fix the MCP server configuration errors first, then test the server again');
    expect(snapshot.message).toContain('2 configuration checks need attention');
  });
});
