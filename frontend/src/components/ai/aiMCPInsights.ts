import type { AIMCPClientInstallStatus, AIMCPServerConfig, AIMCPToolDescriptor } from '../../types';
import { isMCPClientConnected } from '../../utils/mcpClientInstallStatus';
import { validateMCPServerDraft } from '../../utils/mcpServerValidation';
import type { AIInspectionTranslator } from './aiInspectionI18n';
import { translateInspectionCopy } from './aiInspectionI18n';

const SERVER_TOOL_PREVIEW_LIMIT = 20;

const quoteCommandPart = (value: string): string => {
  const text = String(value || '').trim();
  if (!text) {
    return '';
  }
  return /[\s"]/u.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text;
};

const formatLaunchPreview = (command?: string, args?: string[]): string =>
  [String(command || '').trim(), ...(Array.isArray(args) ? args : [])]
    .map((item) => quoteCommandPart(String(item || '').trim()))
    .filter(Boolean)
    .join(' ');

const sortByName = <T extends { name?: string }>(items: T[]): T[] =>
  items.slice().sort((left, right) => String(left.name || '').localeCompare(String(right.name || '')));

export const buildMCPSetupSnapshot = (params: {
  mcpServers?: AIMCPServerConfig[];
  mcpClientStatuses?: AIMCPClientInstallStatus[];
  mcpTools?: AIMCPToolDescriptor[];
  translate?: AIInspectionTranslator;
}) => {
  const {
    mcpServers = [],
    mcpClientStatuses = [],
    mcpTools = [],
    translate,
  } = params;

  const normalizedServers = sortByName(
    (Array.isArray(mcpServers) ? mcpServers : []).map((server) => {
      const serverTools = mcpTools
        .filter((tool) => tool.serverId === server.id)
        .map((tool) => ({
          alias: tool.alias,
          title: tool.title || tool.originalName || tool.alias,
        }));
      const validation = validateMCPServerDraft(server);
      return {
        id: server.id,
        name: server.name,
        transport: server.transport,
        enabled: server.enabled !== false,
        timeoutSeconds: server.timeoutSeconds,
        command: server.command,
        args: Array.isArray(server.args) ? server.args : [],
        launchCommandPreview: formatLaunchPreview(server.command, server.args),
        envKeys: Object.keys(server.env || {}).sort(),
        envVarCount: Object.keys(server.env || {}).length,
        discoveredToolCount: serverTools.length,
        discoveredTools: serverTools.slice(0, SERVER_TOOL_PREVIEW_LIMIT),
        discoveredToolsTruncated: serverTools.length > SERVER_TOOL_PREVIEW_LIMIT,
        configurationIssueCount: validation.issues.length,
        configurationErrorCount: validation.errorCount,
        configurationWarningCount: validation.warningCount,
        configurationCanTest: validation.canTest,
        configurationIssues: validation.issues,
      };
    }),
  );

  const normalizedClientStatuses = (Array.isArray(mcpClientStatuses) ? mcpClientStatuses : [])
    .map((status) => ({
      client: status.client,
      displayName: status.displayName,
      installMode: status.installMode || 'auto',
      installed: status.installed,
      matchesCurrent: isMCPClientConnected(status),
      clientDetected: status.clientDetected === true,
      clientCommand: status.clientCommand || '',
      clientPath: status.clientPath || '',
      configPath: status.configPath || '',
      launchCommandPreview: formatLaunchPreview(status.command, status.args),
      message: status.message || '',
    }))
    .sort((left, right) => left.displayName.localeCompare(right.displayName));

  const enabledServerCount = normalizedServers.filter((server) => server.enabled).length;
  const installedClientCount = normalizedClientStatuses.filter((item) => item.installed).length;
  const currentClientCount = normalizedClientStatuses.filter((item) => item.matchesCurrent).length;
  const serversWithConfigurationErrors = normalizedServers.filter((server) => server.configurationErrorCount > 0).length;
  const serversWithConfigurationWarnings = normalizedServers.filter((server) => server.configurationWarningCount > 0).length;
  const serverConfigurationIssueCount = normalizedServers
    .reduce((total, server) => total + server.configurationIssueCount, 0);
  const enabledServersWithConfigurationIssues = normalizedServers
    .filter((server) => server.enabled && server.configurationIssueCount > 0)
    .length;
  const warnings: string[] = [];
  const nextActions: string[] = [];

  if (serversWithConfigurationErrors > 0) {
    warnings.push(translateInspectionCopy(
      translate,
      'ai_chat.inspection.mcp.warning.config_errors',
      `${serversWithConfigurationErrors} MCP server has launch configuration errors; testing and tool discovery may fail`,
      { count: serversWithConfigurationErrors },
    ));
    nextActions.push(translateInspectionCopy(
      translate,
      'ai_chat.inspection.mcp.next_action.fix_config_errors',
      'Fix the MCP server configuration errors first, then test the server again',
    ));
  } else if (serversWithConfigurationWarnings > 0) {
    warnings.push(translateInspectionCopy(
      translate,
      'ai_chat.inspection.mcp.warning.config_warnings',
      `${serversWithConfigurationWarnings} MCP server has launch configuration warnings; confirm them before diagnosing tool discovery failures`,
      { count: serversWithConfigurationWarnings },
    ));
    nextActions.push(translateInspectionCopy(
      translate,
      'ai_chat.inspection.mcp.next_action.fix_config_warnings',
      'Open the affected MCP server and split launch command, arguments, and timeout according to the configuration check hints',
    ));
  }

  return {
    serverCount: normalizedServers.length,
    enabledServerCount,
    disabledServerCount: normalizedServers.length - enabledServerCount,
    discoveredMCPToolCount: Array.isArray(mcpTools) ? mcpTools.length : 0,
    serverConfigurationIssueCount,
    serversWithConfigurationErrors,
    serversWithConfigurationWarnings,
    enabledServersWithConfigurationIssues,
    servers: normalizedServers,
    clientInstallCount: normalizedClientStatuses.length,
    installedClientCount,
    currentClientCount,
    detectedClientCount: normalizedClientStatuses.filter((item) => item.clientDetected).length,
    clients: normalizedClientStatuses,
    warnings,
    nextActions,
    message: normalizedServers.length > 0
      ? serverConfigurationIssueCount > 0
        ? translateInspectionCopy(
          translate,
          'ai_chat.inspection.mcp.message.with_issues',
          `${normalizedServers.length} MCP server is configured; ${enabledServerCount} enabled; ${serverConfigurationIssueCount} configuration checks need attention`,
          { serverCount: normalizedServers.length, enabledCount: enabledServerCount, issueCount: serverConfigurationIssueCount },
        )
        : translateInspectionCopy(
          translate,
          'ai_chat.inspection.mcp.message.configured',
          `${normalizedServers.length} MCP server is configured; ${enabledServerCount} enabled`,
          { serverCount: normalizedServers.length, enabledCount: enabledServerCount },
        )
      : translateInspectionCopy(
        translate,
        'ai_chat.inspection.mcp.message.empty',
        'No MCP servers are configured yet',
      ),
  };
};
