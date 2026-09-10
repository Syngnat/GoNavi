import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import AISettingsMCPSection from './AISettingsMCPSection';
import type { AISettingsMCPSectionProps } from './AISettingsMCPSection';
import { I18nProvider } from '../../i18n/provider';
import { buildOverlayWorkbenchTheme } from '../../utils/overlayWorkbenchTheme';

const buildMCPSectionProps = (patch: Partial<AISettingsMCPSectionProps> = {}): AISettingsMCPSectionProps => ({
  mcpClientStatuses: [
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
  ],
  selectedMCPClient: 'claude-code',
  selectedMCPClientStatus: {
    client: 'claude-code',
    displayName: 'Claude Code',
    installed: false,
    matchesCurrent: false,
    clientDetected: false,
    clientCommand: 'claude',
    message: '未检测到 Claude Code 用户级 GoNavi MCP 配置',
  },
  selectedMCPClientCommandText: '',
  mcpHTTPServerStatus: {
    running: false,
    addr: '127.0.0.1:8765',
    path: '/mcp',
    url: 'http://127.0.0.1:8765/mcp',
    schemaOnly: false,
    message: 'GoNavi MCP HTTP 服务未启动',
  },
  mcpHTTPServerDraft: {
    addr: '127.0.0.1:8765',
    path: '/mcp',
    authorizationHeader: 'Bearer gnv_test',
    schemaOnly: false,
  },
  mcpServers: [],
  mcpTools: [],
  darkMode: false,
  overlayTheme: buildOverlayWorkbenchTheme(false),
  cardBg: '#fff',
  cardBorder: 'rgba(0,0,0,0.08)',
  inputBg: '#fff',
  loading: false,
  mcpClientStatusLoading: false,
  mcpHTTPServerLoading: false,
  onUpdateHTTPServerDraft: () => {},
  onToggleHTTPServer: () => {},
  onCopyHTTPServerURL: () => {},
  onCopyHTTPServerAuthorization: () => {},
  onSelectClient: () => {},
  onRefreshStatus: () => {},
  onCopyConfigPath: () => {},
  onCopyLaunchCommand: () => {},
  onInstallSelectedClient: () => {},
  onAddServer: () => {},
  onUpdateServerDraft: () => {},
  onTestServer: () => {},
  onSaveServer: () => {},
  onDeleteServer: () => {},
  ...patch,
});

const renderSectionWithMockedHTTPPanel = async (props: AISettingsMCPSectionProps) => {
  const captured: { httpPanelProps?: any } = {};

  vi.resetModules();
  vi.doMock('./AIMCPHTTPServerPanel', () => ({
    default: (panelProps: any) => {
      captured.httpPanelProps = panelProps;
      return null;
    },
  }));
  vi.doMock('./AIMCPClientInstallPanel', () => ({ default: () => null }));
  vi.doMock('./AIMCPQuickAddServerPanel', () => ({ default: () => null }));
  vi.doMock('./AIMCPFieldGuideCard', () => ({ default: () => null }));
  vi.doMock('./AIMCPServerCard', () => ({ default: () => null }));

  const { default: MockedAISettingsMCPSection } = await import('./AISettingsMCPSection');
  renderToStaticMarkup(<MockedAISettingsMCPSection {...props} />);

  vi.doUnmock('./AIMCPHTTPServerPanel');
  vi.doUnmock('./AIMCPClientInstallPanel');
  vi.doUnmock('./AIMCPQuickAddServerPanel');
  vi.doUnmock('./AIMCPFieldGuideCard');
  vi.doUnmock('./AIMCPServerCard');

  return captured;
};

