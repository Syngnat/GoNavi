/** How to open a settings-center destination through `onOpenSettingsNavigation`. */
export type SettingsCenterNavigationTarget = {
  group: 'preferences' | 'services' | 'config' | 'workflow' | 'workspace' | 'about';
  pane?: string;
  /** Child page inside a pane: a theme section or an AI settings section. */
  section?: string;
  action?:
    | 'import-connections'
    | 'export-connections'
    | 'schema-compare'
    | 'data-compare'
    | 'compare'
    | 'sync'
    | 'drivers'
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

const THEME_SECTIONS = ['theme', 'appearance', 'workspace'] as const;
const AI_SECTIONS = [
  'providers', 'analysis', 'request_events', 'safety', 'context',
  'run_policy', 'mcp', 'skills', 'tools', 'prompts',
] as const;

export const SETTINGS_CENTER_MENU_CATALOG: ReadonlyArray<SettingsCenterMenuNode> = [
  group('preferences', 'app.settings.group.preferences.title', 'app.settings.group.preferences.description'),
  pane('preferences', 'language', 'settings.language'),
  pane('preferences', 'theme', 'app.settings.entry.theme'),
  ...THEME_SECTIONS.map((section) => pane(
    'preferences',
    `theme-${section}`,
    `app.theme.nav.${section}`,
    { pane: 'theme', section },
  )),
  pane('preferences', 'sidebar-metadata', 'app.settings.sidebar_metadata'),
  pane('preferences', 'sidebar-objects', 'app.settings.sidebar_objects'),

  group('services', 'app.settings.group.services.title', 'app.settings.group.services.description'),
  pane('services', 'proxy', 'app.settings.entry.proxy'),
  pane('services', 'download-source', 'app.settings.entry.download_source'),
  { ...pane('services', 'web-auth', 'app.settings.entry.web_auth'), webOnly: true },
  pane('services', 'cloud-backup', 'app.settings.entry.cloud_backup'),
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

  group('config', 'app.tools.group.config.title', 'app.tools.group.config.description'),
  pane('config', 'import', 'app.tools.entry.import'),
  pane('config', 'export', 'app.tools.entry.export', { action: 'export-connections' }),
  pane('config', 'connection-health', 'app.tools.entry.connection_health'),
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

  group('workflow', 'app.tools.group.workflow.title', 'app.tools.group.workflow.description'),
  pane('workflow', 'sync', 'app.tools.entry.sync', { action: 'sync' }),
  pane('workflow', 'compare', 'app.tools.entry.compare', { action: 'compare' }),

  group('workspace', 'app.tools.group.workspace.title', 'app.tools.group.workspace.description'),
  pane('workspace', 'drivers', 'app.tools.entry.drivers', { action: 'drivers' }),
  pane('workspace', 'snippet-settings', 'app.tools.entry.snippets'),
  pane('workspace', 'shortcut-settings', 'app.tools.entry.shortcuts'),
  pane('workspace', 'sql-audit', 'app.tools.entry.sql_audit', { action: 'sql-audit' }),
  pane('workspace', 'request-diagnostics', 'app.tools.entry.request_diagnostics', { action: 'request-diagnostics' }),
  pane('workspace', 'dml-snapshot', 'dml_snapshot.workbench', { action: 'dml-snapshot' }),

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
