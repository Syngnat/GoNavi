import { describe, expect, it } from 'vitest';

import type {
  AISkillConfig,
  AIUserPromptSettings,
  SavedConnection,
  TabData,
} from '../../types';
import { catalogs } from '../../i18n/catalog';
import { buildAISystemContextMessages } from './aiSystemContextMessages';

const AI_SYSTEM_INSPECTION_GUIDANCE_KEYS = [
  'ai_chat.system.inspection_guidance.inspect_ai_runtime',
  'ai_chat.system.inspection_guidance.inspect_ai_safety',
  'ai_chat.system.inspection_guidance.inspect_ai_context',
  'ai_chat.system.inspection_guidance.inspect_app_health',
  'ai_chat.system.inspection_guidance.inspect_ai_support_bundle',
  'ai_chat.system.inspection_guidance.inspect_ai_tool_catalog',
  'ai_chat.system.inspection_guidance.inspect_ai_setup_health',
  'ai_chat.system.inspection_guidance.inspect_ai_chat_readiness',
  'ai_chat.system.inspection_guidance.inspect_ai_upstream_logs',
  'ai_chat.system.inspection_guidance.inspect_ai_providers',
  'ai_chat.system.inspection_guidance.inspect_mcp_setup',
  'ai_chat.system.inspection_guidance.inspect_mcp_runtime_failures',
  'ai_chat.system.inspection_guidance.inspect_mcp_authoring_guide',
  'ai_chat.system.inspection_guidance.inspect_mcp_draft',
  'ai_chat.system.inspection_guidance.inspect_mcp_tool_schema',
  'ai_chat.system.inspection_guidance.inspect_ai_guidance',
  'ai_chat.system.inspection_guidance.inspect_shortcuts',
  'ai_chat.system.inspection_guidance.inspect_recent_connection_failures',
  'ai_chat.system.inspection_guidance.inspect_app_logs',
  'ai_chat.system.inspection_guidance.inspect_ai_last_render_error',
  'ai_chat.system.inspection_guidance.inspect_ai_message_flow',
  'ai_chat.system.inspection_guidance.inspect_ai_context_budget',
  'ai_chat.system.inspection_guidance.inspect_codebase_hotspots',
  'ai_chat.system.inspection_guidance.inspect_current_connection',
  'ai_chat.system.inspection_guidance.inspect_connection_capabilities',
  'ai_chat.system.inspection_guidance.inspect_saved_connections',
  'ai_chat.system.inspection_guidance.inspect_redis_topology',
  'ai_chat.system.inspection_guidance.inspect_external_sql_directories',
  'ai_chat.system.inspection_guidance.inspect_external_sql_file',
  'ai_chat.system.inspection_guidance.inspect_recent_sql_activity',
  'ai_chat.system.inspection_guidance.inspect_sql_editor_transaction',
  'ai_chat.system.inspection_guidance.inspect_sql_risk',
  'ai_chat.system.inspection_guidance.inspect_saved_queries',
  'ai_chat.system.inspection_guidance.inspect_ai_sessions',
  'ai_chat.system.inspection_guidance.inspect_sql_snippets',
] as const;

const AI_SYSTEM_CONTEXT_KEYS = [
  'ai_chat.system.context.custom_prompt.global',
  'ai_chat.system.context.custom_prompt.database',
  'ai_chat.system.context.custom_prompt.jvm',
  'ai_chat.system.context.custom_prompt.jvm_diagnostic',
  'ai_chat.system.context.skill_prompt',
  'ai_chat.system.context.database_with_schema',
  'ai_chat.system.context.database_with_target',
  'ai_chat.system.context.database_without_context',
  'ai_chat.system.context.jvm_diagnostic_prompt',
  'ai_chat.system.context.jvm_runtime_prompt',
] as const;

const userPromptSettings: AIUserPromptSettings = {
  global: '回答前先核对上下文。',
  database: '生成 SQL 时保持只读优先。',
  jvm: '解释 JVM 资源时先说风险。',
  jvmDiagnostic: '诊断命令必须说明预期信号。',
};

