import React from "react";
import { Button, Dropdown, Select, Tooltip, type MenuProps } from "antd";
import {
  BulbOutlined,
  CheckOutlined,
  DatabaseOutlined,
  DiffOutlined,
  EyeInvisibleOutlined,
  EyeOutlined,
  FileTextOutlined,
  PlayCircleOutlined,
  SearchOutlined,
  ThunderboltOutlined,
} from "@ant-design/icons";
import AiSparkOutlined from "./icons/AiSparkOutlined";
import {
  GnChevronDownIcon,
  GnFormatIcon,
  GnMoreIcon,
  GnSaveIcon,
  GnSettingsIcon,
  GnWrapIcon,
} from "./icons/gnIcons";

import { t as defaultTranslate } from '../i18n';
import { useOptionalI18n } from '../i18n/provider';
import type { ConnectionDisplaySortMode, ConnectionTag, SavedConnection } from "../types";
import { flattenSidebarConnectionTagTree } from './sidebarV2Utils';
import {
  getShortcutDisplayLabel,
  type ShortcutPlatform,
  type ShortcutPlatformBinding,
} from "../utils/shortcuts";
import QueryEditorTransactionSettings, {
  type SqlEditorCommitMode,
} from "./QueryEditorTransactionSettings";
import { renderV2ActionMenuPopup } from './common/V2ActionMenuPopup';
import { QueryEditorToolbarRunAction } from './queryEditor/QueryEditorToolbarRunAction';
import QueryEditorToolbarMaxRowsSelect from './queryEditor/QueryEditorToolbarMaxRowsSelect';
import { QueryEditorToolbarAnalysisAction } from './queryEditor/QueryEditorToolbarAnalysisAction';

export type QueryEditorMode = "sql" | "elasticsearch";

export type QueryEditorSchemaSelectProps = {
  value: string;
  options: string[];
  loading?: boolean;
  disabled?: boolean;
  onChange: (schemaName: string) => void;
};

export type QueryEditorToolbarProps = {
  editorMode?: QueryEditorMode;
  currentConnectionId: string;
  currentDb: string;
  queryCapableConnections: SavedConnection[];
  connectionTags?: ConnectionTag[];
  sidebarRootOrder?: string[];
  rootSortMode?: ConnectionTag['sortMode'];
  rootConnectionSortMode?: ConnectionDisplaySortMode;
  dbList: string[];
  schemaSelect?: QueryEditorSchemaSelectProps;
  maxRows: number;
  sqlEditorCommitMode: SqlEditorCommitMode;
  sqlEditorAutoCommitDelayMs: number;
  pendingTransactionToolbar: React.ReactNode;
  runQueryShortcutBinding: ShortcutPlatformBinding;
  saveQueryShortcutBinding: ShortcutPlatformBinding;
  formatSqlShortcutBinding: ShortcutPlatformBinding;
  triggerSqlAiCompletionShortcutBinding: ShortcutPlatformBinding;
  toggleQueryResultsPanelShortcutBinding: ShortcutPlatformBinding;
  activeShortcutPlatform: ShortcutPlatform;
  isResultPanelVisible: boolean;
  wordWrapEnabled: boolean;
  loading: boolean;
  contextSelectionDisabled?: boolean;
  runDisabled?: boolean;
  saveMoreMenuItems: MenuProps["items"];
  /** 「历史与诊断」入口菜单项；缺省时不渲染该入口 */
  analysisMenuItems?: MenuProps["items"];
  formatSettingsMenu: MenuProps["items"];
  formatSettingsSelectedKeys?: string[];
  templateMenuItems?: MenuProps["items"];
  onConnectionChange: (connectionId: string) => void;
  onDatabaseChange: (dbName: string) => void;
  onMaxRowsChange: (maxRows: number) => void;
  onCommitModeChange: (mode: SqlEditorCommitMode) => void;
  onAutoCommitDelayMsChange: (delayMs: number) => void;
  onCaptureEditorCursorPosition: () => void;
  onRun: () => void;
  onRunAll?: () => void;
  onCancel: () => void;
  onQuickSave: () => void;
  onFindInEditor: () => void;
  onToggleWordWrap: () => void;
  onFormat: () => void;
  onTriggerSqlAiCompletion: () => void;
  onToggleResultPanelVisibility: () => void;
  onAIAction: (action: "generate" | "explain" | "optimize" | "schema") => void;
  /** 编辑器全屏/还原按钮（由调用方注入，避免本文件继续膨胀） */
  editorFullscreenAction?: React.ReactNode;
  /** object-edit 视图：验证数据变化入口 */
  showViewDataVerify?: boolean;
  onViewDataVerify?: () => void;
};

