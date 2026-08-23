import type { AIMCPClientInstallStatus } from '../types';
import { t as catalogTranslate } from '../i18n/catalog';
import { SUPPORTED_LANGUAGES } from '../i18n/resolveLanguage';
import type { I18nParams } from '../i18n/types';

export type MCPClientKey =
  | 'claude-code'
  | 'codex'
  | 'opencode'
  | 'zcode'
  | 'deepseek-harness'
  | 'kimi'
  | 'grok-build'
  | 'openclaw'
  | 'hermans';

const AUTO_MCP_CLIENTS = new Set<MCPClientKey>([
  'claude-code',
  'codex',
  'opencode',
  'zcode',
  'deepseek-harness',
  'kimi',
  'grok-build',
]);
const REMOTE_MCP_CLIENTS = new Set<MCPClientKey>(['openclaw', 'hermans']);
const DEFAULT_REMOTE_MCP_PUBLIC_URL = 'https://<your-domain-or-tunnel>/mcp';
const DEFAULT_REMOTE_MCP_LOCAL_ADDR = '127.0.0.1:8765';
const DEFAULT_REMOTE_MCP_PATH = '/mcp';
type MCPClientInstallTranslator = (key: string, params?: I18nParams) => string;

const defaultTranslate: MCPClientInstallTranslator = (key, params) => catalogTranslate('en-US', key, params);

const MCP_CLIENT_STATUS_ERROR_TEMPLATE_KEYS = [
  'ai.service.mcp_client.claude_code.config_path_failed',
  'ai.service.mcp_client.codex.config_path_failed',
  'ai.service.mcp_client.executable_path_failed',
  'ai.service.mcp_client.executable_path_empty',
  'ai.service.mcp_client.claude_code.config_format_invalid',
  'ai.service.mcp_client.codex.config_format_invalid',
  'ai.service.mcp_client.claude_code.config_read_failed',
  'ai.service.mcp_client.claude_code.config_parse_failed',
  'ai.service.mcp_client.claude_code.config_serialize_failed',
  'ai.service.mcp_client.claude_code.config_dir_create_failed',
  'ai.service.mcp_client.claude_code.config_write_failed',
  'ai.service.mcp_client.codex.config_read_failed',
  'ai.service.mcp_client.codex.config_dir_create_failed',
  'ai.service.mcp_client.codex.config_write_failed',
  'ai.service.mcp_client.opencode.config_path_failed',
  'ai.service.mcp_client.opencode.config_format_invalid',
  'ai.service.mcp_client.opencode.config_read_failed',
  'ai.service.mcp_client.opencode.config_parse_failed',
  'ai.service.mcp_client.opencode.config_serialize_failed',
  'ai.service.mcp_client.opencode.config_dir_create_failed',
  'ai.service.mcp_client.opencode.config_write_failed',
  'ai.service.mcp_client.external.config_path_failed',
  'ai.service.mcp_client.external.config_format_invalid',
  'ai.service.mcp_client.external.config_read_failed',
  'ai.service.mcp_client.external.config_parse_failed',
  'ai.service.mcp_client.external.config_serialize_failed',
  'ai.service.mcp_client.external.config_dir_create_failed',
  'ai.service.mcp_client.external.config_write_failed',
  'ai.service.mcp_client.claude_code.status.path_check_failed',
  'ai.service.mcp_client.codex.status.path_check_failed',
  'ai.service.mcp_client.opencode.status.path_check_failed',
  'ai.service.mcp_client.external.status.path_check_failed',
] as const;

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const buildCatalogTemplatePattern = (template: string): RegExp | null => {
  const normalized = String(template || '').trim();
  if (!normalized) {
    return null;
  }
  const source = normalized
    .split(/(\{\{[^}]+\}\})/u)
    .filter(Boolean)
    .map((segment) => (segment.startsWith('{{') && segment.endsWith('}}') ? '(.+?)' : escapeRegExp(segment)))
    .join('');
  return source ? new RegExp(`^${source}$`, 'u') : null;
};

const MCP_CLIENT_STATUS_ERROR_PATTERNS: RegExp[] = Array.from(new Set(
  SUPPORTED_LANGUAGES.flatMap((language) => (
    MCP_CLIENT_STATUS_ERROR_TEMPLATE_KEYS.map((key) => catalogTranslate(language, key))
  )),
))
  .map((template) => buildCatalogTemplatePattern(template))
  .filter((pattern): pattern is RegExp => Boolean(pattern));

