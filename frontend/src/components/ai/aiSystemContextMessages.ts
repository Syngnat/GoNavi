import type {
  AIContextItem,
  AISkillConfig,
  AIUserPromptSettings,
  ConnectionConfig,
  JVMAIPlanContext,
  JVMDiagnosticPlanContext,
  SavedConnection,
  TabData,
} from '../../types';
import {
  appendDatabaseInspectionGuidanceMessages,
  appendJVMInspectionGuidanceMessages,
} from './aiSystemInspectionGuidance';
import {
  translateInspectionCopy,
  type AIInspectionTranslator,
} from './aiInspectionI18n';
import { peekDatabaseServerVersion } from '../queryEditor/queryEditorServerVersion';
import { isAIEditorSelectionContext, isAITableSchemaContext } from './aiEditorSelectionContext';

export interface AISystemContextMessage {
  role: 'system';
  content: string;
  images?: string[];
}

interface BuildAISystemContextMessagesOptions {
  activeContext: { connectionId: string; dbName: string } | null;
  aiContexts: Record<string, AIContextItem[]>;
  connections: SavedConnection[];
  tabs: TabData[];
  activeTabId: string | null;
  availableToolNames: string[];
  skills: AISkillConfig[];
  userPromptSettings: AIUserPromptSettings;
  overrideJVMPlanContext?: JVMAIPlanContext;
  overrideJVMDiagnosticPlanContext?: JVMDiagnosticPlanContext;
  translate?: AIInspectionTranslator;
}

const appendCustomPrompt = (
  messages: AISystemContextMessage[],
  key: string,
  content: string,
  translate?: AIInspectionTranslator,
) => {
  const trimmed = String(content || '').trim();
  if (!trimmed) {
    return;
  }
  messages.push({
    role: 'system',
    content: translateInspectionCopy(
      translate,
      key,
      'The user has provided an additional prompt for this context. Follow it when it does not conflict with safety rules or factual constraints:\n{{content}}',
      { content: trimmed },
    ),
  });
};

const appendCustomPromptGroup = (
  messages: AISystemContextMessage[],
  prompts: string[],
  userPromptSettings: AIUserPromptSettings,
  translate?: AIInspectionTranslator,
) => {
  appendCustomPrompt(messages, 'ai_chat.system.context.custom_prompt.global', userPromptSettings.global, translate);
  prompts.forEach((prompt) => {
    if (prompt === 'database') {
      appendCustomPrompt(messages, 'ai_chat.system.context.custom_prompt.database', userPromptSettings.database, translate);
    } else if (prompt === 'jvm') {
      appendCustomPrompt(messages, 'ai_chat.system.context.custom_prompt.jvm', userPromptSettings.jvm, translate);
    } else if (prompt === 'jvmDiagnostic') {
      appendCustomPrompt(messages, 'ai_chat.system.context.custom_prompt.jvm_diagnostic', userPromptSettings.jvmDiagnostic, translate);
    }
  });
};

const appendSkillPromptGroup = (
  messages: AISystemContextMessage[],
  scopes: string[],
  skills: AISkillConfig[],
  availableToolNames: string[],
  translate?: AIInspectionTranslator,
) => {
  const wantedScopes = new Set<string>(['global', ...scopes]);
  const availableToolNameSet = new Set(availableToolNames);
  skills.forEach((skill) => {
    if (!skill?.enabled) {
      return;
    }
    if (!Array.isArray(skill.scopes) || !skill.scopes.some((scope) => wantedScopes.has(scope))) {
      return;
    }
    if (Array.isArray(skill.requiredTools) && skill.requiredTools.length > 0) {
      const hasAllRequiredTools = skill.requiredTools.every((toolName) => availableToolNameSet.has(toolName));
      if (!hasAllRequiredTools) {
        return;
      }
    }
    const promptText = String(skill.systemPrompt || '').trim();
    if (!promptText) {
      return;
    }
    const requiredTools = Array.isArray(skill.requiredTools) && skill.requiredTools.length > 0
      ? skill.requiredTools.join(', ')
      : '';
    const requiredToolText = Array.isArray(skill.requiredTools) && skill.requiredTools.length > 0
      ? translateInspectionCopy(
        translate,
        'ai_chat.system.context.skill_prompt.required_tools',
        `\nRequired tools: ${requiredTools}`,
        { requiredTools },
      )
      : '';
    messages.push({
      role: 'system',
      content: translateInspectionCopy(
        translate,
        skill.description ? 'ai_chat.system.context.skill_prompt' : 'ai_chat.system.context.skill_prompt_without_description',
        skill.description
          ? 'The active Skill "{{skillName}}" ({{skillDescription}}) applies to this response. Follow its constraints and workflow:{{requiredTools}}\n{{content}}'
          : 'The active Skill "{{skillName}}" applies to this response. Follow its constraints and workflow:{{requiredTools}}\n{{content}}',
        {
          skillName: skill.name,
          skillDescription: skill.description || '',
          requiredTools: requiredToolText,
          content: promptText,
        },
      ),
    });
  });
};

