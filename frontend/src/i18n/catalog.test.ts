import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { catalogs, t } from "./catalog";
import { SUPPORTED_LANGUAGES } from "./resolveLanguage";
import {
    APP_THEME_SETTINGS_MODULES,
    DATA_GRID_COMPONENT_MODULES,
    QUERY_EDITOR_COMPONENT_MODULES,
    QUERY_EDITOR_HELPER_MODULES,
} from "../test/splitSourceModules";

const getPlaceholders = (value: string): string[] =>
  Array.from(value.matchAll(/\{\{([A-Za-z0-9_]+)\}\}/g), (match) => match[1]).sort();

const readSourceFile = (relativePath: string): string =>
  readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");

const readSourceFiles = (base: string, files: readonly string[]): string =>
  files.map((file) => readFileSync(new URL(`${base}${file}`, import.meta.url), "utf8")).join("\n");

const readDataGridSource = (): string => readSourceFiles("../components/", DATA_GRID_COMPONENT_MODULES);

const readDataGridColumnInfoPopoverContentSource = (): string => readSourceFile("components/DataGridColumnInfoPopoverContent.tsx");

const readDataGridColumnQuickFindSource = (): string => readSourceFile("components/DataGridColumnQuickFind.tsx");

const readDataGridColumnTitleSource = (): string => readSourceFile("components/DataGridColumnTitle.tsx");

const readDataGridModalsSource = (): string => readSourceFile("components/DataGridModals.tsx");

const readDataGridPageFindSource = (): string => readSourceFile("components/DataGridPageFind.tsx");

const readDataGridPaginationBarSource = (): string => readSourceFile("components/DataGridPaginationBar.tsx");

const readDataGridPaginationSource = (): string => readSourceFile("utils/dataGridPagination.ts");

const readDataGridPreviewPanelSource = (): string => readSourceFile("components/DataGridPreviewPanel.tsx");

const readDataGridRecordViewsSource = (): string => readSourceFile("components/DataGridRecordViews.tsx");

const readDataGridResultViewSwitcherSource = (): string => readSourceFile("components/DataGridResultViewSwitcher.tsx");

const readDataGridSecondaryActionsSource = (): string => readSourceFile("components/DataGridSecondaryActions.tsx");

const readDataGridV2DdlWorkspaceSource = (): string => readSourceFile("components/DataGridV2DdlWorkspace.tsx");

const readQueryEditorSource = (): string => readSourceFiles("../components/", QUERY_EDITOR_COMPONENT_MODULES);

// 主题设置面板已拆为 useAppThemeSettingsRender 与各分区组件
const readAppThemeSettingsSource = (): string => readSourceFiles("../", APP_THEME_SETTINGS_MODULES);

const readQueryEditorHelpersSource = (): string => readSourceFiles("../components/queryEditor/", QUERY_EDITOR_HELPER_MODULES);

const readQueryEditorAiContextSource = (): string => readSourceFile("components/queryEditor/queryEditorAiContext.ts");

const readQueryEditorAiSqlInsertSource = (): string => readSourceFile("components/queryEditor/queryEditorAiSqlInsert.ts");

const readQueryEditorResultsPanelSource = (): string => readSourceFile("components/QueryEditorResultsPanel.tsx");

// sqlDialect.ts 已按主题拆成多个模块，源码扫描需按原顺序聚合。
const readSqlDialectSource = (): string =>
  ["sqlDialect.ts", "sqlDialectCore.ts", "sqlDialectColumnTypes.ts", "sqlDialectKeywords.ts", "sqlDialectFunctions.ts"]
    .map((file) => readFileSync(new URL(`../utils/${file}`, import.meta.url), "utf8"))
    .join("\n");

const readRowLocatorSource = (): string => readSourceFile("utils/rowLocator.ts");

const sliceBetween = (source: string, start: string, end: string): string => {
  const normalizedSource = source.replace(/\r\n/g, "\n");
  const startIndex = normalizedSource.indexOf(start);
  const endIndex = normalizedSource.indexOf(end, startIndex + start.length);

  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);

  return normalizedSource.slice(startIndex, endIndex);
};

