import type { AISettingsSectionKey } from '../ai/AISettingsSidebar';
import { AI_SETTINGS_NAV_ITEMS } from '../ai/AISettingsSidebar';
import type { TabData } from '../../types';
import { buildDMLSnapshotWorkbenchTab } from '../../utils/dmlSnapshotTab';
import { buildRequestDiagnosticsWorkbenchTab } from '../../utils/requestDiagnosticsTab';
import { buildSqlAuditWorkbenchTab } from '../../utils/sqlAuditTab';
import type { SettingsCenterNavigationTarget } from './settingsCenterMenuCatalog';

export type ThemeSettingsSection = 'theme' | 'appearance' | 'workspace';

const THEME_SETTINGS_SECTIONS: ReadonlyArray<ThemeSettingsSection> = ['theme', 'appearance', 'workspace'];

/** Child page of the theme pane a navigation asks for; falls back to the first one. */
export const resolveThemeSettingsSection = (section?: string): ThemeSettingsSection => (
  THEME_SETTINGS_SECTIONS.find((candidate) => candidate === section) ?? 'theme'
);

/** Child page of the AI settings pane a navigation asks for; falls back to 模型供应商. */
export const resolveAISettingsSection = (section?: string): AISettingsSectionKey => (
  AI_SETTINGS_NAV_ITEMS.find((item) => item.key === section)?.key ?? 'providers'
);

/**
 * Navigation actions that open a workbench tab instead of a settings pane. The
 * settings center is closed first so the tab is not opened behind it.
 */
export const SETTINGS_WORKBENCH_TAB_BUILDERS: Partial<
  Record<NonNullable<SettingsCenterNavigationTarget['action']>, () => TabData>
> = {
  'sql-audit': buildSqlAuditWorkbenchTab,
  'request-diagnostics': buildRequestDiagnosticsWorkbenchTab,
  'dml-snapshot': buildDMLSnapshotWorkbenchTab,
};