const resolveDatabaseDisplayType = (config: ConnectionConfig | undefined): string => {
  const dbType = config?.type || 'unknown';
  const displayTypes: Record<string, string> = {
    clickhouse: 'ClickHouse',
    diros: 'Doris',
    duckdb: 'DuckDB',
    mongodb: 'MongoDB',
    mysql: 'MySQL',
    postgresql: 'PostgreSQL',
    redis: 'Redis',
    sqlite: 'SQLite',
    sqlserver: 'SQL Server',
    tdengine: 'TDengine',
  };
  return displayTypes[dbType] || dbType.charAt(0).toUpperCase() + dbType.slice(1);
};

const contextCopy = (
  translate: AIInspectionTranslator | undefined,
  key: string,
  fallback: string,
  params?: Record<string, string | number | boolean | null | undefined>,
) => translateInspectionCopy(translate, key, fallback, params);

const resolveDatabaseVersionLabel = (
  connectionId: string | undefined,
  translate: AIInspectionTranslator | undefined,
): string => peekDatabaseServerVersion(connectionId) || contextCopy(
  translate,
  'query_editor.ai_prompt.default_version',
  'unknown',
);

const resolveActiveTab = (params: {
  tabs: TabData[];
  connections: SavedConnection[];
  activeTabId: string | null;
  overrideJVMPlanContext?: JVMAIPlanContext;
  overrideJVMDiagnosticPlanContext?: JVMDiagnosticPlanContext;
}) => {
  const {
    tabs,
    connections,
    activeTabId,
    overrideJVMPlanContext,
    overrideJVMDiagnosticPlanContext,
  } = params;

  const matchesDiagnosticContext = (tab: TabData) => {
    if (!overrideJVMDiagnosticPlanContext || tab.type !== 'jvm-diagnostic') {
      return false;
    }
    const tabConnection = connections.find((connection) => connection.id === tab.connectionId);
    const tabTransport = tabConnection?.config?.jvm?.diagnostic?.transport || 'agent-bridge';
    return (
      tab.connectionId === overrideJVMDiagnosticPlanContext.connectionId &&
      tabTransport === overrideJVMDiagnosticPlanContext.transport
    );
  };

  if (overrideJVMDiagnosticPlanContext) {
    return (
      tabs.find((tab) => tab.id === overrideJVMDiagnosticPlanContext.tabId && matchesDiagnosticContext(tab)) ||
      tabs.find((tab) => matchesDiagnosticContext(tab))
    );
  }

  if (overrideJVMPlanContext) {
    return (
      tabs.find((tab) => tab.id === overrideJVMPlanContext.tabId) ||
      tabs.find(
        (tab) =>
          tab.type === 'jvm-resource' &&
          tab.connectionId === overrideJVMPlanContext.connectionId &&
          tab.providerMode === overrideJVMPlanContext.providerMode &&
          String(tab.resourcePath || '').trim() === overrideJVMPlanContext.resourcePath,
      )
    );
  }

  return tabs.find((tab) => tab.id === activeTabId);
};

