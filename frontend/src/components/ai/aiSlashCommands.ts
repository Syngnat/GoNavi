import { t as catalogTranslate } from '../../i18n/catalog';
import type { I18nParams } from '../../i18n/types';

export type AISlashCommandCategory = 'generate' | 'review' | 'diagnose';

export type AISlashCommandTranslate = (key: string, params?: I18nParams) => string;

export interface AISlashCommandDefinition {
  cmd: string;
  label: string;
  desc: string;
  prompt: string;
  category: AISlashCommandCategory;
  keywords?: string[];
  featured?: boolean;
}

export interface AISlashCommandCategoryMeta {
  key: AISlashCommandCategory;
  title: string;
  description: string;
}

export interface AISlashCommandGroup extends AISlashCommandCategoryMeta {
  commands: AISlashCommandDefinition[];
}

interface AISlashCommandCategoryTemplate {
  key: AISlashCommandCategory;
  titleKey: string;
  descriptionKey: string;
}

interface AISlashCommandTemplate {
  cmd: string;
  labelKey: string;
  descKey: string;
  promptKey: string;
  category: AISlashCommandCategory;
  keywordKey: string;
  featured?: boolean;
}

const defaultTranslate: AISlashCommandTranslate = (key, params) =>
  catalogTranslate('en-US', key, params);

const AI_SLASH_COMMAND_CATEGORIES: AISlashCommandCategoryTemplate[] = [
  {
    key: 'generate',
    titleKey: 'ai_chat.input.slash.category.generate.title',
    descriptionKey: 'ai_chat.input.slash.category.generate.description',
  },
  {
    key: 'review',
    titleKey: 'ai_chat.input.slash.category.review.title',
    descriptionKey: 'ai_chat.input.slash.category.review.description',
  },
  {
    key: 'diagnose',
    titleKey: 'ai_chat.input.slash.category.diagnose.title',
    descriptionKey: 'ai_chat.input.slash.category.diagnose.description',
  },
];

