import type {
  I18nParams,
} from '../../i18n';
import type {
  AIChatMessage,
  AIContextItem,
  AIMCPToolDescriptor,
  AISkillConfig,
  AIUserPromptSettings,
} from '../../types';
import type { AIInspectionTranslator } from './aiInspectionI18n';
import { translateInspectionCopy } from './aiInspectionI18n';
import { isAIEditorSelectionContext, isAITableSchemaContext } from './aiEditorSelectionContext';

type ContextRiskLevel = 'low' | 'medium' | 'high' | 'critical';

interface BuildAIContextBudgetSnapshotOptions {
  aiContexts?: Record<string, AIContextItem[]>;
  aiChatHistory?: Record<string, AIChatMessage[]>;
  aiChatSessions?: Array<{ id: string; title: string; updatedAt: number }>;
  activeSessionId?: string | null;
  sessionId?: unknown;
  messageLimit?: unknown;
  includeDetails?: unknown;
  mcpTools?: AIMCPToolDescriptor[];
  skills?: AISkillConfig[];
  userPromptSettings?: AIUserPromptSettings;
  translate?: AIInspectionTranslator;
}

const DEFAULT_MESSAGE_LIMIT = 40;
const MAX_MESSAGE_LIMIT = 120;
const MESSAGE_PREVIEW_LIMIT = 160;

const clampNumber = (value: unknown, fallback: number, min: number, max: number): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(parsed)));
};

const charCount = (value: unknown): number => String(value || '').length;

const estimateTokens = (chars: number): number => Math.ceil(Math.max(0, chars) / 3);

