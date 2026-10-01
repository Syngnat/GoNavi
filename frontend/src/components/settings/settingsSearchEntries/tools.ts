import { SHORTCUT_ACTION_META, SHORTCUT_ACTION_ORDER } from '../../../utils/shortcuts';
import {
  defineSettingsCenterPageEntries as page,
  type SettingsCenterSearchEntrySource,
} from '../settingsCenterSearchEntries';

/**
 * Settings inside the tool-center pages (连接与配置, 编辑器与驱动) that render
 * inside the settings center. Data sync/compare, SQL audit, request
 * diagnostics and DML snapshot open their own workbench tabs and are reachable
 * as menu entries only.
 */
export const TOOLS_SEARCH_ENTRIES: ReadonlyArray<SettingsCenterSearchEntrySource> = [
  ...page('config', 'import', [
    ['app.connection_package.import.target_group', 'app.connection_package.import.target_group_help'],
    ['app.connection_package.import.file_title', 'app.connection_package.import.supported_formats'],
    'app.connection_package.import.choose_file',
    'app.connection_package.action.start_import',
  ]),

  ...page('config', 'data-root-saved-queries', [
    'app.data_root.saved_query_directory.apply_title',
  ]),

  ...page('config', 'security-update', [
    'security_update.settings.scope_title',
    'security_update.settings.action.start',
    'security_update.settings.action.retry_check',
  ]),

  ...page('workspace', 'snippet-settings', [
    'snippet_settings.action.new',
    'snippet_settings.list.title',
    'snippet_settings.filter.builtin',
    'snippet_settings.filter.custom',
    'snippet_settings.help.tab.syntax',
    'snippet_settings.help.tab.reference',
  ]),

  {
    group: 'workspace',
    item: 'shortcut-settings',
    // One row per shortcut; the list and its texts live in utils/shortcuts.
    resolve: () => SHORTCUT_ACTION_ORDER.map((action) => ({
      id: action,
      label: SHORTCUT_ACTION_META[action].label,
      description: SHORTCUT_ACTION_META[action].description,
    })),
  },
];