const FULL_NAME_TOOLTIP_DELAY_SECONDS = 1;

type FullNameSelectOption = {
  label: string;
  value: string;
  title: string;
  fullName: string;
};

type QueryToolbarMenuKey = "ai" | "more" | "format" | "templates" | "analysis";

const normalizeV2ActionMenuItems = (
  items: MenuProps["items"],
  fallbackIcon: React.ReactNode,
): MenuProps["items"] => {
  const normalized: NonNullable<MenuProps["items"]> = [];
  const appendDivider = () => {
    if (normalized.length > 0 && (normalized[normalized.length - 1] as { type?: string }).type !== "divider") {
      normalized.push({ type: "divider" });
    }
  };
  const appendItem = (item: any) => {
    if (!item) return;
    if (item.type === "divider") {
      appendDivider();
      return;
    }
    if (item.type === "group") {
      const children = (item.children ?? []).filter(Boolean);
      if (children.length > 0) {
        appendDivider();
        children.forEach(appendItem);
      }
      return;
    }
    normalized.push({ ...item, icon: item.icon ?? fallbackIcon });
  };

  (items ?? []).forEach(appendItem);
  if ((normalized[normalized.length - 1] as { type?: string } | undefined)?.type === "divider") {
    normalized.pop();
  }
  return normalized;
};

const renderFullNameSelectTooltip = (fullName: React.ReactNode) => {
  const fullNameText = String(fullName ?? "");

  return (
    <Tooltip
      title={fullNameText}
      mouseEnterDelay={FULL_NAME_TOOLTIP_DELAY_SECONDS}
      placement="topLeft"
    >
      <span
        className="gn-query-toolbar-select-full-name"
        aria-label={fullNameText}
      >
        {fullNameText}
      </span>
    </Tooltip>
  );
};

