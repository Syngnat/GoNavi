import {
  defineSettingsCenterPageEntries as page,
  type SettingsCenterSearchEntry,
} from '../settingsCenterSearchEntries';

/**
 * Page copy that is not a control label: descriptions, hints, notes, option and
 * theme names. Keeps search useful for people who remember what a page says
 * rather than what its setting is called. Control labels live in the sibling
 * files; each key here is the text the page renders, so opening a hit scrolls
 * to and flashes that text. Skip state-dependent text (empty states, loading,
 * errors) and generic words ("全部", "刷新") that would match everywhere.
 */

const THEME_PRESETS = [
  'warm_paper', 'mist_jade', 'cloud_apricot', 'celadon_breeze',
  'lilac_bloom', 'sakura_haze', 'silver_frost', 'sea_foam',
] as const;

const TAB_DISPLAY_ELEMENTS = ['connection', 'database', 'schema', 'host', 'group'] as const;

const SNIPPET_IDS = [
  'alt', 'ct', 'ctt', 'del', 'dro', 'grp', 'ins', 'inst', 'lim', 'ljo', 'ord', 'sel', 'seld', 'selj', 'selw', 'sub', 'upd',
] as const;

const BUILTIN_TOOL_FLOWS = [
  'locate_table_fields', 'field_lookup_table', 'deep_structure', 'table_snapshot', 'database_overview',
  'app_health_overview', 'support_bundle', 'choose_tool_route', 'ai_setup_health', 'ai_runtime',
  'safety_boundary', 'providers_models', 'chat_readiness', 'upstream_request', 'mcp_setup',
  'remote_agent_mcp', 'mcp_authoring', 'docker_mcp', 'mcp_tool_parameters', 'prompts_skills', 'ai_context',
  'current_connection', 'connection_capabilities', 'saved_connections', 'redis_topology',
  'external_sql_dirs', 'external_sql_file', 'active_tab', 'workspace_tabs', 'shortcuts',
  'recent_sql_logs', 'recent_sql_activity', 'sql_editor_transaction', 'sql_risk', 'app_logs',
  'connection_failures', 'render_error', 'message_flow', 'context_budget', 'codebase_hotspots',
  'saved_queries', 'ai_sessions', 'sql_snippets', 'sample_data', 'readonly_validation',
] as const;