const translateMCPClientCopy = (
  translate: MCPClientInstallTranslator,
  key: string,
  fallback: string,
  params?: I18nParams,
): string => {
  const translated = translate(key, params);
  return translated && translated !== key ? translated : fallback;
};

export interface RemoteMCPClientQuickStart {
  displayName: string;
  configJson: string;
  configCommand: string;
  launchCommand: string;
  standaloneCommand: string;
  verificationSteps: string[];
  securityNotes: string[];
}

export interface RemoteMCPParameterGuide {
  key: string;
  title: string;
  required: boolean;
  fill: string;
  example: string;
  avoid: string;
}

const REMOTE_MCP_PARAMETER_GUIDE_DEFS: Array<Pick<RemoteMCPParameterGuide, 'key' | 'required' | 'example'>> = [
  {
    key: 'publicUrl',
    required: true,
    example: 'https://agent-gateway.example.com/mcp',
  },
  {
    key: 'bearerToken',
    required: true,
    example: 'Authorization: Bearer gnv_xxx',
  },
  {
    key: 'localAddr',
    required: true,
    example: DEFAULT_REMOTE_MCP_LOCAL_ADDR,
  },
  {
    key: 'path',
    required: true,
    example: DEFAULT_REMOTE_MCP_PATH,
  },
  {
    key: 'serverId',
    required: false,
    example: 'gonavi',
  },
];

const REMOTE_MCP_PARAMETER_KEY_MAP: Record<string, string> = {
  publicUrl: 'public_url',
  bearerToken: 'bearer_token',
  localAddr: 'local_addr',
  path: 'path',
  serverId: 'server_id',
};

export const buildRemoteMCPParameterGuides = (
  translate: MCPClientInstallTranslator = defaultTranslate,
): RemoteMCPParameterGuide[] =>
  REMOTE_MCP_PARAMETER_GUIDE_DEFS.map((item) => {
    const key = REMOTE_MCP_PARAMETER_KEY_MAP[item.key] || item.key;
    return {
      ...item,
      title: translate(`ai_settings.mcp_server.remote_quick_start.parameter.${key}.title`),
      fill: translate(`ai_settings.mcp_server.remote_quick_start.parameter.${key}.fill`),
      avoid: translate(`ai_settings.mcp_server.remote_quick_start.parameter.${key}.avoid`),
    };
  });

export const REMOTE_MCP_PARAMETER_GUIDES: RemoteMCPParameterGuide[] = buildRemoteMCPParameterGuides();

export const EMPTY_MCP_CLIENT_STATUSES: AIMCPClientInstallStatus[] = [
  {
    client: 'claude-code',
    displayName: 'Claude Code',
    installMode: 'auto',
    installed: false,
    matchesCurrent: false,
    clientDetected: false,
    clientCommand: 'claude',
    message: 'No Claude Code user-level GoNavi MCP configuration was detected',
  },
  {
    client: 'codex',
    displayName: 'Codex',
    installMode: 'auto',
    installed: false,
    matchesCurrent: false,
    clientDetected: false,
    clientCommand: 'codex',
    message: 'No Codex user-level GoNavi MCP configuration was detected',
  },
  {
    client: 'opencode',
    displayName: 'OpenCode',
    installMode: 'auto',
    installed: false,
    matchesCurrent: false,
    clientDetected: false,
    clientCommand: 'opencode',
    message: 'No OpenCode user-level GoNavi MCP configuration was detected',
  },
  {
    client: 'zcode',
    displayName: 'ZCode',
    installMode: 'auto',
    installed: false,
    matchesCurrent: false,
    clientDetected: false,
    clientCommand: 'zcode',
    message: 'No ZCode user-level GoNavi MCP configuration was detected',
  },
  {
    client: 'deepseek-harness',
    displayName: 'DeepSeek Harness',
    installMode: 'auto',
    installed: false,
    matchesCurrent: false,
    clientDetected: false,
    clientCommand: 'dsh',
    message: 'No DeepSeek Harness user-level GoNavi MCP configuration was detected',
  },
  {
    client: 'kimi',
    displayName: 'Kimi Code',
    installMode: 'auto',
    installed: false,
    matchesCurrent: false,
    clientDetected: false,
    clientCommand: 'kimi',
    message: 'No Kimi Code user-level GoNavi MCP configuration was detected',
  },
  {
    client: 'grok-build',
    displayName: 'Grok Build',
    installMode: 'auto',
    installed: false,
    matchesCurrent: false,
    clientDetected: false,
    clientCommand: 'grok',
    message: 'No Grok Build user-level GoNavi MCP configuration was detected',
  },
  {
    client: 'openclaw',
    displayName: 'OpenClaw',
    installMode: 'remote',
    installed: false,
    matchesCurrent: false,
    clientDetected: false,
    clientCommand: 'openclaw',
    message: 'OpenClaw usually runs on cloud Linux; use a remote MCP bridge to reach Windows GoNavi and do not copy database passwords.',
  },
  {
    client: 'hermans',
    displayName: 'Hermans',
    installMode: 'remote',
    installed: false,
    matchesCurrent: false,
    clientDetected: false,
    clientCommand: 'hermans',
    message: 'Remote Agents such as Hermans should use a remote MCP bridge to reach Windows GoNavi and should not copy database passwords.',
  },
];

