import { describe, expect, it } from 'vitest';

import { buildAISetupHealthSnapshot } from './aiSetupHealthInsights';

describe('buildAISetupHealthSnapshot', () => {
  it('localizes setup health wrappers while keeping provider and skill names raw', () => {
    const snapshot = buildAISetupHealthSnapshot({
      providers: [{
        id: 'provider-1',
        type: 'openai',
        name: 'OpenAI 主账号',
        apiKey: '',
        hasSecret: false,
        baseUrl: '',
        model: '',
        models: [],
        maxTokens: 32000,
        temperature: 0.2,
      }],
      activeProviderId: 'provider-1',
      builtinToolNames: [],
      mcpServers: [],
      mcpClientStatuses: [],
      mcpTools: [],
      skills: [],
      dynamicModels: [],
      userPromptSettings: {
        global: '',
        database: '',
        jvm: '',
        jvmDiagnostic: '',
      },
      activeContext: {
        connectionId: 'conn-1',
        dbName: 'crm',
      },
      activeContextItems: [],
      translate: (key, params) => {
        const suffix = params
          ? ` ${Object.entries(params).map(([paramKey, value]) => `${paramKey}=${value}`).join(',')}`
          : '';
        return `T:${key}${suffix}`;
      },
    });

    expect(snapshot.blockers).toContain('T:ai_chat.inspection.setup.blocker.missing_secret');
    expect(snapshot.blockers).toContain('T:ai_chat.inspection.setup.blocker.missing_base_url');
    expect(snapshot.nextActions).toContain('T:ai_chat.inspection.setup.next_action.fill_secret');
    expect(snapshot.warnings).toContain('T:ai_chat.inspection.setup.warning.no_mcp_servers');
    expect(snapshot.message).toBe('T:ai_chat.inspection.setup.message.blocked count=3');
    expect(snapshot.summary.activeProviderName).toBe('OpenAI 主账号');
  });

  it('marks the setup as blocked when the active provider is missing critical pieces', () => {
    const snapshot = buildAISetupHealthSnapshot({
      providers: [{
        id: 'provider-1',
        type: 'openai',
        name: 'OpenAI 主账号',
        apiKey: '',
        hasSecret: false,
        baseUrl: '',
        model: '',
        models: [],
        maxTokens: 32000,
        temperature: 0.2,
      }],
      activeProviderId: 'provider-1',
      builtinToolNames: ['inspect_ai_setup_health', 'inspect_ai_runtime'],
      mcpServers: [],
      mcpClientStatuses: [],
      mcpTools: [],
      skills: [],
      dynamicModels: [],
      userPromptSettings: {
        global: '',
        database: '',
        jvm: '',
        jvmDiagnostic: '',
      },
      activeContext: {
        connectionId: 'conn-1',
        dbName: 'crm',
      },
      activeContextItems: [],
    });

    expect(snapshot.status).toBe('blocked');
    expect(snapshot.blockers).toContain('The active provider is missing an API Key / Secret');
    expect(snapshot.blockers).toContain('The active provider is missing a base URL');
    expect(snapshot.blockers).toContain('The active provider has no selected model');
    expect(snapshot.nextActions).toContain('Fill in the active provider secret');
    expect(snapshot.nextActions).toContain('Select an available model for the active provider');
    expect(snapshot.warnings.some((warning) => warning.includes('OpenCode'))).toBe(true);
    expect(snapshot.nextActions.some((action) => action.includes('OpenCode'))).toBe(true);
    expect(snapshot.summary.chatReady).toBe(false);
  });

  it('summarizes a ready setup while still surfacing optional next-step guidance', () => {
    const snapshot = buildAISetupHealthSnapshot({
      providers: [{
        id: 'provider-1',
        type: 'openai',
        name: 'OpenAI 主账号',
        apiKey: '',
        hasSecret: true,
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-5.4',
        models: ['gpt-5.4', 'gpt-4.1'],
        maxTokens: 32000,
        temperature: 0.2,
      }],
      activeProviderId: 'provider-1',
      safetyLevel: 'readonly',
      contextLevel: 'with_samples',
      builtinToolNames: ['inspect_ai_setup_health', 'inspect_ai_runtime', 'get_columns'],
      mcpServers: [{
        id: 'server-1',
        name: 'Browser',
        transport: 'stdio',
        command: 'uvx',
        args: ['mcp-server-browser'],
        env: {},
        enabled: true,
        timeoutSeconds: 20,
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
      mcpTools: [{
        alias: 'browser_open',
        originalName: 'browser_open',
        serverId: 'server-1',
        serverName: 'Browser',
        title: '打开页面',
        description: '打开页面',
      }],
      skills: [{
        id: 'skill-1',
        name: '结构审查',
        description: '优先核对字段',
        systemPrompt: '先看字段和索引，再给结论。',
        enabled: true,
        scopes: ['database'],
        requiredTools: ['get_columns'],
      }],
      dynamicModels: ['gpt-5.4', 'gpt-4.1'],
      userPromptSettings: {
        global: '回答前先核对上下文。',
        database: '',
        jvm: '',
        jvmDiagnostic: '',
      },
      activeContext: {
        connectionId: 'conn-1',
        dbName: 'crm',
      },
      activeContextItems: [{
        dbName: 'crm',
        tableName: 'orders',
        ddl: 'CREATE TABLE orders (...)',
      }],
    });

    expect(snapshot.status).toBe('ready');
    expect(snapshot.ready).toBe(true);
    expect(snapshot.blockers).toHaveLength(0);
    expect(snapshot.summary.activeProviderName).toBe('OpenAI 主账号');
    expect(snapshot.summary.currentExternalClientCount).toBe(1);
    expect(snapshot.summary.enabledSkillCount).toBe(1);
    expect(snapshot.mcp.message).toContain('1 MCP server is configured');
    expect(snapshot.guidance.enabledSkillPreview).toContain('结构审查');
  });

  it('includes mcp server configuration validation issues in setup health warnings', () => {
    const snapshot = buildAISetupHealthSnapshot({
      providers: [{
        id: 'provider-1',
        type: 'openai',
        name: 'OpenAI 主账号',
        apiKey: '',
        hasSecret: true,
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-5.4',
        models: ['gpt-5.4'],
        maxTokens: 32000,
        temperature: 0.2,
      }],
      activeProviderId: 'provider-1',
      safetyLevel: 'readonly',
      contextLevel: 'schema_only',
      builtinToolNames: ['inspect_ai_setup_health', 'inspect_mcp_setup'],
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
      skills: [{
        id: 'skill-1',
        name: '结构审查',
        description: '优先核对字段',
        systemPrompt: '先看字段和索引，再给结论。',
        enabled: true,
        scopes: ['database'],
        requiredTools: ['get_columns'],
      }],
      userPromptSettings: {
        global: '回答前先核对上下文。',
        database: '',
        jvm: '',
        jvmDiagnostic: '',
      },
      activeContext: {
        connectionId: 'conn-1',
        dbName: 'crm',
      },
      activeContextItems: [{
        dbName: 'crm',
        tableName: 'orders',
        ddl: 'CREATE TABLE orders (...)',
      }],
    });

    expect(snapshot.status).toBe('needs_attention');
    expect(snapshot.summary.mcpServerConfigurationIssueCount).toBe(2);
    expect(snapshot.summary.mcpServersWithConfigurationErrors).toBe(1);
    expect(snapshot.warnings).toContain('1 MCP server has launch configuration errors; testing and tool discovery may fail');
    expect(snapshot.nextActions).toContain('Fix the MCP server configuration errors first, then test the server again');
    expect(snapshot.mcp.servers[0].configurationIssues.map((issue) => issue.key)).toContain('command-missing');
  });
});
