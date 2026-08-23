import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import AIMCPClientInstallPanel from './AIMCPClientInstallPanel';
import { buildOverlayWorkbenchTheme } from '../../utils/overlayWorkbenchTheme';

describe('AIMCPClientInstallPanel', () => {
  it('renders a clearer external-client selection flow with one selected target and one action button', () => {
    const markup = renderToStaticMarkup(
      <AIMCPClientInstallPanel
        statuses={[
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
            installed: true,
            matchesCurrent: false,
            clientDetected: true,
            clientCommand: 'codex',
            clientPath: 'C:/Users/mock/AppData/Roaming/npm/codex.cmd',
            message: '已检测到 Codex 中的 GoNavi MCP 记录，但与当前 GoNavi 安装路径不一致，建议更新',
            configPath: '~/.codex/config.toml',
            command: 'gonavi-mcp-server',
            args: ['stdio'],
          },
        ]}
        selectedClient="codex"
        selectedStatus={{
          client: 'codex',
          displayName: 'Codex',
          installed: true,
          matchesCurrent: false,
          clientDetected: true,
          clientCommand: 'codex',
          clientPath: 'C:/Users/mock/AppData/Roaming/npm/codex.cmd',
          message: '已检测到 Codex 中的 GoNavi MCP 记录，但与当前 GoNavi 安装路径不一致，建议更新',
          configPath: '~/.codex/config.toml',
          command: 'gonavi-mcp-server',
          args: ['stdio'],
        }}
        selectedCommandText="gonavi-mcp-server stdio"
        darkMode={false}
        overlayTheme={buildOverlayWorkbenchTheme(false)}
        cardBg="#fff"
        cardBorder="rgba(0,0,0,0.08)"
        loading={false}
        statusLoading={false}
        onSelectClient={() => {}}
        onRefreshStatus={() => {}}
        onCopyConfigPath={() => {}}
        onCopyLaunchCommand={() => {}}
        onInstall={() => {}}
      />,
    );

    expect(markup).toContain('This connects GoNavi MCP to supported local clients or remote Agents');
    expect(markup).toContain('external tool calls');
    expect(markup).toContain('After their local command is detected, Claude Code, Codex, OpenCode, ZCode, DeepSeek Harness, Kimi Code, and Grok Build can receive a user-level MCP config');
    expect(markup).toContain('Cloud Agents such as OpenClaw and Hermans use remote connection guidance');
    expect(markup).toContain('Connect external client');
    expect(markup).toContain('Select external client');
    expect(markup).toContain('Choose target client');
    expect(markup).toContain('Write or copy config');
    expect(markup).toContain('Restart or configure target');
    expect(markup).toContain('Client not detected');
    expect(markup).toContain('Update needed');
    expect(markup).toContain('External tool connection status: old config found, update needed');
    expect(markup).toContain('External tool connection status: client not detected');
    expect(markup).toContain('Copy config path');
    expect(markup).toContain('Copy launch command');
    expect(markup).toContain('Update Codex connection config');
    expect(markup).toContain('Selected client status');
    expect(markup).toContain('CLI detection: Detected codex');
    expect(markup).toContain('Selected. Only this client will be written or updated');
    expect(markup).toContain('Current target client: Codex');
  });

  it('renders OpenCode as a local auto-install target', () => {
    const openCodeStatus = {
      client: 'opencode',
      displayName: 'OpenCode',
      installMode: 'auto' as const,
      installed: false,
      matchesCurrent: false,
      clientDetected: true,
      clientCommand: 'opencode',
      message: 'No OpenCode user-level GoNavi MCP configuration was detected',
      configPath: '/Users/mock/.config/opencode/opencode.json',
      command: '/Applications/GoNavi.app/Contents/MacOS/GoNavi',
      args: ['mcp-server'],
    };
    const markup = renderToStaticMarkup(
      <AIMCPClientInstallPanel
        statuses={[openCodeStatus]}
        selectedClient="opencode"
        selectedStatus={openCodeStatus}
        selectedCommandText="/Applications/GoNavi.app/Contents/MacOS/GoNavi mcp-server"
        darkMode={false}
        overlayTheme={buildOverlayWorkbenchTheme(false)}
        cardBg="#fff"
        cardBorder="rgba(0,0,0,0.08)"
        loading={false}
        statusLoading={false}
        onSelectClient={() => {}}
        onRefreshStatus={() => {}}
        onCopyConfigPath={() => {}}
        onCopyLaunchCommand={() => {}}
        onInstall={() => {}}
      />,
    );

    expect(markup).toContain('Current target client: OpenCode');
    expect(markup).toContain('CLI detection: Detected opencode');
    expect(markup).toContain('Install to OpenCode (external tool)');
    expect(markup).not.toContain('Remote connection boundary:');
  });

  it('requires local client detection before enabling MCP configuration writes', () => {
    const markup = renderToStaticMarkup(
      <AIMCPClientInstallPanel
        statuses={[
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
            installed: true,
            matchesCurrent: true,
            clientDetected: true,
            clientCommand: 'codex',
            message: '已检测到 Codex 用户级 GoNavi MCP 配置，且与当前 GoNavi 安装路径一致',
          },
        ]}
        selectedClient="claude-code"
        selectedStatus={{
          client: 'claude-code',
          displayName: 'Claude Code',
          installed: false,
          matchesCurrent: false,
          clientDetected: false,
          clientCommand: 'claude',
          message: '未检测到 Claude Code 用户级 GoNavi MCP 配置',
        }}
        selectedCommandText="gonavi-mcp-server stdio"
        darkMode={false}
        overlayTheme={buildOverlayWorkbenchTheme(false)}
        cardBg="#fff"
        cardBorder="rgba(0,0,0,0.08)"
        loading={false}
        statusLoading={false}
        onSelectClient={() => {}}
        onRefreshStatus={() => {}}
        onCopyConfigPath={() => {}}
        onCopyLaunchCommand={() => {}}
        onInstall={() => {}}
      />,
    );

    expect(markup).toContain('Client not detected');
    expect(markup).toContain('Install or enable Claude Code first');
    expect(markup).toContain('CLI detection: claude was not detected');
    expect(markup).toContain('Local claude command was not detected');
    expect(markup).toContain('configuration writing is disabled');
    expect(markup).toContain('disabled=""');
    expect(markup).not.toContain('Install to Claude Code (external tool)');
    expect(markup).not.toContain('When already connected to this GoNavi, the main button is disabled to avoid repeated writes.');
    expect(markup).toContain('Connected');
  });

  it('renders remote Agent clients as bridge guidance instead of local installs', () => {
    const markup = renderToStaticMarkup(
      <AIMCPClientInstallPanel
        statuses={[
          {
            client: 'openclaw',
            displayName: 'OpenClaw',
            installMode: 'remote',
            installed: false,
            matchesCurrent: false,
            clientDetected: false,
            clientCommand: 'openclaw',
            message: 'OpenClaw 通常部署在云端 Linux；请通过远程 MCP 桥接接入 Windows GoNavi，不要复制数据库密码。',
          },
          {
            client: 'hermans',
            displayName: 'Hermans',
            installMode: 'remote',
            installed: false,
            matchesCurrent: false,
            clientDetected: false,
            clientCommand: 'hermans',
            message: 'Hermans 这类远程 Agent 请通过远程 MCP 桥接接入 Windows GoNavi，不要复制数据库密码。',
          },
        ]}
        selectedClient="openclaw"
        selectedStatus={{
          client: 'openclaw',
          displayName: 'OpenClaw',
          installMode: 'remote',
          installed: false,
          matchesCurrent: false,
          clientDetected: false,
          clientCommand: 'openclaw',
          message: 'OpenClaw 通常部署在云端 Linux；请通过远程 MCP 桥接接入 Windows GoNavi，不要复制数据库密码。',
        }}
        selectedCommandText=""
        darkMode={false}
        overlayTheme={buildOverlayWorkbenchTheme(false)}
        cardBg="#fff"
        cardBorder="rgba(0,0,0,0.08)"
        loading={false}
        statusLoading={false}
        onSelectClient={() => {}}
        onRefreshStatus={() => {}}
        onCopyConfigPath={() => {}}
        onCopyLaunchCommand={() => {}}
        onInstall={() => {}}
      />,
    );

    expect(markup).toContain('Remote bridge');
    expect(markup).toContain('Selected. The remote connection guide will be copied');
    expect(markup).toContain('Remote connection boundary');
    expect(markup).toContain('Cloud Agents read connection summaries, object lists, tables, views, and DDL through schema-only MCP tools by default');
    expect(markup).toContain('execute_sql is not registered');
    expect(markup).toContain('OpenClaw Remote MCP quick setup');
    expect(markup).toContain('Public/tunnel URL');
    expect(markup).toContain('Enter the Streamable HTTP MCP address reachable by the cloud Agent');
    expect(markup).toContain('Do not use the Windows local 127.0.0.1 address');
    expect(markup).toContain('Bearer Token');
    expect(markup).toContain('the Windows launch command and cloud Agent config must match');
    expect(markup).toContain('do not put a database password here');
    expect(markup).toContain('Local listen address');
    expect(markup).toContain('MCP path');
    expect(markup).toContain('Configure in cloud Agent');
    expect(markup).toContain('Generate config without GUI / CLI');
    expect(markup).toContain('&quot;type&quot;: &quot;streamable-http&quot;');
    expect(markup).toContain('&quot;url&quot;: &quot;https://&lt;your-domain-or-tunnel&gt;/mcp&quot;');
    expect(markup).toContain('&quot;Authorization&quot;: &quot;Bearer &lt;random-token&gt;&quot;');
    expect(markup).toContain('GoNavi.exe mcp-server remote-config --client openclaw --url https://&lt;your-domain-or-tunnel&gt;/mcp --token &lt;random-token&gt; --schema-only');
    expect(markup).toContain('Start GoNavi MCP HTTP on Windows');
    expect(markup).toContain('GoNavi.exe mcp-server http --addr 127.0.0.1:8765 --path /mcp --token &lt;random-token&gt; --schema-only');
    expect(markup).toContain('Standalone binary: gonavi-mcp-server http --addr 127.0.0.1:8765 --path /mcp --token &lt;random-token&gt; --schema-only');
    expect(markup).toContain('Verification order');
    expect(markup).toContain('Security boundary');
    expect(markup).toContain('Database accounts and passwords stay in Windows GoNavi');
    expect(markup).toContain('--schema-only does not register execute_sql by default');
    expect(markup).toContain('CLI detection: Remote Agent does not need local openclaw command detection');
    expect(markup).toContain('Copy OpenClaw remote connection guide');
  });

  it('makes repeated install avoidance explicit when the selected client already matches current GoNavi', () => {
    const markup = renderToStaticMarkup(
      <AIMCPClientInstallPanel
        statuses={[
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
            installed: false,
            matchesCurrent: false,
            clientDetected: false,
            clientCommand: 'codex',
            message: '未检测到 Codex 用户级 GoNavi MCP 配置',
          },
        ]}
        selectedClient="claude-code"
        selectedStatus={{
          client: 'claude-code',
          displayName: 'Claude Code',
          installed: true,
          matchesCurrent: true,
          clientDetected: true,
          clientCommand: 'claude',
          message: '已检测到 Claude Code 用户级 GoNavi MCP 配置，且与当前 GoNavi 安装路径一致',
        }}
        selectedCommandText="gonavi-mcp-server stdio"
        darkMode={false}
        overlayTheme={buildOverlayWorkbenchTheme(false)}
        cardBg="#fff"
        cardBorder="rgba(0,0,0,0.08)"
        loading={false}
        statusLoading={false}
        onSelectClient={() => {}}
        onRefreshStatus={() => {}}
        onCopyConfigPath={() => {}}
        onCopyLaunchCommand={() => {}}
        onInstall={() => {}}
      />,
    );

    expect(markup).toContain('Current status: Connected to current GoNavi; no repeated action needed');
    expect(markup).toContain('Claude Code is connected; no reinstall needed');
    expect(markup).toContain('the main button is disabled to avoid repeated writes');
  });

  it('prefers the client that already matches current GoNavi over another stale installed record', () => {
    const markup = renderToStaticMarkup(
      <AIMCPClientInstallPanel
        statuses={[
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
        ]}
        selectedClient="claude-code"
        selectedStatus={{
          client: 'claude-code',
          displayName: 'Claude Code',
          installed: true,
          matchesCurrent: true,
          clientDetected: true,
          clientCommand: 'claude',
          message: '已检测到 Claude Code 用户级 GoNavi MCP 配置，且与当前 GoNavi 安装路径一致',
        }}
        selectedCommandText="gonavi-mcp-server stdio"
        darkMode={false}
        overlayTheme={buildOverlayWorkbenchTheme(false)}
        cardBg="#fff"
        cardBorder="rgba(0,0,0,0.08)"
        loading={false}
        statusLoading={false}
        onSelectClient={() => {}}
        onRefreshStatus={() => {}}
        onCopyConfigPath={() => {}}
        onCopyLaunchCommand={() => {}}
        onInstall={() => {}}
      />,
    );

    expect(markup).toContain('Selected client status');
    expect(markup).toContain('Current status: Connected to current GoNavi; no repeated action needed');
  });
});
