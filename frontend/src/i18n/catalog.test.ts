import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { catalogs, getCatalogKeys, t } from "./catalog";
import { SUPPORTED_LANGUAGES } from "./resolveLanguage";

const getPlaceholders = (value: string): string[] =>
  Array.from(value.matchAll(/\{\{([A-Za-z0-9_]+)\}\}/g), (match) => match[1]).sort();

const readDataGridSource = (): string =>
  readFileSync(new URL("../components/DataGrid.tsx", import.meta.url), "utf8");

const readDataGridColumnInfoPopoverContentSource = (): string =>
  readFileSync(new URL("../components/DataGridColumnInfoPopoverContent.tsx", import.meta.url), "utf8");

const readDataGridColumnQuickFindSource = (): string =>
  readFileSync(new URL("../components/DataGridColumnQuickFind.tsx", import.meta.url), "utf8");

const readDataGridColumnTitleSource = (): string =>
  readFileSync(new URL("../components/DataGridColumnTitle.tsx", import.meta.url), "utf8");

const readDataGridModalsSource = (): string =>
  readFileSync(new URL("../components/DataGridModals.tsx", import.meta.url), "utf8");

const readDataGridPageFindSource = (): string =>
  readFileSync(new URL("../components/DataGridPageFind.tsx", import.meta.url), "utf8");

const readDataGridPaginationBarSource = (): string =>
  readFileSync(new URL("../components/DataGridPaginationBar.tsx", import.meta.url), "utf8");

const readDataGridPaginationSource = (): string =>
  readFileSync(new URL("../utils/dataGridPagination.ts", import.meta.url), "utf8");

const readDataGridPreviewPanelSource = (): string =>
  readFileSync(new URL("../components/DataGridPreviewPanel.tsx", import.meta.url), "utf8");

const readDataGridRecordViewsSource = (): string =>
  readFileSync(new URL("../components/DataGridRecordViews.tsx", import.meta.url), "utf8");

const readDataGridResultViewSwitcherSource = (): string =>
  readFileSync(new URL("../components/DataGridResultViewSwitcher.tsx", import.meta.url), "utf8");

const readDataGridSecondaryActionsSource = (): string =>
  readFileSync(new URL("../components/DataGridSecondaryActions.tsx", import.meta.url), "utf8");

const readDataGridV2DdlWorkspaceSource = (): string =>
  readFileSync(new URL("../components/DataGridV2DdlWorkspace.tsx", import.meta.url), "utf8");

const readQueryEditorSource = (): string =>
  readFileSync(new URL("../components/QueryEditor.tsx", import.meta.url), "utf8");

const readAppSource = (): string =>
  readFileSync(new URL("../App.tsx", import.meta.url), "utf8");

const readQueryEditorHelpersSource = (): string =>
  readFileSync(new URL("../components/queryEditor/QueryEditorHelpers.ts", import.meta.url), "utf8");

const readQueryEditorResultsPanelSource = (): string =>
  readFileSync(new URL("../components/QueryEditorResultsPanel.tsx", import.meta.url), "utf8");

const readSqlDialectSource = (): string =>
  readFileSync(new URL("../utils/sqlDialect.ts", import.meta.url), "utf8");

const readRowLocatorSource = (): string =>
  readFileSync(new URL("../utils/rowLocator.ts", import.meta.url), "utf8");

const sliceBetween = (source: string, start: string, end: string): string => {
  const normalizedSource = source.replace(/\r\n/g, "\n");
  const startIndex = normalizedSource.indexOf(start);
  const endIndex = normalizedSource.indexOf(end, startIndex + start.length);

  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);

  return normalizedSource.slice(startIndex, endIndex);
};

const assertSourceDoesNotInlineCatalogValues = (
  source: string,
  keys: readonly (keyof (typeof catalogs)["en-US"] )[],
  options?: {
    ignoreEnglishBaseline?: boolean;
  },
): void => {
  const executableSource = source.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const language of SUPPORTED_LANGUAGES) {
    for (const key of keys) {
      const value = catalogs[language][key];
      expect(value).toBeTruthy();
      if (!value) {
        continue;
      }
      if (options?.ignoreEnglishBaseline && value === catalogs["en-US"][key]) {
        continue;
      }
      if (executableSource.includes(value)) {
        throw new Error(`catalog literal leaked into source: ${language} ${key}`);
      }
    }
  }
};