// 切片起点用「函数名 + 参数开头」的正则锚定，而不是写死完整签名：
// handleRun 一类函数的参数会随功能演进增删（如新增 runOptions），
// 写死签名会让 indexOf 静默返回 -1、切片落到错误区间，断言随之失效。
const sliceFromFunctionStart = (source: string, declaration: string, end: string): string => {
  const normalizedSource = source.replace(/\r\n/g, "\n");
  const pattern = new RegExp(`^\\s*(?:const|function)\\s+${declaration}\\b[^\\n]*\\{`, "m");
  const match = pattern.exec(normalizedSource);

  expect(match).not.toBeNull();
  const startIndex = match!.index;
  const endIndex = normalizedSource.indexOf(end, startIndex + match![0].length);

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
  // 只剥离整行 // 注释：行尾注释可能与字符串里的 "//"（如 URL）混淆，不处理。
  const executableSource = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
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
  it("renders the table alias setting in theme settings", () => {
    const v2Source = readAppThemeSettingsSource();

    expect(v2Source).toContain("app.theme.table_alias.title");
    expect(v2Source).toContain("app.theme.table_alias.description");
    expect(v2Source).toContain("setAppearance({ autoAddTableAlias: checked })");
    expect(v2Source).toContain("app.theme.table_alias.custom_prefix.title");
    expect(v2Source).toContain("app.theme.table_alias.custom_prefix.description");
    expect(v2Source).toContain("app.theme.table_alias.custom_prefix.placeholder");
    expect(v2Source).toContain("setAppearance({ customTableAliasPrefixEnabled: checked })");
    expect(v2Source).toContain("setAppearance({ customTableAliasPrefix: event.target.value })");
  });

  it("keeps DataGrid column controls in catalogs while preserving raw metadata parameters", () => {
    const dataGridColumnControlKeys = [
      "data_grid.column.type_tooltip",
      "data_grid.column.comment_tooltip",
      "data_grid.column.foreign_key_tooltip",
      "data_grid.column.foreign_key_jump_title",
      "data_grid.column.primary_key_tooltip",
      "data_grid.column.unique_key_tooltip",
      "data_grid.column.index_tooltip",
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
    expect(t("zh-CN", "data_grid.column.primary_key_tooltip")).toBe("主键");
    expect(t("zh-CN", "data_grid.column.unique_key_tooltip")).toBe("唯一索引");
    expect(t("zh-CN", "data_grid.column.index_tooltip")).toBe("索引");
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
      "data_grid.pagination.page_size_custom",
      "data_grid.pagination.page_size_custom_label",
      "data_grid.pagination.page_size_custom_invalid",
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
      "data_grid.cell_editor.escape",
      "data_grid.cell_editor.unescape",
      "data_grid.cell_editor.invalid_unescape",
      "data_grid.cell_viewer.title_with_column",
      "data_grid.context_menu.edit_cell_in_editor",
      "data_grid.batch_fill.title",
      "data_grid.batch_fill.set_null",
      "data_grid.batch_fill.set_null_selected",
      "data_grid.batch_fill.value_placeholder",
      "data_grid.json_editor.title",
      "data_grid.json_editor.description",
      "data_grid.json_editor.format",
      "data_grid.json_editor.compact",
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
    expect(t("zh-CN", "data_grid.json_editor.compact")).toContain("JSON");
    expect(t("zh-CN", "data_grid.json_editor.invalid_format", { error: "<raw-json-error>" })).toContain("<raw-json-error>");
    expect(getPlaceholders(catalogs["en-US"]["data_grid.json_editor.invalid_format"])).toEqual(["error"]);
    expect(t("zh-CN", "data_grid.cell_editor.escape")).toBe("转义");
    expect(t("zh-CN", "data_grid.cell_editor.unescape")).toBe("去转义");
    expect(t("en-US", "data_grid.cell_editor.invalid_unescape", { error: "<raw-unescape-error>" })).toContain("<raw-unescape-error>");
    expect(getPlaceholders(catalogs["en-US"]["data_grid.cell_editor.invalid_unescape"])).toEqual(["error"]);
    assertSourceDoesNotInlineCatalogValues(detachedChromeSource, dataGridDetachedChromeKeys, { ignoreEnglishBaseline: true });
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
    // AI 注入 SQL 的实现已从 QueryEditor.tsx 抽到 queryEditorAiSqlInsert.ts，
    // 锚点必须跟着落到新文件，否则切片会静默失配。
    const insertSqlEffectSource = sliceBetween(
      readQueryEditorAiSqlInsertSource(),
      "export const createAiSqlInsertHandler",
      "export const useAiSqlInsertToTabListener",
    );

    for (const language of SUPPORTED_LANGUAGES) {
      for (const key of toastKeys) {
        expect(catalogs[language]).toHaveProperty(key);
        expect(catalogs[language][key]).toBeTruthy();
      }
    }

    assertSourceDoesNotInlineCatalogValues(formatCatchSource, ["query_editor.message.format_failed"]);
    assertSourceDoesNotInlineCatalogValues(insertSqlEffectSource, [
      "query_editor.message.insert_success",
      "query_editor.message.append_success",
    ]);
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
      "    editor.onDidChangeCursorPosition?.((event: any) => {",
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
    const handleRunSource = sliceFromFunctionStart(
      source,
      "handleRun",
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
    const handleRunSource = sliceFromFunctionStart(
      source,
      "handleRun",
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
    const handleRunSource = sliceFromFunctionStart(
      source,
      "handleRun",
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
      "  const handleReloadResult = async (",
      "  const handleRun = async (",
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

  it("keeps QueryEditor database-qualified table completion detail labels in catalogs instead of source literals", () => {
    const tableLabelKey = "query_editor.object_info.table" as const;
    const source = readQueryEditorSource();
    const databaseQualifiedTableCompletionSource = sliceBetween(
      source,
      "    // 首先检查 qualifier 是否是数据库名（跨库表提示）",
      "    // qualifier 是 schema（如 dbo/public）时，仅补全表名，避免输入 dbo. 后再补成 dbo.dbo.table",
    );
    const databaseQualifiedTableDetailSource = sliceBetween(
      databaseQualifiedTableCompletionSource,
      "                    detail: appendCommentToDetail(",
      "                    documentation: buildCompletionDocumentation(table.comment),",
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
      "    // qualifier 是 schema（如 dbo/public）时，仅补全表名，避免输入 dbo. 后再补成 dbo.dbo.table",
      "    // 否则检查是否是表别名或表名，提示列",
    );
    const schemaQualifiedTableDetailSource = sliceBetween(
      schemaQualifiedTableCompletionSource,
      "                detail: appendCommentToDetail(",
      "                documentation: buildCompletionDocumentation(table.comment),",
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
      "    // 表提示：当前库智能处理 schema.table 格式",
      "            const hasDuplicate = (",
    );
    const globalCrossDbTableDetailSource = sliceBetween(
      globalCrossDbTableCompletionSource,
      "                    detail: appendCommentToDetail(",
      "                    documentation: buildCompletionDocumentation(table.comment),",
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
      "            const hasDuplicate = (",
      "    const buildGlobalViewBatch =",
    );
    const currentDbTableDetailSource = sliceBetween(
      currentDbTableCompletionSource,
      "                detail: appendCommentToDetail(",
      "                documentation: buildCompletionDocumentation(table.comment),",
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
      "    // 数据库提示",
      "    // 关键字提示",
    );
    const databaseSuggestionDetailSource = sliceBetween(
      databaseSuggestionSource,
      "            detail:",
      "            range,",
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
      "query_editor.ai_prompt.default_version",
      "query_editor.ai_prompt.context",
    ] as const;
    const aiContextSource = sliceBetween(
      readQueryEditorAiContextSource(),
      "export const buildQueryEditorAiContextPrompt = (",
      "  return translate('query_editor.ai_prompt.context', {",
    );

    for (const language of SUPPORTED_LANGUAGES) {
      for (const key of aiContextKeys) {
        expect(catalogs[language]).toHaveProperty(key);
        expect(catalogs[language][key]).toBeTruthy();
      }
      expect(getPlaceholders(catalogs[language]["query_editor.ai_prompt.context"])).toEqual([
        "database",
        "name",
        "type",
        "version",
      ]);
    }

    assertSourceDoesNotInlineCatalogValues(aiContextSource, [
      "query_editor.ai_prompt.default_version",
      "query_editor.ai_prompt.context",
    ]);
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
        "    editor.onDidChangeCursorPosition?.((event: any) => {",
      ),
      sliceBetween(
        source,
        "  const registerInsertSqlSnippetContextMenuAction = useCallback((editor: any) => {",
        "  // SQL 诊断 / 慢 SQL 历史的快捷键监听（必须在 binding 声明之后）",
      ),
      sliceBetween(
        source,
        "    // Register runQuery shortcut inside Monaco so it overrides Monaco's default keybinding",
        "    // HMR 重载或测试重置时，以全局状态为准，避免本地闭包状态和 provider 列表不同步。",
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
        "      duplicateCurrentLineActionRef.current = registerQueryEditorShortcutAction({",
        "  }, [activeShortcutPlatform, duplicateCurrentLineShortcutBinding, handleDuplicateCurrentLine, languagePreference]);",
      ),
      sliceBetween(
        source,
        "      saveQueryActionRef.current = registerQueryEditorShortcutAction({",
        "  }, [activeShortcutPlatform, languagePreference, saveQueryShortcutBinding]);",
      ),
      sliceBetween(
        source,
        "      saveQueryAsActionRef.current = registerQueryEditorShortcutAction({",
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
        "const SQL_COMPLETION_PROVIDER_VERSION = '20260831-hover-ddl-v6';",
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

  it("keeps QueryEditor V2 empty state copy in catalogs instead of source literals", () => {
    const emptyStateKeys = [
      "query_editor.empty_state.title",
      "query_editor.empty_state.description",
    ] as const;
    const source = readQueryEditorResultsPanelSource();
    const emptyStateSource = sliceBetween(
      source,
      '<div className="gn-v2-query-empty"',
      "                    </>",
    );

    for (const language of SUPPORTED_LANGUAGES) {
      for (const key of emptyStateKeys) {
        expect(catalogs[language]).toHaveProperty(key);
        expect(catalogs[language][key]).toBeTruthy();
      }
    }

    assertSourceDoesNotInlineCatalogValues(emptyStateSource, emptyStateKeys);
  });
});
