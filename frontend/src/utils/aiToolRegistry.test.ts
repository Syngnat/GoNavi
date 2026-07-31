import { describe, expect, it } from 'vitest';

import { BUILTIN_AI_TOOL_INFO, buildAvailableAIChatTools } from './aiToolRegistry';

describe('aiToolRegistry', () => {
  it('registers the ai-runtime inspector as a builtin tool', () => {
    const info = BUILTIN_AI_TOOL_INFO.find((item) => item.name === 'inspect_ai_runtime');
    expect(info).toBeTruthy();
    expect(info?.desc).toContain('AI runtime status');
    expect(info?.tool.function.description).toContain('provider');
    expect(info?.tool.function.description).toContain('safety level');
  });

  it('registers the ai-setup-health inspector as a builtin tool', () => {
    const info = BUILTIN_AI_TOOL_INFO.find((item) => item.name === 'inspect_ai_setup_health');
    expect(info).toBeTruthy();
    expect(info?.desc).toContain('current AI setup');
    expect(info?.tool.function.description).toContain('chat send prerequisites');
  });

  it('registers the ai-support-bundle inspector as a builtin tool', () => {
    const info = BUILTIN_AI_TOOL_INFO.find((item) => item.name === 'inspect_ai_support_bundle');
    expect(info).toBeTruthy();
    expect(info?.desc).toContain('troubleshooting support bundle');
    expect(info?.tool.function.description).toContain('does not include database passwords');
    expect(info?.tool.function.parameters?.properties?.includeMessageContent?.description).toContain('Default false');
  });

  it('registers the ai-safety inspector as a builtin tool', () => {
    const info = BUILTIN_AI_TOOL_INFO.find((item) => item.name === 'inspect_ai_safety');
    expect(info).toBeTruthy();
    expect(info?.desc).toContain('write safety boundaries');
    expect(info?.tool.function.description).toContain('allowMutating');
  });

  it('registers the mcp-setup inspector as a builtin tool', () => {
    const info = BUILTIN_AI_TOOL_INFO.find((item) => item.name === 'inspect_mcp_setup');
    expect(info).toBeTruthy();
    expect(info?.desc).toContain('MCP configuration');
    expect(info?.detail).toContain('OpenCode');
    expect(info?.tool.function.description).toContain('external client');
    expect(info?.tool.function.description).toContain('OpenCode');
  });

  it('registers the mcp-remote-access inspector as a builtin tool', () => {
    const info = BUILTIN_AI_TOOL_INFO.find((item) => item.name === 'inspect_mcp_remote_access');
    expect(info).toBeTruthy();
    expect(info?.desc).toContain('OpenClaw/Hermans');
    expect(info?.tool.function.description).toContain('Bearer Token');
    expect(info?.tool.function.parameters?.properties?.exposeStrategy?.enum).toContain('cloudflare_tunnel');
  });

  it('registers the mcp-runtime-failure inspector as a builtin tool', () => {
    const info = BUILTIN_AI_TOOL_INFO.find((item) => item.name === 'inspect_mcp_runtime_failures');
    expect(info).toBeTruthy();
    expect(info?.desc).toContain('startup and tool-call failures');
    expect(info?.tool.function.description).toContain('tool discovery failures');
    expect(info?.tool.function.parameters?.properties?.serverName?.description).toContain('MCP service name');
  });

  it('registers the mcp-authoring-guide inspector as a builtin tool', () => {
    const info = BUILTIN_AI_TOOL_INFO.find((item) => item.name === 'inspect_mcp_authoring_guide');
    expect(info).toBeTruthy();
    expect(info?.desc).toContain('add-MCP');
    expect(info?.tool.function.description).toContain('full-command auto-splitting');
  });

  it('registers the mcp-draft inspector as a builtin tool', () => {
    const info = BUILTIN_AI_TOOL_INFO.find((item) => item.name === 'inspect_mcp_draft');
    expect(info).toBeTruthy();
    expect(info?.desc).toContain('add-MCP draft');
    expect(info?.tool.function.description).toContain('automatic splitting');
    expect(info?.tool.function.parameters?.properties?.fullCommand?.description).toContain('full MCP startup command');
    expect(info?.tool.function.parameters?.properties?.templateKey?.enum).toContain('docker');
  });

  it('registers the mcp-docker-setup inspector as a builtin tool', () => {
    const info = BUILTIN_AI_TOOL_INFO.find((item) => item.name === 'inspect_mcp_docker_setup');
    expect(info).toBeTruthy();
    expect(info?.desc).toContain('Docker MCP');
    expect(info?.tool.function.description).toContain('docker run');
    expect(info?.tool.function.parameters?.properties?.includeDisabled?.description).toContain('Default true');
  });

  it('registers the mcp-tool-schema inspector as a builtin tool', () => {
    const info = BUILTIN_AI_TOOL_INFO.find((item) => item.name === 'inspect_mcp_tool_schema');
    expect(info).toBeTruthy();
    expect(info?.desc).toContain('MCP tool argument schema');
    expect(info?.tool.function.description).toContain('parameter schema');
    expect(info?.tool.function.parameters?.properties?.alias?.description).toContain('real alias');
  });

  it('registers the ai-provider inspector as a builtin tool', () => {
    const info = BUILTIN_AI_TOOL_INFO.find((item) => item.name === 'inspect_ai_providers');
    expect(info).toBeTruthy();
    expect(info?.desc).toContain('providers and model configuration');
    expect(info?.tool.function.description).toContain('model list');
  });

  it('registers the chat-readiness inspector as a builtin tool', () => {
    const info = BUILTIN_AI_TOOL_INFO.find((item) => item.name === 'inspect_ai_chat_readiness');
    expect(info).toBeTruthy();
    expect(info?.desc).toContain('AI chat can send');
    expect(info?.tool.function.description).toContain('current AI chat input');
  });

  it('registers the ai-upstream-log inspector as a builtin tool', () => {
    const info = BUILTIN_AI_TOOL_INFO.find((item) => item.name === 'inspect_ai_upstream_logs');
    expect(info).toBeTruthy();
    expect(info?.desc).toContain('upstream request payloads');
    expect(info?.tool.function.description).toContain('request body preview');
    expect(info?.tool.function.parameters?.properties?.requestId?.description).toContain('requestId');
    expect(info?.tool.function.parameters?.properties?.includePayloadSummary?.description).toContain('tool count');
    expect(info?.tool.function.parameters?.properties?.includePayloadSummary?.description).toContain('tool_choice');
  });

  it('registers the ai-tool-catalog inspector as a builtin tool', () => {
    const info = BUILTIN_AI_TOOL_INFO.find((item) => item.name === 'inspect_ai_tool_catalog');
    expect(info).toBeTruthy();
    expect(info?.desc).toContain('built-in tool catalog');
    expect(info?.tool.function.description).toContain('recommended tool-call flows');
    expect(info?.tool.function.parameters?.properties?.keyword?.description).toContain('connection failure');
    expect(info?.tool.function.parameters?.properties?.includeMCPTools?.description).toContain('MCP tool summaries');
  });

  it('registers the ai-guidance inspector as a builtin tool', () => {
    const info = BUILTIN_AI_TOOL_INFO.find((item) => item.name === 'inspect_ai_guidance');
    expect(info).toBeTruthy();
    expect(info?.desc).toContain('prompts and Skills');
    expect(info?.tool.function.description).toContain('user-defined prompts');
  });

  it('registers the current-connection inspector as a builtin tool', () => {
    const info = BUILTIN_AI_TOOL_INFO.find((item) => item.name === 'inspect_current_connection');
    expect(info).toBeTruthy();
    expect(info?.desc).toContain('active connection');
    expect(info?.tool.function.description).toContain('SSH/proxy/HTTP tunnel state');
  });

  it('registers the connection-capability inspector as a builtin tool', () => {
    const info = BUILTIN_AI_TOOL_INFO.find((item) => item.name === 'inspect_connection_capabilities');
    expect(info).toBeTruthy();
    expect(info?.desc).toContain('frontend capabilities');
    expect(info?.tool.function.description).toContain('forced read-only result state');
  });

  it('registers the saved-connections inspector as a builtin tool', () => {
    const info = BUILTIN_AI_TOOL_INFO.find((item) => item.name === 'inspect_saved_connections');
    expect(info).toBeTruthy();
    expect(info?.desc).toContain('saved connections');
    expect(info?.tool.function.description).toContain('locally saved connections');
  });

  it('registers the Redis topology inspector as a builtin tool', () => {
    const info = BUILTIN_AI_TOOL_INFO.find((item) => item.name === 'inspect_redis_topology');
    expect(info).toBeTruthy();
    expect(info?.desc).toContain('Redis standalone, Sentinel, and Cluster');
    expect(info?.tool.function.description).toContain('Sentinel');
    expect(info?.tool.function.description).toContain('do not echo Redis or Sentinel passwords');
    expect(info?.tool.function.parameters?.properties?.connectionId?.description).toContain('Redis connection ID');
  });

  it('registers the external-sql-directory inspector as a builtin tool', () => {
    const info = BUILTIN_AI_TOOL_INFO.find((item) => item.name === 'inspect_external_sql_directories');
    expect(info).toBeTruthy();
    expect(info?.desc).toContain('external SQL directory');
    expect(info?.tool.function.description).toContain('currently open external SQL file tabs');
  });

  it('registers the external-sql-file inspector as a builtin tool', () => {
    const info = BUILTIN_AI_TOOL_INFO.find((item) => item.name === 'inspect_external_sql_file');
    expect(info).toBeTruthy();
    expect(info?.desc).toContain('external SQL file content');
    expect(info?.tool.function.description).toContain('specified external SQL file');
    expect(info?.tool.function.parameters?.properties?.filePath?.description).toContain('Absolute path');
  });

  it('registers the shortcut inspector as a builtin tool', () => {
    const info = BUILTIN_AI_TOOL_INFO.find((item) => item.name === 'inspect_shortcuts');
    expect(info).toBeTruthy();
    expect(info?.desc).toContain('shortcut configuration');
    expect(info?.tool.function.description).toContain('Windows/macOS');
  });

  it('registers the app-log inspector as a builtin tool', () => {
    const info = BUILTIN_AI_TOOL_INFO.find((item) => item.name === 'inspect_app_logs');
    expect(info).toBeTruthy();
    expect(info?.desc).toContain('application log');
    expect(info?.tool.function.description).toContain('gonavi.log');
  });

  it('registers the recent-connection-failure inspector as a builtin tool', () => {
    const info = BUILTIN_AI_TOOL_INFO.find((item) => item.name === 'inspect_recent_connection_failures');
    expect(info).toBeTruthy();
    expect(info?.desc).toContain('connection failures');
    expect(info?.tool.function.description).toContain('SSH tunnel failures');
    expect(info?.tool.function.parameters?.properties?.keyword?.description).toContain('127.0.0.1');
  });

  it('registers the ai-render-error inspector as a builtin tool', () => {
    const info = BUILTIN_AI_TOOL_INFO.find((item) => item.name === 'inspect_ai_last_render_error');
    expect(info).toBeTruthy();
    expect(info?.desc).toContain('render error');
    expect(info?.tool.function.description).toContain('AI message render error');
  });

  it('registers the ai-message-flow inspector as a builtin tool', () => {
    const info = BUILTIN_AI_TOOL_INFO.find((item) => item.name === 'inspect_ai_message_flow');
    expect(info).toBeTruthy();
    expect(info?.desc).toContain('message flow');
    expect(info?.tool.function.description).toContain('consecutive assistant messages');
  });

  it('registers the ai-context-budget inspector as a builtin tool', () => {
    const info = BUILTIN_AI_TOOL_INFO.find((item) => item.name === 'inspect_ai_context_budget');
    expect(info).toBeTruthy();
    expect(info?.desc).toContain('context size');
    expect(info?.tool.function.description).toContain('MCP tool schemas');
    expect(info?.tool.function.parameters?.properties?.messageLimit?.description).toContain('maximum 120');
  });

  it('registers the codebase-hotspots inspector as a builtin tool', () => {
    const info = BUILTIN_AI_TOOL_INFO.find((item) => item.name === 'inspect_codebase_hotspots');
    expect(info).toBeTruthy();
    expect(info?.desc).toContain('large frontend files');
    expect(info?.tool.function.description).toContain('split-hotspot snapshot');
    expect(info?.tool.function.parameters?.properties?.minLines?.description).toContain('Default 1000');
  });

  it('registers the recent-sql-activity, saved-query, and sql-snippet inspectors as builtin tools', () => {
    const recentActivityTool = BUILTIN_AI_TOOL_INFO.find((item) => item.name === 'inspect_recent_sql_activity');
    const sqlEditorTransactionTool = BUILTIN_AI_TOOL_INFO.find((item) => item.name === 'inspect_sql_editor_transaction');
    const sqlRiskTool = BUILTIN_AI_TOOL_INFO.find((item) => item.name === 'inspect_sql_risk');
    const appLogTool = BUILTIN_AI_TOOL_INFO.find((item) => item.name === 'inspect_app_logs');
    const connectionFailureTool = BUILTIN_AI_TOOL_INFO.find((item) => item.name === 'inspect_recent_connection_failures');
    const renderErrorTool = BUILTIN_AI_TOOL_INFO.find((item) => item.name === 'inspect_ai_last_render_error');
    const messageFlowTool = BUILTIN_AI_TOOL_INFO.find((item) => item.name === 'inspect_ai_message_flow');
    const savedQueryTool = BUILTIN_AI_TOOL_INFO.find((item) => item.name === 'inspect_saved_queries');
    const aiSessionsTool = BUILTIN_AI_TOOL_INFO.find((item) => item.name === 'inspect_ai_sessions');
    const snippetTool = BUILTIN_AI_TOOL_INFO.find((item) => item.name === 'inspect_sql_snippets');

    expect(recentActivityTool?.desc).toContain('recent SQL activity');
    expect(recentActivityTool?.tool.function.description).toContain('recent SQL activity');
    expect(sqlEditorTransactionTool?.desc).toContain('SQL editor transaction');
    expect(sqlEditorTransactionTool?.tool.function.description).toContain('managed transaction');
    expect(sqlRiskTool?.desc).toContain('execution risk');
    expect(sqlRiskTool?.tool.function.description).toContain('risk points');
    expect(appLogTool?.desc).toContain('GoNavi application log');
    expect(appLogTool?.tool.function.description).toContain('application log');
    expect(connectionFailureTool?.desc).toContain('connection failures');
    expect(connectionFailureTool?.tool.function.description).toContain('cooldown');
    expect(renderErrorTool?.desc).toContain('message render error');
    expect(renderErrorTool?.tool.function.description).toContain('render error snapshot');
    expect(messageFlowTool?.desc).toContain('message flow');
    expect(messageFlowTool?.tool.function.description).toContain('tool-call to tool-result matching');
    expect(savedQueryTool?.desc).toContain('saved SQL queries');
    expect(savedQueryTool?.tool.function.description).toContain('SQL preview');
    expect(aiSessionsTool?.desc).toContain('AI conversation history');
    expect(aiSessionsTool?.tool.function.description).toContain('latest message preview');
    expect(snippetTool?.desc).toContain('SQL snippet templates');
    expect(snippetTool?.tool.function.description).toContain('snippet templates');
  });

  it('keeps builtin tools and MCP tools in the unified runtime tool chain', () => {
    const tools = buildAvailableAIChatTools([{
      alias: 'custom_probe',
      originalName: 'custom_probe',
      serverId: 'server-1',
      serverName: 'demo',
      title: '自定义探针',
      description: '读取额外环境信息',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
        },
      },
    }]);

    expect(tools.some((item) => item.function.name === 'inspect_ai_runtime')).toBe(true);
    expect(tools.some((item) => item.function.name === 'inspect_ai_setup_health')).toBe(true);
    expect(tools.some((item) => item.function.name === 'inspect_ai_support_bundle')).toBe(true);
    expect(tools.some((item) => item.function.name === 'inspect_ai_safety')).toBe(true);
    expect(tools.some((item) => item.function.name === 'inspect_ai_providers')).toBe(true);
    expect(tools.some((item) => item.function.name === 'inspect_ai_chat_readiness')).toBe(true);
    expect(tools.some((item) => item.function.name === 'inspect_ai_upstream_logs')).toBe(true);
    expect(tools.some((item) => item.function.name === 'inspect_ai_tool_catalog')).toBe(true);
    expect(tools.some((item) => item.function.name === 'inspect_mcp_setup')).toBe(true);
    expect(tools.some((item) => item.function.name === 'inspect_mcp_remote_access')).toBe(true);
    expect(tools.some((item) => item.function.name === 'inspect_mcp_runtime_failures')).toBe(true);
    expect(tools.some((item) => item.function.name === 'inspect_mcp_authoring_guide')).toBe(true);
    expect(tools.some((item) => item.function.name === 'inspect_mcp_draft')).toBe(true);
    expect(tools.some((item) => item.function.name === 'inspect_mcp_tool_schema')).toBe(true);
    expect(tools.some((item) => item.function.name === 'inspect_ai_guidance')).toBe(true);
    expect(tools.some((item) => item.function.name === 'inspect_current_connection')).toBe(true);
    expect(tools.some((item) => item.function.name === 'inspect_connection_capabilities')).toBe(true);
    expect(tools.some((item) => item.function.name === 'inspect_saved_connections')).toBe(true);
    expect(tools.some((item) => item.function.name === 'inspect_redis_topology')).toBe(true);
    expect(tools.some((item) => item.function.name === 'inspect_external_sql_directories')).toBe(true);
    expect(tools.some((item) => item.function.name === 'inspect_external_sql_file')).toBe(true);
    expect(tools.some((item) => item.function.name === 'inspect_recent_sql_activity')).toBe(true);
    expect(tools.some((item) => item.function.name === 'inspect_sql_editor_transaction')).toBe(true);
    expect(tools.some((item) => item.function.name === 'inspect_sql_risk')).toBe(true);
    expect(tools.some((item) => item.function.name === 'inspect_app_logs')).toBe(true);
    expect(tools.some((item) => item.function.name === 'inspect_recent_connection_failures')).toBe(true);
    expect(tools.some((item) => item.function.name === 'inspect_ai_last_render_error')).toBe(true);
    expect(tools.some((item) => item.function.name === 'inspect_ai_message_flow')).toBe(true);
    expect(tools.some((item) => item.function.name === 'inspect_ai_context_budget')).toBe(true);
    expect(tools.some((item) => item.function.name === 'inspect_codebase_hotspots')).toBe(true);
    expect(tools.some((item) => item.function.name === 'inspect_saved_queries')).toBe(true);
    expect(tools.some((item) => item.function.name === 'inspect_ai_sessions')).toBe(true);
    expect(tools.some((item) => item.function.name === 'inspect_sql_snippets')).toBe(true);
    expect(tools.some((item) => item.function.name === 'inspect_shortcuts')).toBe(true);
    expect(tools.some((item) => item.function.name === 'custom_probe')).toBe(true);
  });

  it('localizes MCP fallback descriptions while preserving raw server and tool names', () => {
    const tools = buildAvailableAIChatTools([{
      alias: 'raw_alias',
      originalName: 'raw_original_name',
      serverId: 'server-raw',
      serverName: 'raw-server.local',
      title: 'raw_tool_title',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
        },
      },
    }], (key, params) => `${key}: ${params?.toolName} @ ${params?.serverName}`);

    const mcpTool = tools.find((item) => item.function.name === 'raw_alias');
    expect(mcpTool?.function.description).toBe(
      'ai_chat.tools.mcp_fallback_description: raw_tool_title @ raw-server.local',
    );
  });

  it('localizes SQL inspection tool schema copy while preserving raw tool and parameter names', () => {
    const tools = buildAvailableAIChatTools([], (key) => `T:${key}`);
    const recentLogsTool = tools.find((item) => item.function.name === 'inspect_recent_sql_logs');
    const sqlRiskTool = tools.find((item) => item.function.name === 'inspect_sql_risk');

    expect(recentLogsTool?.function.name).toBe('inspect_recent_sql_logs');
    expect(recentLogsTool?.function.description).toBe(
      'T:ai_chat.inspection.tool_info.inspect_recent_sql_logs.tool_description',
    );
    expect(recentLogsTool?.function.parameters?.properties?.limit?.description).toBe(
      'T:ai_chat.inspection.tool_info.inspect_recent_sql_logs.param.limit',
    );
    expect(recentLogsTool?.function.parameters?.properties?.status?.enum).toEqual(['all', 'success', 'error']);

    expect(sqlRiskTool?.function.name).toBe('inspect_sql_risk');
    expect(sqlRiskTool?.function.description).toBe(
      'T:ai_chat.inspection.tool_info.inspect_sql_risk.tool_description',
    );
    expect(sqlRiskTool?.function.parameters?.properties?.sql?.description).toBe(
      'T:ai_chat.inspection.tool_info.inspect_sql_risk.param.sql',
    );
    expect(sqlRiskTool?.function.parameters?.properties?.previewCharLimit?.description).toBe(
      'T:ai_chat.inspection.tool_info.inspect_sql_risk.param.previewCharLimit',
    );
  });
});