const connections: SavedConnection[] = [
  {
    id: 'conn-1',
    name: '本地开发库',
    config: {
      type: 'mysql',
      host: '127.0.0.1',
      port: 3306,
      user: 'root',
    },
  },
  {
    id: 'jvm-1',
    name: 'JVM 诊断环境',
    config: {
      type: 'jvm',
      host: '10.0.0.8',
      port: 0,
      user: '',
      jvm: {
        environment: 'uat',
        readOnly: true,
        diagnostic: {
          transport: 'agent-bridge',
          allowObserveCommands: true,
          allowTraceCommands: false,
          allowMutatingCommands: false,
        },
      },
    },
  },
];

describe('buildAISystemContextMessages', () => {
  it('uses the provided translator for fixed system inspection guidance', () => {
    const translate = (key: string) => `T:${key}`;

    const messages = buildAISystemContextMessages({
      activeContext: null,
      aiContexts: {},
      connections: [connections[0]],
      tabs: [],
      activeTabId: null,
      availableToolNames: ['inspect_ai_runtime', 'inspect_sql_risk'],
      skills: [],
      userPromptSettings,
      translate,
    });

    const joined = messages.map((message) => message.content).join('\n');
    expect(joined).toContain('T:ai_chat.system.inspection_guidance.inspect_ai_runtime');
    expect(joined).toContain('T:ai_chat.system.inspection_guidance.inspect_sql_risk');
    expect(joined).not.toContain('优先调用 inspect_ai_runtime 读取当前 AI 运行状态');
    expect(joined).not.toContain('优先调用 inspect_sql_risk 检查当前编辑区或传入 SQL');
  });

  it('keeps fixed system inspection guidance keys in all six catalogs', () => {
    for (const key of AI_SYSTEM_INSPECTION_GUIDANCE_KEYS) {
      for (const language of Object.keys(catalogs) as Array<keyof typeof catalogs>) {
        expect(catalogs[language]).toHaveProperty(key);
        expect(catalogs[language][key as keyof (typeof catalogs)[typeof language]]).toBeTruthy();
      }
    }
  });

  it('uses the provided translator for fixed system context prompts and wrappers', () => {
    const translate = (key: string, params?: Record<string, unknown>) => {
      if (key === 'ai_chat.system.context.custom_prompt.global') {
        return `global prompt wrapper -> ${params?.content}`;
      }
      if (key === 'ai_chat.system.context.custom_prompt.database') {
        return `database prompt wrapper -> ${params?.content}`;
      }
      if (key === 'ai_chat.system.context.custom_prompt.jvm') {
        return `jvm prompt wrapper -> ${params?.content}`;
      }
      if (key === 'ai_chat.system.context.custom_prompt.jvm_diagnostic') {
        return `diagnostic prompt wrapper -> ${params?.content}`;
      }
      if (key === 'ai_chat.system.context.skill_prompt') {
        return `skill wrapper -> ${params?.skillName} / ${params?.skillDescription} / ${params?.requiredTools} / ${params?.content}`;
      }
      if (key === 'ai_chat.system.context.database_with_schema') {
        return `database schema prompt -> ${params?.dbType} / ${params?.ddlChunks}`;
      }
      if (key === 'ai_chat.system.context.database_with_target') {
        return `database target prompt -> ${params?.dbType} / ${params?.dbName}`;
      }
      if (key === 'ai_chat.system.context.database_without_context') {
        return `database no context prompt -> ${params?.connList}`;
      }
      if (key === 'ai_chat.system.context.jvm_runtime_prompt') {
        return `jvm runtime prompt -> ${params?.connectionName} / ${params?.host} / ${params?.providerMode} / ${params?.environment} / ${params?.resourcePath}`;
      }
      if (key === 'ai_chat.system.context.jvm_diagnostic_prompt') {
        return `jvm diagnostic prompt -> ${params?.connectionName} / ${params?.host} / ${params?.transport} / ${params?.environment} / ${params?.observeAllowed}`;
      }
      return key;
    };

    const databaseWithSchemaMessages = buildAISystemContextMessages({
      activeContext: { connectionId: 'conn-1', dbName: 'app_db' },
      aiContexts: {
        'conn-1:app_db': [
          {
            dbName: 'app_db',
            tableName: 'orders',
            ddl: 'CREATE TABLE orders (id bigint);',
          },
        ],
      },
      connections: [connections[0]],
      tabs: [],
      activeTabId: null,
      availableToolNames: ['inspect_workspace_tabs', 'get_columns'],
      skills: [
        {
          id: 'skill-1',
          name: '结构审查',
          description: '优先核对结构',
          systemPrompt: '先看字段和索引，再给结论。',
          enabled: true,
          scopes: ['database'],
          requiredTools: ['inspect_workspace_tabs', 'get_columns'],
        },
      ],
      userPromptSettings,
      translate,
    });
    const schemaJoined = databaseWithSchemaMessages.map((message) => message.content).join('\n');
    expect(schemaJoined).toContain('database schema prompt -> MySQL / -- Table: app_db.orders');
    expect(schemaJoined).toContain('CREATE TABLE orders (id bigint);');
    expect(schemaJoined).toContain('global prompt wrapper -> 回答前先核对上下文。');
    expect(schemaJoined).toContain('database prompt wrapper -> 生成 SQL 时保持只读优先。');
    expect(schemaJoined).toContain('skill wrapper -> 结构审查 / 优先核对结构 /');
    expect(schemaJoined).toContain('inspect_workspace_tabs, get_columns');
    expect(schemaJoined).toContain('先看字段和索引，再给结论。');
    expect(schemaJoined).not.toContain('以下是当前用户的自定义补充提示词');
    expect(schemaJoined).not.toContain('以下是当前启用的 Skill');
    expect(schemaJoined).not.toContain('你是一个专业的数据库助手');

    const databaseTargetMessages = buildAISystemContextMessages({
      activeContext: { connectionId: 'conn-1', dbName: 'app_db' },
      aiContexts: {},
      connections: [connections[0]],
      tabs: [],
      activeTabId: null,
      availableToolNames: [],
      skills: [],
      userPromptSettings,
      translate,
    });
    expect(databaseTargetMessages[0].content).toContain('database target prompt -> MySQL / app_db');

    const databaseNoContextMessages = buildAISystemContextMessages({
      activeContext: null,
      aiContexts: {},
      connections: [connections[0]],
      tabs: [],
      activeTabId: null,
      availableToolNames: [],
      skills: [],
      userPromptSettings,
      translate,
    });
    expect(databaseNoContextMessages[0].content).toContain('database no context prompt -> {id: "conn-1", name: "本地开发库", type: "mysql"}');

    const runtimeMessages = buildAISystemContextMessages({
      activeContext: null,
      aiContexts: {},
      connections,
      tabs: [
        {
          id: 'jvm-tab-1',
          title: 'JVM Resource',
          type: 'jvm-resource',
          connectionId: 'jvm-1',
          providerMode: 'jmx',
          resourcePath: 'java.lang:type=Memory',
        },
      ],
      activeTabId: 'jvm-tab-1',
      availableToolNames: [],
      skills: [],
      userPromptSettings,
      translate,
    });
    expect(runtimeMessages[0].content).toContain('jvm runtime prompt -> JVM 诊断环境 / 10.0.0.8 / jmx / uat / java.lang:type=Memory');
    expect(runtimeMessages[1].content).toContain('global prompt wrapper -> 回答前先核对上下文。');
    expect(runtimeMessages[2].content).toContain('jvm prompt wrapper -> 解释 JVM 资源时先说风险。');

    const diagnosticMessages = buildAISystemContextMessages({
      activeContext: null,
      aiContexts: {},
      connections,
      tabs: [
        {
          id: 'diag-tab-1',
          title: 'JVM Diagnostic',
          type: 'jvm-diagnostic',
          connectionId: 'jvm-1',
        },
      ],
      activeTabId: 'diag-tab-1',
      availableToolNames: [],
      skills: [],
      userPromptSettings,
      translate,
    });
    expect(diagnosticMessages[0].content).toContain('jvm diagnostic prompt -> JVM 诊断环境 / 10.0.0.8 / agent-bridge / uat / allowed');
    expect(diagnosticMessages[1].content).toContain('global prompt wrapper -> 回答前先核对上下文。');
    expect(diagnosticMessages[2].content).toContain('diagnostic prompt wrapper -> 诊断命令必须说明预期信号。');
  });

  it('keeps fixed system context keys in all six catalogs', () => {
    for (const key of AI_SYSTEM_CONTEXT_KEYS) {
      for (const language of Object.keys(catalogs) as Array<keyof typeof catalogs>) {
        expect(catalogs[language]).toHaveProperty(key);
        expect(catalogs[language][key as keyof (typeof catalogs)[typeof language]]).toBeTruthy();
      }
    }
  });

  it('adds database workspace inspection guidance plus custom prompts and eligible skills', () => {
    const skills: AISkillConfig[] = [
      {
        id: 'skill-1',
        name: '结构审查',
        description: '优先核对结构',
        systemPrompt: '先看字段和索引，再给结论。',
        enabled: true,
        scopes: ['database'],
        requiredTools: ['inspect_workspace_tabs', 'get_columns'],
      },
    ];

    const messages = buildAISystemContextMessages({
      activeContext: null,
      aiContexts: {},
      connections: [connections[0]],
      tabs: [],
      activeTabId: null,
      availableToolNames: ['inspect_workspace_tabs', 'inspect_app_health', 'inspect_ai_support_bundle', 'inspect_ai_setup_health', 'inspect_ai_runtime', 'inspect_ai_safety', 'inspect_ai_providers', 'inspect_ai_chat_readiness', 'inspect_ai_upstream_logs', 'inspect_ai_tool_catalog', 'inspect_mcp_setup', 'inspect_mcp_runtime_failures', 'inspect_mcp_authoring_guide', 'inspect_mcp_draft', 'inspect_mcp_tool_schema', 'inspect_ai_guidance', 'inspect_ai_context', 'inspect_current_connection', 'inspect_connection_capabilities', 'inspect_saved_connections', 'inspect_redis_topology', 'inspect_external_sql_directories', 'inspect_external_sql_file', 'inspect_recent_sql_activity', 'inspect_sql_editor_transaction', 'inspect_sql_risk', 'inspect_recent_connection_failures', 'inspect_app_logs', 'inspect_ai_last_render_error', 'inspect_ai_message_flow', 'inspect_ai_context_budget', 'inspect_codebase_hotspots', 'inspect_saved_queries', 'inspect_ai_sessions', 'inspect_sql_snippets', 'inspect_shortcuts', 'get_columns'],
      skills,
      userPromptSettings,
    });

    const joined = messages.map((message) => message.content).join('\n');
    expect(joined).toContain('inspect_workspace_tabs');
    for (const key of AI_SYSTEM_INSPECTION_GUIDANCE_KEYS) {
      const toolName = key.slice('ai_chat.system.inspection_guidance.'.length);
      expect(joined).toContain(toolName);
    }
    expect(joined).toContain('call inspect_app_health first');
    expect(joined).toContain('call inspect_sql_risk first');
    expect(joined).toContain('Claude/Codex/OpenCode');
    expect(joined).toContain('Existing connections');
    expect(joined).toContain('The user has provided an additional global prompt');
    expect(joined).toContain('回答前先核对上下文。');
    expect(joined).toContain('The user has provided an additional database-session prompt');
    expect(joined).toContain('生成 SQL 时保持只读优先。');
    expect(joined).toContain('The active Skill "结构审查" (优先核对结构) applies to this response');
    expect(joined).toContain('先看字段和索引，再给结论。');
  });

  it('builds the JVM diagnostic prompt when the active tab is a diagnostic workspace', () => {
    const tabs: TabData[] = [
      {
        id: 'diag-tab-1',
        title: 'JVM 诊断',
        type: 'jvm-diagnostic',
        connectionId: 'jvm-1',
      },
    ];

    const messages = buildAISystemContextMessages({
      activeContext: null,
      aiContexts: {},
      connections,
      tabs,
      activeTabId: 'diag-tab-1',
      availableToolNames: [],
      skills: [],
      userPromptSettings,
    });

    expect(messages).toHaveLength(3);
    expect(messages[0].content).toContain("You are GoNavi's JVM diagnostic assistant");
    expect(messages[0].content).toContain('transport must be the current value agent-bridge');
    expect(messages[1].content).toContain('The user has provided an additional global prompt');
    expect(messages[2].content).toContain('The user has provided an additional JVM diagnostic prompt');
    expect(messages[2].content).toContain('诊断命令必须说明预期信号。');
  });
});