const QueryEditorToolbar: React.FC<QueryEditorToolbarProps> = ({
  editorMode = "sql",
  currentConnectionId,
  currentDb,
  queryCapableConnections,
  connectionTags = [],
  sidebarRootOrder = [],
  rootSortMode = 'manual',
  rootConnectionSortMode = 'createdAt',
  dbList,
  schemaSelect,
  maxRows,
  sqlEditorCommitMode,
  sqlEditorAutoCommitDelayMs,
  pendingTransactionToolbar,
  runQueryShortcutBinding,
  saveQueryShortcutBinding,
  formatSqlShortcutBinding,
  triggerSqlAiCompletionShortcutBinding,
  toggleQueryResultsPanelShortcutBinding,
  activeShortcutPlatform,
  isResultPanelVisible,
  wordWrapEnabled,
  loading,
  contextSelectionDisabled = false,
  runDisabled = false,
  saveMoreMenuItems,
  analysisMenuItems,
  formatSettingsMenu,
  formatSettingsSelectedKeys = [],
  templateMenuItems,
  onConnectionChange,
  onDatabaseChange,
  onMaxRowsChange,
  onCommitModeChange,
  onAutoCommitDelayMsChange,
  onCaptureEditorCursorPosition,
  onRun,
  onRunAll,
  onCancel,
  onQuickSave,
  onFindInEditor,
  onToggleWordWrap,
  onFormat,
  onTriggerSqlAiCompletion,
  onToggleResultPanelVisibility,
  onAIAction,
  editorFullscreenAction,
  showViewDataVerify = false,
  onViewDataVerify,
}) => {
  const i18n = useOptionalI18n();
  const t = i18n?.t ?? defaultTranslate;
  const isElasticsearchMode = editorMode === "elasticsearch";
  const [openToolbarMenu, setOpenToolbarMenu] = React.useState<QueryToolbarMenuKey | null>(null);
  const updateToolbarMenuOpen = (key: QueryToolbarMenuKey, open: boolean) => {
    setOpenToolbarMenu((current) => open ? key : current === key ? null : current);
  };
  const baseMoreMenuItems = saveMoreMenuItems ?? [];
  const orderedQueryCapableConnections = React.useMemo(
    () => flattenSidebarConnectionTagTree(
      queryCapableConnections,
      connectionTags,
      sidebarRootOrder,
      rootSortMode,
      rootConnectionSortMode,
    ),
    [connectionTags, queryCapableConnections, rootConnectionSortMode, rootSortMode, sidebarRootOrder],
  );
  const connectionSelectOptions: FullNameSelectOption[] =
    orderedQueryCapableConnections.map((connection) => ({
      label: connection.name,
      value: connection.id,
      title: "",
      fullName: connection.name,
    }));
  const databaseSelectOptions: FullNameSelectOption[] = dbList.map((db) => ({
    label: db,
    value: db,
    title: "",
    fullName: db,
  }));
  const schemaSelectOptions: FullNameSelectOption[] = (schemaSelect?.options ?? []).map((schema) => ({
    label: schema,
    value: schema,
    title: "",
    fullName: schema,
  }));
  const toggleResultPanelShortcutLabel =
    toggleQueryResultsPanelShortcutBinding.enabled &&
    toggleQueryResultsPanelShortcutBinding.combo
      ? getShortcutDisplayLabel(
          toggleQueryResultsPanelShortcutBinding.combo,
          activeShortcutPlatform,
        )
      : "";
  const toggleResultPanelTitle =
    toggleQueryResultsPanelShortcutBinding.enabled &&
    toggleQueryResultsPanelShortcutBinding.combo
      ? t(
          isResultPanelVisible
            ? "query_editor.action.hide_results_panel_with_shortcut"
            : "query_editor.action.show_results_panel_with_shortcut",
          { shortcut: toggleResultPanelShortcutLabel },
        )
      : isResultPanelVisible
        ? t("query_editor.action.hide_results_panel")
        : t("query_editor.action.show_results_panel");
  const formatSqlTitle =
    !isElasticsearchMode && formatSqlShortcutBinding.enabled && formatSqlShortcutBinding.combo
      ? t("query_editor.action.format_sql_with_shortcut", {
          shortcut: getShortcutDisplayLabel(
            formatSqlShortcutBinding.combo,
            activeShortcutPlatform,
          ),
        })
      : t(isElasticsearchMode
          ? "query_editor.elasticsearch.action.format"
          : "query_editor.action.format_sql");
  const findInEditorShortcutCombo =
    activeShortcutPlatform === "mac" ? "Meta+F" : "Ctrl+F";
  const findInEditorTitle = t(
    "query_editor.action.find_in_editor_with_shortcut",
    {
      shortcut: getShortcutDisplayLabel(
        findInEditorShortcutCombo,
        activeShortcutPlatform,
      ),
    },
  );
  const triggerSqlAiCompletionLabel =
    triggerSqlAiCompletionShortcutBinding.enabled &&
    triggerSqlAiCompletionShortcutBinding.combo
      ? `${t("app.shortcuts.action.triggerSqlAiCompletion.label")} · ${getShortcutDisplayLabel(
          triggerSqlAiCompletionShortcutBinding.combo,
          activeShortcutPlatform,
        )}`
      : t("app.shortcuts.action.triggerSqlAiCompletion.label");
  const aiMoreTitle = isElasticsearchMode
    ? t("query_editor.elasticsearch.action.ai")
    : `AI · ${t("query_editor.action.more")}`;
  const formatSettingsTitle = `${t("query_editor.action.format_sql")} · ${t("settings.title")}`;
  const aiMenuItems: MenuProps["items"] = isElasticsearchMode
    ? [
        {
          key: "ai-generate",
          label: t("query_editor.elasticsearch.action.ai_generate"),
          icon: <FileTextOutlined />,
          onClick: () => onAIAction("generate"),
        },
      ]
    : [
        {
          key: "ai-inline-completion",
          label: triggerSqlAiCompletionLabel,
          icon: <AiSparkOutlined />,
          onClick: onTriggerSqlAiCompletion,
        },
        { type: "divider" as const },
        {
          key: "ai-generate",
          label: t("query_editor.action.ai_text_to_sql_menu"),
          icon: <FileTextOutlined />,
          onClick: () => onAIAction("generate"),
        },
        {
          key: "ai-explain",
          label: t("query_editor.action.ai_explain_sql_menu"),
          icon: <BulbOutlined />,
          onClick: () => onAIAction("explain"),
        },
        {
          key: "ai-optimize",
          label: t("query_editor.action.ai_optimize_sql_menu"),
          icon: <ThunderboltOutlined />,
          onClick: () => onAIAction("optimize"),
        },
        { type: "divider" as const },
        {
          key: "ai-schema",
          label: t("query_editor.action.ai_schema_analysis"),
          icon: <DatabaseOutlined />,
          onClick: () => onAIAction("schema"),
        },
      ];
  const moreMenuItems: MenuProps["items"] = [
        ...baseMoreMenuItems,
        {
          type: 'group',
          key: 'result-visibility',
          label: t('query_editor.action.results'),
          children: [{
            key: "toggle-result-panel",
            label: toggleResultPanelTitle,
            icon: isResultPanelVisible ? (
              <EyeInvisibleOutlined />
            ) : (
              <EyeOutlined />
            ),
            onClick: onToggleResultPanelVisibility,
          }],
        },
      ];
  const templateActionMenuItems = normalizeV2ActionMenuItems(templateMenuItems, <FileTextOutlined />);
  const aiActionMenuItems = normalizeV2ActionMenuItems(aiMenuItems, <AiSparkOutlined />);
  const moreActionMenuItems = normalizeV2ActionMenuItems(moreMenuItems, <GnMoreIcon />);
  const selectedFormatKeys = new Set(formatSettingsSelectedKeys);
  const markSelectedFormatItems = (items: MenuProps['items']): MenuProps['items'] => (items ?? []).map((item) => {
    if (!item || item.type === 'divider') {
      return item;
    }
    if (item.type === 'group') {
      return { ...item, children: markSelectedFormatItems(item.children) };
    }
    return {
      ...item,
      extra: selectedFormatKeys.has(String(item.key)) ? <CheckOutlined aria-label="selected" /> : undefined,
    };
  });
  const formatMenuItemsWithSelection = markSelectedFormatItems(formatSettingsMenu);
  const formatActionMenuItems = normalizeV2ActionMenuItems(formatMenuItemsWithSelection, <GnFormatIcon />);
  const selects = (
    <div
      className="gn-v2-query-toolbar-selects"
      style={{
        display: "flex",
        gap: "8px",
        flexShrink: 0,
        alignItems: "center",
      }}
    >
      <Select
        className="gn-v2-query-toolbar-select gn-v2-query-toolbar-connection-select"
        placeholder={t("query_editor.placeholder.connection")}
        value={currentConnectionId}
        disabled={isElasticsearchMode ? loading : contextSelectionDisabled}
        onChange={onConnectionChange}
        options={connectionSelectOptions}
        optionFilterProp="label"
        optionRender={(option) => renderFullNameSelectTooltip(option.data.fullName)}
        labelRender={(option) => renderFullNameSelectTooltip(option.label ?? option.value)}
        showSearch
      />
      <Select
        className="gn-v2-query-toolbar-select gn-v2-query-toolbar-database-select"
        placeholder={t(isElasticsearchMode
          ? "query_editor.elasticsearch.placeholder.index_optional"
          : "query_editor.placeholder.database")}
        value={currentDb}
        disabled={isElasticsearchMode ? loading : contextSelectionDisabled}
        onChange={(value) => onDatabaseChange(String(value || ""))}
        allowClear={isElasticsearchMode}
        options={databaseSelectOptions}
        optionFilterProp="label"
        optionRender={(option) => renderFullNameSelectTooltip(option.data.fullName)}
        labelRender={(option) => renderFullNameSelectTooltip(option.label ?? option.value)}
        showSearch
      />
      {!isElasticsearchMode && schemaSelect && (
        <Select
          aria-label={t("query_editor.object_info.label.schema")}
          className="gn-v2-query-toolbar-select gn-v2-query-toolbar-schema-select"
          placeholder={t("query_editor.object_info.label.schema")}
          value={schemaSelect.value || undefined}
          loading={schemaSelect.loading}
          disabled={schemaSelect.disabled}
          onChange={(value) => schemaSelect.onChange(String(value || ""))}
          options={schemaSelectOptions}
          optionFilterProp="label"
          optionRender={(option) => renderFullNameSelectTooltip(option.data.fullName)}
          labelRender={(option) => renderFullNameSelectTooltip(option.label ?? option.value)}
          showSearch
        />
      )}
      {isElasticsearchMode && Array.isArray(templateMenuItems) && templateMenuItems.length > 0 && (
        <Tooltip
          title={t("query_editor.elasticsearch.action.templates")}
          open={openToolbarMenu === "templates" ? false : undefined}
        >
          <span className="gn-v2-query-toolbar-menu-trigger">
            <Dropdown
                menu={{ items: templateActionMenuItems }}
                placement="bottomLeft"
                trigger={["click"]}
                rootClassName="gn-v2-titlebar-quick-dropdown gn-v2-action-menu-popup-host"
                popupRender={(menu) => renderV2ActionMenuPopup(menu, true, {
                  title: t('query_editor.elasticsearch.action.templates'),
                  showHeader: false,
                })}
                open={openToolbarMenu === "templates"}
              onOpenChange={(open) => updateToolbarMenuOpen("templates", open)}
            >
              <Button
                aria-label={t("query_editor.elasticsearch.action.templates")}
                className="gn-v2-query-toolbar-icon-action"
                icon={<GnChevronDownIcon />}
                aria-haspopup="menu"
                aria-expanded={openToolbarMenu === "templates"}
              />
            </Dropdown>
          </span>
        </Tooltip>
      )}
      {!isElasticsearchMode && (
        <>
          <QueryEditorToolbarMaxRowsSelect
            maxRows={maxRows}
            onMaxRowsChange={onMaxRowsChange}
          />
          <QueryEditorTransactionSettings
            commitMode={sqlEditorCommitMode}
            autoCommitDelayMs={sqlEditorAutoCommitDelayMs}
            onCommitModeChange={onCommitModeChange}
            onAutoCommitDelayMsChange={onAutoCommitDelayMsChange}
          />
        </>
      )}
    </div>
  );

  const actions = (
    <div
      className="gn-v2-query-toolbar-actions"
      style={{
        display: "flex",
        gap: "8px",
        flexShrink: 0,
        alignItems: "center",
      }}
    >
      <div
        className="gn-v2-query-toolbar-action-group"
        style={{ display: "flex", gap: "8px", alignItems: "center" }}
      >
        <QueryEditorToolbarRunAction
          title={
            isElasticsearchMode
              ? t("query_editor.elasticsearch.action.run_current")
              : runQueryShortcutBinding.enabled && runQueryShortcutBinding.combo
              ? t("query_editor.action.run_with_shortcut", {
                  shortcut: getShortcutDisplayLabel(
                    runQueryShortcutBinding.combo,
                    activeShortcutPlatform,
                  ),
                })
              : t("query_editor.action.run")
          }
          ariaLabel={t(isElasticsearchMode
            ? "query_editor.elasticsearch.action.run_current"
            : "query_editor.action.run")}
          stopTitle={t("query_editor.action.stop")}
          loading={loading}
          disabled={runDisabled}
          onCaptureEditorCursorPosition={onCaptureEditorCursorPosition}
          onRun={onRun}
          onCancel={onCancel}
        />
        {isElasticsearchMode && onRunAll && (
          <Tooltip title={t("query_editor.elasticsearch.action.run_all")}>
            <Button
              aria-label={t("query_editor.elasticsearch.action.run_all")}
              className="gn-v2-query-toolbar-icon-action"
              icon={<PlayCircleOutlined />}
              disabled={loading}
              onMouseDown={onCaptureEditorCursorPosition}
              onClick={onRunAll}
            />
          </Tooltip>
        )}
        {!isElasticsearchMode && showViewDataVerify && onViewDataVerify && (
          <Tooltip title={t("result_diff.view_verify.toolbar.tooltip")}>
            <Button
              aria-label={t("result_diff.view_verify.toolbar")}
              className="gn-v2-query-toolbar-icon-action"
              icon={<DiffOutlined />}
              disabled={loading}
              onClick={onViewDataVerify}
            />
          </Tooltip>
        )}
      </div>
      {!isElasticsearchMode && pendingTransactionToolbar}
      <div
        className="gn-v2-query-toolbar-action-pair"
        style={{ display: "flex", gap: "8px", alignItems: "center" }}
      >
        <Tooltip
          title={
            saveQueryShortcutBinding.enabled && saveQueryShortcutBinding.combo
              ? t("query_editor.action.save_with_shortcut", {
                  shortcut: getShortcutDisplayLabel(
                    saveQueryShortcutBinding.combo,
                    activeShortcutPlatform,
                  ),
                })
              : t("query_editor.action.save")
          }
        >
          <Button
            aria-label={t("query_editor.action.save")}
            className="gn-v2-query-toolbar-icon-action gn-v2-query-toolbar-save-action"
            type="default"
            icon={<GnSaveIcon />}
            onClick={onQuickSave}
          />
        </Tooltip>
        {isElasticsearchMode ? (
          <Tooltip
            title={aiMoreTitle}
            open={openToolbarMenu === "ai" ? false : undefined}
          >
            <span className="gn-v2-query-toolbar-menu-trigger">
              <Dropdown
                menu={{ items: aiActionMenuItems }}
                placement="bottomRight"
                trigger={["click"]}
                  rootClassName="gn-v2-titlebar-quick-dropdown gn-v2-action-menu-popup-host"
                popupRender={(menu) => renderV2ActionMenuPopup(menu, true, {
                  title: aiMoreTitle,
                  showHeader: false,
                })}
                open={openToolbarMenu === "ai"}
                onOpenChange={(open) => updateToolbarMenuOpen("ai", open)}
              >
                <Button
                  className="gn-v2-query-toolbar-icon-action gn-v2-query-toolbar-ai-action"
                  icon={<AiSparkOutlined />}
                  aria-label={aiMoreTitle}
                  aria-haspopup="menu"
                  aria-expanded={openToolbarMenu === "ai"}
                  onMouseDown={onCaptureEditorCursorPosition}
                />
              </Dropdown>
            </span>
          </Tooltip>
        ) : (
          <>
            <div style={{ display: "flex", gap: "4px", alignItems: "center" }}>
              <Tooltip title={triggerSqlAiCompletionLabel}>
                <Button
                  aria-label={triggerSqlAiCompletionLabel}
                  className="gn-v2-query-toolbar-icon-action gn-v2-query-toolbar-ai-action"
                  icon={<AiSparkOutlined />}
                  onMouseDown={onCaptureEditorCursorPosition}
                  onClick={onTriggerSqlAiCompletion}
                />
              </Tooltip>
              <Tooltip
                title={aiMoreTitle}
                open={openToolbarMenu === "ai" ? false : undefined}
              >
                <span className="gn-v2-query-toolbar-menu-trigger">
                  <Dropdown
                    menu={{ items: aiActionMenuItems }}
                    placement="bottomRight"
                    trigger={["click"]}
                    rootClassName="gn-v2-titlebar-quick-dropdown gn-v2-action-menu-popup-host"
                    popupRender={(menu) => renderV2ActionMenuPopup(menu, true, {
                      title: aiMoreTitle,
                      showHeader: false,
                    })}
                    open={openToolbarMenu === "ai"}
                    onOpenChange={(open) => updateToolbarMenuOpen("ai", open)}
                  >
                    <Button
                      className="gn-v2-query-toolbar-icon-action"
                      icon={<GnChevronDownIcon />}
                      aria-label={aiMoreTitle}
                      aria-haspopup="menu"
                      aria-expanded={openToolbarMenu === "ai"}
                      onMouseDown={onCaptureEditorCursorPosition}
                    />
                  </Dropdown>
                </span>
              </Tooltip>
            </div>
            {analysisMenuItems && (
              <QueryEditorToolbarAnalysisAction
                items={analysisMenuItems}
                open={openToolbarMenu === "analysis"}
                label={t("query_editor.action.analysis")}
                tooltip={t("query_editor.action.analysis_tooltip")}
                onOpenChange={(open) => updateToolbarMenuOpen("analysis", open)}
              />
            )}
            <Tooltip
              title={t("query_editor.action.more")}
              open={openToolbarMenu === "more" ? false : undefined}
            >
              <span className="gn-v2-query-toolbar-menu-trigger">
                <Dropdown
                  menu={{ items: moreActionMenuItems }}
                  placement="bottomRight"
                  trigger={["click"]}
                  rootClassName="gn-v2-titlebar-quick-dropdown gn-v2-action-menu-popup-host"
                  popupRender={(menu) => renderV2ActionMenuPopup(menu, true, {
                    title: t('query_editor.action.more'),
                    showHeader: false,
                  })}
                  open={openToolbarMenu === "more"}
                  onOpenChange={(open) => updateToolbarMenuOpen("more", open)}
                >
                  <Button
                    aria-label={t("query_editor.action.more")}
                    className="gn-v2-query-toolbar-icon-action"
                    icon={<GnMoreIcon />}
                    aria-haspopup="menu"
                    aria-expanded={openToolbarMenu === "more"}
                  />
                </Dropdown>
              </span>
            </Tooltip>
          </>
        )}
      </div>

      <div
        className="gn-v2-query-toolbar-action-pair"
        style={{ display: "flex", gap: "8px", alignItems: "center" }}
      >
        {!isElasticsearchMode && (
          <>
            <Tooltip title={findInEditorTitle}>
              <Button
                aria-label={t("query_editor.action.find_in_editor")}
                className="gn-v2-query-toolbar-icon-action"
                icon={<SearchOutlined />}
                onClick={onFindInEditor}
              />
            </Tooltip>
            <Tooltip
              title={t(
                wordWrapEnabled
                  ? "query_editor.action.disable_word_wrap"
                  : "query_editor.action.enable_word_wrap",
              )}
            >
              <Button
                className="gn-v2-query-toolbar-icon-action gn-v2-query-toolbar-word-wrap-action"
                type={wordWrapEnabled ? "primary" : "default"}
                icon={<GnWrapIcon />}
                aria-label={t(
                  wordWrapEnabled
                    ? "query_editor.action.disable_word_wrap"
                    : "query_editor.action.enable_word_wrap",
                )}
                aria-pressed={wordWrapEnabled}
                onClick={onToggleWordWrap}
              />
            </Tooltip>
          </>
        )}
        <Tooltip title={formatSqlTitle}>
          <Button
            aria-label={t(isElasticsearchMode
              ? "query_editor.elasticsearch.action.format"
              : "query_editor.action.format_sql")}
            className="gn-v2-query-toolbar-icon-action"
            icon={<GnFormatIcon />}
            onClick={onFormat}
          />
        </Tooltip>
        {!isElasticsearchMode && (
          <Tooltip
            title={formatSettingsTitle}
            open={openToolbarMenu === "format" ? false : undefined}
          >
            <span className="gn-v2-query-toolbar-menu-trigger">
            <Dropdown
                menu={{
                  items: formatActionMenuItems,
                  selectable: true,
                  selectedKeys: formatSettingsSelectedKeys,
                }}
                placement="bottomRight"
                trigger={["click"]}
                rootClassName="gn-v2-titlebar-quick-dropdown gn-v2-action-menu-popup-host"
                popupRender={(menu) => renderV2ActionMenuPopup(menu, true, {
                  title: formatSettingsTitle,
                  showHeader: false,
                })}
                open={openToolbarMenu === "format"}
                onOpenChange={(open) => updateToolbarMenuOpen("format", open)}
              >
                <Button
                  aria-label={formatSettingsTitle}
                  className="gn-v2-query-toolbar-icon-action"
                  icon={<GnSettingsIcon />}
                  aria-haspopup="menu"
                  aria-expanded={openToolbarMenu === "format"}
                />
              </Dropdown>
            </span>
          </Tooltip>
        )}
        {editorFullscreenAction}
      </div>

    </div>
  );



  return (
    <div
      className="gn-v2-query-toolbar"
      style={{
        padding: "4px 8px 8px",
        display: "flex",
        gap: "8px",
        flexShrink: 0,
      }}
    >
      <div
        className="gn-v2-query-toolbar-main"
        style={{
          display: "flex",
          gap: "8px",
          flexShrink: 0,
          alignItems: "center",
        }}
      >
        {selects}
        {actions}
      </div>
    </div>
  );
};

export default QueryEditorToolbar;
