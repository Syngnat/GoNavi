import React from "react";
import { Button, Dropdown, Select, Tooltip, type MenuProps } from "antd";
import {
  BulbOutlined,
  CheckOutlined,
  DatabaseOutlined,
  DiffOutlined,
  DownOutlined,
  EyeInvisibleOutlined,
  EyeOutlined,
  EllipsisOutlined,
  FileTextOutlined,
  FormatPainterOutlined,
  PlayCircleOutlined,
  RobotOutlined,
  SearchOutlined,
  SaveOutlined,
  SettingOutlined,
  StopOutlined,
  ThunderboltOutlined,
} from "@ant-design/icons";

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
  isV2Ui: boolean;
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
  /** object-edit 视图：验证数据变化入口 */
  showViewDataVerify?: boolean;
  onViewDataVerify?: () => void;
};

const FULL_NAME_TOOLTIP_DELAY_SECONDS = 1;
const QUERY_EXECUTION_TIMER_INTERVAL_MS = 100;

export const formatQueryExecutionElapsed = (elapsedMs: number): string => {
  const totalTenths = Math.floor(Math.max(0, Number(elapsedMs) || 0) / 100);
  const tenths = totalTenths % 10;
  const totalSeconds = Math.floor(totalTenths / 10);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  const secondsText = String(seconds).padStart(2, "0");
  const minutesText = String(minutes).padStart(2, "0");

  return hours > 0
    ? `${String(hours).padStart(2, "0")}:${minutesText}:${secondsText}.${tenths}`
    : `${minutesText}:${secondsText}.${tenths}`;
};

export const resolveQueryExecutionSpeedIcon = (elapsedMs: number): "⚡" | "🐇" | "🐢" => {
  const normalizedElapsedMs = Math.max(0, Number(elapsedMs) || 0);
  if (normalizedElapsedMs < 1_000) return "⚡";
  if (normalizedElapsedMs < 5_000) return "🐇";
  return "🐢";
};

export const useQueryExecutionElapsed = (loading: boolean, executionRunToken = 0): number => {
  const [elapsedMs, setElapsedMs] = React.useState(0);
  const startedAtRef = React.useRef<number | null>(null);

  React.useEffect(() => {
    if (!loading) {
      const startedAt = startedAtRef.current;
      if (startedAt !== null) {
        setElapsedMs(Date.now() - startedAt);
        startedAtRef.current = null;
      }
      return;
    }

    const startedAt = Date.now();
    startedAtRef.current = startedAt;
    setElapsedMs(0);
    const updateElapsed = () => setElapsedMs(Date.now() - startedAt);
    updateElapsed();
    const timer = globalThis.setInterval(updateElapsed, QUERY_EXECUTION_TIMER_INTERVAL_MS);
    return () => globalThis.clearInterval(timer);
  }, [executionRunToken, loading]);

  return elapsedMs;
};

const WrapTextIcon: React.FC = () => (
  <svg
    className="gn-query-toolbar-word-wrap-icon"
    viewBox="0 0 24 24"
    aria-hidden="true"
    focusable="false"
  >
    <path
      fill="currentColor"
      d="M4 19h6v-2H4v2zM20 5H4v2h16V5zm-3 6H4v2h13.25c1.1 0 2 .9 2 2s-.9 2-2 2H15v-2l-3 3 3 3v-2h2c2.21 0 4-1.79 4-4s-1.79-4-4-4z"
    />
  </svg>
);

type FullNameSelectOption = {
  label: string;
  value: string;
  title: string;
  fullName: string;
};