const previewText = (value: unknown, limit = MESSAGE_PREVIEW_LIMIT): string => {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit)}...`;
};

const classifyRisk = (estimatedInputChars: number): ContextRiskLevel => {
  if (estimatedInputChars >= 120000) {
    return 'critical';
  }
  if (estimatedInputChars >= 70000) {
    return 'high';
  }
  if (estimatedInputChars >= 30000) {
    return 'medium';
  }
  return 'low';
};

const appendUnique = (items: string[], item: string) => {
  if (!items.includes(item)) {
    items.push(item);
  }
};

const translateBudgetCopy = (
  translate: AIInspectionTranslator | undefined,
  key: string,
  fallback: string,
  params?: I18nParams,
): string => translateInspectionCopy(
  translate,
  `ai_chat.inspection.context_budget.${key}`,
  fallback,
  params,
);

const getMessagePayloadChars = (message: AIChatMessage): number =>
  charCount(message.content)
  + charCount(message.thinking)
  + charCount(message.reasoning_content)
  + (message.tool_calls ? charCount(JSON.stringify(message.tool_calls)) : 0);

export const buildAIContextBudgetSnapshot = ({
  aiContexts = {},
  aiChatHistory = {},
  aiChatSessions = [],
  activeSessionId = null,
  sessionId,
  messageLimit,
  includeDetails,
  mcpTools = [],
  skills = [],
  userPromptSettings,
  translate,
}: BuildAIContextBudgetSnapshotOptions) => {
  const requestedSessionId = String(sessionId || activeSessionId || '').trim();
  const allMessages = requestedSessionId ? (aiChatHistory[requestedSessionId] || []) : [];
  const effectiveMessageLimit = clampNumber(messageLimit, DEFAULT_MESSAGE_LIMIT, 1, MAX_MESSAGE_LIMIT);
  const inspectedMessages = allMessages.slice(-effectiveMessageLimit);
  const shouldIncludeDetails = includeDetails !== false;
  const session = aiChatSessions.find((item) => item.id === requestedSessionId);

  const messageRoleCounts = inspectedMessages.reduce<Record<string, number>>((acc, message) => {
    acc[message.role] = (acc[message.role] || 0) + 1;
    return acc;
  }, {});
  const messagePayloadChars = inspectedMessages.reduce((sum, message) => sum + getMessagePayloadChars(message), 0);
  const toolResultChars = inspectedMessages
    .filter((message) => message.role === 'tool')
    .reduce((sum, message) => sum + charCount(message.content), 0);
  const thinkingChars = inspectedMessages.reduce(
    (sum, message) => sum + charCount(message.thinking) + charCount(message.reasoning_content),
    0,
  );
  const unresolvedToolCallIds = new Set<string>();
  inspectedMessages.forEach((message) => {
    (message.tool_calls || []).forEach((toolCall) => unresolvedToolCallIds.add(toolCall.id));
    if (message.role === 'tool' && message.tool_call_id) {
      unresolvedToolCallIds.delete(message.tool_call_id);
    }
  });

  const contextEntries = Object.entries(aiContexts).flatMap(([contextKey, items]) => (
    (items || []).map((item) => ({ contextKey, item }))
  ));
  const tableEntries = contextEntries.filter((entry) => isAITableSchemaContext(entry.item));
  const selectionEntries = contextEntries.filter((entry) => isAIEditorSelectionContext(entry.item));
  const ddlChars = tableEntries.reduce((sum, entry) => sum + charCount(entry.item.ddl), 0);
  const selectionChars = selectionEntries.reduce((sum, entry) => sum + charCount(entry.item.content || entry.item.ddl), 0);
  const largestTables = tableEntries
    .map((entry) => ({
      contextKey: entry.contextKey,
      dbName: entry.item.dbName,
      tableName: entry.item.tableName,
      ddlChars: charCount(entry.item.ddl),
    }))
    .sort((left, right) => right.ddlChars - left.ddlChars)
    .slice(0, shouldIncludeDetails ? 8 : 3);

  const mcpSchemaChars = mcpTools.reduce((sum, tool) => (
    sum
    + charCount(tool.alias)
    + charCount(tool.description)
    + charCount(tool.inputSchema ? JSON.stringify(tool.inputSchema) : '')
  ), 0);
  const largestMCPTools = [...mcpTools]
    .map((tool) => ({
      alias: tool.alias,
      serverName: tool.serverName,
      schemaChars: charCount(tool.inputSchema ? JSON.stringify(tool.inputSchema) : ''),
    }))
    .sort((left, right) => right.schemaChars - left.schemaChars)
    .slice(0, shouldIncludeDetails ? 8 : 3);

  const enabledSkills = skills.filter((skill) => skill.enabled);
  const skillPromptChars = enabledSkills.reduce((sum, skill) => (
    sum + charCount(skill.name) + charCount(skill.description) + charCount(skill.systemPrompt)
  ), 0);
  const userPromptChars = userPromptSettings
    ? charCount(userPromptSettings.global)
      + charCount(userPromptSettings.database)
      + charCount(userPromptSettings.jvm)
      + charCount(userPromptSettings.jvmDiagnostic)
    : 0;

  const estimatedInputChars = messagePayloadChars + ddlChars + selectionChars + mcpSchemaChars + skillPromptChars + userPromptChars;
  const riskLevel = classifyRisk(estimatedInputChars);
  const warnings: string[] = [];
  const nextActions: string[] = [];

  if (!requestedSessionId || !session) {
    appendUnique(warnings, translateBudgetCopy(
      translate,
      'warning.missing_session',
      'The target AI session was not found, so message volume statistics only cover an empty window',
    ));
    appendUnique(nextActions, translateBudgetCopy(
      translate,
      'next_action.open_session',
      'Open or select the target AI session first, then call inspect_ai_context_budget again',
    ));
  }
  if (riskLevel === 'critical') {
    appendUnique(warnings, translateBudgetCopy(
      translate,
      'warning.critical_risk',
      'The current AI input context has reached critical volume and may cause slow replies, truncation, or ignored constraints',
    ));
  } else if (riskLevel === 'high') {
    appendUnique(warnings, translateBudgetCopy(
      translate,
      'warning.high_risk',
      'The current AI input context is large; narrow the context before complex questions',
    ));
  }
  if (ddlChars >= 60000 || contextEntries.length >= 30) {
    appendUnique(warnings, translateBudgetCopy(
      translate,
      'warning.large_schema_context',
      'Many table schemas or long DDL are mounted and may crowd out the user question and tool results',
    ));
    appendUnique(nextActions, translateBudgetCopy(
      translate,
      'next_action.narrow_tables',
      'Keep only tables relevant to this turn; if needed, use inspect_table_bundle to read target tables on demand',
    ));
  }
  if (messagePayloadChars >= 40000) {
    appendUnique(warnings, translateBudgetCopy(
      translate,
      'warning.large_messages',
      'Recent messages in this session are long and may affect the stability of later replies',
    ));
    appendUnique(nextActions, translateBudgetCopy(
      translate,
      'next_action.summarize_or_new_session',
      'Start a new session or ask AI to summarize the current conclusion before continuing the next complex task',
    ));
  }
  if (toolResultChars >= 20000) {
    appendUnique(warnings, translateBudgetCopy(
      translate,
      'warning.large_tool_results',
      'Recent tool results are long and may dilute later answers with logs or large result sets',
    ));
    appendUnique(nextActions, translateBudgetCopy(
      translate,
      'next_action.reduce_tool_results',
      'Reduce the returned volume from inspect_app_logs / inspect_recent_sql_logs / includeDDL / includeLogLines',
    ));
  }
  if (mcpTools.length >= 40 || mcpSchemaChars >= 30000) {
    appendUnique(warnings, translateBudgetCopy(
      translate,
      'warning.large_mcp_catalog',
      'Many MCP tools or schemas are exposed, which may make the model more likely to choose the wrong tool',
    ));
    appendUnique(nextActions, translateBudgetCopy(
      translate,
      'next_action.narrow_tools',
      'Temporarily disable unrelated MCP services, or call inspect_ai_tool_catalog by keyword first to narrow the tool route',
    ));
  }
  if (enabledSkills.length >= 8 || skillPromptChars >= 16000) {
    appendUnique(warnings, translateBudgetCopy(
      translate,
      'warning.large_skills',
      'Many Skills are enabled or prompts are long, which may stack conflicting constraints',
    ));
    appendUnique(nextActions, translateBudgetCopy(
      translate,
      'next_action.reduce_skills',
      'Keep only Skills relevant to this turn, then restore other Skills after finishing',
    ));
  }
  if (unresolvedToolCallIds.size > 0) {
    appendUnique(warnings, translateBudgetCopy(
      translate,
      'warning.unresolved_tool_calls',
      `The recent message window contains ${unresolvedToolCallIds.size} unclosed tool calls`,
      { count: unresolvedToolCallIds.size },
    ));
    appendUnique(nextActions, translateBudgetCopy(
      translate,
      'next_action.inspect_message_flow',
      'Call inspect_ai_message_flow first to confirm whether tool calls are missing tool result messages',
    ));
  }
  if (warnings.length === 0) {
    appendUnique(nextActions, translateBudgetCopy(
      translate,
      'next_action.continue_narrow_probe',
      'The current context volume is manageable; continue by calling narrower schema, log, or SQL risk probes for the specific question',
    ));
  }

  const largestMessages = inspectedMessages
    .map((message) => ({
      id: message.id,
      role: message.role,
      chars: getMessagePayloadChars(message),
      preview: shouldIncludeDetails ? previewText(message.content) : undefined,
    }))
    .sort((left, right) => right.chars - left.chars)
    .slice(0, shouldIncludeDetails ? 8 : 3);

  return {
    requestedSessionId: requestedSessionId || null,
    activeSessionId,
    foundSession: Boolean(session),
    title: session?.title || '',
    riskLevel,
    estimatedInputChars,
    estimatedInputTokens: estimateTokens(estimatedInputChars),
    messageWindow: {
      totalMessages: allMessages.length,
      inspectedMessages: inspectedMessages.length,
      limit: effectiveMessageLimit,
      roleCounts: messageRoleCounts,
      payloadChars: messagePayloadChars,
      thinkingChars,
      toolResultChars,
      unresolvedToolCallCount: unresolvedToolCallIds.size,
      largestMessages,
    },
    schemaContext: {
      contextCount: Object.keys(aiContexts).length,
      tableCount: tableEntries.length,
      selectionCount: selectionEntries.length,
      ddlChars,
      selectionChars,
      estimatedTokens: estimateTokens(ddlChars + selectionChars),
      largestTables,
    },
    toolCatalog: {
      mcpToolCount: mcpTools.length,
      mcpSchemaChars,
      estimatedTokens: estimateTokens(mcpSchemaChars),
      largestMCPTools,
    },
    promptsAndSkills: {
      userPromptChars,
      enabledSkillCount: enabledSkills.length,
      skillPromptChars,
      estimatedTokens: estimateTokens(userPromptChars + skillPromptChars),
      enabledSkillNames: enabledSkills.map((skill) => skill.name).slice(0, shouldIncludeDetails ? 20 : 8),
    },
    warnings,
    nextActions,
  };
};