const MCP_CLIENT_ORDER: MCPClientKey[] = [
  'claude-code',
  'codex',
  'opencode',
  'zcode',
  'deepseek-harness',
  'kimi',
  'grok-build',
  'openclaw',
  'hermans',
];

const quoteMCPCommandPart = (value: string): string => {
  const text = String(value || '').trim();
  if (!text) {
    return '';
  }
  return /[\s"]/u.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text;
};

export const isMCPClientKey = (client: string): client is MCPClientKey =>
  client === 'claude-code' ||
  client === 'codex' ||
  client === 'opencode' ||
  client === 'zcode' ||
  client === 'deepseek-harness' ||
  client === 'kimi' ||
  client === 'grok-build' ||
  client === 'openclaw' ||
  client === 'hermans';

export const isRemoteMCPClientStatus = (status?: Pick<AIMCPClientInstallStatus, 'client' | 'installMode'> | null): boolean => {
  const client = String(status?.client || '').trim();
  return status?.installMode === 'remote' || (isMCPClientKey(client) && REMOTE_MCP_CLIENTS.has(client));
};

export const supportsAutoMCPClientInstall = (status?: Pick<AIMCPClientInstallStatus, 'client' | 'installMode'> | null): boolean => {
  const client = String(status?.client || '').trim();
  return status?.installMode === 'auto' || (isMCPClientKey(client) && AUTO_MCP_CLIENTS.has(client));
};

export const isLocalMCPClientUnavailable = (
  status?: Pick<AIMCPClientInstallStatus, 'client' | 'installMode' | 'clientDetected'> | null,
): boolean => supportsAutoMCPClientInstall(status) && status?.clientDetected !== true;

export const isMCPClientConnected = (
  status?: Pick<AIMCPClientInstallStatus, 'client' | 'installMode' | 'clientDetected' | 'matchesCurrent'> | null,
): boolean => status?.matchesCurrent === true && !isLocalMCPClientUnavailable(status);

const hasStatusError = (status: AIMCPClientInstallStatus): boolean =>
  MCP_CLIENT_STATUS_ERROR_PATTERNS.some((pattern) => pattern.test(String(status.message || '').trim()));

const getMCPClientPriority = (status: AIMCPClientInstallStatus): number => {
  if (isMCPClientConnected(status)) {
    return 0;
  }
  if (isLocalMCPClientUnavailable(status)) {
    return 5;
  }
  if (status.installed && !status.matchesCurrent) {
    return 1;
  }
  if (status.clientDetected) {
    return 2;
  }
  if (hasStatusError(status)) {
    return 3;
  }
  return 4;
};

export const normalizeMCPClientStatuses = (items?: AIMCPClientInstallStatus[]): AIMCPClientInstallStatus[] => {
  const baseMap = new Map<string, AIMCPClientInstallStatus>(
    EMPTY_MCP_CLIENT_STATUSES.map((item) => [item.client, { ...item }]),
  );
  (Array.isArray(items) ? items : []).forEach((item) => {
    if (!item || !item.client) {
      return;
    }
    const base = baseMap.get(item.client) || {
      client: item.client,
      displayName: item.client,
      installed: false,
      matchesCurrent: false,
      message: '',
    };
    baseMap.set(item.client, {
      ...base,
      ...item,
      displayName: item.displayName || base.displayName,
      installMode: item.installMode || base.installMode || 'auto',
      clientDetected: item.clientDetected ?? base.clientDetected ?? false,
      clientCommand: item.clientCommand || base.clientCommand,
      clientPath: item.clientPath || '',
      message: item.message || base.message,
      args: Array.isArray(item.args) ? item.args : (base.args || []),
    });
  });
  return MCP_CLIENT_ORDER
    .map((client) => baseMap.get(client))
    .filter((item): item is AIMCPClientInstallStatus => Boolean(item));
};

export const pickPreferredMCPClient = (
  items: AIMCPClientInstallStatus[],
  current?: MCPClientKey,
): MCPClientKey => {
  if (current && items.some((item) => item.client === current)) {
    return current;
  }

  const ranked = items
    .filter((item): item is AIMCPClientInstallStatus & { client: MCPClientKey } => isMCPClientKey(item.client))
    .slice()
    .sort((left, right) => {
      const priorityDiff = getMCPClientPriority(left) - getMCPClientPriority(right);
      if (priorityDiff !== 0) {
        return priorityDiff;
      }
      return MCP_CLIENT_ORDER.indexOf(left.client) - MCP_CLIENT_ORDER.indexOf(right.client);
    });

  return ranked[0]?.client || 'claude-code';
};

export const formatMCPLaunchCommand = (
  input?: Pick<AIMCPClientInstallStatus, 'command' | 'args'> | { command?: string; args?: string[] } | null,
): string => {
  const command = String(input?.command || '').trim();
  if (!command) {
    return '';
  }
  const args = Array.isArray(input?.args)
    ? input.args.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  return [command, ...args].map(quoteMCPCommandPart).filter(Boolean).join(' ');
};

export const buildRemoteMCPClientGuide = (
  status?: Partial<Pick<AIMCPClientInstallStatus, 'client' | 'displayName' | 'message'>> | null,
  translate: MCPClientInstallTranslator = defaultTranslate,
): string => {
  const quickStart = buildRemoteMCPClientQuickStart(status, translate);
  const standaloneWithoutToken = quickStart.standaloneCommand.replace(` --token <random-token>`, '');
  return [
    translateMCPClientCopy(
      translate,
      'ai_settings.mcp_server.remote_quick_start.guide.title',
      'GoNavi MCP remote access guide - {{displayName}}',
      { displayName: quickStart.displayName },
    ),
    '',
    translateMCPClientCopy(
      translate,
      'ai_settings.mcp_server.remote_quick_start.guide.goal_heading',
      'Goal:',
    ),
    `- ${translateMCPClientCopy(
      translate,
      'ai_settings.mcp_server.remote_quick_start.guide.goal.credentials_stay_local',
      'Database connections, accounts, and passwords stay in Windows GoNavi. The cloud Agent does not need to store database passwords.',
    )}`,
    `- ${translateMCPClientCopy(
      translate,
      'ai_settings.mcp_server.remote_quick_start.guide.goal.tools_only',
      'The cloud Agent only reads get_connections/get_databases/get_objects/get_tables/get_views/get_columns/get_table_ddl results through MCP tools.',
    )}`,
    `- ${translateMCPClientCopy(
      translate,
      'ai_settings.mcp_server.remote_quick_start.guide.goal.schema_only',
      'Remote access uses schema-only mode by default and does not register execute_sql, suitable for giving OpenClaw/Hermans schema-structure access only.',
    )}`,
    '',
    translateMCPClientCopy(
      translate,
      'ai_settings.mcp_server.remote_quick_start.guide.boundary_heading',
      'Current boundary:',
    ),
    `- ${translateMCPClientCopy(
      translate,
      'ai_settings.mcp_server.remote_quick_start.guide.boundary.local_stdio',
      'The built-in local GoNavi MCP entry is stdio, suitable for clients such as Claude Code / Codex / OpenCode / ZCode / DeepSeek Harness / Kimi Code / Grok Build running on the same machine as GoNavi.',
    )}`,
    `- ${translateMCPClientCopy(
      translate,
      'ai_settings.mcp_server.remote_quick_start.guide.boundary.remote_cloud',
      'If OpenClaw/Hermans runs on cloud Linux, it cannot use the Windows local stdio command directly; start GoNavi Streamable HTTP mode on Windows, then let the cloud Agent call it through a tunnel or reverse proxy.',
    )}`,
    '',
    translateMCPClientCopy(
      translate,
      'ai_settings.mcp_server.remote_quick_start.guide.access_heading',
      'Recommended access method:',
    ),
    translateMCPClientCopy(
      translate,
      'ai_settings.mcp_server.remote_quick_start.guide.step.keep_windows_accessible',
      '1. Keep GoNavi reachable on Windows, and let GoNavi read saved connections and system credentials.',
    ),
    translateMCPClientCopy(
      translate,
      'ai_settings.mcp_server.remote_quick_start.guide.step.run_command',
      '2. Run this on Windows or the trusted intranet side: {{launchCommand}}.',
      { launchCommand: quickStart.launchCommand },
    ),
    translateMCPClientCopy(
      translate,
      'ai_settings.mcp_server.remote_quick_start.guide.step.configure_remote_server',
      '3. Add a remote MCP Server in {{displayName}}, choose Streamable HTTP transport, set the URL to the tunneled/reverse-proxied /mcp address, and set Authorization: Bearer <random-token>.',
      { displayName: quickStart.displayName },
    ),
    translateMCPClientCopy(
      translate,
      'ai_settings.mcp_server.remote_quick_start.guide.step.inspect_schema',
      '4. Call get_connections first to obtain connectionId, then call schema tools; do not write database host/user/password into the cloud Agent config.',
    ),
    '',
    translateMCPClientCopy(
      translate,
      'ai_settings.mcp_server.remote_quick_start.guide.config_heading',
      'Copyable config snippet (for Agents that support mcpServers JSON):',
    ),
    ...quickStart.configJson.split('\n'),
    '',
    translateMCPClientCopy(
      translate,
      'ai_settings.mcp_server.remote_quick_start.guide.config_command_heading',
      'No GUI / CLI config generation command:',
    ),
    quickStart.configCommand,
    '',
    translateMCPClientCopy(
      translate,
      'ai_settings.mcp_server.remote_quick_start.guide.launch_command_heading',
      'CLI / service launch command:',
    ),
    quickStart.launchCommand,
    translateMCPClientCopy(
      translate,
      'ai_settings.mcp_server.remote_quick_start.guide.env_fallback',
      'Or set environment variable GONAVI_MCP_HTTP_TOKEN=<random-token>, then run {{standaloneCommand}}',
      { standaloneCommand: standaloneWithoutToken },
    ),
    translateMCPClientCopy(
      translate,
      'ai_settings.mcp_server.remote_quick_start.guide.execute_sql_note',
      'If remote SQL execution is explicitly required, remove --schema-only; execute_sql remains constrained by GoNavi AI safety controls, and writes must explicitly pass allowMutating=true.',
    ),
    '',
    status?.message
      ? translateMCPClientCopy(
          translate,
          'ai_settings.mcp_server.remote_quick_start.guide.current_hint',
          'Current hint: {{message}}',
          { message: status.message },
        )
      : '',
  ].filter((line, index, lines) => line || index < lines.length - 1).join('\n');
};

export const buildRemoteMCPClientQuickStart = (
  status?: Partial<Pick<AIMCPClientInstallStatus, 'client' | 'displayName'>> | null,
  translate: MCPClientInstallTranslator = defaultTranslate,
): RemoteMCPClientQuickStart => {
  const displayName = String(status?.displayName || translate('ai_settings.mcp_server.remote_quick_start.default_agent_name')).trim();
  const client = isMCPClientKey(String(status?.client || '')) ? String(status?.client || '').trim() : 'openclaw';
  const launchCommand = `GoNavi.exe mcp-server http --addr ${DEFAULT_REMOTE_MCP_LOCAL_ADDR} --path ${DEFAULT_REMOTE_MCP_PATH} --token <random-token> --schema-only`;
  const standaloneCommand = `gonavi-mcp-server http --addr ${DEFAULT_REMOTE_MCP_LOCAL_ADDR} --path ${DEFAULT_REMOTE_MCP_PATH} --token <random-token> --schema-only`;
  const configCommand = `GoNavi.exe mcp-server remote-config --client ${client} --url ${DEFAULT_REMOTE_MCP_PUBLIC_URL} --token <random-token> --schema-only`;
  const configJson = JSON.stringify({
    mcpServers: {
      gonavi: {
        type: 'streamable-http',
        url: DEFAULT_REMOTE_MCP_PUBLIC_URL,
        headers: {
          Authorization: 'Bearer <random-token>',
        },
      },
    },
  }, null, 2);

  return {
    displayName,
    configJson,
    configCommand,
    launchCommand,
    standaloneCommand,
    verificationSteps: [
      translate('ai_settings.mcp_server.remote_quick_start.verification.healthz'),
      translate('ai_settings.mcp_server.remote_quick_start.verification.configure_agent', { displayName }),
      translate('ai_settings.mcp_server.remote_quick_start.verification.inspect_schema'),
    ],
    securityNotes: [
      translate('ai_settings.mcp_server.remote_quick_start.security.credentials_stay_local'),
      translate('ai_settings.mcp_server.remote_quick_start.security.schema_only'),
      translate('ai_settings.mcp_server.remote_quick_start.security.token_required'),
      translate('ai_settings.mcp_server.remote_quick_start.security.execute_sql'),
    ],
  };
};