type QueryToolbarMenuKey = "ai" | "more" | "format" | "templates";

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
  isV2Ui,
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
          icon: <RobotOutlined />,
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
  const moreMenuItems: MenuProps["items"] = isV2Ui
    ? [
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
      ]
    : baseMoreMenuItems;
  const templateActionMenuItems = normalizeV2ActionMenuItems(templateMenuItems, <FileTextOutlined />);
  const aiActionMenuItems = normalizeV2ActionMenuItems(aiMenuItems, <RobotOutlined />);
  const moreActionMenuItems = normalizeV2ActionMenuItems(moreMenuItems, <EllipsisOutlined />);
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
  const formatActionMenuItems = normalizeV2ActionMenuItems(formatMenuItemsWithSelection, <FormatPainterOutlined />);
  const selects = (
    <div
      className={isV2Ui ? "gn-v2-query-toolbar-selects" : undefined}
      style={{
        display: "flex",
        gap: "8px",
        flexShrink: 0,
        alignItems: "center",
      }}
    >
      <Select
        className={
          isV2Ui
            ? "gn-v2-query-toolbar-select gn-v2-query-toolbar-connection-select"
            : undefined
        }
        style={isV2Ui ? undefined : { width: 150 }}
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
        className={
          isV2Ui
            ? "gn-v2-query-toolbar-select gn-v2-query-toolbar-database-select"
            : undefined
        }
        style={isV2Ui ? undefined : { width: 200 }}
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
          className={
            isV2Ui
              ? "gn-v2-query-toolbar-select gn-v2-query-toolbar-schema-select"
              : undefined
          }
          style={isV2Ui ? undefined : { width: 150 }}
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
          title={isV2Ui ? t("query_editor.elasticsearch.action.templates") : undefined}
          open={isV2Ui && openToolbarMenu === "templates" ? false : undefined}
        >
          <span className={isV2Ui ? "gn-v2-query-toolbar-menu-trigger" : undefined}>
            <Dropdown
                menu={{ items: isV2Ui ? templateActionMenuItems : templateMenuItems }}
                placement="bottomLeft"
                trigger={["click"]}
                rootClassName={isV2Ui ? 'gn-v2-titlebar-quick-dropdown gn-v2-action-menu-popup-host' : undefined}
                popupRender={(menu) => renderV2ActionMenuPopup(menu, isV2Ui, {
                  title: t('query_editor.elasticsearch.action.templates'),
                  showHeader: false,
                })}
                open={isV2Ui ? openToolbarMenu === "templates" : undefined}
              onOpenChange={isV2Ui ? (open) => updateToolbarMenuOpen("templates", open) : undefined}
            >
              <Button
                aria-label={t("query_editor.elasticsearch.action.templates")}
                className={isV2Ui ? "gn-v2-query-toolbar-icon-action" : undefined}
                icon={<DownOutlined />}
                aria-haspopup="menu"
                aria-expanded={isV2Ui ? openToolbarMenu === "templates" : undefined}
              >
                {!isV2Ui && t("query_editor.elasticsearch.action.templates")}
              </Button>
            </Dropdown>
          </span>
        </Tooltip>
      )}
      {!isElasticsearchMode && (
        <>
          <Tooltip title={t("query_editor.max_rows.tooltip")}>
            <Select
              className={
                isV2Ui
                  ? "gn-v2-query-toolbar-select gn-v2-query-toolbar-max-rows-select"
                  : undefined
              }
              style={isV2Ui ? undefined : { width: 170 }}
              value={maxRows}
              onChange={(val) => onMaxRowsChange(Number(val))}
              options={[
                { label: '100', value: 100 },
                { label: t("query_editor.max_rows.option_500"), value: 500 },
                { label: t("query_editor.max_rows.option_1000"), value: 1000 },
                { label: t("query_editor.max_rows.option_5000"), value: 5000 },
                { label: t("query_editor.max_rows.option_20000"), value: 20000 },
                { label: t("query_editor.max_rows.option_unlimited"), value: 0 },
              ]}
            />
          </Tooltip>
          <QueryEditorTransactionSettings
            isV2Ui={isV2Ui}
            commitMode={sqlEditorCommitMode}
            autoCommitDelayMs={sqlEditorAutoCommitDelayMs}
            onCommitModeChange={onCommitModeChange}
            onAutoCommitDelayMsChange={onAutoCommitDelayMsChange}
          />
          {!isV2Ui && pendingTransactionToolbar}
        </>
      )}
    </div>
  );

  const actions = (
    <div
      className={isV2Ui ? "gn-v2-query-toolbar-actions" : undefined}
      style={{
        display: "flex",
        gap: "8px",
        flexShrink: 0,
        alignItems: "center",
      }}
    >
      <div
        className={isV2Ui ? "gn-v2-query-toolbar-action-group" : undefined}
        style={{ display: "flex", gap: "8px", alignItems: "center" }}
      >
        <Tooltip
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
        >
          <Button
            aria-label={t(isElasticsearchMode
              ? "query_editor.elasticsearch.action.run_current"
              : "query_editor.action.run")}
            className={isV2Ui ? "gn-v2-query-toolbar-icon-action gn-v2-query-toolbar-run-action" : undefined}
            type="primary"
            icon={<PlayCircleOutlined />}
            onMouseDown={onCaptureEditorCursorPosition}
            onClick={onRun}
            loading={loading}
            disabled={runDisabled}
          >
            {!isV2Ui && t(isElasticsearchMode
              ? "query_editor.elasticsearch.action.run_current"
              : "query_editor.action.run")}
          </Button>
        </Tooltip>
        {isElasticsearchMode && onRunAll && (
          <Tooltip title={t("query_editor.elasticsearch.action.run_all")}>
            <Button
              aria-label={t("query_editor.elasticsearch.action.run_all")}
              className={isV2Ui ? "gn-v2-query-toolbar-icon-action" : undefined}
              icon={<PlayCircleOutlined />}
              disabled={loading}
              onMouseDown={onCaptureEditorCursorPosition}
              onClick={onRunAll}
            >
              {!isV2Ui && t("query_editor.elasticsearch.action.run_all")}
            </Button>
          </Tooltip>
        )}
        {!isElasticsearchMode && showViewDataVerify && onViewDataVerify && (
          <Tooltip title={t("result_diff.view_verify.toolbar.tooltip")}>
            <Button
              aria-label={t("result_diff.view_verify.toolbar")}
              className={isV2Ui ? "gn-v2-query-toolbar-icon-action" : undefined}
              icon={<DiffOutlined />}
              disabled={loading}
              onClick={onViewDataVerify}
            >
              {!isV2Ui && t("result_diff.view_verify.toolbar")}
            </Button>
          </Tooltip>
        )}
        {loading && (
          <Tooltip title={t("query_editor.action.stop")}>
            <Button
              aria-label={t("query_editor.action.stop")}
              className={isV2Ui ? "gn-v2-query-toolbar-icon-action gn-v2-query-toolbar-stop-action" : undefined}
              type="primary"
              danger
              icon={<StopOutlined />}
              onClick={onCancel}
            >
              {!isV2Ui && t("query_editor.action.stop")}
            </Button>
          </Tooltip>
        )}
      </div>
      {!isElasticsearchMode && isV2Ui && pendingTransactionToolbar}
      <div
        className={isV2Ui ? "gn-v2-query-toolbar-action-pair" : undefined}
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
            className={isV2Ui ? "gn-v2-query-toolbar-icon-action gn-v2-query-toolbar-save-action" : undefined}
            /* v2 与终端等工具按钮同族（default），避免 primary 的 on-accent 前景在暗色下发脏绿；
               可读性靠 CSS 把图标提到 fg-1。legacy 仍用 primary 实心按钮。 */
            type={isV2Ui ? "default" : "primary"}
            icon={<SaveOutlined />}
            onClick={onQuickSave}
          >
            {!isV2Ui && t("query_editor.action.save")}
          </Button>
        </Tooltip>
        {isElasticsearchMode ? (
          <Tooltip
            title={isV2Ui ? aiMoreTitle : undefined}
            open={isV2Ui && openToolbarMenu === "ai" ? false : undefined}
          >
            <span className={isV2Ui ? "gn-v2-query-toolbar-menu-trigger" : undefined}>
              <Dropdown
                menu={{ items: isV2Ui ? aiActionMenuItems : aiMenuItems }}
                placement="bottomRight"
                trigger={["click"]}
                  rootClassName={isV2Ui ? 'gn-v2-titlebar-quick-dropdown gn-v2-action-menu-popup-host' : undefined}
                popupRender={(menu) => renderV2ActionMenuPopup(menu, isV2Ui, {
                  title: aiMoreTitle,
                  showHeader: false,
                })}
                open={isV2Ui ? openToolbarMenu === "ai" : undefined}
                onOpenChange={isV2Ui ? (open) => updateToolbarMenuOpen("ai", open) : undefined}
              >
                <Button
                  className={isV2Ui ? "gn-v2-query-toolbar-icon-action gn-v2-query-toolbar-ai-action" : undefined}
                  icon={<RobotOutlined />}
                  style={isV2Ui ? undefined : { color: "#818cf8" }}
                  aria-label={aiMoreTitle}
                  aria-haspopup="menu"
                  aria-expanded={isV2Ui ? openToolbarMenu === "ai" : undefined}
                  onMouseDown={onCaptureEditorCursorPosition}
                >
                  {!isV2Ui && "AI"}
                </Button>
              </Dropdown>
            </span>
          </Tooltip>
        ) : (
          <>
            <div style={{ display: "flex", gap: "4px", alignItems: "center" }}>
              <Tooltip title={triggerSqlAiCompletionLabel}>
                <Button
                  aria-label={triggerSqlAiCompletionLabel}
                  className={isV2Ui ? "gn-v2-query-toolbar-icon-action gn-v2-query-toolbar-ai-action" : undefined}
                  icon={<RobotOutlined />}
                  style={isV2Ui ? undefined : { color: "#818cf8" }}
                  onMouseDown={onCaptureEditorCursorPosition}
                  onClick={onTriggerSqlAiCompletion}
                >
                  {!isV2Ui && "AI"}
                </Button>
              </Tooltip>
              <Tooltip
                title={isV2Ui ? aiMoreTitle : undefined}
                open={isV2Ui && openToolbarMenu === "ai" ? false : undefined}
              >
                <span className={isV2Ui ? "gn-v2-query-toolbar-menu-trigger" : undefined}>
                  <Dropdown
                    menu={{ items: isV2Ui ? aiActionMenuItems : aiMenuItems }}
                    placement="bottomRight"
                    trigger={["click"]}
                    rootClassName={isV2Ui ? 'gn-v2-titlebar-quick-dropdown gn-v2-action-menu-popup-host' : undefined}
                    popupRender={(menu) => renderV2ActionMenuPopup(menu, isV2Ui, {
                      title: aiMoreTitle,
                      showHeader: false,
                    })}
                    open={isV2Ui ? openToolbarMenu === "ai" : undefined}
                    onOpenChange={isV2Ui ? (open) => updateToolbarMenuOpen("ai", open) : undefined}
                  >
                    <Button
                      className={isV2Ui ? "gn-v2-query-toolbar-icon-action" : undefined}
                      icon={<DownOutlined />}
                      aria-label={aiMoreTitle}
                      aria-haspopup="menu"
                      aria-expanded={isV2Ui ? openToolbarMenu === "ai" : undefined}
                      onMouseDown={onCaptureEditorCursorPosition}
                    />
                  </Dropdown>
                </span>
              </Tooltip>
            </div>
            <Tooltip
              title={isV2Ui ? t("query_editor.action.more") : undefined}
              open={isV2Ui && openToolbarMenu === "more" ? false : undefined}
            >
              <span className={isV2Ui ? "gn-v2-query-toolbar-menu-trigger" : undefined}>
                <Dropdown
                  menu={{ items: isV2Ui ? moreActionMenuItems : moreMenuItems }}
                  placement="bottomRight"
                  trigger={["click"]}
                  rootClassName={isV2Ui ? 'gn-v2-titlebar-quick-dropdown gn-v2-action-menu-popup-host' : undefined}
                  popupRender={(menu) => renderV2ActionMenuPopup(menu, isV2Ui, {
                    title: t('query_editor.action.more'),
                    showHeader: false,
                  })}
                  open={isV2Ui ? openToolbarMenu === "more" : undefined}
                  onOpenChange={isV2Ui ? (open) => updateToolbarMenuOpen("more", open) : undefined}
                >
                  <Button
                    aria-label={t("query_editor.action.more")}
                    className={isV2Ui ? "gn-v2-query-toolbar-icon-action" : undefined}
                    icon={isV2Ui ? <EllipsisOutlined /> : undefined}
                    aria-haspopup="menu"
                    aria-expanded={isV2Ui ? openToolbarMenu === "more" : undefined}
                  >
                    {!isV2Ui && t("query_editor.action.more")}
                  </Button>
                </Dropdown>
              </span>
            </Tooltip>
          </>
        )}
      </div>

      <div
        className={isV2Ui ? "gn-v2-query-toolbar-action-pair" : undefined}
        style={{ display: "flex", gap: "8px", alignItems: "center" }}
      >
        {!isElasticsearchMode && (
          <>
            <Tooltip title={findInEditorTitle}>
              <Button
                aria-label={t("query_editor.action.find_in_editor")}
                className={isV2Ui ? "gn-v2-query-toolbar-icon-action" : undefined}
                icon={<SearchOutlined />}
                onClick={onFindInEditor}
              >
                {!isV2Ui && t("query_editor.action.find_in_editor")}
              </Button>
            </Tooltip>
            <Tooltip
              title={t(
                wordWrapEnabled
                  ? "query_editor.action.disable_word_wrap"
                  : "query_editor.action.enable_word_wrap",
              )}
            >
              <Button
                className={isV2Ui ? "gn-v2-query-toolbar-icon-action gn-v2-query-toolbar-word-wrap-action" : undefined}
                type={wordWrapEnabled ? "primary" : "default"}
                icon={<WrapTextIcon />}
                aria-label={t(
                  wordWrapEnabled
                    ? "query_editor.action.disable_word_wrap"
                    : "query_editor.action.enable_word_wrap",
                )}
                aria-pressed={wordWrapEnabled}
                onClick={onToggleWordWrap}
              >
                {!isV2Ui && t("query_editor.action.word_wrap")}
              </Button>
            </Tooltip>
          </>
        )}
        <Tooltip title={formatSqlTitle}>
          <Button
            aria-label={t(isElasticsearchMode
              ? "query_editor.elasticsearch.action.format"
              : "query_editor.action.format_sql")}
            className={isV2Ui ? "gn-v2-query-toolbar-icon-action" : undefined}
            icon={<FormatPainterOutlined />}
            onClick={onFormat}
          >
            {!isV2Ui && t(isElasticsearchMode
              ? "query_editor.elasticsearch.action.format"
              : "query_editor.action.format")}
          </Button>
        </Tooltip>
        {!isElasticsearchMode && (
          <Tooltip
            title={isV2Ui ? formatSettingsTitle : undefined}
            open={isV2Ui && openToolbarMenu === "format" ? false : undefined}
          >
            <span className={isV2Ui ? "gn-v2-query-toolbar-menu-trigger" : undefined}>
            <Dropdown
                menu={{
                  items: isV2Ui ? formatActionMenuItems : formatMenuItemsWithSelection,
                  selectable: true,
                  selectedKeys: formatSettingsSelectedKeys,
                }}
                placement="bottomRight"
                trigger={["click"]}
                rootClassName={isV2Ui ? 'gn-v2-titlebar-quick-dropdown gn-v2-action-menu-popup-host' : undefined}
                popupRender={(menu) => renderV2ActionMenuPopup(menu, isV2Ui, {
                  title: formatSettingsTitle,
                  showHeader: false,
                })}
                open={isV2Ui ? openToolbarMenu === "format" : undefined}
                onOpenChange={isV2Ui ? (open) => updateToolbarMenuOpen("format", open) : undefined}
              >
                <Button
                  aria-label={formatSettingsTitle}
                  className={isV2Ui ? "gn-v2-query-toolbar-icon-action" : undefined}
                  icon={<SettingOutlined />}
                  aria-haspopup="menu"
                  aria-expanded={isV2Ui ? openToolbarMenu === "format" : undefined}
                />
              </Dropdown>
            </span>
          </Tooltip>
        )}
      </div>

      {!isElasticsearchMode && !isV2Ui && (
        <Tooltip title={toggleResultPanelTitle}>
          <Button
            icon={
              isResultPanelVisible ? <EyeInvisibleOutlined /> : <EyeOutlined />
            }
            onClick={onToggleResultPanelVisibility}
          >
            {t("query_editor.action.results")}
          </Button>
        </Tooltip>
      )}
    </div>
  );

  if (!isV2Ui) {
    return (
      <div
        className={undefined}
        style={{
          padding: "4px 8px 8px",
          display: "flex",
          gap: "8px",
          flexShrink: 0,
          alignItems: "center",
        }}
      >
        {selects}
        {actions}
      </div>
    );
  }

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