describe("i18n catalog", () => {
  it("loads six complete catalogs with consistent base keys", () => {
    const baseKeys = getCatalogKeys("en-US");

    expect(SUPPORTED_LANGUAGES).toHaveLength(6);
    expect(baseKeys).toContain("common.cancel");
    expect(baseKeys).toContain("settings.language.title");

    for (const language of SUPPORTED_LANGUAGES) {
      expect(getCatalogKeys(language)).toEqual(baseKeys);
      expect(catalogs[language]["common.cancel"]).toBeTruthy();
      expect(catalogs[language]["settings.language.title"]).toBeTruthy();
    }
  });

  it("keeps MSI and Portable update copy complete across all catalogs", () => {
    const updateKeys = [
      "app.about.action.download_msi_update",
      "app.about.action.download_portable_update",
      "app.about.action.install_and_restart",
      "app.about.action.launch_installer",
      "app.about.download_progress.ready_to_install",
      "app.about.download_progress.installing_and_restarting",
      "app.about.download_progress.launching_installer",
      "app.about.download_progress.restarting_after_install",
      "app.about.download_progress.installer_started",
      "app.about.message.download_ready_install",
      "app.about.message.download_ready_install_with_path",
      "app.about.update_status.new_version_ready_install",
      "app.about.version.install_mode",
      "app.about.version.package_type",
      "app.about.install_mode.portable",
      "app.about.install_mode.msi",
      "app.about.package_type.portable",
      "app.about.package_type.msi",
    ] as const;
    const base = catalogs["en-US"];

    for (const language of SUPPORTED_LANGUAGES) {
      for (const key of updateKeys) {
        expect(catalogs[language]).toHaveProperty(key);
        expect(catalogs[language][key]).toBeTruthy();
        expect(getPlaceholders(catalogs[language][key])).toEqual(getPlaceholders(base[key]));
      }
    }
  });

  it("keeps latest and dev update channel descriptions distinct", () => {
    const latestHintKey = "app.about.version_update.channel_hint.latest";
    const devHintKey = "app.about.version_update.channel_hint.dev";

    for (const language of SUPPORTED_LANGUAGES) {
      expect(catalogs[language]).toHaveProperty(latestHintKey);
      expect(catalogs[language]).toHaveProperty(devHintKey);
      expect(catalogs[language][latestHintKey]).toBeTruthy();
      expect(catalogs[language][devHintKey]).toBeTruthy();
      expect(catalogs[language][latestHintKey]).not.toBe(catalogs[language][devHintKey]);
    }

    expect(catalogs["zh-CN"][latestHintKey]).toBe("接收最新的稳定版本");
    expect(catalogs["zh-CN"][devHintKey]).toBe("接收最新的开发版本");
  });

  it("keeps data-root log directory copy complete across all catalogs", () => {
    const logDirectoryKeys = [
      "app.data_root.log_directory.backend.dialog.select_directory",
      "app.data_root.log_directory.backend.error.desktop_only",
      "app.data_root.log_directory.backend.error.directory_unavailable",
      "app.data_root.log_directory.backend.error.environment_managed",
      "app.data_root.log_directory.backend.error.open_directory_failed",
      "app.data_root.log_directory.backend.error.open_directory_unsupported",
      "app.data_root.log_directory.backend.error.save_failed",
      "app.data_root.log_directory.backend.message.opened",
      "app.data_root.log_directory.backend.message.unchanged",
      "app.data_root.log_directory.backend.message.updated_restart",
      "app.data_root.log_directory.current_file",
      "app.data_root.log_directory.default_directory",
      "app.data_root.log_directory.description",
      "app.data_root.log_directory.environment_hint",
      "app.data_root.log_directory.message.apply_failed_with_error",
      "app.data_root.log_directory.message.open_failed_with_error",
      "app.data_root.log_directory.message.select_failed_with_error",
      "app.data_root.log_directory.message.select_valid_first",
      "app.data_root.log_directory.message.updated",
      "app.data_root.log_directory.pending_restart",
      "app.data_root.log_directory.placeholder",
      "app.data_root.log_directory.restart_hint",
      "app.data_root.log_directory.title",
    ] as const;
    const base = catalogs["en-US"];

    for (const language of SUPPORTED_LANGUAGES) {
      for (const key of logDirectoryKeys) {
        expect(catalogs[language]).toHaveProperty(key);
        expect(catalogs[language][key]).toBeTruthy();
        expect(getPlaceholders(catalogs[language][key])).toEqual(getPlaceholders(base[key]));
      }
    }

    expect(catalogs["zh-CN"]["app.data_root.log_directory.title"]).toBe("日志目录");
    expect(catalogs["zh-CN"]["app.data_root.log_directory.environment_hint"]).toContain("GONAVI_LOG_DIR");
    expect(catalogs["en-US"]["app.data_root.log_directory.restart_hint"]).toContain("gonavi.log");
  });

  it("keeps saved query directory copy complete across all catalogs", () => {
    const savedQueryDirectoryKeys = [
      "app.data_root.saved_query_directory.backend.dialog.select_directory",
      "app.data_root.saved_query_directory.backend.error.desktop_only",
      "app.data_root.saved_query_directory.backend.error.directory_unavailable",
      "app.data_root.saved_query_directory.backend.error.migrate_failed",
      "app.data_root.saved_query_directory.backend.error.open_directory_failed",
      "app.data_root.saved_query_directory.backend.error.open_directory_unsupported",
      "app.data_root.saved_query_directory.backend.error.query_file_unavailable",
      "app.data_root.saved_query_directory.backend.error.query_id_required",
      "app.data_root.saved_query_directory.backend.error.query_not_found",
      "app.data_root.saved_query_directory.backend.error.reveal_failed",
      "app.data_root.saved_query_directory.backend.error.reveal_unsupported",
      "app.data_root.saved_query_directory.backend.error.save_failed",
      "app.data_root.saved_query_directory.backend.message.opened",
      "app.data_root.saved_query_directory.backend.message.revealed",
      "app.data_root.saved_query_directory.backend.message.unchanged",
      "app.data_root.saved_query_directory.backend.message.updated",
      "app.data_root.saved_query_directory.current_directory",
      "app.data_root.saved_query_directory.default_directory",
      "app.data_root.saved_query_directory.description",
      "app.data_root.saved_query_directory.message.apply_failed_with_error",
      "app.data_root.saved_query_directory.message.open_failed_with_error",
      "app.data_root.saved_query_directory.message.select_failed_with_error",
      "app.data_root.saved_query_directory.message.select_valid_first",
      "app.data_root.saved_query_directory.message.updated",
      "app.data_root.saved_query_directory.placeholder",
      "app.data_root.saved_query_directory.title",
    ] as const;
    const base = catalogs["en-US"];

    for (const language of SUPPORTED_LANGUAGES) {
      for (const key of savedQueryDirectoryKeys) {
        expect(catalogs[language]).toHaveProperty(key);
        expect(catalogs[language][key]).toBeTruthy();
        expect(getPlaceholders(catalogs[language][key])).toEqual(getPlaceholders(base[key]));
      }
    }

    expect(catalogs["zh-CN"]["app.data_root.saved_query_directory.title"]).toBe("已存查询目录");
    expect(catalogs["zh-CN"]["app.data_root.saved_query_directory.description"]).toContain(".sql");
    expect(catalogs["en-US"]["app.data_root.saved_query_directory.description"]).toContain("independent .sql file");
  });

  it("includes App shell keys required by every supported language", () => {
    const appShellKeys = [
      "app.tools.title",
      "app.tools.group.config.title",
      "app.tools.group.config.description",
      "app.tools.group.workflow.title",
      "app.tools.group.workflow.description",
      "app.tools.group.workspace.title",
      "app.tools.group.workspace.description",
      "app.tools.entry.import.title",
      "app.tools.entry.security_update.description",
      "app.tools.entry.security_update.status_description",
      "app.tools.entry.security_update.title",
      "app.tools.entry.snippets.description",
      "app.tools.entry.snippets.title",
      "app.data_root.title",
      "app.data_root.action.switch_only",
      "app.data_root.message.apply_failed",
      "app.data_root.message.apply_failed_with_error",
      "app.data_root.message.load_failed",
      "app.data_root.message.load_failed_with_error",
      "app.data_root.message.open_failed",
      "app.data_root.message.open_failed_with_error",
      "app.data_root.message.select_failed",
      "app.data_root.message.select_failed_with_error",
      "app.data_root.message.select_valid_first",
      "app.data_root.message.updated",
      "app.security_update.error.capability_unavailable",
      "app.security_update.message.completed",
      "app.security_update.message.needs_attention",
      "app.security_update.message.not_finished_retry_later",
      "app.security_update.message.postpone_failed",
      "app.security_update.message.rolled_back",
      "app.security_update.stage.checking_saved_config",
      "app.security_update.stage.updating_secure_storage",
      "app.security_update.stage.verifying_result",
      "app.sidebar.ai_assistant",
      "app.sidebar.collapse",
      "app.sidebar.expand",
      "app.sidebar.resize_width",
      "app.sidebar.settings",
      "app.sidebar.sql_execution_log",
      "app.sidebar.tools",
      "app.window_zoom.message.fullscreen_exit_first",
      "app.window_zoom.message.reset_failed",
      "app.window_zoom.message.reset_success",
      "app.window_zoom.message.reset_success_fallback",
      "app.window_zoom.message.windows_only",
      "app.ai_panel.action.close",
      "app.ai_panel.action.reload",
      "app.ai_panel.aria.close",
      "app.ai_panel.error.description",
      "app.ai_panel.error.title",
      "app.about.title",
      "app.about.field.update_status",
      "common.back_to_previous",
      "common.unknown",
      "common.close",
    ] as const;

    for (const language of SUPPORTED_LANGUAGES) {
      for (const key of appShellKeys) {
        expect(catalogs[language]).toHaveProperty(key);
        expect(catalogs[language][key]).toBeTruthy();
      }
    }
  });

  it("includes App theme modal shell keys required by every supported language", () => {
    const themeModalShellKeys = [
      "app.theme.appearance_settings_description",
      "app.theme.appearance_settings_title",
      "app.theme.mode.dark.description",
      "app.theme.mode.dark.label",
      "app.theme.mode.light.description",
      "app.theme.mode.light.label",
      "app.theme.mode.system.description",
      "app.theme.mode.system.label",
      "app.theme.mode_title",
      "app.theme.data_table.row_number",
      "app.theme.data_table.row_number_hint",
      "app.theme.data_table.table_double_click_action",
      "app.theme.data_table.table_double_click_action.open_data",
      "app.theme.data_table.table_double_click_action.open_design",
      "app.theme.data_table.table_double_click_action_hint",
      "app.theme.data_table.query_ctrl_click_action",
      "app.theme.data_table.query_ctrl_click_action.open_design",
      "app.theme.data_table.query_ctrl_click_action.locate",
      "app.theme.data_table.query_ctrl_click_action_hint",
      "app.theme.instant_apply_hint",
      "app.theme.nav.appearance.description",
      "app.theme.nav.appearance.title",
      "app.theme.nav.theme.description",
      "app.theme.nav.theme.title",
      "app.theme.nav.workspace.description",
      "app.theme.nav.workspace.title",
      "app.theme.navigation_title",
      "app.theme.workspace_settings_description",
      "app.theme.workspace_settings_title",
      "app.theme.query_template.description",
      "app.theme.query_template.hint",
      "app.theme.query_template.reset_default",
      "app.theme.query_template.title",
      "app.theme.table_alias.description",
      "app.theme.table_alias.title",
      "app.theme.theme_settings_description",
      "app.theme.theme_settings_title",
      "app.theme.ui_version.beta_warning",
      "app.theme.ui_version.description",
      "app.theme.ui_version.legacy.badge",
      "app.theme.ui_version.legacy.description",
      "app.theme.ui_version.legacy.label",
      "app.theme.ui_version.platform_hint",
      "app.theme.ui_version.title",
      "app.theme.ui_version.v2.description",
      "app.theme.ui_version.v2.label",
    ] as const;

    for (const language of SUPPORTED_LANGUAGES) {
      for (const key of themeModalShellKeys) {
        expect(catalogs[language]).toHaveProperty(key);
        expect(catalogs[language][key]).toBeTruthy();
      }
    }
  });

  it("renders the table alias setting in both theme setting variants", () => {
    const source = readAppSource();
    const v2Source = sliceBetween(
      source,
      "const renderThemeSettingsContentV2 = () =>",
      "const renderThemeSettingsContentLegacy = () =>",
    );
    const legacySource = sliceBetween(
      source,
      "const renderThemeSettingsContentLegacy = () =>",
      "const renderThemeSettingsContent = () =>",
    );

    for (const settingsSource of [v2Source, legacySource]) {
      expect(settingsSource).toContain("app.theme.table_alias.title");
      expect(settingsSource).toContain("app.theme.table_alias.description");
      expect(settingsSource).toContain("setAppearance({ autoAddTableAlias: checked })");
    }
  });

  it("includes App shortcut modal keys required by every supported language", () => {
    const shortcutModalKeys = [
      "app.shortcuts.action.closeActiveTab.description",
      "app.shortcuts.action.closeActiveTab.label",
      "app.shortcuts.action.focusSidebarSearch.description",
      "app.shortcuts.action.focusSidebarSearch.label",
      "app.shortcuts.action.newConnection.description",
      "app.shortcuts.action.newConnection.label",
      "app.shortcuts.action.newQueryTab.description",
      "app.shortcuts.action.newQueryTab.label",
      "app.shortcuts.action.openShortcutManager.description",
      "app.shortcuts.action.openShortcutManager.label",
      "app.shortcuts.action.record",
      "app.shortcuts.action.duplicateCurrentLine.description",
      "app.shortcuts.action.duplicateCurrentLine.label",
      "app.shortcuts.action.resetWindowZoom.description",
      "app.shortcuts.action.resetWindowZoom.label",
      "app.shortcuts.action.restore_defaults",
      "app.shortcuts.action.runQuery.description",
      "app.shortcuts.action.runQuery.label",
      "app.shortcuts.action.saveQuery.description",
      "app.shortcuts.action.saveQuery.label",
      "app.shortcuts.action.saveQueryAs.description",
      "app.shortcuts.action.saveQueryAs.label",
      "app.shortcuts.action.selectCurrentStatement.description",
      "app.shortcuts.action.selectCurrentStatement.label",
      "app.shortcuts.action.sendAIChatMessage.description",
      "app.shortcuts.action.sendAIChatMessage.label",
      "app.shortcuts.action.triggerSqlAiCompletion.description",
      "app.shortcuts.action.triggerSqlAiCompletion.label",
      "app.shortcuts.action.switchToNextTab.description",
      "app.shortcuts.action.switchToNextTab.label",
      "app.shortcuts.action.switchToPreviousTab.description",
      "app.shortcuts.action.switchToPreviousTab.label",
      "app.shortcuts.action.toggleAIPanel.description",
      "app.shortcuts.action.toggleAIPanel.label",
      "app.shortcuts.action.toggleLogPanel.description",
      "app.shortcuts.action.toggleLogPanel.label",
      "app.shortcuts.action.toggleMacFullscreen.description",
      "app.shortcuts.action.toggleMacFullscreen.label",
      "app.shortcuts.action.toggleTheme.description",
      "app.shortcuts.action.toggleTheme.label",
      "app.shortcuts.capture_hint",
      "app.shortcuts.capture_waiting",
      "app.shortcuts.context.datagrid",
      "app.shortcuts.context.global",
      "app.shortcuts.context.monaco",
      "app.shortcuts.description",
      "app.shortcuts.message.ai_send_limit",
      "app.shortcuts.message.conflict",
      "app.shortcuts.message.modifier_required",
      "app.shortcuts.message.reserved_conflict_info",
      "app.shortcuts.message.reserved_conflict_warning",
      "app.shortcuts.message.restored_defaults",
      "app.shortcuts.reserved.browser_close_tab",
      "app.shortcuts.reserved.browser_new_incognito_window",
      "app.shortcuts.reserved.browser_new_tab",
      "app.shortcuts.reserved.browser_new_window",
      "app.shortcuts.reserved.browser_print",
      "app.shortcuts.reserved.browser_save",
      "app.shortcuts.reserved.datagrid_copy",
      "app.shortcuts.reserved.editor_add_selection",
      "app.shortcuts.reserved.editor_delete_line",
      "app.shortcuts.reserved.editor_find",
      "app.shortcuts.reserved.editor_find_global",
      "app.shortcuts.reserved.editor_goto_line",
      "app.shortcuts.reserved.editor_insert_line_after",
      "app.shortcuts.reserved.editor_insert_line_before",
      "app.shortcuts.reserved.editor_quick_open",
      "app.shortcuts.reserved.editor_rename_symbol",
      "app.shortcuts.reserved.editor_replace",
      "app.shortcuts.title",
      "app.tools.entry.shortcuts.description",
      "app.tools.entry.shortcuts.title",
      "common.cancel",
      "common.close",
    ] as const;

    for (const language of SUPPORTED_LANGUAGES) {
      for (const key of shortcutModalKeys) {
        expect(catalogs[language]).toHaveProperty(key);
        expect(catalogs[language][key]).toBeTruthy();
      }
    }

    expect(t("en-US", "app.shortcuts.message.conflict", { action: "Run SQL" })).toContain("Run SQL");
    expect(t("en-US", "app.shortcuts.message.reserved_conflict_warning", {
      contexts: "Browser",
      labels: "Browser Save",
    })).toContain("Browser Save");
  });

  it("keeps placeholders aligned and preserves raw parameter values", () => {
    const base = catalogs["en-US"];
    const key = "connection_modal.title.create";

    for (const language of SUPPORTED_LANGUAGES) {
      expect(getPlaceholders(catalogs[language][key])).toEqual(
        getPlaceholders(base[key]),
      );
    }

    expect(t("en-US", key, { type: "<raw>" })).toBe("New <raw> connection");
  });

  it("keeps DataGrid column controls in catalogs while preserving raw metadata parameters", () => {
    const dataGridColumnControlKeys = [
      "data_grid.column.type_tooltip",
      "data_grid.column.comment_tooltip",
      "data_grid.column.foreign_key_tooltip",
      "data_grid.column.foreign_key_jump_title",
      "data_grid.column_quick_find.tooltip",
      "data_grid.column_quick_find.placeholder",
      "data_grid.column_settings.display_settings",
      "data_grid.column_settings.show_comments",
      "data_grid.column_settings.show_types",
      "data_grid.column_settings.column_visibility",
      "data_grid.column_settings.show_all",
      "data_grid.column_settings.hide_all",
      "data_grid.column_settings.search_columns_placeholder",
      "data_grid.column_settings.global_hidden_columns",
      "data_grid.column_settings.global_hidden_columns_help",
      "data_grid.column_settings.global_hidden_columns_apply",
      "data_grid.column_settings.global_hidden_columns_add_current",
      "data_grid.column_settings.global_hidden_columns_clear",
      "data_grid.column_settings.remember_column_order",
      "data_grid.column_settings.remember_hidden_columns",
      "data_grid.column_settings.reset_order",
      "data_grid.column_settings.reset_hidden",
      "data_grid.column_settings.reset_order_success",
      "data_grid.column_settings.reset_hidden_success",
    ] as const;
    const source = [
      readDataGridSource(),
      readDataGridColumnInfoPopoverContentSource(),
      readDataGridColumnQuickFindSource(),
      readDataGridColumnTitleSource(),
    ].join("\n");
    const base = catalogs["en-US"];

    for (const language of SUPPORTED_LANGUAGES) {
      for (const key of dataGridColumnControlKeys) {
        expect(catalogs[language]).toHaveProperty(key);
        expect(catalogs[language][key]).toBeTruthy();
        expect(getPlaceholders(catalogs[language][key])).toEqual(getPlaceholders(base[key]));
      }
    }

    for (const key of dataGridColumnControlKeys) {
    }

    expect(t("zh-CN", "data_grid.column.type_tooltip", { type: "uuid" })).toBe("类型：uuid");
    expect(t("zh-CN", "data_grid.column.comment_tooltip", { comment: "账户编号" })).toBe("注释：账户编号");
    expect(t("zh-CN", "data_grid.column.foreign_key_tooltip", { target: "public.users.id" })).toBe("外键：public.users.id");
    expect(t("en-US", "data_grid.column.foreign_key_jump_title", { tableName: "audit.log" })).toBe("Open foreign key table: audit.log");
    assertSourceDoesNotInlineCatalogValues(source, dataGridColumnControlKeys);
  });

  it("keeps DataGrid detached chrome labels in catalogs while preserving raw parameter values", () => {
    const dataGridDetachedChromeKeys = [
      "data_grid.page_find.tooltip",
      "data_grid.page_find.placeholder",
      "data_grid.page_find.previous",
      "data_grid.page_find.next",
      "data_grid.page_find.summary",
      "data_grid.pagination.result_set",
      "data_grid.pagination.page_size_aria",
      "data_grid.pagination.page_size_option",
      "data_grid.pagination.first_page",
      "data_grid.pagination.last_page",
      "data_grid.pagination.jump_label",
      "data_grid.pagination.jump_aria",
      "data_grid.pagination.jump_action",
      "data_grid.pagination.selected_count",
      "data_grid.pagination.summary.approximate",
      "data_grid.pagination.summary.cancelled",
      "data_grid.pagination.summary.counting",
      "data_grid.pagination.summary.counting_exact",
      "data_grid.pagination.summary.empty",
      "data_grid.pagination.summary.known",
      "data_grid.pagination.summary.not_counted",
      "data_grid.pagination.page.current",
      "data_grid.pagination.page.known",
      "data_grid.view.result_view",
      "data_grid.view.table",
      "data_grid.view.text",
      "data_grid.column_settings.field_info",
      "data_grid.secondary.data_preview",
      "data_grid.secondary.view_ddl",
      "data_grid.secondary.er_diagram",
      "data_grid.secondary.column_display",
      "data_grid.secondary.jump_column",
      "data_grid.record_view.empty",
      "data_grid.record_view.json_record_count",
      "data_grid.record_view.edit_json",
      "data_grid.record_view.field",
      "data_grid.record_view.value",
      "data_grid.record_view.comment",
      "data_grid.record_view.type",
      "data_grid.record_view.copy_value",
      "data_grid.record_view.previous",
      "data_grid.record_view.next",
      "data_grid.record_view.record_position",
      "data_grid.record_view.edit_current",
      "data_grid.preview_panel.no_cell_title",
      "data_grid.preview_panel.no_cell_description",
      "data_grid.row_editor.title",
      "data_grid.row_editor.popup_edit",
      "data_grid.cell_editor.title",
      "data_grid.cell_editor.title_with_column",
      "data_grid.cell_viewer.title_with_column",
      "data_grid.batch_fill.title",
      "data_grid.batch_fill.set_null",
      "data_grid.batch_fill.set_null_selected",
      "data_grid.batch_fill.value_placeholder",
      "data_grid.json_editor.title",
      "data_grid.json_editor.description",
      "data_grid.json_editor.format",
      "data_grid.json_editor.apply_changes",
      "data_grid.json_editor.invalid_format",
      "data_grid.ddl.layout_bottom",
      "data_grid.ddl.layout_side",
      "data_grid.ddl.reload",
      "data_grid.ddl.copy",
      "data_grid.ddl.loading",
      "data_grid.ddl.sidebar_aria",
      "data_grid.action.apply",
      "common.cancel",
      "common.close",
      "common.save",
    ] as const;
    const dataGridSource = readDataGridSource();
    const detachedChromeSource = [
      readDataGridPageFindSource(),
      readDataGridPaginationBarSource(),
      readDataGridPreviewPanelSource(),
      readDataGridRecordViewsSource(),
      readDataGridResultViewSwitcherSource(),
      readDataGridSecondaryActionsSource(),
      readDataGridModalsSource(),
      readDataGridV2DdlWorkspaceSource(),
    ].join("\n");
    const source = [
      dataGridSource,
      detachedChromeSource,
      readDataGridPaginationSource(),
    ].join("\n");
    const base = catalogs["en-US"];

    for (const language of SUPPORTED_LANGUAGES) {
      for (const key of dataGridDetachedChromeKeys) {
        expect(catalogs[language]).toHaveProperty(key);
        expect(catalogs[language][key]).toBeTruthy();
        expect(getPlaceholders(catalogs[language][key])).toEqual(getPlaceholders(base[key]));
      }
    }

    for (const key of dataGridDetachedChromeKeys) {
    }

    expect(t("en-US", "data_grid.page_find.summary", { occurrences: "<raw-occurrences>", cells: "<raw-cells>" })).toContain("<raw-occurrences>");
    expect(t("en-US", "data_grid.page_find.summary", { occurrences: "<raw-occurrences>", cells: "<raw-cells>" })).toContain("<raw-cells>");
    expect(t("zh-CN", "data_grid.pagination.page_size_option", { count: "<raw-count>" })).toContain("<raw-count>");
    expect(t("zh-CN", "data_grid.pagination.summary.approximate", { current: "<raw-current>", total: "<raw-total>" })).toContain("<raw-current>");
    expect(t("zh-CN", "data_grid.pagination.summary.approximate", { current: "<raw-current>", total: "<raw-total>" })).toContain("<raw-total>");
    expect(t("en-US", "data_grid.pagination.summary.known", { current: "<raw-current>", total: "<raw-total>" })).toContain("<raw-current>");
    expect(t("en-US", "data_grid.pagination.summary.known", { current: "<raw-current>", total: "<raw-total>" })).toContain("<raw-total>");
    expect(t("en-US", "data_grid.pagination.page.current", { current: "<raw-current>" })).toContain("<raw-current>");
    expect(t("en-US", "data_grid.pagination.page.known", { current: "<raw-current>", totalPages: "<raw-total-pages>" })).toContain("<raw-current>");
    expect(t("en-US", "data_grid.pagination.page.known", { current: "<raw-current>", totalPages: "<raw-total-pages>" })).toContain("<raw-total-pages>");
    expect(t("zh-CN", "data_grid.secondary.view_ddl")).toContain("DDL");
    expect(t("ja-JP", "data_grid.secondary.er_diagram")).toContain("ER");
    expect(t("zh-CN", "data_grid.record_view.json_record_count", { count: "<raw-count>" })).toContain("<raw-count>");
    expect(t("en-US", "data_grid.record_view.record_position", { current: "<raw-current>", total: "<raw-total>" })).toContain("<raw-current>");
    expect(t("en-US", "data_grid.record_view.record_position", { current: "<raw-current>", total: "<raw-total>" })).toContain("<raw-total>");
    expect(t("en-US", "data_grid.cell_editor.title_with_column", { column: "<raw-column>" })).toContain("<raw-column>");
    expect(t("zh-CN", "data_grid.cell_editor.title_with_column", { column: "<raw-column>" })).toContain("<raw-column>");
    expect(getPlaceholders(catalogs["en-US"]["data_grid.cell_editor.title_with_column"])).toEqual(["column"]);
    expect(t("en-US", "data_grid.batch_fill.title", { count: "<raw-count>" })).toContain("<raw-count>");
    expect(t("zh-CN", "data_grid.batch_fill.title", { count: "<raw-count>" })).toContain("<raw-count>");
    expect(getPlaceholders(catalogs["en-US"]["data_grid.batch_fill.title"])).toEqual(["count"]);
    expect(t("en-US", "data_grid.ddl.layout_bottom")).toBe("Bottom");
    expect(t("zh-CN", "data_grid.ddl.layout_side")).toBe("侧栏");
    expect(t("en-US", "data_grid.ddl.reload")).toBe("Reload");
    expect(t("en-US", "data_grid.ddl.copy")).toContain("DDL");
    expect(t("zh-CN", "data_grid.ddl.loading")).toContain("DDL");
    expect(t("en-US", "data_grid.ddl.sidebar_aria")).toContain("DDL");
    ([
      "data_grid.ddl.layout_bottom",
      "data_grid.ddl.layout_side",
      "data_grid.ddl.reload",
      "data_grid.ddl.copy",
      "data_grid.ddl.loading",
      "data_grid.ddl.sidebar_aria",
    ] as const).forEach((key) => {
      expect(getPlaceholders(catalogs["en-US"][key])).toEqual([]);
    });
    expect(t("en-US", "data_grid.json_editor.title")).toContain("JSON");
    expect(t("zh-CN", "data_grid.json_editor.description")).toContain("JSON");
    expect(t("zh-CN", "data_grid.json_editor.format")).toContain("JSON");
    expect(t("zh-CN", "data_grid.json_editor.invalid_format", { error: "<raw-json-error>" })).toContain("<raw-json-error>");
    expect(getPlaceholders(catalogs["en-US"]["data_grid.json_editor.invalid_format"])).toEqual(["error"]);
    assertSourceDoesNotInlineCatalogValues(detachedChromeSource, dataGridDetachedChromeKeys, { ignoreEnglishBaseline: true });
  });

  it("keeps raw cancelled sentinels out of data-root and export feedback catalogs", () => {
    const guardedKeyPrefixes = [
      "app.data_root.",
      "data_export.",
    ];

    for (const language of SUPPORTED_LANGUAGES) {
      for (const [key, value] of Object.entries(catalogs[language])) {
        if (guardedKeyPrefixes.some((prefix) => key.startsWith(prefix))) {
          expect(value, `${language}:${key}`).not.toBe("已取消");
        }
      }
    }
  });

  it("keeps DataGrid row export messages in catalogs while preserving raw placeholders", () => {
    const dataGridRowExportMessageKeys = [
      "data_grid.message.exporting_rows",
      "data_grid.message.export_success",
      "data_grid.message.export_failed",
    ] as const;
    const source = readDataGridSource();
    const base = catalogs["en-US"];

    for (const language of SUPPORTED_LANGUAGES) {
      for (const key of dataGridRowExportMessageKeys) {
        expect(catalogs[language]).toHaveProperty(key);
        expect(catalogs[language][key]).toBeTruthy();
        expect(getPlaceholders(catalogs[language][key])).toEqual(getPlaceholders(base[key]));
      }

      expect(getPlaceholders(catalogs[language]["data_grid.message.exporting_rows"])).toEqual(["count"]);
      expect(getPlaceholders(catalogs[language]["data_grid.message.export_success"])).toEqual([]);
      expect(getPlaceholders(catalogs[language]["data_grid.message.export_failed"])).toEqual(["detail"]);
    }

    expect(t("zh-CN", "data_grid.message.exporting_rows", { count: "<raw-count>" })).toContain("<raw-count>");
    expect(t("en-US", "data_grid.message.export_failed", { detail: "<raw-detail>" })).toContain("<raw-detail>");
    assertSourceDoesNotInlineCatalogValues(source, dataGridRowExportMessageKeys);
  });

  it("keeps DataGrid commit, preview SQL, and copy feedback messages in catalogs with raw placeholders", () => {
    const detailKeys = [
      "data_grid.message.change_set_build_failed_detail",
      "data_grid.message.preview_sql_failed_detail",
      "data_grid.message.commit_failed",
      "data_grid.message.rollback_failed",
    ];
    const noPlaceholderKeys = [
      "data_grid.message.change_set_build_failed",
      "data_grid.message.preview_sql_failed",
      "data_grid.message.transaction_committed",
      "data_grid.message.transaction_rolled_back",
      "data_grid.message.no_changes_to_commit",
      "data_grid.message.copied_to_clipboard",
      "data_grid.message.no_field_name",
      "data_grid.message.no_copyable_columns",
      "data_grid.message.no_copyable_cells",
      "data_grid.message.drag_select_cells_to_copy",
      "data_grid.message.selection_no_copyable_content",
      "data_grid.message.copy_sql_not_supported",
      "data_grid.message.keep_one_visible_column",
      "data_grid.message.result_set_no_copyable_content",
      "data_grid.message.current_row_no_copyable_content",
      "data_grid.copy_sql.error.missing_safe_where",
      "data_grid.copy_sql.error.no_copyable_fields",
    ];
    const modeKeys = [
      "data_grid.copy_sql.error.missing_table_name",
    ];
    const allKeys = [...detailKeys, ...noPlaceholderKeys, ...modeKeys];
    const base = catalogs["en-US"] as Record<string, string>;

    for (const language of SUPPORTED_LANGUAGES) {
      const catalog = catalogs[language] as Record<string, string>;
      for (const key of allKeys) {
        expect(catalog).toHaveProperty(key);
        expect(catalog[key]).toBeTruthy();
        expect(getPlaceholders(catalog[key])).toEqual(getPlaceholders(base[key]));
      }

      detailKeys.forEach((key) => {
        expect(getPlaceholders(catalog[key])).toEqual(["detail"]);
      });
      noPlaceholderKeys.forEach((key) => {
        expect(getPlaceholders(catalog[key])).toEqual([]);
      });
      modeKeys.forEach((key) => {
        expect(getPlaceholders(catalog[key])).toEqual(["mode"]);
      });
    }

    expect(t("en-US", "data_grid.message.commit_failed", { detail: "<raw-detail>" })).toContain("<raw-detail>");
    expect(t("en-US", "data_grid.message.rollback_failed", { detail: "<raw-rollback-detail>" })).toContain("<raw-rollback-detail>");
    expect(t("zh-CN", "data_grid.message.preview_sql_failed_detail", { detail: "<raw-preview-error>" })).toContain("<raw-preview-error>");
    expect(t("de-DE", "data_grid.copy_sql.error.missing_table_name", { mode: "UPDATE" })).toContain("UPDATE");
  });

  it("keeps DataGrid Preview SQL Modal chrome in catalogs while preserving raw SQL operation labels", () => {
    const noPlaceholderKeys = [
      "data_grid.preview_sql.title",
      "data_grid.preview_sql.copied",
      "data_grid.preview_sql.no_changes",
    ];
    const summaryKey = "data_grid.preview_sql.summary";
    const allKeys = [...noPlaceholderKeys, summaryKey];
    const base = catalogs["en-US"] as Record<string, string>;

    for (const language of SUPPORTED_LANGUAGES) {
      const catalog = catalogs[language] as Record<string, string>;
      for (const key of allKeys) {
        expect(catalog).toHaveProperty(key);
        expect(catalog[key]).toBeTruthy();
        expect(getPlaceholders(catalog[key])).toEqual(getPlaceholders(base[key]));
      }

      noPlaceholderKeys.forEach((key) => {
        expect(getPlaceholders(catalog[key])).toEqual([]);
      });
      expect(getPlaceholders(catalog[summaryKey])).toEqual(["deletes", "inserts", "updates"]);
      expect(catalog[summaryKey]).toContain("DELETE");
      expect(catalog[summaryKey]).toContain("UPDATE");
      expect(catalog[summaryKey]).toContain("INSERT");
    }

    const zhSummary = t("zh-CN", summaryKey, {
      deletes: "<raw-deletes>",
      updates: "<raw-updates>",
      inserts: "<raw-inserts>",
    });
    expect(zhSummary).toContain("<raw-deletes>");
    expect(zhSummary).toContain("<raw-updates>");
    expect(zhSummary).toContain("<raw-inserts>");
    expect(t("en-US", "data_grid.preview_sql.copied")).toBe("Copied");
  });

  it("keeps QueryEditor format settings menu labels in catalogs instead of source literals", () => {
    const formatMenuKeys = [
      "query_editor.format.keyword_upper",
      "query_editor.format.keyword_lower",
      "query_editor.format.snippet_settings",
      "query_editor.format.shortcut_settings",
    ] as const;
    const source = readQueryEditorSource();
    const formatMenuSource = sliceBetween(
      source,
      "const formatSettingsMenu: MenuProps['items'] = [",
      "const splitSQLStatements = (",
    );

    for (const language of SUPPORTED_LANGUAGES) {
      for (const key of formatMenuKeys) {
        expect(catalogs[language]).toHaveProperty(key);
        expect(catalogs[language][key]).toBeTruthy();
      }
    }

    for (const key of formatMenuKeys) {
    }

    assertSourceDoesNotInlineCatalogValues(formatMenuSource, formatMenuKeys);
  });

  it("keeps QueryEditor format and SQL insert toasts in catalogs instead of source literals", () => {
    const toastKeys = [
      "query_editor.message.format_failed",
      "query_editor.message.insert_success",
      "query_editor.message.append_success",
    ] as const;
    const source = readQueryEditorSource();
    const formatCatchSource = sliceBetween(
      source,
      "} catch (e) {",
      "const handleAIAction = (action: 'generate' | 'explain' | 'optimize' | 'schema') => {",
    );
    const insertSqlEffectSource = sliceBetween(
      source,
      "const handleInsertSql = (e: any) => {",
      "const resolveDefaultQueryName = () => {",
    );

    for (const language of SUPPORTED_LANGUAGES) {
      for (const key of toastKeys) {
        expect(catalogs[language]).toHaveProperty(key);
        expect(catalogs[language][key]).toBeTruthy();
      }
    }
  });

  it("keeps QueryEditor local editor interaction toasts in catalogs instead of source literals", () => {
    const toastKeys = [
      "query_editor.message.current_line_no_copyable_content",
      "data_grid.message.copied_to_clipboard",
      "connection_modal.message.copy_failed",
      "query_editor.message.object_info_target_not_found",
    ] as const;
    const source = readQueryEditorSource();
    const selectStatementSource = sliceBetween(
      source,
      "const handleSelectCurrentStatement = async () => {",
      "  const syncQueryToEditor = (sql: string) => {",
    );
    const objectInfoActionSource = sliceBetween(
      source,
      "      objectHoverActionRef.current = editor.addAction({",
      "      editor.onDidChangeCursorPosition?.((event: any) => {",
    );

    for (const language of SUPPORTED_LANGUAGES) {
      for (const key of toastKeys) {
        expect(catalogs[language]).toHaveProperty(key);
        expect(catalogs[language][key]).toBeTruthy();
      }
    }

    assertSourceDoesNotInlineCatalogValues(selectStatementSource, [
      "query_editor.message.current_line_no_copyable_content",
      "data_grid.message.copied_to_clipboard",
      "connection_modal.message.copy_failed",
    ]);
    assertSourceDoesNotInlineCatalogValues(objectInfoActionSource, ["query_editor.message.object_info_target_not_found"]);
  });

  it("keeps QueryEditor run and cancel guard messages in catalogs instead of source literals", () => {
    const guardKeys = [
      "query_editor.message.no_executable_sql",
      "query_editor.message.select_database_first",
      "query_editor.message.connection_not_found",
      "query_editor.message.unsupported_source",
      "query_editor.message.cancel_no_running",
      "query_editor.message.cancel_success",
      "query_editor.message.cancel_failed",
    ] as const;
    const source = readQueryEditorSource();
    const handleRunSource = sliceBetween(
      source,
      "const handleRun = async (runScope: QueryEditorRunScope = 'default') => {",
      "  const handleCancel = async () => {",
    );
    const handleCancelSource = sliceBetween(
      source,
      "  const handleCancel = async () => {",
      "  useEffect(() => {",
    );

    for (const language of SUPPORTED_LANGUAGES) {
      for (const key of guardKeys) {
        expect(catalogs[language]).toHaveProperty(key);
        expect(catalogs[language][key]).toBeTruthy();
      }
    }

    assertSourceDoesNotInlineCatalogValues(handleRunSource, guardKeys);
    assertSourceDoesNotInlineCatalogValues(handleCancelSource, guardKeys);
  });

  it("keeps QueryEditor execution toasts in catalogs instead of source literals", () => {
    const executionToastKeys = [
      "query_editor.message.execution_success",
      "query_editor.message.execution_multi_success",
      "query_editor.message.execution_result_sets_success",
      "query_editor.message.execution_failed_with_error",
    ] as const;
    const source = readQueryEditorSource();
    const handleRunSource = sliceBetween(
      source,
      "const handleRun = async (runScope: QueryEditorRunScope = 'default') => {",
      "  const handleCancel = async () => {",
    );

    for (const language of SUPPORTED_LANGUAGES) {
      for (const key of executionToastKeys) {
        expect(catalogs[language]).toHaveProperty(key);
        expect(catalogs[language][key]).toBeTruthy();
      }

      expect(getPlaceholders(catalogs[language]["query_editor.message.execution_multi_success"])).toEqual(["results", "statements"]);
      expect(getPlaceholders(catalogs[language]["query_editor.message.execution_result_sets_success"])).toEqual(["results"]);
      expect(getPlaceholders(catalogs[language]["query_editor.message.execution_failed_with_error"])).toEqual(["error"]);
    }

    for (const key of executionToastKeys) {
    }

    assertSourceDoesNotInlineCatalogValues(handleRunSource, executionToastKeys);
  });

  it("keeps QueryEditor multi-statement failure prefixes in catalogs instead of source literals", () => {
    const statementFailedPrefixKey = "query_editor.message.statement_failed_prefix" as const;
    const source = readQueryEditorSource();
    const handleRunSource = sliceBetween(
      source,
      "const handleRun = async (runScope: QueryEditorRunScope = 'default') => {",
      "  const handleCancel = async () => {",
    );

    for (const language of SUPPORTED_LANGUAGES) {
      expect(catalogs[language]).toHaveProperty(statementFailedPrefixKey);
      expect(catalogs[language][statementFailedPrefixKey]).toBeTruthy();
      expect(getPlaceholders(catalogs[language][statementFailedPrefixKey])).toEqual(["index"]);
    }
    assertSourceDoesNotInlineCatalogValues(handleRunSource, [statementFailedPrefixKey]);
  });

  it("keeps QueryEditor refresh failure toast in catalogs instead of source literals", () => {
    const refreshToastKeys = [
      "query_editor.message.refresh_failed",
      "common.unknown",
    ] as const;
    const source = readQueryEditorSource();
    const handleReloadSource = sliceBetween(
      source,
      "  const handleReloadResult = async (resultKey: string, sql: string) => {",
      "  const handleRun = async (runScope: QueryEditorRunScope = 'default') => {",
    );

    for (const language of SUPPORTED_LANGUAGES) {
      for (const key of refreshToastKeys) {
        expect(catalogs[language]).toHaveProperty(key);
        expect(catalogs[language][key]).toBeTruthy();
      }

      expect(getPlaceholders(catalogs[language]["query_editor.message.refresh_failed"])).toEqual(["error"]);
    }

    for (const key of refreshToastKeys) {
    }

    assertSourceDoesNotInlineCatalogValues(handleReloadSource, refreshToastKeys);
  });

  it("keeps QueryEditor export sql file toasts in catalogs instead of source literals", () => {
    const exportSqlFileToastKeys = [
      "query_editor.message.export_sql_file_success",
      "query_editor.message.export_sql_file_failed",
      "common.unknown",
    ] as const;
    const source = readQueryEditorSource();
    const handleExportSQLFileSource = sliceBetween(
      source,
      "  const handleExportSQLFile = async () => {",
      "  const saveMoreMenuItems: MenuProps['items'] = [",
    );

    for (const language of SUPPORTED_LANGUAGES) {
      for (const key of exportSqlFileToastKeys) {
        expect(catalogs[language]).toHaveProperty(key);
        expect(catalogs[language][key]).toBeTruthy();
      }

      expect(getPlaceholders(catalogs[language]["query_editor.message.export_sql_file_success"])).toEqual([]);
      expect(getPlaceholders(catalogs[language]["query_editor.message.export_sql_file_failed"])).toEqual(["error"]);
    }

    for (const key of exportSqlFileToastKeys) {
    }

    assertSourceDoesNotInlineCatalogValues(handleExportSQLFileSource, exportSqlFileToastKeys);
  });

  it("keeps QueryEditor hover shortcut hints in catalogs instead of source literals", () => {
    const hoverKeys = [
      "query_editor.hover.switch_database_with_shortcut",
      "query_editor.hover.open_table_with_shortcut",
      "query_editor.hover.locate_table_with_shortcut",
      "query_editor.hover.open_view_with_shortcut",
      "query_editor.hover.open_materialized_view_with_shortcut",
      "query_editor.hover.open_trigger_with_shortcut",
      "query_editor.hover.open_procedure_with_shortcut",
      "query_editor.hover.open_function_with_shortcut",
      "query_editor.hover.open_sequence_with_shortcut",
      "query_editor.hover.open_package_with_shortcut",
    ] as const;
    const source = readQueryEditorHelpersSource();
    const hoverMessageSource = sliceBetween(
      source,
      "const hoverMessage = (() => {",
      "    return [{",
    );

    for (const language of SUPPORTED_LANGUAGES) {
      for (const key of hoverKeys) {
        expect(catalogs[language]).toHaveProperty(key);
        expect(catalogs[language][key]).toBeTruthy();
        expect(getPlaceholders(catalogs[language][key])).toEqual(["shortcut"]);
      }
    }

    for (const key of hoverKeys) {
    }

    assertSourceDoesNotInlineCatalogValues(hoverMessageSource, hoverKeys);
  });

  it("keeps QueryEditor table and column hover markdown in catalogs instead of source literals", () => {
    const tableAndColumnHoverKeys = [
      "query_editor.object_info.table",
      "query_editor.object_info.column",
      "query_editor.object_info.label.database",
      "query_editor.object_info.label.table",
      "query_editor.object_info.label.type",
      "query_editor.object_info.label.schema",
    ] as const;
    const tableAndColumnHoverSeparatorKey = "query_editor.object_info.label.separator" as const;
    const source = readQueryEditorHelpersSource();
    const hoverMarkdownSource = sliceBetween(
      source,
      "const buildQueryEditorHoverMarkdown = (target: QueryEditorHoverTarget): string => {",
      "const buildQueryEditorAliasMap = (",
    );
    const tableCaseSource = sliceBetween(
      hoverMarkdownSource,
      "        case 'table':",
      "        case 'view':",
    );
    const columnCaseSource = sliceBetween(
      hoverMarkdownSource,
      "        case 'column':",
      "        default:",
    );

    for (const language of SUPPORTED_LANGUAGES) {
      for (const key of [...tableAndColumnHoverKeys, tableAndColumnHoverSeparatorKey]) {
        expect(catalogs[language]).toHaveProperty(key);
        expect(catalogs[language][key]).toBeTruthy();
        expect(getPlaceholders(catalogs[language][key])).toEqual([]);
      }
    }

    const scopedHoverMarkdownSource = `${tableCaseSource}\n${columnCaseSource}`;

    for (const key of tableAndColumnHoverKeys) {
    }

    assertSourceDoesNotInlineCatalogValues(scopedHoverMarkdownSource, tableAndColumnHoverKeys);
  });

  it("keeps QueryEditor view and materialized view hover markdown in catalogs instead of source literals", () => {
    const viewHoverKeys = [
      "sidebar.object.view",
      "query_editor.object_info.materialized_view",
      "query_editor.object_info.label.database",
      "query_editor.object_info.label.schema",
    ] as const;
    const viewHoverSeparatorKey = "query_editor.object_info.label.separator" as const;
    const source = readQueryEditorHelpersSource();
    const hoverMarkdownSource = sliceBetween(
      source,
      "const buildQueryEditorHoverMarkdown = (target: QueryEditorHoverTarget): string => {",
      "const buildQueryEditorAliasMap = (",
    );
    const viewCaseSource = sliceBetween(
      hoverMarkdownSource,
      "        case 'view':",
      "        case 'materialized-view':",
    );
    const materializedViewCaseSource = sliceBetween(
      hoverMarkdownSource,
      "        case 'materialized-view':",
      "        case 'trigger':",
    );

    for (const language of SUPPORTED_LANGUAGES) {
      for (const key of [...viewHoverKeys, viewHoverSeparatorKey]) {
        expect(catalogs[language]).toHaveProperty(key);
        expect(catalogs[language][key]).toBeTruthy();
        expect(getPlaceholders(catalogs[language][key])).toEqual([]);
      }
    }

    for (const key of viewHoverKeys) {
    }

    assertSourceDoesNotInlineCatalogValues(`${viewCaseSource}\n${materializedViewCaseSource}`, viewHoverKeys);
  });

  it("keeps QueryEditor trigger hover markdown in catalogs instead of source literals", () => {
    const triggerHoverKeys = [
      "trigger_viewer.field.trigger",
      "query_editor.object_info.label.database",
      "query_editor.object_info.label.table",
      "query_editor.object_info.label.schema",
    ] as const;
    const triggerHoverSeparatorKey = "query_editor.object_info.label.separator" as const;
    const source = readQueryEditorHelpersSource();
    const hoverMarkdownSource = sliceBetween(
      source,
      "const buildQueryEditorHoverMarkdown = (target: QueryEditorHoverTarget): string => {",
      "const buildQueryEditorAliasMap = (",
    );
    const triggerCaseSource = sliceBetween(
      hoverMarkdownSource,
      "        case 'trigger':",
      "        case 'routine':",
    );

    for (const language of SUPPORTED_LANGUAGES) {
      for (const key of [...triggerHoverKeys, triggerHoverSeparatorKey]) {
        expect(catalogs[language]).toHaveProperty(key);
        expect(catalogs[language][key]).toBeTruthy();
        expect(getPlaceholders(catalogs[language][key])).toEqual([]);
      }
    }

    for (const key of triggerHoverKeys) {
    }

    assertSourceDoesNotInlineCatalogValues(triggerCaseSource, triggerHoverKeys);
  });

  it("keeps QueryEditor routine hover markdown in catalogs instead of source literals", () => {
    const routineHoverKeys = [
      "sidebar.object.procedure",
      "sidebar.object.function",
      "query_editor.object_info.label.database",
      "query_editor.object_info.label.schema",
    ] as const;
    const routineHoverSeparatorKey = "query_editor.object_info.label.separator" as const;
    const source = readQueryEditorHelpersSource();
    const hoverMarkdownSource = sliceBetween(
      source,
      "const buildQueryEditorHoverMarkdown = (target: QueryEditorHoverTarget): string => {",
      "const buildQueryEditorAliasMap = (",
    );
    const routineCaseSource = sliceBetween(
      hoverMarkdownSource,
      "        case 'routine':",
      "        case 'column':",
    );

    for (const language of SUPPORTED_LANGUAGES) {
      for (const key of [...routineHoverKeys, routineHoverSeparatorKey]) {
        expect(catalogs[language]).toHaveProperty(key);
        expect(catalogs[language][key]).toBeTruthy();
        expect(getPlaceholders(catalogs[language][key])).toEqual([]);
      }
    }

    for (const key of routineHoverKeys) {
    }

    assertSourceDoesNotInlineCatalogValues(routineCaseSource, routineHoverKeys);
  });

  it("keeps QueryEditor database hover markdown in catalogs instead of source literals", () => {
    const databaseHoverKeys = [
      "query_editor.object_info.database",
    ] as const;
    const source = readQueryEditorHelpersSource();
    const hoverMarkdownSource = sliceBetween(
      source,
      "const buildQueryEditorHoverMarkdown = (target: QueryEditorHoverTarget): string => {",
      "const buildQueryEditorAliasMap = (",
    );
    const databaseCaseSource = sliceBetween(
      hoverMarkdownSource,
      "        case 'database':",
      "        case 'table':",
    );

    for (const language of SUPPORTED_LANGUAGES) {
      for (const key of databaseHoverKeys) {
        expect(catalogs[language]).toHaveProperty(key);
        expect(catalogs[language][key]).toBeTruthy();
        expect(getPlaceholders(catalogs[language][key])).toEqual([]);
      }
    }

    for (const key of databaseHoverKeys) {
    }

    assertSourceDoesNotInlineCatalogValues(databaseCaseSource, databaseHoverKeys);
  });

  it("keeps QueryEditor completion comment documentation prefix in catalogs instead of source literals", () => {
    const completionCommentKey = "query_editor.completion.documentation.comment" as const;
    const source = readQueryEditorHelpersSource();
    const completionDocumentationSource = sliceBetween(
      source,
      "const buildCompletionDocumentation = (comment?: string): string | undefined => {",
      "const appendCommentToDetail = (detail: string, comment?: string): string => {",
    );

    for (const language of SUPPORTED_LANGUAGES) {
      expect(catalogs[language]).toHaveProperty(completionCommentKey);
      expect(catalogs[language][completionCommentKey]).toBeTruthy();
      expect(getPlaceholders(catalogs[language][completionCommentKey])).toEqual(["comment"]);
    }

    expect(t("zh-CN", completionCommentKey, { comment: "主键ID" })).toBe("备注：主键ID");
    expect(t("en-US", completionCommentKey, { comment: "主键ID" })).toBe("Comment: 主键ID");
    assertSourceDoesNotInlineCatalogValues(completionDocumentationSource, [completionCommentKey]);
  });

  it("keeps sqlDialect common function completion detail keys in catalogs instead of inline Chinese", () => {
    const detailKeys = [
      "query_editor.completion.detail.aggregate",
      "query_editor.completion.action.count",
      "query_editor.completion.action.concatenation",
      "query_editor.completion.action.row_number",
    ] as const;
    const source = readSqlDialectSource();
    const commonFunctionsSource = sliceBetween(
      source,
      "const COMMON_FUNCTIONS = [",
      "const MYSQL_FUNCTIONS = [",
    );

    for (const language of SUPPORTED_LANGUAGES) {
      for (const key of detailKeys) {
        expect(catalogs[language]).toHaveProperty(key);
        expect(catalogs[language][key]).toBeTruthy();
      }
    }

    for (const key of detailKeys) {
    }
    assertSourceDoesNotInlineCatalogValues(commonFunctionsSource, detailKeys, {
      ignoreEnglishBaseline: true,
    });
  });

  it("keeps sqlDialect mysql and starrocks function completion detail keys in catalogs instead of inline Chinese", () => {
    const detailKeys = [
      "query_editor.completion.action.group_concatenation",
      "query_editor.completion.action.bitmap_construction",
      "query_editor.completion.action.json_string_extraction",
    ] as const;
    const source = readSqlDialectSource();
    const mysqlFunctionsSource = sliceBetween(
      source,
      "const MYSQL_FUNCTIONS = [",
      "const PG_FUNCTIONS = [",
    );
    const starrocksFunctionsSource = sliceBetween(
      source,
      "const STARROCKS_FUNCTIONS = [",
      "const TDENGINE_FUNCTIONS = [",
    );
    const groupedSource = `${mysqlFunctionsSource}\n${starrocksFunctionsSource}`;

    for (const language of SUPPORTED_LANGUAGES) {
      for (const key of detailKeys) {
        expect(catalogs[language]).toHaveProperty(key);
        expect(catalogs[language][key]).toBeTruthy();
      }
    }

    for (const key of detailKeys) {
    }
    assertSourceDoesNotInlineCatalogValues(groupedSource, detailKeys, {
      ignoreEnglishBaseline: true,
    });
  });

  it("keeps sqlDialect postgresql and oracle function completion detail keys in catalogs instead of inline Chinese", () => {
    const detailKeys = [
      "query_editor.completion.action.string_aggregation",
      "query_editor.completion.action.null_replacement",
      "query_editor.completion.action.regex_replace",
    ] as const;
    const source = readSqlDialectSource();
    const groupedSource = sliceBetween(
      source,
      "const PG_FUNCTIONS = [",
      "const SQLSERVER_FUNCTIONS = [",
    );

    for (const language of SUPPORTED_LANGUAGES) {
      for (const key of detailKeys) {
        expect(catalogs[language]).toHaveProperty(key);
        expect(catalogs[language][key]).toBeTruthy();
      }
    }

    for (const key of detailKeys) {
    }
    assertSourceDoesNotInlineCatalogValues(groupedSource, detailKeys, {
      ignoreEnglishBaseline: true,
    });
  });

  it("keeps sqlDialect sql server and sqlite function completion detail keys in catalogs instead of inline Chinese", () => {
    const detailKeys = [
      "query_editor.completion.action.current_date_time",
      "query_editor.completion.action.try_conversion",
      "query_editor.completion.action.json_value_extraction",
    ] as const;
    const source = readSqlDialectSource();
    const groupedSource = sliceBetween(
      source,
      "const SQLSERVER_FUNCTIONS = [",
      "const DUCKDB_FUNCTIONS = [",
    );

    for (const language of SUPPORTED_LANGUAGES) {
      for (const key of detailKeys) {
        expect(catalogs[language]).toHaveProperty(key);
        expect(catalogs[language][key]).toBeTruthy();
      }
    }

    for (const key of detailKeys) {
    }
    assertSourceDoesNotInlineCatalogValues(groupedSource, detailKeys, {
      ignoreEnglishBaseline: true,
    });
  });

  it("keeps sqlDialect duckdb clickhouse and tdengine function completion detail keys in catalogs instead of inline Chinese", () => {
    const detailKeys = [
      "query_editor.completion.action.struct_construction",
      "query_editor.completion.action.date_formatting",
      "query_editor.completion.action.time_difference",
      "query_editor.completion.action.instant_rate_of_change",
    ] as const;
    const source = readSqlDialectSource();
    const groupedSource = sliceBetween(
      source,
      "const DUCKDB_FUNCTIONS = [",
      "const mergeFunctions = (",
    );

    for (const language of SUPPORTED_LANGUAGES) {
      for (const key of detailKeys) {
        expect(catalogs[language]).toHaveProperty(key);
        expect(catalogs[language][key]).toBeTruthy();
      }
    }

    for (const key of detailKeys) {
    }
    assertSourceDoesNotInlineCatalogValues(groupedSource, detailKeys, {
      ignoreEnglishBaseline: true,
    });
  });

  it("keeps builtin function completion action labels localized beyond the english baseline in ja-JP de-DE and ru-RU", () => {
    const actionKeys = [
      "query_editor.completion.action.absolute_value",
      "query_editor.completion.action.bitmap_construction",
      "query_editor.completion.action.group_concatenation",
    ] as const;

    for (const language of ["ja-JP", "de-DE", "ru-RU"] as const) {
      for (const key of actionKeys) {
        expect(catalogs[language]).toHaveProperty(key);
        expect(catalogs[language][key]).toBeTruthy();
        expect(catalogs[language][key]).not.toBe(catalogs["en-US"][key]);
      }
    }
  });

  it("keeps QueryEditor database-qualified table completion detail labels in catalogs instead of source literals", () => {
    const tableLabelKey = "query_editor.object_info.table" as const;
    const source = readQueryEditorSource();
    const databaseQualifiedTableCompletionSource = sliceBetween(
      source,
      "                  // 首先检查 qualifier 是否是数据库名（跨库表提示）",
      "                  // qualifier 是 schema（如 dbo/public）时，仅补全表名，避免输入 dbo. 后再补成 dbo.dbo.table",
    );
    const databaseQualifiedTableDetailSource = sliceBetween(
      databaseQualifiedTableCompletionSource,
      "                          detail: appendCommentToDetail(",
      "                          documentation: buildCompletionDocumentation(table.comment),",
    );

    for (const language of SUPPORTED_LANGUAGES) {
      expect(catalogs[language]).toHaveProperty(tableLabelKey);
      expect(catalogs[language][tableLabelKey]).toBeTruthy();
      expect(getPlaceholders(catalogs[language][tableLabelKey])).toEqual([]);
    }

    expect(t("zh-CN", tableLabelKey)).toBe("表");
    expect(t("en-US", tableLabelKey)).toBe("Table");

    assertSourceDoesNotInlineCatalogValues(databaseQualifiedTableDetailSource, [tableLabelKey]);
  });

  it("keeps QueryEditor schema-qualified table completion detail labels in catalogs instead of source literals", () => {
    const tableLabelKey = "query_editor.object_info.table" as const;
    const source = readQueryEditorSource();
    const schemaQualifiedTableCompletionSource = sliceBetween(
      source,
      "                  // qualifier 是 schema（如 dbo/public）时，仅补全表名，避免输入 dbo. 后再补成 dbo.dbo.table",
      "                  // 否则检查是否是表别名或表名，提示列",
    );
    const schemaQualifiedTableDetailSource = sliceBetween(
      schemaQualifiedTableCompletionSource,
      "                          detail: appendCommentToDetail(",
      "                          documentation: buildCompletionDocumentation(table.comment),",
    );

    for (const language of SUPPORTED_LANGUAGES) {
      expect(catalogs[language]).toHaveProperty(tableLabelKey);
      expect(catalogs[language][tableLabelKey]).toBeTruthy();
      expect(getPlaceholders(catalogs[language][tableLabelKey])).toEqual([]);
    }

    expect(t("zh-CN", tableLabelKey)).toBe("表");
    expect(t("en-US", tableLabelKey)).toBe("Table");

    assertSourceDoesNotInlineCatalogValues(schemaQualifiedTableDetailSource, [tableLabelKey]);
  });

  it("keeps QueryEditor global cross-db table completion detail labels in catalogs instead of source literals", () => {
    const tableLabelKey = "query_editor.object_info.table" as const;
    const source = readQueryEditorSource();
    const globalCrossDbTableCompletionSource = sliceBetween(
      source,
      "              // 表提示：当前库智能处理 schema.table 格式",
      "                      const hasDuplicate = (",
    );
    const globalCrossDbTableDetailSource = sliceBetween(
      globalCrossDbTableCompletionSource,
      "                              detail: appendCommentToDetail(",
      "                              documentation: buildCompletionDocumentation(table.comment),",
    );

    for (const language of SUPPORTED_LANGUAGES) {
      expect(catalogs[language]).toHaveProperty(tableLabelKey);
      expect(catalogs[language][tableLabelKey]).toBeTruthy();
      expect(getPlaceholders(catalogs[language][tableLabelKey])).toEqual([]);
    }

    expect(t("zh-CN", tableLabelKey)).toBe("表");
    expect(t("en-US", tableLabelKey)).toBe("Table");

    assertSourceDoesNotInlineCatalogValues(globalCrossDbTableDetailSource, [tableLabelKey]);
  });

  it("keeps QueryEditor current-db table completion detail labels in catalogs instead of source literals", () => {
    const tableLabelKey = "query_editor.object_info.table" as const;
    const source = readQueryEditorSource();
    const currentDbTableCompletionSource = sliceBetween(
      source,
      "                      const hasDuplicate = (",
      "              const buildGlobalViewBatch =",
    );
    const currentDbTableDetailSource = sliceBetween(
      currentDbTableCompletionSource,
      "                      detail: appendCommentToDetail(",
      "                      documentation: buildCompletionDocumentation(table.comment),",
    );

    for (const language of SUPPORTED_LANGUAGES) {
      expect(catalogs[language]).toHaveProperty(tableLabelKey);
      expect(catalogs[language][tableLabelKey]).toBeTruthy();
      expect(getPlaceholders(catalogs[language][tableLabelKey])).toEqual([]);
    }

    expect(t("zh-CN", tableLabelKey)).toBe("表");
    expect(t("en-US", tableLabelKey)).toBe("Table");

    assertSourceDoesNotInlineCatalogValues(currentDbTableDetailSource, [tableLabelKey]);
  });

  it("keeps QueryEditor database suggestion detail labels in catalogs instead of source literals", () => {
    const databaseLabelKey = "query_editor.object_info.database" as const;
    const source = readQueryEditorSource();
    const databaseSuggestionSource = sliceBetween(
      source,
      "              // 数据库提示",
      "              // 关键字提示",
    );
    const databaseSuggestionDetailSource = sliceBetween(
      databaseSuggestionSource,
      "                      detail:",
      "                      range,",
    );

    for (const language of SUPPORTED_LANGUAGES) {
      expect(catalogs[language]).toHaveProperty(databaseLabelKey);
      expect(catalogs[language][databaseLabelKey]).toBeTruthy();
      expect(getPlaceholders(catalogs[language][databaseLabelKey])).toEqual([]);
    }

    expect(t("zh-CN", databaseLabelKey)).toBe("数据库");
    expect(t("en-US", databaseLabelKey)).toBe("Database");

    assertSourceDoesNotInlineCatalogValues(databaseSuggestionDetailSource, [databaseLabelKey]);
  });

  it("keeps the all-columns edit hint in catalogs instead of source literals", () => {
    const allColumnsHintKey = "data_viewer.edit_hint.all_columns_locator" as const;
    const rowLocatorSource = readRowLocatorSource();
    const helpersSource = readQueryEditorHelpersSource();
    const buildAllColumnsLocatorSource = sliceBetween(
      rowLocatorSource,
      "export const buildAllColumnsLocator = (",
      "export const resolveEditRowLocator = ({",
    );

    for (const language of SUPPORTED_LANGUAGES) {
      expect(catalogs[language]).toHaveProperty(allColumnsHintKey);
      expect(catalogs[language][allColumnsHintKey]).toBeTruthy();
      expect(getPlaceholders(catalogs[language][allColumnsHintKey])).toEqual([]);
    }

    expect(t("zh-CN", allColumnsHintKey)).toBe("未检测到主键或唯一索引，将使用全列匹配定位行，请谨慎编辑。");
    expect(t("en-US", allColumnsHintKey)).toBe("No primary key or unique index was detected, so rows will be located by matching all columns. Edit with care.");

    assertSourceDoesNotInlineCatalogValues(rowLocatorSource, [allColumnsHintKey]);
    assertSourceDoesNotInlineCatalogValues(helpersSource, [allColumnsHintKey]);
  });

  it("keeps QueryEditor AI context menu labels in catalogs instead of source literals", () => {
    const actionLabelKeys = [
      "query_editor.action.ai_generate_sql_menu",
      "query_editor.action.ai_explain_sql_menu",
      "query_editor.action.ai_optimize_sql_menu",
    ] as const;
    const source = readQueryEditorSource();
    const aiActionsSource = sliceBetween(
      source,
      "  const buildQueryEditorAiContextMenuActions = useCallback(() => ([",
      "  const disposeQueryEditorAiContextMenuActions = useCallback(() => {",
    );

    for (const language of SUPPORTED_LANGUAGES) {
      for (const key of actionLabelKeys) {
        expect(catalogs[language]).toHaveProperty(key);
        expect(catalogs[language][key]).toBeTruthy();
      }
    }

    for (const key of actionLabelKeys) {
    }

    assertSourceDoesNotInlineCatalogValues(aiActionsSource, actionLabelKeys);
  });

  it("keeps QueryEditor SQL snippet picker copy in catalogs instead of source literals", () => {
    const snippetPickerKeys = [
      "query_editor.action.insert_sql_snippet",
      "query_editor.snippet_picker.title",
      "query_editor.snippet_picker.description",
      "query_editor.snippet_picker.search_placeholder",
      "query_editor.snippet_picker.empty",
      "query_editor.snippet_picker.empty_filtered",
      "query_editor.snippet_picker.manage",
      "snippet_settings.tag.builtin",
    ] as const;
    const snippetPickerLiteralGuardKeys = [
      "query_editor.action.insert_sql_snippet",
      "query_editor.snippet_picker.title",
      "query_editor.snippet_picker.description",
      "query_editor.snippet_picker.search_placeholder",
      "query_editor.snippet_picker.empty",
      "query_editor.snippet_picker.empty_filtered",
      "query_editor.snippet_picker.manage",
    ] as const;
    const source = readQueryEditorSource();

    for (const language of SUPPORTED_LANGUAGES) {
      for (const key of snippetPickerKeys) {
        expect(catalogs[language]).toHaveProperty(key);
        expect(catalogs[language][key]).toBeTruthy();
      }
    }

    for (const key of snippetPickerKeys) {
    }

    assertSourceDoesNotInlineCatalogValues(source, snippetPickerLiteralGuardKeys);
  });

  it("keeps QueryEditor AI prompt context in catalogs instead of source literals", () => {
    const aiContextKeys = [
      "query_editor.ai_prompt.default_source",
      "query_editor.ai_prompt.default_database",
      "query_editor.ai_prompt.context",
    ] as const;
    const source = readQueryEditorSource();
    const aiContextSource = sliceBetween(
      source,
      "const buildQueryEditorAiContextPrompt = (connection: any, database: string): string => {",
      "// HMR 重载时释放旧注册避免补全和 hover 内容重复",
    );

    for (const language of SUPPORTED_LANGUAGES) {
      for (const key of aiContextKeys) {
        expect(catalogs[language]).toHaveProperty(key);
        expect(catalogs[language][key]).toBeTruthy();
      }
    }

    for (const key of aiContextKeys) {
    }

    assertSourceDoesNotInlineCatalogValues(aiContextSource, aiContextKeys);
  });

  it("keeps QueryEditor AI context menu prompts in catalogs instead of source literals", () => {
    const promptKeys = [
      "query_editor.ai_prompt.generate",
      "query_editor.ai_prompt.explain",
      "query_editor.ai_prompt.optimize",
    ] as const;
    const source = readQueryEditorSource();
    const aiActionsSource = sliceBetween(
      source,
      "  const buildQueryEditorAiContextMenuActions = useCallback(() => ([",
      "  const disposeQueryEditorAiContextMenuActions = useCallback(() => {",
    );

    for (const language of SUPPORTED_LANGUAGES) {
      for (const key of promptKeys) {
        expect(catalogs[language]).toHaveProperty(key);
        expect(catalogs[language][key]).toBeTruthy();
      }
    }

    for (const key of promptKeys) {
    }

    assertSourceDoesNotInlineCatalogValues(aiActionsSource, promptKeys);
  });

  it("keeps QueryEditor slash command definitions in catalogs instead of source literals", () => {
    const slashKeys = [
      "query_editor.slash_command.query.label",
      "query_editor.slash_command.query.description",
      "query_editor.slash_command.query.prompt",
      "query_editor.slash_command.sql.label",
      "query_editor.slash_command.sql.description",
      "query_editor.slash_command.sql.prompt",
      "query_editor.slash_command.schema.label",
      "query_editor.slash_command.schema.description",
      "query_editor.slash_command.schema.prompt",
      "query_editor.slash_command.index.label",
      "query_editor.slash_command.index.description",
      "query_editor.slash_command.index.prompt",
      "query_editor.slash_command.diff.label",
      "query_editor.slash_command.diff.description",
      "query_editor.slash_command.diff.prompt",
      "query_editor.slash_command.mock.label",
      "query_editor.slash_command.mock.description",
      "query_editor.slash_command.mock.prompt",
      "query_editor.slash_command.explain.label",
      "query_editor.slash_command.explain.description",
      "query_editor.slash_command.explain.prompt",
      "query_editor.slash_command.optimize.label",
      "query_editor.slash_command.optimize.description",
      "query_editor.slash_command.optimize.prompt",
    ] as const;
    const source = readQueryEditorSource();
    const slashDefinitionsSource = sliceBetween(
      source,
      "  const buildQueryEditorSlashCommandDefs = useCallback(() => ([",
      "  const refreshQueryEditorSlashCommandDefs = useCallback(() => {",
    );

    for (const language of SUPPORTED_LANGUAGES) {
      for (const key of slashKeys) {
        expect(catalogs[language]).toHaveProperty(key);
        expect(catalogs[language][key]).toBeTruthy();
      }
    }

    for (const key of slashKeys) {
    }

    assertSourceDoesNotInlineCatalogValues(slashDefinitionsSource, slashKeys);
  });

  it("keeps QueryEditor toolbar and diagnose AI prompts in catalogs instead of source literals", () => {
    const toolbarPromptKeys = [
      "query_editor.ai_prompt.generate",
      "query_editor.ai_prompt.explain",
      "query_editor.ai_prompt.optimize",
      "query_editor.ai_prompt.schema",
    ] as const;
    const diagnosePromptKeys = [
      "query_editor.ai_prompt.diagnose",
    ] as const;
    const source = readQueryEditorSource();
    const toolbarPromptSource = sliceBetween(
      source,
      "  const handleAIAction = (action: 'generate' | 'explain' | 'optimize' | 'schema') => {",
      "  const formatSettingsMenu: MenuProps['items'] = [",
    );
    const diagnosePromptSource = sliceBetween(
      source,
      "  const handleDiagnoseExecutionError = () => {",
      "  const sqlEditorTransactionToolbar = (",
    );
    const toolbarAndDiagnoseSource = `${toolbarPromptSource}\n${diagnosePromptSource}`;

    for (const language of SUPPORTED_LANGUAGES) {
      for (const key of [...toolbarPromptKeys, ...diagnosePromptKeys]) {
        expect(catalogs[language]).toHaveProperty(key);
        expect(catalogs[language][key]).toBeTruthy();
      }
    }

    for (const key of toolbarPromptKeys) {
    }

    assertSourceDoesNotInlineCatalogValues(toolbarAndDiagnoseSource, [
      ...toolbarPromptKeys,
      ...diagnosePromptKeys,
    ]);
  });

  it("keeps QueryEditor Monaco action labels in catalogs instead of source literals", () => {
    const actionLabelKeys = [
      "app.shortcuts.action.duplicateCurrentLine.label",
      "query_editor.action.insert_sql_snippet",
      "app.shortcuts.action.runQuery.label",
      "app.shortcuts.action.selectCurrentStatement.label",
      "app.shortcuts.action.saveQuery.label",
      "app.shortcuts.action.saveQueryAs.label",
      "query_editor.action.show_object_info",
      "query_editor.action.run_selected_sql",
      "query_editor.action.run_all_sql",
    ] as const;
    const source = readQueryEditorSource();
    const actionLabelSource = [
      sliceBetween(
        source,
        "      objectHoverActionRef.current = editor.addAction({",
        "      editor.onDidChangeCursorPosition?.((event: any) => {",
      ),
      sliceBetween(
        source,
        "  const registerInsertSqlSnippetContextMenuAction = useCallback((editor: any) => {",
        "  // SQL 诊断 / 慢 SQL 历史的快捷键监听（必须在 binding 声明之后）",
      ),
      sliceBetween(
        source,
        "      // Register runQuery shortcut inside Monaco so it overrides Monaco's default keybinding",
        "      // HMR 重载或测试重置时，以全局状态为准，避免本地闭包状态和 provider 列表不同步。",
      ),
      sliceBetween(
        source,
        "      const binding = runQueryShortcutBinding;",
        "  }, [activeShortcutPlatform, languagePreference, runQueryShortcutBinding]);",
      ),
      sliceBetween(
        source,
        "      const binding = selectCurrentStatementShortcutBinding;",
        "  }, [activeShortcutPlatform, languagePreference, selectCurrentStatementShortcutBinding, handleSelectCurrentStatement]);",
      ),
      sliceBetween(
        source,
        "      const binding = duplicateCurrentLineShortcutBinding;",
        "  }, [activeShortcutPlatform, duplicateCurrentLineShortcutBinding, handleDuplicateCurrentLine, languagePreference]);",
      ),
      sliceBetween(
        source,
        "      const binding = saveQueryShortcutBinding;",
        "  }, [activeShortcutPlatform, languagePreference, saveQueryShortcutBinding]);",
      ),
      sliceBetween(
        source,
        "      const binding = saveQueryAsShortcutBinding;",
        "  }, [activeShortcutPlatform, currentSavedQuery, languagePreference, saveQueryAsShortcutBinding, tab.filePath]);",
      ),
    ].join("\n");

    for (const language of SUPPORTED_LANGUAGES) {
      for (const key of actionLabelKeys) {
        expect(catalogs[language]).toHaveProperty(key);
        expect(catalogs[language][key]).toBeTruthy();
        expect(getPlaceholders(catalogs[language][key])).toEqual([]);
      }
    }

    for (const key of actionLabelKeys) {
    }

    assertSourceDoesNotInlineCatalogValues(actionLabelSource, actionLabelKeys);
  });

  it("keeps QueryEditor object navigation tab titles in catalogs instead of source literals", () => {
    const objectTabTitleKeys = [
      "definition_viewer.edit.tab_title",
      "definition_viewer.object.view",
      "definition_viewer.object.materialized_view",
      "definition_viewer.object.sequence",
      "definition_viewer.object.package",
      "trigger_viewer.tab.edit_trigger_title",
      "sidebar.tab.edit_routine",
      "sidebar.object.procedure",
      "sidebar.object.function",
    ] as const;
    const source = readQueryEditorSource();
    const objectNavigationSource = [
      sliceBetween(
        source,
        "const buildQueryEditorEditableDefinitionSql = (",
        "const buildQueryEditorAiContextPrompt = (",
      ),
      sliceBetween(
        source,
        "  const openRoutineObjectEditTab = useCallback(async (",
        "  // Setup Autocomplete and Editor",
      ),
    ].join("\n");

    for (const language of SUPPORTED_LANGUAGES) {
      for (const key of objectTabTitleKeys) {
        expect(catalogs[language]).toHaveProperty(key);
        expect(catalogs[language][key]).toBeTruthy();
      }

      expect([...getPlaceholders(catalogs[language]["definition_viewer.edit.tab_title"])].sort()).toEqual(["name", "object"]);
      expect(getPlaceholders(catalogs[language]["definition_viewer.object.view"])).toEqual([]);
      expect(getPlaceholders(catalogs[language]["definition_viewer.object.materialized_view"])).toEqual([]);
      expect(getPlaceholders(catalogs[language]["definition_viewer.object.sequence"])).toEqual([]);
      expect(getPlaceholders(catalogs[language]["definition_viewer.object.package"])).toEqual([]);
      expect(getPlaceholders(catalogs[language]["trigger_viewer.tab.edit_trigger_title"])).toEqual(["name"]);
      expect([...getPlaceholders(catalogs[language]["sidebar.tab.edit_routine"])].sort()).toEqual(["name", "type"]);
      expect(getPlaceholders(catalogs[language]["sidebar.object.procedure"])).toEqual([]);
      expect(getPlaceholders(catalogs[language]["sidebar.object.function"])).toEqual([]);
    }

    for (const key of objectTabTitleKeys) {
    }

    assertSourceDoesNotInlineCatalogValues(objectNavigationSource, [
      "definition_viewer.edit.tab_title",
      "trigger_viewer.tab.edit_trigger_title",
      "sidebar.tab.edit_routine",
    ]);
  });

  it("guards QueryEditor V2 empty state against inlining any catalog literal into source", () => {
    const emptyStateKeys = [
      "query_editor.empty_state.title",
      "query_editor.empty_state.description",
    ] as const;
    const inlineSource = [
      `<strong>${catalogs["en-US"]["query_editor.empty_state.title"]}</strong>`,
      `<span>${catalogs["en-US"]["query_editor.empty_state.description"]}</span>`,
    ].join("");

    expect(() => {
      assertSourceDoesNotInlineCatalogValues(inlineSource, emptyStateKeys);
    }).toThrowError(/catalog literal/i);
  });

  it("keeps QueryEditor V2 empty state copy in catalogs instead of source literals", () => {
    const emptyStateKeys = [
      "query_editor.empty_state.title",
      "query_editor.empty_state.description",
    ] as const;
    const source = readQueryEditorResultsPanelSource();
    const emptyStateSource = sliceBetween(
      source,
      "<div className={isV2Ui ? 'gn-v2-query-empty' : undefined}",
      "                    </>",
    );

    for (const language of SUPPORTED_LANGUAGES) {
      for (const key of emptyStateKeys) {
        expect(catalogs[language]).toHaveProperty(key);
        expect(catalogs[language][key]).toBeTruthy();
      }
    }

    for (const key of emptyStateKeys) {
    }

    assertSourceDoesNotInlineCatalogValues(emptyStateSource, emptyStateKeys);
  });
});
