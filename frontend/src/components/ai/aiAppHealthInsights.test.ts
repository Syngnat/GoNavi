import { describe, expect, it } from 'vitest';

import { buildAIAppHealthSnapshot } from './aiAppHealthInsights';

describe('buildAIAppHealthSnapshot', () => {
  it('localizes app health wrappers while keeping raw runtime details unchanged', () => {
    const translate = (key: string, params?: Record<string, unknown>) => {
      const suffix = params
        ? ` ${Object.entries(params).map(([paramKey, value]) => `${paramKey}=${value}`).join(',')}`
        : '';
      return `T:${key}${suffix}`;
    };

    const snapshot = buildAIAppHealthSnapshot({
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
      mcpServers: [{
        id: 'server-1',
        name: 'GoNavi MCP',
        transport: 'stdio',
        command: 'gonavi-mcp-server',
        args: ['stdio'],
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
        alias: 'inspect_app_health',
        originalName: 'inspect_app_health',
        serverId: 'server-1',
        serverName: 'GoNavi MCP',
        title: 'Inspect app health',
      }],
      userPromptSettings: {
        global: '回答前先核对上下文。',
        database: '',
        jvm: '',
        jvmDiagnostic: '',
      },
      tabs: [],
      appLogReadResult: {
        success: false,
        message: 'raw log backend failure',
      },
      connectionFailureReadResult: {
        success: false,
        message: 'raw connection log failure',
      },
      translate,
    } as any);

    expect(snapshot.appLog.message).toBe('T:ai_chat.inspection.app_health.app_log.unread detail=raw log backend failure');
    expect(snapshot.connectionFailures.message).toBe(
      'T:ai_chat.inspection.app_health.connection_failures.unread detail=raw connection log failure',
    );
    expect(snapshot.warnings).toContain('T:ai_chat.inspection.app_health.warning.app_log_unread');
    expect(snapshot.warnings).toContain('T:ai_chat.inspection.app_health.warning.connection_failures_unread');
    expect(snapshot.warnings).toContain('T:ai_chat.inspection.app_health.warning.no_workspace_tabs');
    expect(snapshot.nextActions).toContain('T:ai_chat.inspection.app_health.next_action.enable_app_log_reading');
    expect(snapshot.nextActions).toContain('T:ai_chat.inspection.app_health.next_action.open_sql_tab');
    expect(snapshot.message).toBe('T:ai_chat.inspection.app_health.message.needs_attention count=3');
  });

  it('marks the app health as degraded when logs and connection failures show runtime problems', () => {
    const snapshot = buildAIAppHealthSnapshot({
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
      builtinToolNames: ['inspect_app_health', 'inspect_ai_setup_health', 'inspect_app_logs'],
      mcpServers: [{
        id: 'server-1',
        name: 'GoNavi MCP',
        transport: 'stdio',
        command: 'gonavi-mcp-server',
        args: ['stdio'],
        env: {},
        enabled: true,
        timeoutSeconds: 20,
      }],
      mcpClientStatuses: [],
      mcpTools: [],
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
      aiContexts: {
        'conn-1:crm': [],
      },
      connections: [{
        id: 'conn-1',
        name: '主库',
        config: {
          type: 'mysql',
          host: '127.0.0.1',
          port: 3306,
          user: 'root',
        },
      }],
      tabs: [{
        id: 'query-1',
        title: '订单查询',
        type: 'query',
        connectionId: 'conn-1',
        dbName: 'crm',
        query: 'select * from orders',
      }],
      activeTabId: 'query-1',
      appLogReadResult: {
        success: true,
        data: {
          logPath: 'C:/Users/demo/.GoNavi/Logs/gonavi.log',
          requestedLineLimit: 120,
          lines: [
            '2026/06/10 09:00:00.000000 [INFO] started',
            '2026/06/10 09:00:01.000000 [ERROR] MCP server boot failed',
          ],
        },
      },
      connectionFailureReadResult: {
        success: true,
        data: {
          logPath: 'C:/Users/demo/.GoNavi/Logs/gonavi.log',
          requestedLineLimit: 120,
          lines: [
            '2026/06/10 09:01:00.000000 [ERROR] 建立数据库连接失败：类型=mysql 地址=127.0.0.1:3306 数据库=crm 用户=root；错误链：连接建立后验证失败：127.0.0.1:3306 验证失败: Error 1064 (42000): syntax error',
            '2026/06/10 09:01:01.000000 [WARN] 命中数据库连接失败冷却：类型=mysql 地址=127.0.0.1:3306 数据库=crm 缓存Key=abc 剩余=29s 原因=连接建立后验证失败：127.0.0.1:3306 验证失败: Error 1064 (42000): syntax error',
          ],
        },
      },
    });

    expect(snapshot.status).toBe('degraded');
    expect(snapshot.summary.appLogErrorCount).toBe(1);
    expect(snapshot.summary.recentConnectionFailureCount).toBe(2);
    expect(snapshot.summary.activeTabTitle).toBe('订单查询');
    expect(snapshot.warnings).toContain('Recent application logs contain 1 ERROR entries; inspect_app_logs should be checked first');
    expect(snapshot.nextActions).toContain('Call inspect_recent_connection_failures to review the latest connection failure cause, then decide whether to inspect the current connection or saved connection config');
    expect(snapshot.appLog.lines).toHaveLength(0);
    expect(snapshot.appLog.linesOmitted).toBe(true);
  });

  it('marks missing provider pieces as blocked even when logs are clean', () => {
    const snapshot = buildAIAppHealthSnapshot({
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
      appLogReadResult: {
        success: true,
        data: { lines: ['2026/06/10 09:00:00.000000 [INFO] started'] },
      },
      connectionFailureReadResult: {
        success: true,
        data: { lines: [] },
      },
    });

    expect(snapshot.status).toBe('blocked');
    expect(snapshot.blockers).toContain('The active provider is missing an API Key / Secret');
    expect(snapshot.blockers).toContain('The active provider is missing a base URL');
    expect(snapshot.summary.chatReady).toBe(false);
  });

  it('marks the app health as degraded when the last ai message render error is present', () => {
    const snapshot = buildAIAppHealthSnapshot({
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
      builtinToolNames: ['inspect_app_health', 'inspect_ai_last_render_error'],
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
      aiContexts: {
        'conn-1:crm': [{
          dbName: 'crm',
          tableName: 'orders',
          ddl: 'CREATE TABLE orders (...)',
        }],
      },
      connections: [{
        id: 'conn-1',
        name: '主库',
        config: {
          type: 'mysql',
          host: '127.0.0.1',
          port: 3306,
          user: 'root',
        },
      }],
      tabs: [{
        id: 'query-1',
        title: '订单查询',
        type: 'query',
        connectionId: 'conn-1',
        dbName: 'crm',
        query: 'select * from orders',
      }],
      activeTabId: 'query-1',
      appLogReadResult: {
        success: true,
        data: { lines: ['2026/06/10 09:00:00.000000 [INFO] started'] },
      },
      connectionFailureReadResult: {
        success: true,
        data: { lines: [] },
      },
      lastRenderErrorSnapshot: {
        hasError: true,
        summary: '已记录到最近一次 AI 消息渲染异常',
        messageId: 'msg-1',
        role: 'assistant',
        recordedAt: 1780700000000,
        contentPreview: '回复预览',
        errorMessage: 'Cannot read properties of undefined',
        nextActions: ['先按 messageId 和 contentPreview 对照当前会话。'],
      },
    });

    expect(snapshot.status).toBe('degraded');
    expect(snapshot.summary.hasLastAIMessageRenderError).toBe(true);
    expect(snapshot.summary.lastAIMessageRenderErrorId).toBe('msg-1');
    expect(snapshot.warnings).toContain('A recent AI message render error was recorded and may affect reply bubble display or Markdown rendering');
    expect(snapshot.nextActions).toContain('Call inspect_ai_last_render_error to review the latest bubble render error messageId, content preview, and component stack');
    expect(snapshot.lastRenderError.errorMessage).toBe('Cannot read properties of undefined');
  });
});
