import { defineSettingsCenterPageEntries as page, type SettingsCenterSearchEntry } from '../settingsCenterSearchEntries';

/** Settings inside the 偏好设置 pages (language, theme & appearance, sidebar). */
export const PREFERENCES_SEARCH_ENTRIES: ReadonlyArray<SettingsCenterSearchEntry> = [
  ...page('preferences', 'language', [
    'settings.language.follow_system',
    'settings.language.simplified_chinese',
    'settings.language.traditional_chinese',
    'settings.language.english',
    'settings.language.japanese',
    'settings.language.german',
    'settings.language.russian',
  ]),

  // 主题与外观 > 主题与界面
  ...page('preferences', 'theme-theme', [
    'app.theme.mode_title',
    'app.theme.mode.light.label',
    'app.theme.mode.dark.label',
    'app.theme.mode.system.label',
    'app.theme.custom.title',
    ['app.theme.toolbar_buttons.title', 'app.theme.toolbar_buttons.description'],
    ['app.theme.titlebar_actions_placement.title', 'app.theme.titlebar_actions_placement.hint'],
    ['app.theme.sidebar_actions_placement.title', 'app.theme.sidebar_actions_placement.hint'],
    'app.theme.sidebar_actions_placement.toolbar',
    'app.theme.sidebar_actions_placement.rail',
    ['app.theme.ui_version.sidebar_search.title', 'app.theme.ui_version.sidebar_search.hint'],
    'app.theme.ui_version.sidebar_search.command',
    'app.theme.ui_version.sidebar_search.filter',
  ]),

  // 主题与外观 > 显示与字体
  ...page('preferences', 'theme-appearance', [
    ['app.theme.appearance.ui_scale_title', 'app.theme.appearance.ui_scale_hint'],
    'app.theme.appearance.font_size_title',
    ['app.theme.appearance.sidebar_rail_scale_title', 'app.theme.appearance.sidebar_rail_scale_hint'],
    ['app.theme.appearance.single_database_expansion_title', 'app.theme.appearance.single_database_expansion_hint'],
    'app.theme.font_family.title',
    'app.theme.font_family.ui_title',
    ['app.theme.font_family.mono_title', 'app.theme.font_family.mono_hint'],
    'app.theme.appearance.transparency_blur_title',
    ['app.theme.appearance.enable_transparency_blur', 'app.theme.appearance.enable_transparency_blur_hint'],
    'app.theme.appearance.opacity_title',
    ['app.theme.appearance.blur_title', 'app.theme.appearance.blur_hint'],
  ]),

  // 主题与外观 > 工作区
  ...page('preferences', 'theme-workspace', [
    ['app.theme.query_template.title', 'app.theme.query_template.description'],
    ['app.theme.table_alias.title', 'app.theme.table_alias.description'],
    ['app.theme.table_alias.custom_prefix.title', 'app.theme.table_alias.custom_prefix.description'],
    ['app.theme.tab_display.title', 'app.theme.tab_display.description'],
    'app.theme.tab_display.layout.single',
    'app.theme.tab_display.layout.double',
    ['app.theme.tab_display.environment_accent_thickness', 'app.theme.tab_display.environment_accent_thickness_hint'],
    'app.theme.data_table.title',
    ['app.theme.data_table.vertical_borders', 'app.theme.data_table.vertical_borders_hint'],
    ['app.theme.data_table.row_number', 'app.theme.data_table.row_number_hint'],
    ['app.theme.data_table.table_double_click_action', 'app.theme.data_table.table_double_click_action_hint'],
    ['app.theme.data_table.query_ctrl_click_action', 'app.theme.data_table.query_ctrl_click_action_hint'],
    ['app.theme.data_table.density', 'app.theme.data_table.density_hint'],
    'app.theme.data_table.sql_editor_font_size',
    'app.theme.data_table.font_size',
    'app.theme.data_table.sidebar_tree_font_size',
    ['app.theme.startup_window.title', 'app.theme.startup_window.hint'],
    'app.theme.startup_window.maximised',
  ]),

  ...page('preferences', 'sidebar-metadata', [
    'sidebar.v2_table_group_menu.show_table_comments',
    'sidebar.v2_table_group_menu.display_table_rows',
    'sidebar.v2_table_group_menu.display_table_size',
    'sidebar.v2_table_group_menu.display_create_time',
    'sidebar.v2_table_group_menu.display_update_time',
  ]),

  ...page('preferences', 'sidebar-objects', [
    'sidebar.tree.saved_queries',
    'sidebar.object_group.tables',
    'sidebar.object_group.views',
    'sidebar.object_group.materialized_views',
    'sidebar.object_group.routines',
    'sidebar.object_group.triggers',
    'sidebar.object_group.events',
    'sidebar.object_group.sequences',
    'sidebar.object_group.packages',
    'sidebar.object_group.database_links',
    'app.settings.sidebar_objects.action.show_all',
    'app.settings.sidebar_objects.action.tables_only',
  ]),
];