export function buildAISystemContextMessages({
  activeContext,
  aiContexts,
  connections,
  tabs,
  activeTabId,
  availableToolNames,
  skills,
  userPromptSettings,
  overrideJVMPlanContext,
  overrideJVMDiagnosticPlanContext,
  translate,
}: BuildAISystemContextMessagesOptions): AISystemContextMessage[] {
  const connectionKey = activeContext?.connectionId ? `${activeContext.connectionId}:${activeContext.dbName || ''}` : 'default';
  const activeContextItems = aiContexts[connectionKey] || [];
  const systemMessages: AISystemContextMessage[] = [];
  const activeTab = resolveActiveTab({
    tabs,
    connections,
    activeTabId,
    overrideJVMPlanContext,
    overrideJVMDiagnosticPlanContext,
  });
  const activeConnection = activeTab?.connectionId
    ? connections.find((connection) => connection.id === activeTab.connectionId)
    : undefined;

  if (
    activeTab &&
    activeTab.type === 'jvm-diagnostic' &&
    activeConnection?.config?.type === 'jvm'
  ) {
    const diagnostic = activeConnection.config.jvm?.diagnostic;
    const diagnosticTransport = overrideJVMDiagnosticPlanContext?.transport || diagnostic?.transport || 'agent-bridge';
    const readOnly = activeConnection.config.jvm?.readOnly !== false;
    const environment = activeConnection.config.jvm?.environment || 'unknown';
    const diagnosticPolicy = contextCopy(
      translate,
      readOnly ? 'ai_chat.system.context.jvm_diagnostic_policy.read_only' : 'ai_chat.system.context.jvm_diagnostic_policy.writable',
      readOnly
        ? 'Default to read-only diagnostic reasoning: only generate observe, trace, and troubleshooting commands, and never assume anything has already executed.'
        : 'Diagnostic commands may be generated, but provide a plan first and let the user decide whether to run it.',
    );
    const permissionAllowed = contextCopy(
      translate,
      'ai_chat.system.context.permission.allowed',
      'allowed',
    );
    const permissionDenied = contextCopy(
      translate,
      'ai_chat.system.context.permission.denied',
      'denied',
    );
    systemMessages.push({
      role: 'system',
      content: contextCopy(
        translate,
        'ai_chat.system.context.jvm_diagnostic_prompt',
        `You are GoNavi's JVM diagnostic assistant. The active tab is an Arthas-compatible diagnostic workspace. Produce a structured diagnostic plan that can be filled back into the diagnostic console.

Current connection: {{connectionName}}
Target host: {{host}}
Diagnostic transport: {{transport}}
Runtime environment: {{environment}}
Connection policy: {{connectionPolicy}}
Command permissions: observe={{observeAllowed}}, trace={{traceAllowed}}, mutating={{mutatingAllowed}}

Response rules:
1. You may include a short analysis first, but the response must contain exactly one \`\`\`json code block.
2. JSON fields are strictly limited to intent, transport, command, riskLevel, reason, and expectedSignals.
3. transport must be the current value {{transport}}; do not invent another transport.
4. command must be a single diagnostic command without a shell prompt, line-joined commands, multiple commands, or a code fence.
5. riskLevel must be low, medium, or high.
6. expectedSignals must be an array of strings describing the signals to observe after execution.
7. If permissions do not allow a class of operation, do not output that class of command; if the request cannot be satisfied, state the limitation directly.`,
        {
          connectionName: activeConnection.name,
          host: activeConnection.config.host || '-',
          transport: diagnosticTransport,
          environment,
          connectionPolicy: diagnosticPolicy,
          observeAllowed: diagnostic?.allowObserveCommands !== false ? permissionAllowed : permissionDenied,
          traceAllowed: diagnostic?.allowTraceCommands === true ? permissionAllowed : permissionDenied,
          mutatingAllowed: diagnostic?.allowMutatingCommands === true ? permissionAllowed : permissionDenied,
        },
      ),
    });
    appendJVMInspectionGuidanceMessages(systemMessages, availableToolNames, translate);
    appendCustomPromptGroup(systemMessages, ['jvmDiagnostic'], userPromptSettings, translate);
    appendSkillPromptGroup(systemMessages, ['jvmDiagnostic'], skills, availableToolNames, translate);
    return systemMessages;
  }

  if (
    activeTab &&
    (activeTab.type === 'jvm-resource' || activeTab.type === 'jvm-overview' || activeTab.type === 'jvm-audit') &&
    activeConnection?.config?.type === 'jvm'
  ) {
    const providerMode = activeTab.providerMode || activeConnection.config.jvm?.preferredMode || 'jmx';
    const resourcePath = activeTab.resourcePath || '';
    const readOnly = activeConnection.config.jvm?.readOnly !== false;
    const environment = activeConnection.config.jvm?.environment || 'unknown';
    const connectionPolicy = contextCopy(
      translate,
      readOnly ? 'ai_chat.system.context.jvm_runtime_policy.read_only' : 'ai_chat.system.context.jvm_runtime_policy.writable',
      readOnly
        ? 'This is a read-only connection. Only analyze and generate change plans; never assume writes have already executed.'
        : 'This is a writable connection, but every modification must first produce a preview and wait for human confirmation.',
    );
    const resourcePathLine = resourcePath
      ? contextCopy(
        translate,
        'ai_chat.system.context.jvm_runtime_resource_path',
        'Current resource path: {{resourcePath}}',
        { resourcePath },
      )
      : contextCopy(
        translate,
        'ai_chat.system.context.jvm_runtime_resource_path_unselected',
        'No specific resource path is currently selected.',
      );
    systemMessages.push({
      role: 'system',
      content: contextCopy(
        translate,
        'ai_chat.system.context.jvm_runtime_prompt',
        `You are GoNavi's JVM runtime analysis assistant. The current context is not SQL; it is the JVM resource workspace.

Current connection: {{connectionName}}
Target host: {{host}}
Provider mode: {{providerMode}}
Runtime environment: {{environment}}
Connection policy: {{connectionPolicy}}
{{resourcePathLine}}

Response rules:
1. You may explain resource structure, risk, modification suggestions, and rollback suggestions.
2. If the user asks for a JVM change plan, output exactly one \`\`\`json code block, and limit JSON fields to targetType, selector, action, payload, and reason.
3. Prefer actions declared by the current resource snapshot or metadata in supportedActions. If none are declared, infer cautiously from the snapshot.
4. Prefer the current resource path for selector.resourcePath. If the path is unknown, state that exact targeting is unavailable instead of inventing a path.
5. payload may only use {"format":"json","value":{...}} or {"format":"text","value":"..."}; do not output scripts, commands, or bare values.
6. Do not output scripts, commands, or statements such as "already executed successfully".`,
        {
          connectionName: activeConnection.name,
          host: activeConnection.config.host || '-',
          providerMode,
          environment,
          connectionPolicy,
          resourcePath,
          resourcePathLine,
        },
      ),
    });
    appendJVMInspectionGuidanceMessages(systemMessages, availableToolNames, translate);
    appendCustomPromptGroup(systemMessages, ['jvm'], userPromptSettings, translate);
    appendSkillPromptGroup(systemMessages, ['jvm'], skills, availableToolNames, translate);
    return systemMessages;
  }

  let targetConnId = activeContext?.connectionId;
  let targetDbName = activeContext?.dbName;
  if (!targetConnId || !targetDbName) {
    if (activeTab && activeTab.connectionId && activeTab.dbName) {
      targetConnId = activeTab.connectionId;
      targetDbName = activeTab.dbName;
    }
  }

  if (activeContextItems.length > 0) {
    const connection = connections.find((item) => item.id === targetConnId);
    const dbDisplayType = resolveDatabaseDisplayType(connection?.config);
    const databaseVersion = resolveDatabaseVersionLabel(targetConnId, translate);
    const tableChunks = activeContextItems
      .filter(isAITableSchemaContext)
      .map((item) => `-- Table: ${item.dbName}.${item.tableName}\n${item.ddl}`);
    const selectionChunks = activeContextItems
      .filter(isAIEditorSelectionContext)
      .map((item) => `-- Editor selection: ${item.label || item.source?.tabTitle || 'current editor'}\n${item.content || item.ddl}`);
    const ddlChunks = [...tableChunks, ...selectionChunks].join('\n\n');
    systemMessages.push({
      role: 'system',
      content: contextCopy(
        translate,
        'ai_chat.system.context.database_with_schema',
        'You are a professional database assistant. The current connection database type is {{dbType}}, and the live server version is {{version}}. Generate SQL using the {{dbType}} dialect and only syntax that version already supports. Do not emit newer-version SQL. If the version is unknown, call get_server_version first. The user has attached table schema information; prioritize it when answering:\n\n{{ddlChunks}}',
        { dbType: dbDisplayType, version: databaseVersion, ddlChunks },
      ),
    });
  } else if (targetConnId && targetDbName) {
    const connection = connections.find((item) => item.id === targetConnId);
    const dbDisplayType = resolveDatabaseDisplayType(connection?.config);
    const databaseVersion = resolveDatabaseVersionLabel(targetConnId, translate);
    systemMessages.push({
      role: 'system',
      content: contextCopy(
        translate,
        'ai_chat.system.context.database_with_target',
        'You are a professional database assistant. The current connection database type is {{dbType}}, the current database name is {{dbName}}, and the live server version is {{version}}. Use only SQL syntax that version already supports. Do not emit newer-version SQL. If the version is unknown, call get_server_version first. If the user needs a specific table or information about the current database, call the provided get_tables tool to actively fetch table information.',
        { dbType: dbDisplayType, dbName: targetDbName, version: databaseVersion },
      ),
    });
  } else {
    const connList = connections.map((connection) => `{id: "${connection.id}", name: "${connection.name}", type: "${connection.config?.type || 'unknown'}"}`).join(', ');
    const renderedConnList = connList || contextCopy(
      translate,
      'ai_chat.system.context.no_connections',
      'no connections',
    );
    systemMessages.push({
      role: 'system',
      content: contextCopy(
        translate,
        'ai_chat.system.context.database_without_context',
        `You are a professional database assistant. The user has not selected any specific database or table in the interface as context.

Important rules:
1. If you need to help the user find a target table, never guess the table name. Call tools to fetch real data.
2. Complete workflow: get_connections -> get_server_version -> get_databases -> get_tables -> get_columns -> generate SQL. Do not skip any step.
3. Connection priority is critical. After retrieving connections, check them in this order:
   - First priority: host is localhost or 127.0.0.1, or the connection name indicates a local environment.
   - Second priority: name or host indicates a development/local environment, or host is a private-network IP such as 10.x, 192.168.x, or 172.16-31.x.
   - Third priority: other connections such as testing or production.
   If the target table is found in a higher-priority connection, use that connection directly and do not search lower-priority connections.
4. If the target table is not found in the current database, continue querying other databases instead of giving up.
5. Stop only when every possible database has been checked or the target table has clearly been found.
6. For ordinary questions that do not involve database queries, answer normally.

SQL generation rules:
7. If the user mentions the current tab, current SQL, current editor, or this statement without pasting the content, call inspect_active_tab first to read the active tab context instead of guessing what is open.
8. If the user asks which tabs are open or what queries are currently in the workspace, call inspect_workspace_tabs first, then decide which tab to inspect further.
9. Field accuracy is an absolute rule. Before generating SQL, call get_columns to get the real target-table field list. Every field name in SQL must exactly match the field value returned by get_columns, including case. Do not compose, abbreviate, or infer field names.
10. If the user asks about index optimization, join relationships, trigger side effects, constraints, or DDL details, call get_indexes, get_foreign_keys, get_triggers, and get_table_ddl as needed after get_columns, then provide the conclusion.
11. When generating SQL, do not use a "database.table" qualified prefix; write only the table name.
12. When reporting results, the connection name/ID and database name must come from the same actual get_tables call parameters. Do not mix connectionId from one connection with dbName from another.
13. If multiple databases have similar names, clearly tell the user which database contains the target table.
14. The first line of each SQL code block must be a context declaration comment in this exact format: -- @context connectionId=<connectionId> dbName=<dbName>. connectionId and dbName must come from the same successful get_tables call parameters. Example:
\`\`\`sql
-- @context connectionId=1770778676549 dbName=mkefu_test
SELECT * FROM users WHERE status = 1;
\`\`\`

Existing connections: [{{connList}}]`,
        { connList: renderedConnList },
      ),
    });
  }

  appendDatabaseInspectionGuidanceMessages(systemMessages, availableToolNames, translate);

  appendCustomPromptGroup(systemMessages, ['database'], userPromptSettings, translate);
  appendSkillPromptGroup(systemMessages, ['database'], skills, availableToolNames, translate);
  return systemMessages;
}
