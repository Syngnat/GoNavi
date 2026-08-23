import { describe, expect, it } from 'vitest';

import type { AIMCPClientInstallStatus } from '../types';
import {
  buildRemoteMCPClientGuide,
  buildRemoteMCPClientQuickStart,
  EMPTY_MCP_CLIENT_STATUSES,
  formatMCPLaunchCommand,
  isLocalMCPClientUnavailable,
  isMCPClientConnected,
  isRemoteMCPClientStatus,
  normalizeMCPClientStatuses,
  pickPreferredMCPClient,
  supportsAutoMCPClientInstall,
} from './mcpClientInstallStatus';

describe('mcpClientInstallStatus helpers', () => {
  it('fills missing clients with default placeholder statuses', () => {
    const statuses = normalizeMCPClientStatuses([
      {
        client: 'codex',
        displayName: 'Codex',
        installed: true,
        matchesCurrent: true,
        message: '已检测到 Codex 用户级 GoNavi MCP 配置，且与当前 GoNavi 安装路径一致',
      },
    ]);

    expect(statuses).toEqual([
      EMPTY_MCP_CLIENT_STATUSES[0],
      {
        client: 'codex',
        displayName: 'Codex',
        installMode: 'auto',
        installed: true,
        matchesCurrent: true,
        clientDetected: false,
        clientCommand: 'codex',
        clientPath: '',
        message: '已检测到 Codex 用户级 GoNavi MCP 配置，且与当前 GoNavi 安装路径一致',
        args: [],
      },
      EMPTY_MCP_CLIENT_STATUSES[2],
      EMPTY_MCP_CLIENT_STATUSES[3],
      EMPTY_MCP_CLIENT_STATUSES[4],
      EMPTY_MCP_CLIENT_STATUSES[5],
      EMPTY_MCP_CLIENT_STATUSES[6],
      EMPTY_MCP_CLIENT_STATUSES[7],
      EMPTY_MCP_CLIENT_STATUSES[8],
    ]);
  });

  it('keeps all local one-click MCP clients in the auto-install client order', () => {
    expect(EMPTY_MCP_CLIENT_STATUSES.map((item) => item.client)).toEqual([
      'claude-code',
      'codex',
      'opencode',
      'zcode',
      'deepseek-harness',
      'kimi',
      'grok-build',
      'openclaw',
      'hermans',
    ]);

    expect(EMPTY_MCP_CLIENT_STATUSES.filter((item) => item.installMode === 'auto').map((item) => item.client)).toEqual([
      'claude-code',
      'codex',
      'opencode',
      'zcode',
      'deepseek-harness',
      'kimi',
      'grok-build',
    ]);
    for (const client of ['opencode', 'zcode', 'deepseek-harness', 'kimi', 'grok-build']) {
      const status = EMPTY_MCP_CLIENT_STATUSES.find((item) => item.client === client);
      expect(supportsAutoMCPClientInstall(status)).toBe(true);
      expect(isRemoteMCPClientStatus(status)).toBe(false);
    }
  });

  it('prefers an already-installed but outdated client over a completely uninstalled one', () => {
    const statuses: AIMCPClientInstallStatus[] = [
      {
        client: 'claude-code',
        displayName: 'Claude Code',
        installed: false,
        matchesCurrent: false,
        message: '未检测到 Claude Code 用户级 GoNavi MCP 配置',
      },
      {
        client: 'codex',
        displayName: 'Codex',
        installed: true,
        matchesCurrent: false,
        clientDetected: true,
        clientCommand: 'codex',
        message: '已检测到 Codex 中的 GoNavi MCP 记录，但与当前 GoNavi 安装路径不一致，建议更新',
      },
    ];

    expect(pickPreferredMCPClient(statuses)).toBe('codex');
  });

  it('does not treat a matching config as connected or writable when its local client is absent', () => {
    const unavailableClient: AIMCPClientInstallStatus = {
      client: 'deepseek-harness',
      displayName: 'DeepSeek Harness',
      installMode: 'auto',
      installed: true,
      matchesCurrent: true,
      clientDetected: false,
      clientCommand: 'dsh',
      message: 'A GoNavi MCP configuration was found',
    };

    expect(isLocalMCPClientUnavailable(unavailableClient)).toBe(true);
    expect(isMCPClientConnected(unavailableClient)).toBe(false);
    expect(pickPreferredMCPClient([
      unavailableClient,
      {
        client: 'codex',
        displayName: 'Codex',
        installMode: 'auto',
        installed: false,
        matchesCurrent: false,
        clientDetected: true,
        clientCommand: 'codex',
        message: 'No Codex user-level GoNavi MCP configuration was detected',
      },
    ])).toBe('codex');
  });

  it('prefers a locally detected client command when neither client has existing GoNavi MCP config', () => {
    const statuses: AIMCPClientInstallStatus[] = [
      {
        client: 'claude-code',
        displayName: 'Claude Code',
        installed: false,
        matchesCurrent: false,
        clientDetected: false,
        clientCommand: 'claude',
        message: '未检测到 Claude Code 用户级 GoNavi MCP 配置',
      },
      {
        client: 'codex',
        displayName: 'Codex',
        installed: false,
        matchesCurrent: false,
        clientDetected: true,
        clientCommand: 'codex',
        clientPath: 'C:/Users/mock/AppData/Roaming/npm/codex.cmd',
        message: '未检测到 Codex 用户级 GoNavi MCP 配置',
      },
    ];

    expect(pickPreferredMCPClient(statuses)).toBe('codex');
  });

  it('prefers a client whose English status message reports a configuration error', () => {
    const statuses: AIMCPClientInstallStatus[] = [
      {
        client: 'claude-code',
        displayName: 'Claude Code',
        installed: false,
        matchesCurrent: false,
        clientDetected: false,
        clientCommand: 'claude',
        message: 'No Claude Code user-level GoNavi MCP configuration was detected',
      },
      {
        client: 'codex',
        displayName: 'Codex',
        installed: false,
        matchesCurrent: false,
        clientDetected: true,
        clientCommand: 'codex',
        message: 'Failed to locate Codex configuration: access denied',
      },
    ];

    expect(pickPreferredMCPClient(statuses)).toBe('codex');
  });

  it('treats an English empty-path status as higher priority than a plain missing status', () => {
    const statuses: AIMCPClientInstallStatus[] = [
      {
        client: 'claude-code',
        displayName: 'Claude Code',
        installed: false,
        matchesCurrent: false,
        clientDetected: false,
        clientCommand: 'claude',
        message: 'No Claude Code user-level GoNavi MCP configuration was detected',
      },
      {
        client: 'codex',
        displayName: 'Codex',
        installed: false,
        matchesCurrent: false,
        clientDetected: true,
        clientCommand: 'codex',
        message: 'Current GoNavi executable path is empty',
      },
    ];

    expect(pickPreferredMCPClient(statuses)).toBe('codex');
  });

  it('prefers a client that already matches current GoNavi over another client with a stale config', () => {
    const statuses: AIMCPClientInstallStatus[] = [
      {
        client: 'claude-code',
        displayName: 'Claude Code',
        installed: true,
        matchesCurrent: true,
        clientDetected: true,
        clientCommand: 'claude',
        message: '已检测到 Claude Code 用户级 GoNavi MCP 配置，且与当前 GoNavi 安装路径一致',
      },
      {
        client: 'codex',
        displayName: 'Codex',
        installed: true,
        matchesCurrent: false,
        clientDetected: true,
        clientCommand: 'codex',
        message: '已检测到 Codex 中的 GoNavi MCP 记录，但与当前 GoNavi 安装路径不一致，建议更新',
      },
    ];

    expect(pickPreferredMCPClient(statuses)).toBe('claude-code');
  });

  it('keeps the user-selected client when it is still present in the latest status list', () => {
    expect(pickPreferredMCPClient(EMPTY_MCP_CLIENT_STATUSES, 'codex')).toBe('codex');
    expect(pickPreferredMCPClient(EMPTY_MCP_CLIENT_STATUSES, 'opencode')).toBe('opencode');
    expect(pickPreferredMCPClient(EMPTY_MCP_CLIENT_STATUSES, 'kimi')).toBe('kimi');
    expect(pickPreferredMCPClient(EMPTY_MCP_CLIENT_STATUSES, 'openclaw')).toBe('openclaw');
  });

  it('prefers a detected OpenCode CLI over clients without local commands or config', () => {
    const statuses = normalizeMCPClientStatuses([{
      client: 'opencode',
      displayName: 'OpenCode',
      installMode: 'auto',
      installed: false,
      matchesCurrent: false,
      clientDetected: true,
      clientCommand: 'opencode',
      clientPath: '/usr/local/bin/opencode',
      message: 'No OpenCode user-level GoNavi MCP configuration was detected',
    }]);

    expect(pickPreferredMCPClient(statuses)).toBe('opencode');
  });

  it('recognizes a Kimi configuration status error when ranking local clients', () => {
    const statuses: AIMCPClientInstallStatus[] = [
      {
        client: 'claude-code',
        displayName: 'Claude Code',
        installed: false,
        matchesCurrent: false,
        message: 'No Claude Code user-level GoNavi MCP configuration was detected',
      },
      {
        client: 'kimi',
        displayName: 'Kimi Code',
        installed: false,
        matchesCurrent: false,
        clientDetected: true,
        clientCommand: 'kimi',
        message: 'Failed to locate Kimi Code configuration: access denied',
      },
    ];

    expect(pickPreferredMCPClient(statuses)).toBe('kimi');
  });

  it('formats quoted launch commands for display and clipboard use', () => {
    expect(formatMCPLaunchCommand({
      command: 'C:/Program Files/GoNavi/GoNavi.exe',
      args: ['mcp-server', '--stdio'],
    })).toBe('"C:/Program Files/GoNavi/GoNavi.exe" mcp-server --stdio');
  });

  it('marks OpenClaw and Hermans as remote bridge clients and builds a safe guide', () => {
    const openClaw = EMPTY_MCP_CLIENT_STATUSES.find((item) => item.client === 'openclaw');

    expect(isRemoteMCPClientStatus(openClaw)).toBe(true);
    const guide = buildRemoteMCPClientGuide(openClaw);
    expect(guide).toContain('GoNavi MCP remote access guide - OpenClaw');
    expect(guide).toContain('The cloud Agent does not need to store database passwords.');
    expect(guide).toContain('Remote access uses schema-only mode by default and does not register execute_sql');
    expect(guide).toContain('it cannot use the Windows local stdio command directly');
    expect(guide).toContain('Claude Code / Codex / OpenCode / ZCode / DeepSeek Harness / Kimi Code / Grok Build');
    expect(guide).toContain('allowMutating=true');
    expect(guide).toContain('"type": "streamable-http"');
    expect(guide).toContain('"Authorization": "Bearer <random-token>"');
    expect(guide).toContain('GoNavi.exe mcp-server remote-config --client openclaw --url https://<your-domain-or-tunnel>/mcp --token <random-token> --schema-only');
    expect(guide).toContain('GoNavi.exe mcp-server http --addr 127.0.0.1:8765 --path /mcp --token <random-token> --schema-only');
  });

  it('builds remote quick-start snippets for cloud agents without database secrets', () => {
    const quickStart = buildRemoteMCPClientQuickStart({
      client: 'hermans',
      displayName: 'OpenClaw',
    });

    expect(quickStart.displayName).toBe('OpenClaw');
    expect(quickStart.configJson).toContain('"type": "streamable-http"');
    expect(quickStart.configJson).toContain('"url": "https://<your-domain-or-tunnel>/mcp"');
    expect(quickStart.configJson).toContain('"Authorization": "Bearer <random-token>"');
    expect(quickStart.configJson).not.toContain('password');
    expect(quickStart.configCommand).toBe('GoNavi.exe mcp-server remote-config --client hermans --url https://<your-domain-or-tunnel>/mcp --token <random-token> --schema-only');
    expect(quickStart.launchCommand).toBe('GoNavi.exe mcp-server http --addr 127.0.0.1:8765 --path /mcp --token <random-token> --schema-only');
    expect(quickStart.standaloneCommand).toBe('gonavi-mcp-server http --addr 127.0.0.1:8765 --path /mcp --token <random-token> --schema-only');
    expect(quickStart.verificationSteps.join('\n')).toContain('get_connections');
    expect(quickStart.securityNotes.join('\n')).toContain('--schema-only does not register execute_sql by default');
    expect(quickStart.securityNotes.join('\n')).toContain('allowMutating=true');
  });
});
