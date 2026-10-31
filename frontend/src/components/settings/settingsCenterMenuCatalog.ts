import { PREFERENCE_PAGES, preferenceTitleKey, preferenceDescriptionKey, type PreferencePage } from './preferences/preferencePages';
// How to open a settings-center destination through `onOpenSettingsNavigation`.
// `'workflow'` is not a settings-center group any more, but stays a valid target
// because title-bar 数据同步/数据对比 entries navigate with it and the handler
// dispatches on `action` alone.
export type SettingsCenterNavigationTarget = {
  group: PreferencePage | 'preferences' | 'services' | 'config' | 'workflow' | 'workspace' | 'about';
  pane?: string;
  /** Child page inside a pane: a theme section or an AI settings section. */
  section?: string;
  action?:
    | 'import-connections'
    | 'export-connections'
    | 'connection-health'
    | 'cloud-backup'
    | 'schema-compare'
    | 'data-compare'
    | 'compare'
    | 'sync'
    | 'drivers'
    | 'plugins'
    | 'sql-audit'
    | 'request-diagnostics'
    | 'dml-snapshot';
};

/**
 * One node of the settings-center menu tree as the command palette sees it.
 * The tree itself is assembled in App.tsx; this catalog mirrors its keys and
 * titles so the palette can list every destination without mounting it. When
 * a menu page is added, renamed or removed in App.tsx, update this catalog in
 * the same change (tests may not read source files, so nothing checks it).
 */
export type SettingsCenterMenuNode = {
  group: SettingsCenterNavigationTarget['group'];
  /** Tree item key; omitted for a group node. */
  item?: string;
  titleKey: string;
  descriptionKey: string;
  target: SettingsCenterNavigationTarget;
  /** Only present in the browser build (`isWebRuntime`). */
  webOnly?: boolean;
};

const group = (
  key: SettingsCenterNavigationTarget['group'],
  titleKey: string,
  descriptionKey: string,
): SettingsCenterMenuNode => ({ group: key, titleKey, descriptionKey, target: { group: key } });

const pane = (
  groupKey: SettingsCenterNavigationTarget['group'],
  item: string,
  titlePrefix: string,
  target: Omit<SettingsCenterNavigationTarget, 'group'> = { pane: item },
): SettingsCenterMenuNode => ({
  group: groupKey,
  item,
  titleKey: `${titlePrefix}.title`,
  descriptionKey: `${titlePrefix}.description`,
  target: { group: groupKey, ...target },
});

const AI_SECTIONS = [
  'providers', 'analysis', 'request_events', 'safety', 'context',
  'run_policy', 'mcp', 'skills', 'tools', 'prompts',
] as const;

export const SETTINGS_CENTER_MENU_CATALOG: ReadonlyArray<SettingsCenterMenuNode> = [
  ...PREFERENCE_PAGES.map(key => ({ group: key, item: key, titleKey: preferenceTitleKey(key), descriptionKey: preferenceDescriptionKey(key), target: { group: key, pane: key } })),
  group('preferences', 'settings.group.more_preferences.title', 'settings.group.more_preferences.description'),
  pane('preferences', 'language', 'settings.language'),
  pane('preferences', 'brand-icon', 'app.settings.entry.brand_icon'),
  pane('preferences', 'shortcut-settings', 'app.tools.entry.shortcuts'),

  group('services', 'app.settings.group.services.title', 'app.settings.group.services.description'),
  pane('services', 'proxy', 'app.settings.entry.proxy'),
  { ...pane('services', 'web-auth', 'app.settings.entry.web_auth'), webOnly: true },
  pane('services', 'ai', 'app.settings.entry.ai'),
  ...AI_SECTIONS.map((section) => pane(
    'services',
    `ai-${section}`,
    `ai_settings.nav.${section}`,
    { pane: 'ai', section },
  )),
  {
    group: 'services',
    item: 'ai-providers-connected',
    titleKey: 'ai_settings.provider.configured',
    descriptionKey: 'ai_settings.provider.configured_hint',
    target: { group: 'services', pane: 'ai', section: 'providers' },
  },

  // 插件不进设置中心：入口在标题栏工具条，作为独立工作台 Tab 打开
  // （SETTINGS_WORKBENCH_TAB_BUILDERS.plugins），目录（命令面板 / 搜索）里不挂插件节点。
  group('config', 'app.tools.group.config.title', 'app.tools.group.config.description'),
  pane('config', 'data-root', 'app.tools.entry.data_root'),
  {
    group: 'config',
    item: 'data-root-application',
    titleKey: 'app.data_root.current_directory',
    descriptionKey: 'app.data_root.description',
    target: { group: 'config', pane: 'data-root-application' },
  },
  pane('config', 'data-root-agent', 'app.data_root.agent_data'),
  pane('config', 'data-root-saved-queries', 'app.data_root.saved_query_directory'),
  pane('config', 'security-update', 'app.tools.entry.security_update'),

  {
    group: 'about',
    titleKey: 'app.settings.entry.about.title',
    descriptionKey: 'app.settings.entry.about.description',
    target: { group: 'about', pane: 'about-go-navi' },
  },
];

/** Where opening the given tree item should navigate; `undefined` for unknown items. */
export const findSettingsCenterNavigationTarget = (
  groupKey: string,
  item: string,
): SettingsCenterNavigationTarget | undefined => (
  SETTINGS_CENTER_MENU_CATALOG.find((node) => node.group === groupKey && node.item === item)?.target
);

/** Entries can only be reached when their page is in the catalog. */
export const isKnownSettingsCenterPage = (groupKey: string, item: string): boolean => (
  findSettingsCenterNavigationTarget(groupKey, item) !== undefined
);