export const CONTENT_SEARCH_ENTRIES: ReadonlyArray<SettingsCenterSearchEntry> = [
  // 偏好设置
  ...page('preferences', 'language', [
    'settings.language.restart_hint',
  ]),
  ...page('preferences', 'theme-theme', [
    'app.theme.custom.list_label',
    'app.theme.custom.preset.title',
    'app.theme.custom.preset.description',
    ...THEME_PRESETS.flatMap((preset) => [
      `app.theme.custom.preset.${preset}.name`,
      `app.theme.custom.preset.${preset}.description`,
    ]),
    'app.theme.custom.my_themes_title',
    'app.theme.custom.description',
    'app.theme.custom.action.download_template',
    'app.theme.custom.action.upload',
    'app.theme.toolbar_buttons.kind.label',
    'app.theme.toolbar_buttons.kind.button',
    'app.theme.toolbar_buttons.kind.primary',
    'app.theme.toolbar_buttons.state.hover',
    'app.theme.toolbar_buttons.state.active',
    'app.theme.toolbar_buttons.preview',
    'app.theme.toolbar_buttons.preview.hint',
    'app.theme.toolbar_buttons.token.fg',
    'app.theme.toolbar_buttons.token.bg',
    'app.theme.toolbar_buttons.token.border',
    'app.theme.toolbar_buttons.precedence_hint',
    'app.theme.titlebar_actions_placement.toolbar',
    'app.theme.titlebar_actions_placement.titlebar',
    'app.theme.titlebar_actions_placement.display_title',
    'app.theme.titlebar_actions_placement.display_hint',
    'app.theme.titlebar_actions_placement.display.text',
    'app.theme.titlebar_actions_placement.display.icon',
    'app.theme.titlebar_actions_placement.display.icon_text',
  ]),
  ...page('preferences', 'theme-workspace', [
    'app.theme.query_template.hint',
    'app.theme.tab_display.row.primary',
    'app.theme.tab_display.row.secondary',
    'app.theme.tab_display.element.object.label',
    'app.theme.tab_display.element.object.description',
    'app.theme.tab_display.element.kind.label',
    'app.theme.tab_display.element.kind.description',
    ...TAB_DISPLAY_ELEMENTS.map((element) => `app.theme.tab_display.element.${element}.description`),
    'app.theme.tab_display.element.schema.label',
    'app.theme.tab_display.element.host.label',
    'app.theme.tab_display.preview.prefix',
    'app.theme.data_table.table_double_click_action.open_data',
    'app.theme.data_table.table_double_click_action.open_design',
    'app.theme.data_table.query_ctrl_click_action.locate',
    'app.theme.data_table.density.comfortable',
    'app.theme.data_table.follow_global',
  ]),

  // 服务配置
  ...page('services', 'proxy', [
    'app.proxy.preset.clash_mixed',
    'app.proxy.preset.socks5_local',
    'app.proxy.preset.http_local',
    'app.proxy.test.preset.github_api',
    'app.proxy.scope_hint',
  ]),
  ...page('services', 'download-source', [
    'app.download_source.description',
    'app.download_source.fallback_hint',
  ]),
  ...page('services', 'web-auth', [
    'app.settings.web_auth.password.description',
  ]),
  ...page('services', 'cloud-backup', [
    'app.cloud_backup.description',
    'app.cloud_backup.category.connections',
    'app.cloud_backup.category.saved_queries',
    'app.cloud_backup.category.ai_settings',
    'app.cloud_backup.category.daily_secrets',
    'app.cloud_backup.category.update_settings',
    'app.cloud_backup.provider.webdav',
    'app.cloud_backup.provider.s3',
    'app.cloud_backup.provider.webdav_hint',
    'app.cloud_backup.secret_hint',
    'app.cloud_backup.schedule.manual',
  ]),

  // AI 设置
  ...page('services', 'ai-providers', [
    'ai_settings.provider.choose_configuration',
  ]),
  ...page('services', 'ai-analysis', [
    'ai_settings.analysis.metric.success_rate',
    'ai_settings.analysis.metric.p95_latency',
    'ai_settings.analysis.trend.hint',
    'ai_settings.analysis.outcomes.hint',
    'ai_settings.analysis.outcomes.active',
    'ai_settings.analysis.outcomes.other',
    'ai_settings.analysis.outcomes.reserved',
    'ai_settings.analysis.outcomes.budget',
    'ai_settings.analysis.outcomes.retried',
    'ai_settings.analysis.efficiency.hint',
    'ai_settings.analysis.models.hint',
    'ai_settings.analysis.latency.hint',
    'ai_settings.analysis.latency.average',
    'ai_settings.analysis.latency.p50',
    'ai_settings.analysis.latency.samples',
    'ai_settings.analysis.distribution.hint',
    'ai_settings.analysis.heatmap.hint',
  ]),
  ...page('services', 'ai-request_events', [
    'ai_settings.request_events.column.attempt',
  ]),
  ...page('services', 'ai-safety', [
    'ai_settings.safety.description',
  ]),
  ...page('services', 'ai-context', [
    'ai_settings.open_mode.title',
    'ai_settings.open_mode.description',
    'ai_settings.open_mode.dock.label',
    'ai_settings.open_mode.dock.desc',
    'ai_settings.open_mode.detached.desc',
    'ai_settings.context.description',
  ]),
  ...page('services', 'ai-mcp', [
    'ai_settings.mcp_section.tab.external_clients',
    'ai_settings.mcp_section.tab.tool_sources',
    'ai_settings.mcp_http.panel.mode.limited_query',
    'ai_settings.mcp_http.panel.details_summary',
    'ai_settings.mcp_http.panel.description',
    'ai_chat.mcp_client.install.intro.title',
    'ai_chat.mcp_client.install.intro.description',
    'ai_chat.mcp_client.install.guide_summary',
    'ai_chat.mcp_client.install.selector.title',
    'ai_chat.mcp_client.install.selector.description',
    'ai_chat.mcp_client.install.selector.choice_title',
    'ai_chat.mcp_client.install.selector.step.target.title',
    'ai_chat.mcp_client.install.selector.step.target.detail',
    'ai_chat.mcp_client.install.selector.step.write.title',
    'ai_chat.mcp_client.install.selector.step.write.detail',
    'ai_chat.mcp_client.install.selector.step.restart.title',
    'ai_chat.mcp_client.install.selector.step.restart.detail',
    'ai_chat.mcp_client.install.status.title',
    'ai_chat.mcp_client.install.status.details_summary',
    'ai_chat.mcp_client.install.repeat_avoidance',
  ]),
  ...page('services', 'ai-skills', [
    'ai_settings.skill.description',
    'ai_settings.skill.hint',
  ]),
  ...page('services', 'ai-tools', [
    'ai_settings.tools.description',
    'ai_settings.tools.view.flows',
    ...BUILTIN_TOOL_FLOWS.map((flow) => `ai_chat.builtin_tools.flows.${flow}.title`),
  ]),
  ...page('services', 'ai-prompts', [
    'ai_settings.prompts.builtin.description',
  ]),

  // 连接与配置
  ...page('config', 'import', [
    'app.connection_package.import.description',
    'app.connection_package.import.root_level',
  ]),
  ...page('config', 'connection-health', [
    'connection_health.description',
  ]),
  ...page('config', 'data-root-application', [
    'app.data_root.current_location',
    'app.data_root.application.current_description',
    'app.data_root.application.stores',
    'app.data_root.application.content.connections',
    'app.data_root.application.content.ai_config',
    'app.data_root.application.content.drivers',
    'app.data_root.default_directory',
    'app.data_root.driver_directory',
    'app.data_root.log_directory.title',
    'app.data_root.log_directory.description',
    'app.data_root.log_directory.current_file',
    'app.data_root.log_directory.default_directory',
    'app.data_root.log_directory.restart_hint',
  ]),
  ...page('config', 'data-root-agent', [
    'app.data_root.agent_data.current_description',
    'app.data_root.agent_data.current_directory',
    'app.data_root.agent_data.disk_usage',
    'app.data_root.agent_data.ledger_data',
    'app.data_root.agent_data.reclaimable',
    'app.data_root.agent_data.write_log',
    'app.data_root.agent_data.default_directory',
    'app.data_root.agent_data.sessions',
    'app.data_root.agent_data.runs',
    'app.data_root.agent_data.snapshots',
    'app.data_root.agent_data.active_runs',
    'app.data_root.agent_data.read_only_hint',
  ]),
  ...page('config', 'data-root-saved-queries', [
    'app.data_root.saved_query_directory.current_description',
    'app.data_root.saved_query_directory.current_directory',
    'app.data_root.saved_query_directory.default_directory',
  ]),
  ...page('config', 'security-update', [
    'security_update.settings.summary.total',
    'security_update.settings.pending_list',
  ]),

  // 编辑器与驱动
  ...page('workspace', 'snippet-settings', SNIPPET_IDS.map((id) => `sql_snippets.builtin.${id}.name`)),
];