const AI_SLASH_COMMAND_TEMPLATES: AISlashCommandTemplate[] = [
  { cmd: '/query', labelKey: 'ai_chat.input.slash.query.label', descKey: 'ai_chat.input.slash.query.desc', promptKey: 'ai_chat.input.slash.query.prompt', keywordKey: 'ai_chat.input.slash.query.keywords', category: 'generate', featured: true },
  { cmd: '/sql', labelKey: 'ai_chat.input.slash.sql.label', descKey: 'ai_chat.input.slash.sql.desc', promptKey: 'ai_chat.input.slash.sql.prompt', keywordKey: 'ai_chat.input.slash.sql.keywords', category: 'generate', featured: true },
  { cmd: '/mock', labelKey: 'ai_chat.input.slash.mock.label', descKey: 'ai_chat.input.slash.mock.desc', promptKey: 'ai_chat.input.slash.mock.prompt', keywordKey: 'ai_chat.input.slash.mock.keywords', category: 'generate' },
  { cmd: '/diff', labelKey: 'ai_chat.input.slash.diff.label', descKey: 'ai_chat.input.slash.diff.desc', promptKey: 'ai_chat.input.slash.diff.prompt', keywordKey: 'ai_chat.input.slash.diff.keywords', category: 'generate' },
  { cmd: '/explain', labelKey: 'ai_chat.input.slash.explain.label', descKey: 'ai_chat.input.slash.explain.desc', promptKey: 'ai_chat.input.slash.explain.prompt', keywordKey: 'ai_chat.input.slash.explain.keywords', category: 'review', featured: true },
  { cmd: '/optimize', labelKey: 'ai_chat.input.slash.optimize.label', descKey: 'ai_chat.input.slash.optimize.desc', promptKey: 'ai_chat.input.slash.optimize.prompt', keywordKey: 'ai_chat.input.slash.optimize.keywords', category: 'review' },
  { cmd: '/schema', labelKey: 'ai_chat.input.slash.schema.label', descKey: 'ai_chat.input.slash.schema.desc', promptKey: 'ai_chat.input.slash.schema.prompt', keywordKey: 'ai_chat.input.slash.schema.keywords', category: 'review' },
  { cmd: '/index', labelKey: 'ai_chat.input.slash.index.label', descKey: 'ai_chat.input.slash.index.desc', promptKey: 'ai_chat.input.slash.index.prompt', keywordKey: 'ai_chat.input.slash.index.keywords', category: 'review' },
  { cmd: '/health', labelKey: 'ai_chat.input.slash.health.label', descKey: 'ai_chat.input.slash.health.desc', promptKey: 'ai_chat.input.slash.health.prompt', keywordKey: 'ai_chat.input.slash.health.keywords', category: 'diagnose', featured: true },
  { cmd: '/tools', labelKey: 'ai_chat.input.slash.tools.label', descKey: 'ai_chat.input.slash.tools.desc', promptKey: 'ai_chat.input.slash.tools.prompt', keywordKey: 'ai_chat.input.slash.tools.keywords', category: 'diagnose' },
  { cmd: '/budget', labelKey: 'ai_chat.input.slash.budget.label', descKey: 'ai_chat.input.slash.budget.desc', promptKey: 'ai_chat.input.slash.budget.prompt', keywordKey: 'ai_chat.input.slash.budget.keywords', category: 'diagnose' },
  { cmd: '/hotspots', labelKey: 'ai_chat.input.slash.hotspots.label', descKey: 'ai_chat.input.slash.hotspots.desc', promptKey: 'ai_chat.input.slash.hotspots.prompt', keywordKey: 'ai_chat.input.slash.hotspots.keywords', category: 'diagnose' },
  { cmd: '/mcp', labelKey: 'ai_chat.input.slash.mcp.label', descKey: 'ai_chat.input.slash.mcp.desc', promptKey: 'ai_chat.input.slash.mcp.prompt', keywordKey: 'ai_chat.input.slash.mcp.keywords', category: 'diagnose', featured: true },
  { cmd: '/mcpfail', labelKey: 'ai_chat.input.slash.mcpfail.label', descKey: 'ai_chat.input.slash.mcpfail.desc', promptKey: 'ai_chat.input.slash.mcpfail.prompt', keywordKey: 'ai_chat.input.slash.mcpfail.keywords', category: 'diagnose' },
  { cmd: '/mcpadd', labelKey: 'ai_chat.input.slash.mcpadd.label', descKey: 'ai_chat.input.slash.mcpadd.desc', promptKey: 'ai_chat.input.slash.mcpadd.prompt', keywordKey: 'ai_chat.input.slash.mcpadd.keywords', category: 'diagnose', featured: true },
  { cmd: '/mcpdraft', labelKey: 'ai_chat.input.slash.mcpdraft.label', descKey: 'ai_chat.input.slash.mcpdraft.desc', promptKey: 'ai_chat.input.slash.mcpdraft.prompt', keywordKey: 'ai_chat.input.slash.mcpdraft.keywords', category: 'diagnose' },
  { cmd: '/mcptool', labelKey: 'ai_chat.input.slash.mcptool.label', descKey: 'ai_chat.input.slash.mcptool.desc', promptKey: 'ai_chat.input.slash.mcptool.prompt', keywordKey: 'ai_chat.input.slash.mcptool.keywords', category: 'diagnose' },
  { cmd: '/connfail', labelKey: 'ai_chat.input.slash.connfail.label', descKey: 'ai_chat.input.slash.connfail.desc', promptKey: 'ai_chat.input.slash.connfail.prompt', keywordKey: 'ai_chat.input.slash.connfail.keywords', category: 'diagnose', featured: true },
  { cmd: '/shortcuts', labelKey: 'ai_chat.input.slash.shortcuts.label', descKey: 'ai_chat.input.slash.shortcuts.desc', promptKey: 'ai_chat.input.slash.shortcuts.prompt', keywordKey: 'ai_chat.input.slash.shortcuts.keywords', category: 'diagnose' },
  { cmd: '/applog', labelKey: 'ai_chat.input.slash.applog.label', descKey: 'ai_chat.input.slash.applog.desc', promptKey: 'ai_chat.input.slash.applog.prompt', keywordKey: 'ai_chat.input.slash.applog.keywords', category: 'diagnose' },
  { cmd: '/airender', labelKey: 'ai_chat.input.slash.airender.label', descKey: 'ai_chat.input.slash.airender.desc', promptKey: 'ai_chat.input.slash.airender.prompt', keywordKey: 'ai_chat.input.slash.airender.keywords', category: 'diagnose' },
  { cmd: '/safety', labelKey: 'ai_chat.input.slash.safety.label', descKey: 'ai_chat.input.slash.safety.desc', promptKey: 'ai_chat.input.slash.safety.prompt', keywordKey: 'ai_chat.input.slash.safety.keywords', category: 'diagnose' },
  { cmd: '/activity', labelKey: 'ai_chat.input.slash.activity.label', descKey: 'ai_chat.input.slash.activity.desc', promptKey: 'ai_chat.input.slash.activity.prompt', keywordKey: 'ai_chat.input.slash.activity.keywords', category: 'diagnose' },
  { cmd: '/tx', labelKey: 'ai_chat.input.slash.tx.label', descKey: 'ai_chat.input.slash.tx.desc', promptKey: 'ai_chat.input.slash.tx.prompt', keywordKey: 'ai_chat.input.slash.tx.keywords', category: 'diagnose', featured: true },
];

