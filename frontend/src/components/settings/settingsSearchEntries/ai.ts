import { t } from '../../../i18n';
import {
  defineSettingsCenterPageEntries as page,
  type SettingsCenterSearchEntrySource,
} from '../settingsCenterSearchEntries';

const PROVIDER_PRESETS = [
  'anthropic', 'atlascloud', 'claude_subscription', 'cursor_cli', 'custom', 'deepseek', 'gemini', 'grok',
  'minimax', 'moonshot', 'ollama', 'openai', 'orcarouter', 'qwen_bailian', 'qwen_coding_plan',
  'volcengine_ark', 'volcengine_coding', 'xiaomi_mimo', 'zhipu',
] as const;

const PROVIDER_ENDPOINTS = ['openai-responses', 'openai', 'anthropic', 'gemini', 'cli', 'cursor-agent'] as const;

/** Built-in tools listed on the 内置工具 page; the tool ids are what the page renders. */
const BUILTIN_TOOL_IDS = [
  'execute_sql', 'get_columns', 'get_connections', 'get_databases', 'get_table_ddl', 'get_tables',
] as const;

/** Settings inside the AI 设置 sub-pages. */
export const AI_SEARCH_ENTRIES: ReadonlyArray<SettingsCenterSearchEntrySource> = [
  ...page('services', 'ai-providers', [
    'ai_settings.provider.default_label',
    'ai_settings.provider.editor.add_title',
    'ai_settings.form.provider_name',
    'ai_settings.form.display_name',
    'ai_settings.form.inline_completion_enabled',
    'ai_settings.form.local_cli.title',
    ...PROVIDER_PRESETS.map((preset) => `ai_settings.provider_preset.${preset}.label`),
    ...PROVIDER_ENDPOINTS.map((endpoint) => `ai_settings.endpoint.${endpoint}.label`),
  ]),

  ...page('services', 'ai-analysis', [
    'ai_settings.analysis.trend.title',
    'ai_settings.analysis.models.title',
    'ai_settings.analysis.latency.title',
    'ai_settings.analysis.outcomes.title',
    'ai_settings.analysis.efficiency.title',
    'ai_settings.analysis.distribution.title',
    'ai_settings.analysis.heatmap.title',
    'ai_settings.observability.range.today',
    'ai_settings.observability.range.7d',
    'ai_settings.observability.range.30d',
  ]),

  ...page('services', 'ai-request_events', [
    'ai_settings.request_events.column.provider',
    'ai_settings.request_events.column.model',
    'ai_settings.request_events.column.task',
    'ai_settings.request_events.column.state',
    'ai_settings.request_events.column.thinking',
    'ai_settings.request_events.column.duration',
    'ai_settings.request_events.column.input_tokens',
    'ai_settings.request_events.column.output_tokens',
    'ai_settings.request_events.column.total_tokens',
    'ai_settings.observability.clear_filters',
  ]),

  ...page('services', 'ai-safety', [
    ['ai_settings.safety.readonly.label', 'ai_settings.safety.readonly.desc'],
    ['ai_settings.safety.readwrite.label', 'ai_settings.safety.readwrite.desc'],
    ['ai_settings.safety.full.label', 'ai_settings.safety.full.desc'],
    ['ai_settings.result_masking.title', 'ai_settings.result_masking.description'],
    'ai_settings.result_masking.enabled',
    'ai_settings.result_masking.full_fields',
    'ai_settings.result_masking.partial_fields',
    'ai_settings.result_masking.save',
  ]),

  ...page('services', 'ai-context', [
    'ai_settings.context.section_title',
    ['ai_settings.context.schema_only.label', 'ai_settings.context.schema_only.desc'],
    ['ai_settings.context.with_results.label', 'ai_settings.context.with_results.desc'],
    ['ai_settings.context.with_samples.label', 'ai_settings.context.with_samples.desc'],
  ]),

  ...page('services', 'ai-run_policy', [
    ['ai_settings.run_policy.dispatch.title', 'ai_settings.run_policy.dispatch.description'],
    'ai_settings.run_policy.dispatch.queue',
    'ai_settings.run_policy.dispatch.steer',
    ['ai_settings.run_policy.limits.title', 'ai_settings.run_policy.limits.description'],
    ['ai_settings.run_policy.default_tool_timeout.label', 'ai_settings.run_policy.default_tool_timeout.hint'],
    ['ai_settings.run_policy.max_active_duration.label', 'ai_settings.run_policy.max_active_duration.hint'],
    ['ai_settings.run_policy.max_total_tokens.label', 'ai_settings.run_policy.max_total_tokens.hint'],
    ['ai_settings.run_policy.max_tool_rounds.label', 'ai_settings.run_policy.max_tool_rounds.hint'],
    ['ai_settings.run_policy.soft_tool_round_limit.label', 'ai_settings.run_policy.soft_tool_round_limit.hint'],
    ['ai_settings.run_policy.max_failed_tool_rounds.label', 'ai_settings.run_policy.max_failed_tool_rounds.hint'],
    ['ai_settings.run_policy.max_tool_nudges.label', 'ai_settings.run_policy.max_tool_nudges.hint'],
    ['ai_settings.run_policy.max_tool_result_bytes.label', 'ai_settings.run_policy.max_tool_result_bytes.hint'],
    ['ai_settings.run_policy.max_model_retries.label', 'ai_settings.run_policy.max_model_retries.hint'],
    ['ai_settings.run_policy.model_turn_timeout.label', 'ai_settings.run_policy.model_turn_timeout.hint'],
    ['ai_settings.run_policy.model_idle_timeout.label', 'ai_settings.run_policy.model_idle_timeout.hint'],
    ['ai_settings.run_policy.ledger.title', 'ai_settings.run_policy.ledger.description'],
    ['ai_settings.run_policy.runtime.title', 'ai_settings.run_policy.runtime.description'],
    ['ai_settings.run_policy.runtime.control_poll_interval.label', 'ai_settings.run_policy.runtime.control_poll_interval.hint'],
    ['ai_settings.run_policy.runtime.policy_watch_interval.label', 'ai_settings.run_policy.runtime.policy_watch_interval.hint'],
    ['ai_settings.run_policy.runtime.workspace_renew_interval.label', 'ai_settings.run_policy.runtime.workspace_renew_interval.hint'],
    ['ai_settings.run_policy.runtime.workspace_lease_duration.label', 'ai_settings.run_policy.runtime.workspace_lease_duration.hint'],
    'ai_settings.run_policy.save',
  ]),

  ...page('services', 'ai-mcp', [
    'ai_settings.mcp_http.panel.title',
    'ai_settings.mcp_http.panel.addr_label',
    'ai_settings.mcp_http.panel.limited_query.label',
  ]),

  ...page('services', 'ai-skills', [
    'ai_settings.skill.action.add',
    ['ai_settings.skill.scope.global.label', 'ai_settings.skill.scope.global.desc'],
    ['ai_settings.skill.scope.database.label', 'ai_settings.skill.scope.database.desc'],
    ['ai_settings.skill.scope.jvm.label', 'ai_settings.skill.scope.jvm.desc'],
    ['ai_settings.skill.scope.jvm_diagnostic.label', 'ai_settings.skill.scope.jvm_diagnostic.desc'],
  ]),

  {
    group: 'services',
    item: 'ai-tools',
    resolve: () => BUILTIN_TOOL_IDS.map((id) => ({
      id,
      label: id,
      description: t(`ai_settings.tools.${id}.desc`),
    })),
  },

  ...page('services', 'ai-prompts', [
    ['ai_settings.prompts.user.title', 'ai_settings.prompts.user.description'],
    ['ai_settings.prompts.field.global.title', 'ai_settings.prompts.field.global.description'],
    ['ai_settings.prompts.field.database.title', 'ai_settings.prompts.field.database.description'],
    ['ai_settings.prompts.field.jvm.title', 'ai_settings.prompts.field.jvm.description'],
    ['ai_settings.prompts.field.jvm_diagnostic.title', 'ai_settings.prompts.field.jvm_diagnostic.description'],
    'ai_settings.prompts.action.save',
  ]),
];