describe('AISettingsMCPSection', () => {
  it('renders the extracted MCP client installer and server management entry point', () => {
    const markup = renderToStaticMarkup(
      <AISettingsMCPSection {...buildMCPSectionProps()} />,
    );

    expect(markup).toContain('GoNavi MCP HTTP service');
    expect(markup).toContain('customize the local listen port and Bearer Token');
    expect(markup).toContain('http://127.0.0.1:8765/mcp');
    expect(markup).toContain('Copy Authorization');
    expect(markup).toContain('Connect external client');
    expect(markup).toContain('Current GoNavi MCP is not connected here yet');
    expect(markup).toContain('Quick add from one command');
    expect(markup).toContain('Choose the closest template');
    expect(markup).toContain('Parse and add draft');
    expect(markup).toContain('Parameter quick reference');
    expect(markup).toContain('command');
    expect(markup).toContain('args');
    expect(markup).toContain('env');
    expect(markup).toContain('timeout');
    expect(markup).toContain('Enter only the program name or launcher itself');
    expect(markup).toContain('Fill:');
    expect(markup).toContain('Enter npx, node, uvx, python, docker, or an absolute path to an exe');
    expect(markup).toContain('Do not enter the whole command line, such as npx -y pkg --stdio');
    expect(markup).toContain('Split script names, module names, and flags into separate entries');
    expect(markup).toContain('Do not enter npx/node/uvx/python/docker again');
    expect(markup).toContain('Pass KEY=VALUE configuration to the MCP Server');
    expect(markup).toContain('Do not write export, set, or a $env: prefix');
    expect(markup).toContain('Maximum wait time for one tool discovery or call');
    expect(markup).toContain('Common startup templates');
    expect(markup).toContain('npx package');
    expect(markup).toContain('npx -y @modelcontextprotocol/server-filesystem --stdio');
    expect(markup).toContain('Node script');
    expect(markup).toContain('Docker image');
    expect(markup).toContain('docker run -i --rm image');
    expect(markup).toContain('Add MCP service');
    expect(markup).toContain('No MCP service yet');
    expect(markup).toContain('No MCP tool source yet');
    expect(markup).toContain('npx -y package --stdio');
    expect(markup).toContain('class="gonavi-ai-mcp-section"');
    expect(markup).toContain('class="gonavi-ai-mcp-tabs"');
    expect(markup).toContain('class="gonavi-ai-mcp-tab is-active"');
    expect(markup).toContain('External clients');
    expect(markup).toContain('MCP tool sources');
    expect(markup).toContain('aria-label="External clients → GoNavi"');
    expect(markup).toContain('aria-label="GoNavi → MCP tool sources"');
    expect(markup).toContain('class="gonavi-ai-mcp-route-arrow"');
    expect(markup).toContain('aria-selected="true"');
    expect(markup).toContain('id="gonavi-ai-mcp-panel-tool-sources"');
    expect(markup).toContain('class="gonavi-ai-mcp-panel"');
    expect(markup).toContain('hidden=""');
    expect(markup).toContain('class="gonavi-ai-mcp-http-panel"');
    expect(markup).toContain('class="gonavi-ai-mcp-client-panel"');
    expect(markup).toContain('class="gonavi-ai-mcp-quick-add"');
    expect(markup).toContain('class="gonavi-ai-mcp-disclosure gonavi-ai-mcp-http-disclosure"');
    expect(markup).toContain('class="gonavi-ai-mcp-disclosure gonavi-ai-mcp-quick-add-disclosure"');
    expect(markup).toContain('class="gonavi-ai-mcp-disclosure gonavi-ai-mcp-reference-disclosure"');
    expect(markup).toContain('background:transparent');
    expect(markup).not.toContain('border-bottom:1px solid rgba(0,0,0,0.08)');
    expect(markup).not.toContain('border-top:1px solid rgba(0,0,0,0.08)');
    expect(markup).not.toContain('border-bottom-color:#1677ff');
  });

  it('renders the MCP quick reference in Chinese when an i18n provider is available', () => {
    const markup = renderToStaticMarkup(
      <I18nProvider preference="zh-CN" systemLanguages={['zh-CN']} onPreferenceChange={() => {}}>
        <AISettingsMCPSection {...buildMCPSectionProps()} />
      </I18nProvider>,
    );

    expect(markup).toContain('参数速查');
    expect(markup).toContain('应填：');
    expect(markup).toContain('新增 MCP 服务');
    expect(markup).toContain('还没有 MCP 服务');
    expect(markup).toContain('npx -y package --stdio');
  });

  it('renders troubleshooting hints when a server draft exists', () => {
    const markup = renderToStaticMarkup(
      <AISettingsMCPSection
        {...buildMCPSectionProps({
          mcpServers: [{
            id: 'mcp-local',
            name: 'Local MCP',
            transport: 'stdio',
            command: 'node',
            args: ['server.js', '--stdio'],
            env: {},
            enabled: true,
            timeoutSeconds: 20,
          }],
          mcpTools: [
            {
              alias: 'execute_sql',
              serverId: 'mcp-local',
              serverName: 'Local MCP',
              originalName: 'execute_sql',
              description: '执行 SQL',
              inputSchema: {
                type: 'object',
                required: ['connectionId', 'sql'],
                properties: {
                  connectionId: { type: 'string', description: '连接 ID' },
                  dbName: { type: 'string', description: '数据库名' },
                  sql: { type: 'string', description: 'SQL 文本' },
                  allowMutating: { type: 'boolean', description: '显式允许写操作' },
                },
              },
            },
            {
              alias: 'legacy_tool',
              serverId: 'mcp-local',
              serverName: 'Local MCP',
              originalName: 'legacy_tool',
            },
          ],
        })}
      />,
    );

    expect(markup).toContain('Common setup mistakes');
    expect(markup).toContain('Test says the command cannot be found');
    expect(markup).toContain('Authentication failed, 401, or 403');
    expect(markup).toContain('the current GoNavi add flow does not directly support it');
    expect(markup).toContain('do not put secrets into chat content');
    expect(markup).toContain('Discovered tools and parameter hints');
    expect(markup).toContain('execute_sql');
    expect(markup).toContain('4 parameters, 2 required; an asterisk marks required fields.');
    expect(markup).toContain('Minimum arguments example:');
    expect(markup).toContain('&quot;connectionId&quot;:&quot;&lt;connectionId&gt;&quot;');
    expect(markup).toContain('&quot;sql&quot;:&quot;&lt;sql&gt;&quot;');
    expect(markup).toContain('connectionId*: string');
    expect(markup).toContain('sql*: string');
    expect(markup).toContain('allowMutating: boolean');
    expect(markup).toContain('legacy_tool');
    expect(markup).toContain('No inputSchema declared; check the service docs or use /mcptool before calling.');
    expect(markup).toContain('class="gonavi-ai-mcp-server-row gonavi-ai-mcp-disclosure"');
    expect(markup).toContain('border-left:3px solid #15803d');
  });

  it('toggles the in-app MCP HTTP service from the switch panel', async () => {
    const onToggleHTTPServer = vi.fn();
    const captured = await renderSectionWithMockedHTTPPanel(buildMCPSectionProps({
      onToggleHTTPServer,
    }));

    expect(captured.httpPanelProps).toBeTruthy();
    captured.httpPanelProps.onToggle(true);

    expect(onToggleHTTPServer).toHaveBeenCalledWith(true);
  });

  it('passes MCP HTTP draft updates through the switch panel', async () => {
    const onUpdateHTTPServerDraft = vi.fn();
    const captured = await renderSectionWithMockedHTTPPanel(buildMCPSectionProps({
      onUpdateHTTPServerDraft,
    }));

    expect(captured.httpPanelProps).toBeTruthy();
    captured.httpPanelProps.onDraftChange({ addr: '127.0.0.1:9123' });

    expect(onUpdateHTTPServerDraft).toHaveBeenCalledWith({ addr: '127.0.0.1:9123' });
  });
});