const splitAISlashCommandKeywords = (keywords: string): string[] =>
  String(keywords || '')
    .split('|')
    .map((keyword) => keyword.trim())
    .filter(Boolean);

const localizeAISlashCommand = (
  command: AISlashCommandTemplate,
  translate: AISlashCommandTranslate,
): AISlashCommandDefinition => ({
  cmd: command.cmd,
  label: translate(command.labelKey),
  desc: translate(command.descKey),
  prompt: translate(command.promptKey),
  category: command.category,
  keywords: splitAISlashCommandKeywords(translate(command.keywordKey)),
  featured: command.featured,
});

const localizeAISlashCommandCategories = (
  translate: AISlashCommandTranslate,
): AISlashCommandCategoryMeta[] => AI_SLASH_COMMAND_CATEGORIES.map((meta) => ({
  key: meta.key,
  title: translate(meta.titleKey),
  description: translate(meta.descriptionKey),
}));

const buildAISlashCommands = (
  translate: AISlashCommandTranslate = defaultTranslate,
): AISlashCommandDefinition[] => AI_SLASH_COMMAND_TEMPLATES.map((command) =>
  localizeAISlashCommand(command, translate));

export const DEFAULT_AI_SLASH_COMMANDS: AISlashCommandDefinition[] = buildAISlashCommands();

const buildCommandSearchText = (command: AISlashCommandDefinition): string => [
  command.cmd,
  command.label,
  command.desc,
  ...(command.keywords || []),
].join(' ').toLowerCase();

export const filterAISlashCommands = (
  filter: string,
  translate: AISlashCommandTranslate = defaultTranslate,
): AISlashCommandDefinition[] => {
  const commands = buildAISlashCommands(translate);
  const normalized = String(filter || '').trim().toLowerCase();
  if (!normalized || normalized === '/') {
    return commands;
  }

  const slashSearch = normalized.startsWith('/') ? normalized : `/${normalized}`;
  const keywordSearch = normalized.startsWith('/') ? normalized.slice(1) : normalized;

  return commands.filter((command) => {
    const searchText = buildCommandSearchText(command);
    return command.cmd.startsWith(slashSearch) || searchText.includes(keywordSearch);
  });
};

export const groupAISlashCommands = (
  commands: AISlashCommandDefinition[],
  translate: AISlashCommandTranslate = defaultTranslate,
): AISlashCommandGroup[] =>
  localizeAISlashCommandCategories(translate)
    .map((meta) => ({
      ...meta,
      commands: commands.filter((command) => command.category === meta.key),
    }))
    .filter((group) => group.commands.length > 0);

export const getFeaturedAISlashCommands = (
  translate: AISlashCommandTranslate = defaultTranslate,
): AISlashCommandDefinition[] =>
  buildAISlashCommands(translate).filter((command) => command.featured);

/**
 * Labels start with an emoji ("🔍 Natural language query"). Split it off so the
 * menu can give every icon its own column instead of letting it shift the text.
 */
export const splitAISlashCommandIcon = (label: string): { icon: string; text: string } => {
  const match = /^(\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*)\s*([\s\S]*)$/u.exec(String(label || '').trim());
  return match ? { icon: match[1], text: match[2] } : { icon: '', text: String(label || '') };
};

/** Commands in the order the menu draws them (grouped), which is the order arrow keys walk. */
export const orderAISlashCommandsForDisplay = (
  commands: AISlashCommandDefinition[],
  translate: AISlashCommandTranslate = defaultTranslate,
): AISlashCommandDefinition[] => groupAISlashCommands(commands, translate).flatMap((group) => group.commands);
