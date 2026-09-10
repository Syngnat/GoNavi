import Modal from './components/common/ResizableDraggableModal';
import React, { useState, useEffect, useLayoutEffect, useMemo, useCallback, useRef } from 'react';
import { withAISettingsLeaveGuard, type AISettingsLeaveGuard } from './utils/aiSettingsLeaveGuard';
import { Layout, Button, ConfigProvider, theme, message, notification, Spin, Slider, Switch, Input, InputNumber, Select, Segmented, Tooltip, Alert } from 'antd';
import { UploadOutlined, DownloadOutlined, CloudDownloadOutlined, BugOutlined, GlobalOutlined, InfoCircleOutlined, GithubOutlined, SkinOutlined, CheckOutlined, SettingOutlined, LinkOutlined, BgColorsOutlined, AppstoreOutlined, RobotOutlined, FolderOpenOutlined, HddOutlined, SafetyCertificateOutlined, SwitcherOutlined, CodeOutlined, RightOutlined, TableOutlined, MenuOutlined, PoweroffOutlined, UserOutlined, MessageOutlined, FileTextOutlined, SyncOutlined, SendOutlined, AuditOutlined, ThunderboltOutlined, ApiOutlined, WechatOutlined, CopyOutlined } from '@ant-design/icons';
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { arrayMove, SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { BrowserOpenURL, Environment, EventsOn, WindowFullscreen, WindowGetPosition, WindowGetSize, WindowIsFullscreen, WindowIsMaximised, WindowIsMinimised, WindowIsNormal, WindowMaximise, WindowMinimise, WindowSetDarkTheme, WindowSetLightTheme, WindowSetPosition, WindowSetSize, WindowSetSystemDefaultTheme, WindowUnfullscreen, WindowUnmaximise } from '../wailsjs/runtime';
import Sidebar from './components/Sidebar';
import TitleBarPrimaryActions, {
  resolveTitleBarPrimaryActionShortcut,
} from './components/TitleBarPrimaryActions';
import TitleBarSystemActions from './components/TitleBarSystemActions';
import ConnectionGroupManagementModal from './components/sidebar/ConnectionGroupManagementModal';
import TabManager from './components/TabManager';
import FloatingWorkbenchWindows from './components/FloatingWorkbenchWindows';
import FloatingAIChatWindow from './components/FloatingAIChatWindow';
import FloatingQueryResultWindows from './components/FloatingQueryResultWindows';
import NativeDetachedWindowController from './components/NativeDetachedWindowController';
import { TitleBarCloseIcon, TitleBarMaximizeIcon, TitleBarMinimizeIcon, TitleBarRestoreIcon } from './components/TitleBarWindowControlIcons';
import ConnectionModal from './components/ConnectionModal';
import ConnectionHealthModal from './components/ConnectionHealthModal';
import SnippetSettingsModal from './components/SnippetSettingsModal';
import DriverManagerModal from './components/DriverManagerModal';
import ConnectionPackagePasswordModal from './components/ConnectionPackagePasswordModal';
import ConnectionImportSettingsPanel, {
  buildConnectionImportGroupOptions,
  resolveConnectionImportPlacement,
  type ConnectionImportNotice,
} from './components/settings/ConnectionImportSettingsPanel';
import UpdateReleaseNotesModal from './components/UpdateReleaseNotesModal';
import {
  buildReleaseNotesReadKey,
  isReleaseNotesRead,
  markReleaseNotesRead,
} from './utils/updateReleaseNotesReadState';
import { type DataSyncEntryMode } from './components/dataSyncEntryMode';
import LinuxCJKFontBanner from './components/LinuxCJKFontBanner';
import LogPanel from './components/LogPanel';
import AIPanelErrorBoundary from './components/ai/AIPanelErrorBoundary';
import SecurityUpdateBanner from './components/SecurityUpdateBanner';
import SecurityUpdateIntroModal from './components/SecurityUpdateIntroModal';
import SecurityUpdateProgressModal from './components/SecurityUpdateProgressModal';
import SecurityUpdateSettingsModal from './components/SecurityUpdateSettingsModal';
import LanguageSettingsPanel from './components/LanguageSettingsPanel';
import WebAuthSettingsPanel from './components/WebAuthSettingsPanel';
import CloudBackupSettings from './components/CloudBackupSettings';
import BrandIconPicker from './components/BrandIconPicker';
import {
  resolveBrandAboutSrc,
  resolveBrandDockSrc,
  resolveBrandIconSrc,
  setLoadedBrandIconSources,
  BRAND_ICONS,
  type BrandIconId,
} from './brand/brandIcons';
import { composeMacOSDockIconBase64, shouldSyncApplicationBrandIcon } from './brand/macDockIcon';
import CustomThemeManager from './components/settings/CustomThemeManager';
import ToolbarButtonAppearanceSettings from './components/settings/ToolbarButtonAppearanceSettings';
import SettingsCenterTreeNav, {
  findSettingsCenterTreeItem,
} from './components/settings/SettingsCenterTreeNav';
import {
  DataDirectoryPage,
  DirectoryChoice,
  DirectoryMetaGrid,
  DirectoryNote,
  DirectoryPathDisplay,
  DirectorySectionHeading,
} from './components/settings/DataDirectorySettings';
import { AI_SETTINGS_NAV_ITEMS, type AISettingsSectionKey } from './components/ai/AISettingsSidebar';
import CustomThemeStyleHost, {
  type CustomThemeAntTokenSnapshot,
} from './components/theme/CustomThemeStyleHost';
import ToolbarAppearanceStyleHost from './components/theme/ToolbarAppearanceStyleHost';
import {
  AUTO_CHECK_FOR_UPDATES_INTERVAL_OPTIONS,
  DEFAULT_APPEARANCE,
  MAX_TAB_ENVIRONMENT_ACCENT_THICKNESS,
  MAX_V2_SIDEBAR_RAIL_SCALE,
  MIN_TAB_ENVIRONMENT_ACCENT_THICKNESS,
  MIN_V2_SIDEBAR_RAIL_SCALE,
  sanitizeTabEnvironmentAccentThickness,
  sanitizeV2SidebarRailScale,
  type QueryTableCtrlClickAction,
  type ThemePreference,
  flushAppStatePersistence,
  useStore,
} from './store';
import { useCustomThemeStore } from './customThemeStore';
import { GlobalProxyConfig, SavedConnection, SecurityUpdateIssue, SecurityUpdateStatus } from './types';
import { blurToFilter, normalizeBlurForPlatform, normalizeOpacityForPlatform, isMacLikePlatform, isWindowsPlatform, resolveAppearanceValues } from './utils/appearance';
import { buildFontFamilyOptions, DEFAULT_MONO_FONT_FAMILY, DEFAULT_UI_FONT_FAMILY, getLinuxCJKFontInstallHint, matchFontFamilyOption, resolveMonoFontFamily, resolveUIFontFamily, sanitizeFontFamilyInput, type FontFamilyOption, type InstalledFontFamily } from './utils/fontFamilies';
import {
  DENSITY_OPTIONS,
  sanitizeDataTableDensity,
  sanitizeDataTableFontSize,
  sanitizeSidebarTreeFontSize,
} from './utils/dataGridDisplay';
import {
  MAX_SQL_EDITOR_FONT_SIZE,
  MIN_SQL_EDITOR_FONT_SIZE,
  resolveSqlEditorFontSize,
  sanitizeSqlEditorFontSize,
} from './utils/sqlEditorTypography';
import {
  TAB_DISPLAY_SECONDARY_DEFAULT_KEYS,
  TAB_DISPLAY_ELEMENT_META,
  applyTabDisplaySettingsPatch,
  resolveTabDisplayElementOrder,
  sanitizeTabDisplaySettings,
  switchTabDisplayLayout,
  type TabDisplayElementKey,
  type TabDisplayLayout,
  type TabDisplaySettings,
} from './utils/tabDisplay';
import {
  resolveTitlebarContext,
  type TitlebarSidebarSnapshot,
} from './utils/titlebarContext';
import { getMacNativeTitlebarContentOffset, getMacNativeTitlebarPaddingLeft, getMacNativeTitlebarPaddingRight, shouldHandleMacNativeFullscreenShortcut, shouldSuppressMacNativeEscapeExit } from './utils/macWindow';
import { shouldEnableMacWindowDiagnostics } from './utils/macWindowDiagnostics';
import { getConnectionWorkbenchState } from './utils/startupReadiness';
import {
  createConnectionSidebarLayoutCoordinator,
  type ConnectionSidebarLayoutCoordinator,
} from './utils/connectionSidebarLayoutCoordinator';
import { createGlobalProxyDraft, toSaveGlobalProxyInput } from './utils/globalProxyDraft';
import {
  detectConnectionImportKind,
  isConnectionPackagePasswordRequiredError,
  resolveConnectionPackageExportResult,
  normalizeConnectionPackagePassword,
} from './utils/connectionExport';
import { downloadBrowserTextFile } from './utils/browserFileTransfer';
import { buildDataSyncWorkbenchTab } from './utils/dataSyncTab';
import {
  buildDriverManagerWorkbenchTab,
  DOWNLOAD_SOURCE_CHANGED_EVENT,
  getNextDownloadSource,
  normalizeDownloadSource,
  notifyDownloadSourceChanged,
  OPEN_GLOBAL_PROXY_SETTINGS_EVENT,
  type DownloadSourceId,
} from './utils/driverManagerTab';
import {
  buildSettingsCenterWorkbenchTab,
  SETTINGS_CENTER_WORKBENCH_TAB_ID,
} from './utils/settingsCenterTab';
import { SettingsCenterWorkbenchRegistrar } from './components/settings/SettingsCenterWorkbenchBridge';
import { buildSqlAuditWorkbenchTab } from './utils/sqlAuditTab';
import { buildRequestDiagnosticsWorkbenchTab } from './utils/requestDiagnosticsTab';
import {
  getDataSourceCapabilities,
  isMessageQueueDataSource,
  resolveMessageQueueExecutionDbName,
  resolveDataSourceType,
} from './utils/dataSourceCapabilities';
import { buildContextualNewQueryTemplate } from './utils/objectQueryTemplates';
import {
  extractCustomThemeAntTokens,
} from './utils/customTheme';
import { resolveAvailableCustomTheme } from './utils/customThemePresets';
import {
  mergeRedisDbAliases,
  sanitizeRedisDbAliases,
  type RedisDbAliasMap,
} from './utils/redisDbAlias';
import {
  bootstrapSecureConfig,
  finalizeSecurityUpdateStatus,
  mergeSecurityUpdateStatusWithLegacySource,
  prepareSecureConfigForExternalMCP,
  startSecurityUpdateFromBootstrap,
} from './utils/secureConfigBootstrap';
import { bootstrapSavedQueries } from './utils/savedQueryPersistence';
import {
  LEGACY_PERSIST_KEY,
  hasLegacyMigratableSensitiveItems,
  stripLegacyPersistedConnectionById,
} from './utils/legacyConnectionStorage';
import { DEFAULT_QUERY_TEMPLATE } from './components/queryEditor/QueryEditorHelpers';
import {
  DEFAULT_SIDEBAR_TABLE_METADATA_FIELDS,
  SIDEBAR_TABLE_METADATA_FIELDS,
  applySidebarTableMetadataFieldOrder,
  resolveSidebarTableMetadataFieldOrder,
  resolveSidebarTableMetadataFields,
  setSidebarTableMetadataFieldSelected,
  type SidebarTableMetadataField,
} from './utils/sidebarTableMetadata';
import {
  SIDEBAR_OBJECT_GROUP_KEYS,
  type SidebarObjectGroupKey,
} from './utils/sidebarObjectVisibility';
import {
  getSecurityUpdateStatusMeta,
  resolveSecurityUpdateEntryVisibility,
} from './utils/securityUpdatePresentation';
import {
  hasSecurityUpdateRecentResult,
  resolveSecurityUpdateRepairEntry,
  resolveSecurityUpdateSettingsFocusTarget,
  shouldRefreshSecurityUpdateDetailsFocus,
  shouldReopenSecurityUpdateDetails,
  shouldRetrySecurityUpdateAfterRepairSave,
  type SecurityUpdateRepairSource,
  type SecurityUpdateSettingsFocusTarget,
} from './utils/securityUpdateRepairFlow';
import { getWindowsScaleFixNudgedWidth } from './utils/windowsScaleFix';
import {
  clearStartupWindowRestorePending,
  isStartupMaximisedWindowSettled,
  isStartupWindowSurfaceCoveringViewport,
  isStartupWindowRestorePending,
  markStartupWindowRestorePending,
  resolveDefaultStartupWindowBounds,
  resolveStartupWindowRestoreMode,
  resolveWorkAreaFillWindowBounds,
} from './utils/windowStartupLayout';
import {
  SHORTCUT_ACTION_META,
  SHORTCUT_ACTION_ORDER,
  ShortcutAction,
  canRecordShortcutForAction,
  eventToShortcut,
  findReservedConflictsForAction,
  getShortcutDisplay,
  getShortcutDisplayLabel,
  getShortcutPlatform,
  installGlobalImeCompositionTracking,
  isEditableElement,
  isImeComposingKeyEvent,
  isShortcutMatch,
  normalizeShortcutCombo,
  resolveShortcutBinding,
  setGlobalShortcutCaptureActive,
  splitConflictsByContext,
  type ConflictInfo,
} from './utils/shortcuts';
import {
  dispatchCloseActiveResultTab,
  dispatchCloseActiveWorkspaceTab,
  isCloseShortcutInteractionBlocked,
  resolveCloseShortcutKeydownDecision,
  resolveCloseShortcutScopeFromTarget,
  resolveDockedActiveTabId,
  type CloseShortcutScope,
} from './utils/closeTabShortcut';
import {
  installNativeWindowActivityScheduler,
  resolveTitleBarToggleIconKey,
  resolveWindowsScaleCheckDelayMs,
  WINDOW_STATE_FALLBACK_INTERVAL_MS,
  WINDOWS_SCALE_FALLBACK_INTERVAL_MS,
  type WindowScaleFixReason,
  type WindowsScaleCheckTrigger,
} from './utils/windowStateUi';
import { resolveVisibleStartupWindowBounds } from './utils/windowRestoreBounds';
import { resolveWailsWindowSetPosition, resolveWailsWindowVisibleViewport } from './utils/wailsWindowViewport';
import {
  DEFAULT_AI_PANEL_WIDTH,
  resolveFullscreenAIPanelOverlayWidth,
  resolveOverlayAIPanelWidth,
  shouldOverlayAIPanel,
  shouldUseFullscreenAIPanelOverlay,
} from './utils/aiPanelLayout';
import { safeWindowRuntimeCall } from './utils/wailsRuntime';
import { repairWindowsWindowScale } from './utils/windowsWindowScaleRepair';
import { waitForWindowCondition } from './utils/windowTransition';
import {
  hasNativeDetachedWindowManager,
  openNativeAIChatWindow,
  openNativeWorkbenchTabWindow,
  toggleOrFocusNativeAIChatFromMainWindow,
} from './utils/nativeDetachedWindowHost';
import {
  buildApplicationQuitUnsavedSQLLabel,
  collectApplicationQuitUnsavedSQLTargets,
  saveLatestApplicationQuitUnsavedSQLState,
} from './utils/sqlEditorApplicationQuit';
import { prepareApplicationQuitPersistence } from './utils/applicationQuitPersistence';
import { flushQueryTabDraftSnapshots } from './utils/sqlFileTabDrafts';
import {
  APP_APPLICATION_QUIT_MODAL_Z_INDEX,
  APP_FOREGROUND_MODAL_Z_INDEX,
  APP_NESTED_MODAL_Z_INDEX,
  APP_OVERLAY_Z_INDEX_BASE,
} from './utils/overlayZIndex';
import { useAppUpdateManager } from './hooks/useAppUpdateManager';
import { useAppLogPanelResize } from './hooks/useAppLogPanelResize';
import { useAppSidebarResize } from './hooks/useAppSidebarResize';
import { canInheritNewQueryTableContext, resolveNewQueryContext } from './utils/newQueryContext';
import { useAppUtilityStyles } from './hooks/useAppUtilityStyles';
import { useWorkbenchTabs } from './hooks/useWorkbenchTabs';
import { useAIWorkspaceSnapshot } from './components/ai/useAIWorkspaceSnapshot';
import AgentDataSettingsPanel from './components/ai/AgentDataSettingsPanel';
import {
  ApplyDataRootDirectory,
  ApplyLogDirectory,
  ApplySavedQueryDirectory,
  CancelApplicationQuit,
  ForceQuitApplication,
  GetDataRootDirectoryInfo,
  GetSavedConnections,
  GetSavedQueries,
  ListInstalledFontFamilies,
  OpenDataRootDirectory,
  OpenLogDirectory,
  OpenSavedQueryDirectory,
  SelectDataRootDirectory,
  SelectLogDirectory,
  SelectSavedQueryDirectory,
  SetApplicationBrandIcon,
  GetBrandIconDataURL,
  SetWindowTranslucency,
} from '../wailsjs/go/app/App';
import { getAntdLocale } from './i18n/frameworkLocale';
import { useI18n } from './i18n/provider';
import {
  normalizeTitlebarRuntimePlatform,
  resolveDocumentPlatform,
  resolveTitleBarLayout,
  resolveTitlebarRuntimePlatform,
  shouldDockCollapsedSidebarActionsInTitlebar as resolveCollapsedSidebarDocking,
} from './utils/titlebarLayout';
import './App.css';
import './v2-theme.css';
import './styles/v2-theme-workbench.css';
import './styles/v2-theme-ai.css';

const createLazyAIChatPanel = () => React.lazy(() => import('./components/AIChatPanel'));
const createLazyAISettingsContent = () => React.lazy(async () => {
  const module = await import('./components/AISettingsModal');
  return { default: module.AISettingsContent };
});

const { Sider, Content } = Layout;
const MIN_UI_SCALE = 0.8;
const MAX_UI_SCALE = 1.25;
const MIN_FONT_SIZE = 12;
const MAX_FONT_SIZE = 20;
type ApplicationQuitConfirmedAction = () => Promise<boolean>;
/** 设置页 Slider 底部预设刻度 */
const UI_SCALE_SLIDER_MARKS: Record<number, string> = {
  0.8: '80%',
  0.9: '90%',
  1: '100%',
  1.1: '110%',
  1.25: '125%',
};
const FONT_SIZE_SLIDER_MARKS: Record<number, string> = {
  12: '12',
  14: '14',
  16: '16',
  18: '18',
  20: '20',
};
const SIDEBAR_RAIL_SCALE_SLIDER_MARKS: Record<number, string> = {
  1: '100%',
  1.25: '125%',
  1.5: '150%',
  1.8: '180%',
};
const TAB_ENVIRONMENT_ACCENT_THICKNESS_SLIDER_MARKS: Record<number, string> = {
  1: '1',
  2: '2',
  4: '4',
  6: '6',
};
const OPACITY_SLIDER_MARKS: Record<number, string> = {
  0.1: '10%',
  0.5: '50%',
  1: '100%',
};
const BLUR_SLIDER_MARKS: Record<number, string> = {
  0: '0',
  6: '6',
  12: '12',
  20: '20',
};
const DATA_TABLE_FONT_SLIDER_MARKS: Record<number, string> = {
  10: '10',
  12: '12',
  14: '14',
  16: '16',
  18: '18',
};
const SQL_EDITOR_FONT_SLIDER_MARKS: Record<number, string> = {
  ...DATA_TABLE_FONT_SLIDER_MARKS,
  20: '20',
};
const DEFAULT_UI_SCALE = 1.0;
const DEFAULT_FONT_SIZE = 14;
const EMPTY_INSTALLED_FONT_FAMILIES: InstalledFontFamily[] = [];

type ThemeSettingsSliderUnit = 'percent' | 'px' | 'none';

type ThemeSettingsSliderProps = {
  min: number;
  max: number;
  step?: number;
  value: number;
  onChange: (value: number) => void;
  disabled?: boolean;
  marks?: Record<number, string>;
  /** percent：右侧按百分比输入（内部仍用 0~1 / 0.8~1.25 比例） */
  unit?: ThemeSettingsSliderUnit;
};

const clampThemeSliderValue = (value: number, min: number, max: number, step?: number): number => {
  let next = Math.min(max, Math.max(min, value));
  if (step && step > 0) {
    const steps = Math.round((next - min) / step);
    next = min + steps * step;
    // 消除浮点误差
    const decimals = String(step).includes('.') ? (String(step).split('.')[1]?.length ?? 0) : 0;
    if (decimals > 0) {
      next = Number(next.toFixed(decimals));
    }
    next = Math.min(max, Math.max(min, next));
  }
  return next;
};

/** 主题设置页：滑条 + 底部预设 + 可编辑数值 */
const ThemeSettingsSlider: React.FC<ThemeSettingsSliderProps> = ({
  min,
  max,
  step,
  value,
  onChange,
  disabled,
  marks,
  unit = 'none',
}) => {
  const isPercent = unit === 'percent';
  const minN = Number(min);
  const maxN = Number(max);
  const span = maxN - minN || 1;
  const stepN = step === undefined || step === null ? undefined : Number(step);
  const current = Number(value);
  const displayMin = isPercent ? minN * 100 : minN;
  const displayMax = isPercent ? maxN * 100 : maxN;
  const displayStep = isPercent
    ? (stepN !== undefined ? stepN * 100 : 1)
    : (stepN !== undefined ? stepN : 1);
  const displayValue = Number.isFinite(current)
    ? (isPercent ? Number((current * 100).toFixed(4)) : current)
    : displayMin;

  const commitDisplayValue = (raw: number | string | null) => {
    if (raw === null || raw === undefined || raw === '') {
      return;
    }
    const parsed = typeof raw === 'number' ? raw : Number(String(raw).trim().replace(/%/g, ''));
    if (!Number.isFinite(parsed)) {
      return;
    }
    const modelValue = isPercent ? parsed / 100 : parsed;
    onChange(clampThemeSliderValue(modelValue, minN, maxN, stepN));
  };

  const markEntries = marks
    ? Object.entries(marks).map(([raw, label]) => ({
        value: Number(raw),
        label,
      }))
    : [];

  return (
    <div className={`gonavi-settings-slider-row${marks ? ' has-marks' : ''}`}>
      <div className="gonavi-settings-slider-main">
        <div className="gonavi-settings-slider-track-wrap">
          <Slider
            min={minN}
            max={maxN}
            step={stepN}
            value={current}
            onChange={(next) => {
              const n = Array.isArray(next) ? next[0] : next;
              if (typeof n === 'number' && Number.isFinite(n)) {
                onChange(clampThemeSliderValue(n, minN, maxN, stepN));
              }
            }}
            disabled={disabled}
            tooltip={{ open: false }}
          />
        </div>
        {markEntries.length > 0 ? (
          <div className="gonavi-settings-slider-presets" role="group">
            {markEntries.map((mark) => {
              const pct = ((mark.value - minN) / span) * 100;
              const active = Number.isFinite(current)
                ? (stepN && stepN > 0
                  ? Math.abs(current - mark.value) <= stepN / 2 + 1e-9
                  : Math.abs(current - mark.value) < 1e-6)
                : false;
              return (
                <button
                  key={String(mark.value)}
                  type="button"
                  className={`gonavi-settings-slider-preset${active ? ' is-active' : ''}`}
                  style={{ left: `${pct}%` }}
                  disabled={Boolean(disabled)}
                  onClick={() => {
                    if (disabled) return;
                    onChange(clampThemeSliderValue(mark.value, minN, maxN, stepN));
                  }}
                >
                  {mark.label}
                </button>
              );
            })}
          </div>
        ) : null}
      </div>
      <InputNumber
        className="gonavi-settings-slider-value-input"
        size="small"
        min={displayMin}
        max={displayMax}
        step={displayStep}
        value={displayValue}
        disabled={disabled}
        controls={false}
        keyboard
        stringMode={false}
        style={{ width: unit === 'none' ? 48 : 62 }}
        addonAfter={unit === 'percent' ? '%' : unit === 'px' ? 'px' : undefined}
        onChange={(next) => {
          if (typeof next === 'number') {
            commitDisplayValue(next);
          }
        }}
        onBlur={(event) => {
          commitDisplayValue(event.target.value);
        }}
        onPressEnter={(event) => {
          commitDisplayValue((event.target as HTMLInputElement).value);
          (event.target as HTMLInputElement).blur();
        }}
      />
    </div>
  );
};

const createEmptySecurityUpdateStatus = (): SecurityUpdateStatus => ({
  overallStatus: 'not_detected',
  summary: {
    total: 0,
    updated: 0,
    pending: 0,
    skipped: 0,
    failed: 0,
  },
  issues: [],
});

const detectNavigatorPlatform = (): string => {
  if (typeof navigator === 'undefined') {
      return '';
  }
  const uaDataPlatform = (navigator as Navigator & {
      userAgentData?: { platform?: string };
  }).userAgentData?.platform;
  if (uaDataPlatform) {
      return uaDataPlatform;
  }
  return navigator.userAgent || '';
};

const readCurrentVisibleViewport = () => resolveWailsWindowVisibleViewport(
  window.screen as Screen & { availLeft?: number; availTop?: number },
  { innerWidth: window.innerWidth, innerHeight: window.innerHeight },
  { useMonitorLocalOrigin: isMacLikePlatform() },
);

const getSystemThemeMode = (): 'light' | 'dark' => {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return 'light';
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
};


const mergeSavedConnections = (current: SavedConnection[], imported: SavedConnection[]): SavedConnection[] => {
  const merged = new Map<string, SavedConnection>();
  current.forEach((conn) => merged.set(conn.id, conn));
  imported.forEach((conn) => merged.set(conn.id, conn));
  return Array.from(merged.values());
};

type ConnectionPackageImportPayload = {
  connections: SavedConnection[];
  redisDbAliases: RedisDbAliasMap;
};

/** Normalize ImportConnectionsPayload results: object (new) or bare array (legacy/mock). */
const normalizeConnectionPackageImportPayload = (value: unknown): ConnectionPackageImportPayload | null => {
  if (Array.isArray(value)) {
    return {
      connections: value as SavedConnection[],
      redisDbAliases: {},
    };
  }
  if (!value || typeof value !== 'object') {
    return null;
  }
  const record = value as { connections?: unknown; redisDbAliases?: unknown };
  if (!Array.isArray(record.connections)) {
    return null;
  }
  return {
    connections: record.connections as SavedConnection[],
    redisDbAliases: sanitizeRedisDbAliases(record.redisDbAliases),
  };
};

type ConnectionPackageDialogMode = 'import' | 'export';
type ToolCenterGroupKey = 'config' | 'workflow' | 'workspace';
type ToolCenterPaneKey =
  | 'connection-package'
  | 'import'
  | 'export'
  | 'connection-health'
  | 'data-root'
  | 'data-root-application'
  | 'data-root-agent'
  | 'data-root-saved-queries'
  | 'security-update'
  | 'drivers'
  | 'snippet-settings'
  | 'shortcut-settings';

type SettingsCenterGroupKey = 'preferences' | 'services' | ToolCenterGroupKey | 'about';
type SettingsCenterPaneKey =
  | 'language'
  | 'theme'
  | 'brand-icon'
  | 'sidebar-metadata'
  | 'sidebar-objects'
  | 'proxy'
  | 'download-source'
  | 'web-auth'
  | 'cloud-backup'
  | 'ai'
  | ToolCenterPaneKey
  | 'about-go-navi';
type SettingsCenterPaneState = {
  key: SettingsCenterPaneKey;
  group: SettingsCenterGroupKey;
};

const isToolCenterGroupKey = (group: SettingsCenterGroupKey): group is ToolCenterGroupKey => (
  group === 'config' || group === 'workflow' || group === 'workspace'
);

const isConnectionPackageSettingsPaneKey = (
  key: SettingsCenterPaneKey | string | null | undefined,
): boolean => key === 'connection-package' || key === 'import' || key === 'export';

const resolveSettingsCenterGroupInitialPane = (group: SettingsCenterGroupKey): SettingsCenterPaneState | null => {
  switch (group) {
    case 'preferences':
      return { key: 'language', group };
    case 'services':
      return { key: 'proxy', group };
    case 'config':
      return { key: 'data-root-application', group };
    case 'workspace':
      return { key: 'snippet-settings', group };
    case 'about':
      return { key: 'about-go-navi', group };
    default:
      return null;
  }
};

const DEFAULT_GLOBAL_PROXY_TEST_URL = 'https://api.github.com/';

type GlobalProxyTestResultState = {
  success: boolean;
  message: string;
  url?: string;
  finalUrl?: string;
  statusCode?: number;
  durationMs?: number;
  viaProxy?: boolean;
};

const getGlobalProxyDefaultPort = (type: GlobalProxyConfig['type']): number => (
  type === 'http' ? 8080 : 1080
);

const createGlobalProxyComparableDraft = (
  value: Partial<GlobalProxyConfig> = {},
): GlobalProxyConfig => ({
  ...createGlobalProxyDraft(value),
  password: typeof value.password === 'string' ? value.password : '',
});

const areGlobalProxyDraftsEqual = (
  left: Partial<GlobalProxyConfig>,
  right: Partial<GlobalProxyConfig>,
): boolean => {
  const normalizedLeft = createGlobalProxyComparableDraft(left);
  const normalizedRight = createGlobalProxyComparableDraft(right);
  return (
    normalizedLeft.enabled === normalizedRight.enabled &&
    normalizedLeft.type === normalizedRight.type &&
    normalizedLeft.host === normalizedRight.host &&
    normalizedLeft.port === normalizedRight.port &&
    normalizedLeft.user === normalizedRight.user &&
    normalizedLeft.password === normalizedRight.password &&
    normalizedLeft.hasPassword === normalizedRight.hasPassword
  );
};

const formatAboutCheckedAt = (value: Date): string => {
  const pad = (input: number) => String(input).padStart(2, '0');
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} ${pad(value.getHours())}:${pad(value.getMinutes())}`;
};

const formatAboutReleaseTime = (value: string | undefined): string => {
  const text = String(value || '').trim();
  if (!text) {
    return '-';
  }
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) {
    return '-';
  }
  return formatAboutCheckedAt(date);
};

type ConnectionPackageDialogState = {
  open: boolean;
  mode: ConnectionPackageDialogMode;
  includeSecrets: boolean;
  useFilePassword: boolean;
  password: string;
  error: string;
  confirmLoading: boolean;
  /** Export only: selected connection ids to include in the package. */
  selectedConnectionIds: string[];
};

const createClosedConnectionPackageDialogState = (): ConnectionPackageDialogState => ({
  open: false,
  mode: 'export',
  includeSecrets: true,
  useFilePassword: false,
  password: '',
  error: '',
  confirmLoading: false,
  selectedConnectionIds: [],
});

type SidebarMetadataSortableRowProps = {
  field: SidebarTableMetadataField;
  label: string;
  checked: boolean;
  dividerColor: string;
  titleColor: string;
  mutedColor: string;
  onToggle: (selected: boolean) => void;
};

const SidebarMetadataSortableRow: React.FC<SidebarMetadataSortableRowProps> = ({
  field,
  label,
  checked,
  dividerColor,
  titleColor,
  mutedColor,
  onToggle,
}) => {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: field });

  return (
    <div
      ref={setNodeRef}
      data-sidebar-metadata-field={field}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        minHeight: 44,
        padding: '6px 2px',
        borderBottom: `1px solid ${dividerColor}`,
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.72 : 1,
        position: 'relative',
        zIndex: isDragging ? 2 : undefined,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
        <button
          type="button"
          aria-label={`Drag ${label}`}
          {...attributes}
          {...listeners}
          style={{
            width: 24,
            height: 24,
            border: 'none',
            borderRadius: 8,
            background: 'transparent',
            color: mutedColor,
            cursor: isDragging ? 'grabbing' : 'grab',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 0,
            touchAction: 'none',
          }}
        >
          <MenuOutlined />
        </button>
        <span style={{ fontWeight: 500, color: titleColor, minWidth: 0 }}>{label}</span>
      </div>
      <Switch
        checked={checked}
        onChange={(selected) => onToggle(selected)}
      />
    </div>
  );
};

function App() {
  const { language, t } = useI18n();
  // The workspace source belongs to the application lifetime, not to the
  // optional AI panel. This keeps a running harness supplied with a live
  // snapshot while the panel is hidden, detached, or being remounted.
  useAIWorkspaceSnapshot({ enabled: true });
  const [notificationApi, notificationContextHolder] = notification.useNotification();
  const [brandAssetRevision, setBrandAssetRevision] = useState(0);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isConnectionModalMounted, setIsConnectionModalMounted] = useState(false);
  const [editingConnection, setEditingConnection] = useState<SavedConnection | null>(null);
  const [connectionHealthTargetIds, setConnectionHealthTargetIds] = useState<string[]>([]);
  const pendingConnectionTagIdRef = useRef<string | null>(null);
  const connectionModalWarmupDoneRef = useRef(false);
  const windowState = useStore(state => state.windowState);
  const themeMode = useStore(state => state.theme);
  const themePreference = useStore(state => state.themePreference);
  const brandIconId = useStore(state => state.brandIconId);
  const setBrandIconId = useStore(state => state.setBrandIconId);
  const setTheme = useStore(state => state.setTheme);
  const setThemePreference = useStore(state => state.setThemePreference);
  const customThemes = useCustomThemeStore(state => state.themes);
  const activeCustomThemeId = useCustomThemeStore(state => state.activeThemeId);
  const selectCustomTheme = useCustomThemeStore(state => state.selectCustomTheme);
  const appearance = useStore(state => state.appearance);
  const setAppearance = useStore(state => state.setAppearance);
  const uiScale = useStore(state => state.uiScale);
  const setUiScale = useStore(state => state.setUiScale);
  const fontSize = useStore(state => state.fontSize);
  const setFontSize = useStore(state => state.setFontSize);
  // Keep reading the legacy persisted field; its product meaning is now startup maximise.
  const startupMaximised = useStore(state => state.startupFullscreen);
  const setStartupMaximised = useStore(state => state.setStartupFullscreen);
  const autoCheckForUpdates = useStore(state => state.autoCheckForUpdates);
  const setAutoCheckForUpdates = useStore(state => state.setAutoCheckForUpdates);
  const autoCheckForUpdatesIntervalMinutes = useStore(state => state.autoCheckForUpdatesIntervalMinutes);
  const setAutoCheckForUpdatesIntervalMinutes = useStore(state => state.setAutoCheckForUpdatesIntervalMinutes);
  const globalProxy = useStore(state => state.globalProxy);
  const replaceConnections = useStore(state => state.replaceConnections);
  const replaceConnectionSidebarLayout = useStore(state => state.replaceConnectionSidebarLayout);
  const replaceGlobalProxy = useStore(state => state.replaceGlobalProxy);
  const replaceSavedQueries = useStore(state => state.replaceSavedQueries);
  const reloadSavedQueryGroups = useStore(state => state.reloadSavedQueryGroups);
  const queryOptions = useStore(state => state.queryOptions);
  const setQueryOptions = useStore(state => state.setQueryOptions);
  const shortcutOptions = useStore(state => state.shortcutOptions);
  const updateShortcut = useStore(state => state.updateShortcut);
  const resetShortcutOptions = useStore(state => state.resetShortcutOptions);
  const [systemThemeMode, setSystemThemeMode] = useState<'light' | 'dark'>(() => getSystemThemeMode());
  const activeCustomTheme = useMemo(
      () => resolveAvailableCustomTheme(customThemes, activeCustomThemeId),
      [activeCustomThemeId, customThemes],
  );
  const effectiveThemePreference = activeCustomTheme?.baseMode ?? themePreference;
  const resolvedThemeMode = effectiveThemePreference === 'system'
      ? systemThemeMode
      : effectiveThemePreference;
  const darkMode = resolvedThemeMode === 'dark';
  const sourceCustomThemeAntTokens = useMemo(
      () => activeCustomTheme ? extractCustomThemeAntTokens(activeCustomTheme.css) : {},
      [activeCustomTheme],
  );
  const [computedCustomThemeAntTokens, setComputedCustomThemeAntTokens] = useState<CustomThemeAntTokenSnapshot | null>(null);
  const customThemeStyleContextKey = `${resolvedThemeMode}:v2`;
  const customThemeAntTokens = activeCustomTheme
      && computedCustomThemeAntTokens?.themeId === activeCustomTheme.id
      && computedCustomThemeAntTokens.themeRevision === activeCustomTheme.updatedAt
      && computedCustomThemeAntTokens.contextKey === customThemeStyleContextKey
      ? computedCustomThemeAntTokens.tokens
      : sourceCustomThemeAntTokens;

  const effectiveUiScale = Math.min(MAX_UI_SCALE, Math.max(MIN_UI_SCALE, Number(uiScale) || DEFAULT_UI_SCALE));
  const effectiveFontSize = Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Math.round(Number(fontSize) || DEFAULT_FONT_SIZE)));
  const tokenFontSize = Math.round(effectiveFontSize * effectiveUiScale);
  const titleBarToggleIconKey = resolveTitleBarToggleIconKey(
      windowState === 'fullscreen' ? 'fullscreen' : (windowState === 'maximized' ? 'maximized' : 'normal')
  );
  const tokenFontSizeSM = Math.max(10, Math.round(tokenFontSize * 0.86));
  const tokenFontSizeLG = Math.max(tokenFontSize + 1, Math.round(tokenFontSize * 1.14));
  const tokenControlHeight = Math.max(24, Math.round(32 * effectiveUiScale));
  const tokenControlHeightSM = Math.max(20, Math.round(24 * effectiveUiScale));
  const tokenControlHeightLG = Math.max(30, Math.round(40 * effectiveUiScale));
  const dataTableFontSizeFollowsGlobal = appearance.dataTableFontSizeFollowGlobal !== false;
  const sqlEditorFontSizeFollowsGlobal = appearance.sqlEditorFontSizeFollowGlobal !== false;
  const sidebarTreeFontSizeFollowsGlobal = appearance.sidebarTreeFontSizeFollowGlobal !== false;
  const effectiveDataTableFontSize = dataTableFontSizeFollowsGlobal
      ? effectiveFontSize
      : (sanitizeDataTableFontSize(appearance.dataTableFontSize) ?? effectiveFontSize);
  const effectiveSqlEditorFontSize = resolveSqlEditorFontSize({
      globalFontSize: effectiveFontSize,
      sqlEditorFontSize: appearance.sqlEditorFontSize,
      sqlEditorFontSizeFollowGlobal: appearance.sqlEditorFontSizeFollowGlobal,
  });
  const effectiveSidebarTreeFontSize = sidebarTreeFontSizeFollowsGlobal
      ? effectiveFontSize
      : (sanitizeSidebarTreeFontSize(appearance.sidebarTreeFontSize) ?? effectiveFontSize);
  const effectiveSidebarRailScale = sanitizeV2SidebarRailScale(appearance.v2SidebarRailScale);
  const effectiveTabEnvironmentAccentThickness = sanitizeTabEnvironmentAccentThickness(
      appearance.tabEnvironmentAccentThickness,
  );
  const tableDoubleClickAction = appearance.tableDoubleClickAction === 'open-design' ? 'open-design' : 'open-data';
  const queryTableCtrlClickAction: QueryTableCtrlClickAction = appearance.queryTableCtrlClickAction === 'locate'
      ? 'locate'
      : 'open-design';
  const newQuerySqlTemplate = appearance.newQuerySqlTemplate ?? DEFAULT_QUERY_TEMPLATE;
  const sidebarTableMetadataFieldOrder = useMemo(
      () => resolveSidebarTableMetadataFieldOrder(queryOptions?.sidebarTableMetadataFieldOrder),
      [queryOptions?.sidebarTableMetadataFieldOrder],
  );
  const sidebarTableMetadataFields = useMemo(
      () => resolveSidebarTableMetadataFields(
          queryOptions?.sidebarTableMetadataFields,
          queryOptions?.showSidebarTableComment === true,
          sidebarTableMetadataFieldOrder,
      ),
      [queryOptions?.showSidebarTableComment, queryOptions?.sidebarTableMetadataFields, sidebarTableMetadataFieldOrder],
  );
  const sidebarMetadataDragSensors = useSensors(
      useSensor(PointerSensor, {
          activationConstraint: { distance: 4 },
      }),
  );
  const tabDisplaySettings = useMemo(
      () => sanitizeTabDisplaySettings(appearance.tabDisplay),
      [appearance.tabDisplay],
  );
  const tabDisplayElementOrder = useMemo(
      () => resolveTabDisplayElementOrder(tabDisplaySettings),
      [tabDisplaySettings],
  );
  const visibleTabDisplayElementKeys = useMemo(
      () => new Set<TabDisplayElementKey>([
          ...tabDisplaySettings.primaryElements,
          ...tabDisplaySettings.secondaryElements,
      ]),
      [tabDisplaySettings],
  );
  const getTabDisplayElementLabel = useCallback(
      (key: TabDisplayElementKey) => t(TAB_DISPLAY_ELEMENT_META[key].labelKey),
      [t],
  );
  const getTabDisplayElementDescription = useCallback(
      (key: TabDisplayElementKey) => t(TAB_DISPLAY_ELEMENT_META[key].descriptionKey),
      [t],
  );
  useEffect(() => {
      if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
          return;
      }
      const mediaQueryList = window.matchMedia('(prefers-color-scheme: dark)');
      const applySystemTheme = (matches: boolean) => {
          setSystemThemeMode(matches ? 'dark' : 'light');
      };
      applySystemTheme(mediaQueryList.matches);
      const handleChange = (event: MediaQueryListEvent) => {
          applySystemTheme(event.matches);
      };
      if (typeof mediaQueryList.addEventListener === 'function') {
          mediaQueryList.addEventListener('change', handleChange);
          return () => {
              mediaQueryList.removeEventListener('change', handleChange);
          };
      }
      mediaQueryList.addListener(handleChange);
      return () => {
          mediaQueryList.removeListener(handleChange);
      };
  }, []);
  useEffect(() => {
      if (themeMode !== resolvedThemeMode) {
          setTheme(resolvedThemeMode);
      }
      if (effectiveThemePreference === 'system') {
          void safeWindowRuntimeCall(() => WindowSetSystemDefaultTheme(), undefined);
          return;
      }
      if (resolvedThemeMode === 'dark') {
          void safeWindowRuntimeCall(() => WindowSetDarkTheme(), undefined);
          return;
      }
      void safeWindowRuntimeCall(() => WindowSetLightTheme(), undefined);
  }, [effectiveThemePreference, resolvedThemeMode, setTheme, themeMode]);

  // Apply the selected brand mascot to the favicon and supported native OS surfaces.
  useEffect(() => {
      if (typeof document === 'undefined') return;
      const href = resolveBrandIconSrc(brandIconId);
      let link = document.querySelector<HTMLLinkElement>("link[rel='icon'][data-brand-icon='true']");
      if (!link) {
          link = document.createElement('link');
          link.rel = 'icon';
          link.setAttribute('data-brand-icon', 'true');
          document.head.appendChild(link);
      }
      link.type = 'image/svg+xml';
      link.href = href;

      let cancelled = false;
      const applyNativeIcon = async () => {
          try {
              const environment = await Environment();
              if (cancelled || !shouldSyncApplicationBrandIcon(environment)) {
                  return;
              }
              const dockHref = resolveBrandDockSrc(brandIconId);
              // The compact fallback is suitable for UI placeholders, but it
              // must never become the cached Windows taskbar or macOS Dock icon.
              if (!dockHref) return;
              const b64 = await composeMacOSDockIconBase64(dockHref);
              if (cancelled) return;
              const result = await SetApplicationBrandIcon(b64);
              if (!result.success && !cancelled) {
                  console.warn('Failed to update the native application icon:', result.message);
                  message.warning(t('app.settings.entry.brand_icon.native_sync_failed'));
              }
          } catch (error) {
              if (!cancelled) {
                  console.warn('Failed to update the native application icon:', error);
                  message.warning(t('app.settings.entry.brand_icon.native_sync_failed'));
              }
          }
      };
      void applyNativeIcon();
      return () => {
          cancelled = true;
      };
  }, [brandIconId, t, brandAssetRevision]);

  useEffect(() => {
      let cancelled = false;
      const loadBrandAssets = async () => {
          const loaded: Partial<Record<BrandIconId, string>> = {};
          await Promise.all(BRAND_ICONS.map(async (icon) => {
              try {
                  const source = await GetBrandIconDataURL(icon.id);
                  if (source) loaded[icon.id] = source;
              } catch {
                  // The compact in-memory fallback keeps the UI usable offline.
              }
          }));
          if (!cancelled && Object.keys(loaded).length > 0) {
              setLoadedBrandIconSources(loaded);
              setBrandAssetRevision((revision) => revision + 1);
              window.dispatchEvent(new Event('gonavi-brand-assets-ready'));
          }
      };
      void loadBrandAssets();
      return () => { cancelled = true; };
  }, []);

  const selectPresetTheme = useCallback((preference: ThemePreference) => {
      // Custom CSS is an independent skin layer. Selecting a built-in preset
      // first disables that layer, then preserves the existing 3-mode contract.
      if (activeCustomTheme) {
          const result = selectCustomTheme(null);
          if (!result.ok) message.warning(t('app.theme.custom.error.storage_failed'));
      }
      setThemePreference(preference);
  }, [activeCustomTheme, selectCustomTheme, setThemePreference, t]);
  const setTabDisplaySettings = useCallback((settings: Partial<TabDisplaySettings>) => {
      setAppearance({
          tabDisplay: applyTabDisplaySettingsPatch(tabDisplaySettings, settings),
      });
  }, [setAppearance, tabDisplaySettings]);
  const setTabDisplayLayout = useCallback((layout: TabDisplayLayout) => {
      if (layout === tabDisplaySettings.layout) return;
      setAppearance({
          tabDisplay: switchTabDisplayLayout(tabDisplaySettings, layout),
      });
  }, [setAppearance, tabDisplaySettings]);
  const updateTabDisplayElementVisibility = useCallback((key: TabDisplayElementKey, checked: boolean) => {
      setFocusedTabDisplayElementKey(key);
      const removeKey = (keys: TabDisplayElementKey[]) => keys.filter((item) => item !== key);
      if (!checked) {
          setTabDisplaySettings({
              layout: tabDisplaySettings.layout,
              primaryElements: removeKey(tabDisplaySettings.primaryElements),
              secondaryElements: removeKey(tabDisplaySettings.secondaryElements),
          });
          return;
      }

      const primaryElements = removeKey(tabDisplaySettings.primaryElements);
      const secondaryElements = removeKey(tabDisplaySettings.secondaryElements);
      if (tabDisplaySettings.layout === 'double' && TAB_DISPLAY_SECONDARY_DEFAULT_KEYS.includes(key)) {
          secondaryElements.push(key);
      } else {
          primaryElements.push(key);
      }
      setTabDisplaySettings({
          layout: tabDisplaySettings.layout,
          primaryElements,
          secondaryElements,
      });
  }, [setTabDisplaySettings, tabDisplaySettings]);
  const moveTabDisplayElement = useCallback((key: TabDisplayElementKey, offset: -1 | 1) => {
      setFocusedTabDisplayElementKey(key);
      const moveWithin = (keys: TabDisplayElementKey[]) => {
          const index = keys.indexOf(key);
          if (index < 0) return keys;
          const nextIndex = index + offset;
          if (nextIndex < 0 || nextIndex >= keys.length) return keys;
          const next = [...keys];
          [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
          return next;
      };

      setTabDisplaySettings({
          layout: tabDisplaySettings.layout,
          primaryElements: moveWithin(tabDisplaySettings.primaryElements),
          secondaryElements: moveWithin(tabDisplaySettings.secondaryElements),
      });
  }, [setTabDisplaySettings, tabDisplaySettings]);
  const setTabDisplayElementRow = useCallback((key: TabDisplayElementKey, row: 'primary' | 'secondary') => {
      setFocusedTabDisplayElementKey(key);
      const primaryElements = tabDisplaySettings.primaryElements.filter((item) => item !== key);
      const secondaryElements = tabDisplaySettings.secondaryElements.filter((item) => item !== key);
      if (row === 'primary') {
          primaryElements.push(key);
      } else {
          secondaryElements.push(key);
      }
      setTabDisplaySettings({
          layout: tabDisplaySettings.layout,
          primaryElements,
          secondaryElements,
      });
  }, [setTabDisplaySettings, tabDisplaySettings]);
  const resolvedUiFontFamily = resolveUIFontFamily(appearance.customUIFontFamily);
  const resolvedMonoFontFamily = resolveMonoFontFamily(appearance.customMonoFontFamily);
  const appComponentSize: 'small' | 'middle' | 'large' = effectiveUiScale <= 0.92 ? 'small' : (effectiveUiScale >= 1.12 ? 'large' : 'middle');
  const titleBarButtonWidth = Math.max(40, Math.round(46 * effectiveUiScale));
  const floatingLogButtonHeight = Math.max(30, Math.round(34 * effectiveUiScale));
  const resolvedAppearance = resolveAppearanceValues(appearance);
  const effectiveOpacity = normalizeOpacityForPlatform(resolvedAppearance.opacity);
  const effectiveBlur = normalizeBlurForPlatform(resolvedAppearance.blur);
  const blurFilter = blurToFilter(effectiveBlur);
  const [runtimePlatform, setRuntimePlatform] = useState('');
  const [runtimeBuildType, setRuntimeBuildType] = useState('');
  const [isLinuxRuntime, setIsLinuxRuntime] = useState(false);
  const isWebRuntime = runtimeBuildType === 'web'
    || (typeof window !== 'undefined' && (window as any).__GONAVI_WEB_RUNTIME__?.buildType === 'web');
  const [installedFontFamilies, setInstalledFontFamilies] = useState<InstalledFontFamily[]>(EMPTY_INSTALLED_FONT_FAMILIES);
  const [isFontFamiliesLoading, setIsFontFamiliesLoading] = useState(false);
  const [fontFamiliesLoadError, setFontFamiliesLoadError] = useState<string | null>(null);
  const hasLoadedInstalledFontsRef = useRef(false);
  const uiFontOptions = useMemo(
      () => buildFontFamilyOptions(runtimePlatform, 'ui', installedFontFamilies, t),
      [installedFontFamilies, runtimePlatform, t],
  );
  const monoFontOptions = useMemo(
      () => buildFontFamilyOptions(runtimePlatform, 'mono', installedFontFamilies, t),
      [installedFontFamilies, runtimePlatform, t],
  );
  const linuxCJKFontInstallHint = getLinuxCJKFontInstallHint(runtimePlatform, installedFontFamilies);
  const [isStoreHydrated, setIsStoreHydrated] = useState(() => useStore.persist.hasHydrated());
  const closeTabsByConnection = useStore(state => state.closeTabsByConnection);
  const savedQueriesBootstrapPromiseRef = useRef<Promise<void> | null>(null);
  const savedQueriesLoadedRef = useRef(false);
  const [hasLoadedSecureConfig, setHasLoadedSecureConfig] = useState(false);
  const [downloadSource, setDownloadSource] = useState<DownloadSourceId>('cst');
  const [downloadSourceSaving, setDownloadSourceSaving] = useState(false);
  const [hasLoadedConnectionSidebarLayout, setHasLoadedConnectionSidebarLayout] = useState(false);
  const connectionSidebarLayoutCoordinatorRef = useRef<ConnectionSidebarLayoutCoordinator | null>(null);
  const [viewportWidth, setViewportWidth] = useState(() => (typeof window === 'undefined' ? 1280 : window.innerWidth || 1280));
  const [securityUpdateStatus, setSecurityUpdateStatus] = useState<SecurityUpdateStatus>(() => createEmptySecurityUpdateStatus());
  const [securityUpdateRawPayload, setSecurityUpdateRawPayload] = useState<string | null>(null);
  const [securityUpdateHasLegacySensitiveItems, setSecurityUpdateHasLegacySensitiveItems] = useState(false);
  const [isSecurityUpdateIntroOpen, setIsSecurityUpdateIntroOpen] = useState(false);
  const [isSecurityUpdateBannerDismissed, setIsSecurityUpdateBannerDismissed] = useState(false);
  const [securityUpdateSettingsFocusTarget, setSecurityUpdateSettingsFocusTarget] = useState<SecurityUpdateSettingsFocusTarget | null>(null);
  const [securityUpdateSettingsFocusRequest, setSecurityUpdateSettingsFocusRequest] = useState(0);
  const [isSecurityUpdateProgressOpen, setIsSecurityUpdateProgressOpen] = useState(false);
  const [securityUpdateProgressStage, setSecurityUpdateProgressStage] = useState(() => t('app.security_update.stage.checking_saved_config'));
  const [securityUpdateRepairSource, setSecurityUpdateRepairSource] = useState<SecurityUpdateRepairSource | null>(null);
  const isSettingsModalOpen = useStore((state) => state.tabs.some((tab) => tab.id === SETTINGS_CENTER_WORKBENCH_TAB_ID));
  const openSettingsCenterWorkbenchTab = useCallback(() => {
      useStore.getState().addTab(buildSettingsCenterWorkbenchTab());
  }, []);
  const closeSettingsCenterWorkbenchTab = useCallback(() => {
      const { tabs, closeTab } = useStore.getState();
      if (tabs.some((tab) => tab.id === SETTINGS_CENTER_WORKBENCH_TAB_ID)) {
          closeTab(SETTINGS_CENTER_WORKBENCH_TAB_ID);
      }
  }, []);
  const [isConnectionGroupManagementOpen, setIsConnectionGroupManagementOpen] = useState(false);
  const [activeSettingsCenterGroupKey, setActiveSettingsCenterGroupKey] = useState<SettingsCenterGroupKey>('preferences');
  const [activeSettingsCenterPane, setActiveSettingsCenterPane] = useState<SettingsCenterPaneState | null>(null);
  const activeSettingsCenterPaneRef = useRef<SettingsCenterPaneState | null>(null);
  const aiSettingsLeaveGuardRef = useRef<AISettingsLeaveGuard | null>(null);
  const registerAISettingsLeaveGuard = useCallback((guard: AISettingsLeaveGuard | null) => {
      aiSettingsLeaveGuardRef.current = guard;
  }, []);
  activeSettingsCenterPaneRef.current = activeSettingsCenterPane;
  const [focusedTabDisplayElementKey, setFocusedTabDisplayElementKey] = useState<TabDisplayElementKey | null>(null);
  const [focusedAIProviderId, setFocusedAIProviderId] = useState<string | undefined>(undefined);
  const [aiSettingsSection, setAiSettingsSection] = useState<AISettingsSectionKey>('providers');
  const [aiSettingsProviderView, setAiSettingsProviderView] = useState<'workspace' | 'connected'>('workspace');
  const [connectionPackageDialog, setConnectionPackageDialog] = useState<ConnectionPackageDialogState>(() => createClosedConnectionPackageDialogState());
  const [pendingConnectionImportPayload, setPendingConnectionImportPayload] = useState<string | null>(null);
  const [connectionImportTargetTagId, setConnectionImportTargetTagId] = useState('');
  const [connectionImportNotice, setConnectionImportNotice] = useState<ConnectionImportNotice | null>(null);
  const browserConnectionImportInputRef = useRef<HTMLInputElement>(null);
  const browserConnectionImportSourceGroupRef = useRef<ToolCenterGroupKey | undefined>(undefined);
  const [aiPanelRenderNonce, setAiPanelRenderNonce] = useState(0);
  const [aiSettingsRenderNonce, setAiSettingsRenderNonce] = useState(0);
  const LazyAIChatPanel = useMemo(createLazyAIChatPanel, [aiPanelRenderNonce]);
  const LazyAISettingsContent = useMemo(createLazyAISettingsContent, [aiSettingsRenderNonce]);
  const sidebarWidth = useStore(state => state.sidebarWidth);
  const setSidebarWidth = useStore(state => state.setSidebarWidth);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [collapsedSidebarActionsTarget, setCollapsedSidebarActionsTarget] = useState<HTMLDivElement | null>(null);
  const sidebarContentRef = useRef<HTMLDivElement>(null);
  const sidebarCollapsedToggleRef = useRef<HTMLButtonElement>(null);
  const sidebarExplorerToggleRef = useRef<HTMLButtonElement>(null);
  const pendingSidebarToggleFocusRef = useRef<'collapsed' | 'explorer' | null>(null);
  const navigatorPlatform = detectNavigatorPlatform();
  const documentPlatform = resolveDocumentPlatform(runtimePlatform, navigatorPlatform);
  const titlebarRuntimePlatform = resolveTitlebarRuntimePlatform(runtimePlatform, navigatorPlatform);
  const isMacRuntime = titlebarRuntimePlatform === 'darwin';
  const shouldDockCollapsedSidebarActionsInTitlebar = resolveCollapsedSidebarDocking(
      runtimePlatform,
      navigatorPlatform,
      isWebRuntime,
  );
  const isCollapsedSidebarActionsDocked = isSidebarCollapsed && shouldDockCollapsedSidebarActionsInTitlebar;
  useLayoutEffect(() => {
      const sidebarContent = sidebarContentRef.current;
      if (!sidebarContent) return;
      // aria-hidden alone does not remove focusable tree wrappers from the tab order.
      sidebarContent.inert = isCollapsedSidebarActionsDocked;
  }, [isCollapsedSidebarActionsDocked]);
  const handleCollapseSidebarPanel = useCallback(() => {
      if (typeof document !== 'undefined') {
          const activeElement = document.activeElement as HTMLElement | null;
          if (activeElement?.closest?.('[data-sidebar-content="true"]')) {
              activeElement.blur();
          }
      }
      pendingSidebarToggleFocusRef.current = 'collapsed';
      setIsSidebarCollapsed(true);
  }, []);
  const handleExpandSidebarPanel = useCallback(() => {
      pendingSidebarToggleFocusRef.current = 'explorer';
      setIsSidebarCollapsed(false);
  }, []);
  const handleTitlebarSidebarToggle = useCallback(() => {
      setIsSidebarCollapsed((collapsed) => !collapsed);
  }, []);
  useLayoutEffect(() => {
      const target = pendingSidebarToggleFocusRef.current;
      if (!target) return;
      if (
          target === 'collapsed'
          && isCollapsedSidebarActionsDocked
          && !collapsedSidebarActionsTarget
      ) return;
      pendingSidebarToggleFocusRef.current = null;
      (target === 'collapsed' ? sidebarCollapsedToggleRef : sidebarExplorerToggleRef).current?.focus();
  }, [collapsedSidebarActionsTarget, isCollapsedSidebarActionsDocked, isSidebarCollapsed]);
  const titleBarLayout = resolveTitleBarLayout(
      effectiveUiScale,
      isCollapsedSidebarActionsDocked,
      effectiveSidebarRailScale,
  );
  const titleBarHeight = titleBarLayout.height;
  const sidebarCollapsedWidth = !shouldDockCollapsedSidebarActionsInTitlebar
      ? 38 * effectiveUiScale * effectiveSidebarRailScale
      : 0;
  const renderedSidebarWidth = isSidebarCollapsed ? sidebarCollapsedWidth : sidebarWidth;
  const aiPanelVisible = useStore(state => state.aiPanelVisible);
  const detachedAIChatWindow = useStore(state => state.detachedAIChatWindow);
  const detachAIChatPanel = useStore(state => state.detachAIChatPanel);
  const aiChatDetached = Boolean(detachedAIChatWindow);
  const detachedAIChatZIndex = Number(detachedAIChatWindow?.zIndex);
  const settingsCenterModalZIndex = Math.max(
    APP_FOREGROUND_MODAL_Z_INDEX,
    Number.isFinite(detachedAIChatZIndex) ? detachedAIChatZIndex + 1 : APP_FOREGROUND_MODAL_Z_INDEX,
  );
  const settingsChildModalZIndex = Math.max(
    APP_NESTED_MODAL_Z_INDEX,
    settingsCenterModalZIndex + 100,
  );
  const applicationQuitModalZIndex = Math.max(
    APP_APPLICATION_QUIT_MODAL_Z_INDEX,
    settingsChildModalZIndex + 100,
  );
  const setAIPanelVisible = useStore(state => state.setAIPanelVisible);
  const aiPanelTerminalGuardRef = useRef<(() => Promise<boolean>) | null>(null);
  const aiPanelTerminalActionPendingRef = useRef(false);
  const registerAIPanelTerminalGuard = useCallback((guard: (() => Promise<boolean>) | null) => {
    aiPanelTerminalGuardRef.current = guard;
  }, []);
  const runAIPanelTerminalAction = useCallback((action: () => void) => {
    if (aiPanelTerminalActionPendingRef.current) return;
    aiPanelTerminalActionPendingRef.current = true;
    void (async () => {
      try {
        const canTerminate = await aiPanelTerminalGuardRef.current?.();
        if (canTerminate === false) return;
        action();
      } catch (error) {
        console.warn('Failed to stop AI activity before changing the panel state', error);
      } finally {
        aiPanelTerminalActionPendingRef.current = false;
      }
    })();
  }, []);
  const handleCloseAIPanel = useCallback(() => {
    runAIPanelTerminalAction(() => setAIPanelVisible(false));
  }, [runAIPanelTerminalAction, setAIPanelVisible]);
  const handleDetachAIPanel = useCallback(() => {
    runAIPanelTerminalAction(() => detachAIChatPanel());
  }, [detachAIChatPanel, runAIPanelTerminalAction]);
  const handleToggleOrFocusAIPanel = useCallback(() => {
    if (aiPanelVisible && (!aiChatDetached || !hasNativeDetachedWindowManager())) {
      handleCloseAIPanel();
      return;
    }
    void toggleOrFocusNativeAIChatFromMainWindow().catch((error) => {
      void message.error(error instanceof Error ? error.message : String(error));
    });
  }, [aiChatDetached, aiPanelVisible, handleCloseAIPanel]);
  useEffect(() => {
    if (!aiPanelVisible || !detachedAIChatWindow || !hasNativeDetachedWindowManager()) {
      return undefined;
    }
    let active = true;
    void openNativeAIChatWindow().catch((error) => {
      if (!active) return;
      useStore.getState().attachAIChatPanel();
      void message.error(error instanceof Error ? error.message : String(error));
    });
    return () => {
      active = false;
    };
  }, [aiPanelVisible, aiChatDetached]);
  const windowDiagSequenceRef = React.useRef(0);
  const windowDiagLastSignatureRef = React.useRef('');
  const windowDiagLastAtRef = React.useRef(0);
  const captureMainWindowStateRef = React.useRef<() => Promise<void>>(async () => undefined);
  const connectionWorkbenchState = getConnectionWorkbenchState(
      isStoreHydrated,
      hasLoadedSecureConfig,
      hasLoadedConnectionSidebarLayout,
  );
  const securityUpdateStatusMeta = useMemo(
      () => getSecurityUpdateStatusMeta(securityUpdateStatus, t),
      [securityUpdateStatus, t],
  );
  const securityUpdateEntryVisibility = useMemo(
      () => resolveSecurityUpdateEntryVisibility(securityUpdateStatus),
      [securityUpdateStatus],
  );
  const isSecurityUpdateBannerVisible = securityUpdateEntryVisibility.showBanner
      && !isSecurityUpdateBannerDismissed;

  const windowCornerRadius = 14;
  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    const syncViewportWidth = () => {
      setViewportWidth(window.innerWidth || document.documentElement?.clientWidth || 1280);
    };
    syncViewportWidth();
    window.addEventListener('resize', syncViewportWidth);
    return () => window.removeEventListener('resize', syncViewportWidth);
  }, []);

  useEffect(()=>{
    if (typeof document === 'undefined' || !document.body) {
        return;
    }
    switch(windowState){
        case 'fullscreen':
        case 'maximized':
            document.body.style.setProperty('--gonavi-border-radius', '0px');
            break;
        default:
            document.body.style.setProperty('--gonavi-border-radius', `${windowCornerRadius}px`);
            break;
    }
  }, [windowState]);

  // 同步 macOS 窗口透明度：opacity=1.0 且 blur=0 时关闭 NSVisualEffectView，
  // 避免 GPU 持续计算窗口背后的模糊合成
  useEffect(() => {
    try {
        void SetWindowTranslucency(resolvedAppearance.opacity, resolvedAppearance.blur, darkMode).catch(() => undefined);
    } catch(e) { /* ignore */ }
  }, [darkMode, resolvedAppearance.blur, resolvedAppearance.opacity]);

  useEffect(() => {
      let cancelled = false;
      try {
          Environment()
              .then((env) => {
                  if (cancelled) return;
                  const platform = normalizeTitlebarRuntimePlatform(String(env?.platform || ''));
                  setRuntimePlatform(platform);
                  setRuntimeBuildType(String(env?.buildType || '').trim().toLowerCase());
                  setIsLinuxRuntime(platform === 'linux');
              })
              .catch(() => {
                  if (cancelled) return;
                  const normalized = resolveDocumentPlatform('', detectNavigatorPlatform());
                  setRuntimePlatform(normalized);
                  setIsLinuxRuntime(normalized === 'linux');
              });
      } catch(e) {
          if (cancelled) return;
          const normalized = resolveDocumentPlatform('', detectNavigatorPlatform());
          setRuntimePlatform(normalized);
          setIsLinuxRuntime(normalized === 'linux');
      }
      return () => {
          cancelled = true;
      };
  }, []);

  useEffect(() => {
      if (isStoreHydrated) {
          return;
      }
      const unsubscribe = useStore.persist.onFinishHydration(() => {
          setIsStoreHydrated(true);
      });
      return () => {
          unsubscribe();
      };
  }, [isStoreHydrated]);

  const ensureSavedQueriesLoaded = useCallback(async (): Promise<void> => {
      if (savedQueriesLoadedRef.current) {
          return;
      }
      if (!savedQueriesBootstrapPromiseRef.current) {
          savedQueriesBootstrapPromiseRef.current = (async () => {
              await bootstrapSavedQueries({
                  backend: (window as any).go?.app?.App,
                  replaceSavedQueries,
              });
              savedQueriesLoadedRef.current = true;
              void reloadSavedQueryGroups().catch((error) => {
                  console.warn('Failed to reload saved query groups', error);
              });
          })();
      }
      const pending = savedQueriesBootstrapPromiseRef.current;
      try {
          await pending;
      } catch (error) {
          if (savedQueriesBootstrapPromiseRef.current === pending) {
              savedQueriesBootstrapPromiseRef.current = null;
          }
          throw error;
      }
  }, [reloadSavedQueryGroups, replaceSavedQueries]);

  useEffect(() => {
      if (!isStoreHydrated) {
          return;
      }
      void ensureSavedQueriesLoaded().catch((err) => {
          console.warn('Failed to bootstrap saved queries', err);
      });
  }, [ensureSavedQueriesLoaded, isStoreHydrated]);

  const normalizeSecurityUpdateStatus = useCallback((status?: Partial<SecurityUpdateStatus> | null): SecurityUpdateStatus => {
      const fallback = createEmptySecurityUpdateStatus();
      return {
          ...fallback,
          ...(status ?? {}),
          summary: {
              ...fallback.summary,
              ...(status?.summary ?? {}),
          },
          issues: Array.isArray(status?.issues) ? status.issues : [],
      };
  }, []);

  const applySecurityUpdateStatus = useCallback((
      status?: Partial<SecurityUpdateStatus> | null,
      options?: {
          openSettings?: boolean;
          refreshFocus?: boolean;
          resetBannerDismissed?: boolean;
      },
  ) => {
      const nextStatus = normalizeSecurityUpdateStatus(status);
      const visibility = resolveSecurityUpdateEntryVisibility(nextStatus);
      setSecurityUpdateStatus(nextStatus);
      setIsSecurityUpdateIntroOpen(visibility.showIntro);
      if (options?.resetBannerDismissed !== false) {
          setIsSecurityUpdateBannerDismissed(false);
      }
      if (options?.openSettings) {
          withAISettingsLeaveGuard(aiSettingsLeaveGuardRef.current, () => {
              if (options.refreshFocus !== false) {
                  setSecurityUpdateSettingsFocusTarget(resolveSecurityUpdateSettingsFocusTarget(nextStatus));
                  setSecurityUpdateSettingsFocusRequest((current) => current + 1);
              }
              setToolCenterBackGroupKey('config');
              setActiveSettingsCenterGroupKey('config');
              setActiveSettingsCenterPane({ key: 'security-update', group: 'config' });
              openSettingsCenterWorkbenchTab();
          });
      }
      return nextStatus;
  }, [normalizeSecurityUpdateStatus]);

  useEffect(() => {
      if (!isStoreHydrated) {
          return;
      }

      let cancelled = false;
      const loadSecureConfig = async () => {
          try {
              const result = await bootstrapSecureConfig({
                  backend: (window as any).go?.app?.App,
                  autoStartLegacySecurityUpdate: true,
                  replaceConnections,
                  replaceGlobalProxy,
                  t,
              });
              if (cancelled) {
                  return;
              }
              setSecurityUpdateRawPayload(result.rawPayload);
              setSecurityUpdateHasLegacySensitiveItems(result.hasLegacySensitiveItems);
              applySecurityUpdateStatus(result.status);
          } catch (err) {
              console.warn('Failed to bootstrap secure config', err);
          } finally {
              if (!cancelled) {
                  setHasLoadedSecureConfig(true);
              }
          }
      };

      void loadSecureConfig();
      return () => {
          cancelled = true;
      };
  }, [applySecurityUpdateStatus, isStoreHydrated, replaceConnections, replaceGlobalProxy, t]);

  useEffect(() => {
      let cancelled = false;
      const backendApp = (window as any).go?.app?.App;
      if (typeof backendApp?.GetDownloadSourceConfig !== 'function') {
          return () => {
              cancelled = true;
          };
      }
      void backendApp.GetDownloadSourceConfig()
          .then((result: { source?: string } | undefined) => {
              if (!cancelled) {
                  setDownloadSource(normalizeDownloadSource(result?.source));
              }
          })
          .catch((error: unknown) => {
              if (!cancelled) {
                  console.warn('Failed to load download source preference', error);
              }
          });
      return () => {
          cancelled = true;
      };
  }, []);

  useEffect(() => {
      const syncDownloadSource = (event: Event) => {
          setDownloadSource(normalizeDownloadSource((event as CustomEvent<{ source?: unknown }>).detail?.source));
      };
      window.addEventListener(DOWNLOAD_SOURCE_CHANGED_EVENT, syncDownloadSource);
      return () => window.removeEventListener(DOWNLOAD_SOURCE_CHANGED_EVENT, syncDownloadSource);
  }, []);

  const handleDownloadSourceChange = useCallback(async (value: DownloadSourceId) => {
      const nextSource = normalizeDownloadSource(value);
      const previousSource = downloadSource;
      setDownloadSource(nextSource);
      notifyDownloadSourceChanged(nextSource);
      const backendApp = (window as any).go?.app?.App;
      if (typeof backendApp?.SaveDownloadSourceConfig !== 'function') {
          return;
      }
      setDownloadSourceSaving(true);
      try {
          const result = await backendApp.SaveDownloadSourceConfig(nextSource);
          const savedSource = normalizeDownloadSource(result?.source ?? nextSource);
          setDownloadSource(savedSource);
          notifyDownloadSourceChanged(savedSource);
          void message.success(t('app.download_source.message.saved'));
      } catch (error: unknown) {
          setDownloadSource(previousSource);
          notifyDownloadSourceChanged(previousSource);
          void message.error(error instanceof Error ? error.message : t('app.download_source.message.save_failed'));
      } finally {
          setDownloadSourceSaving(false);
      }
  }, [downloadSource, t]);

  useEffect(() => {
      if (!isStoreHydrated || !hasLoadedSecureConfig) {
          return;
      }

      let cancelled = false;
      const notificationKey = 'connection-sidebar-layout-save-state';
      let coordinator: ConnectionSidebarLayoutCoordinator;
      coordinator = createConnectionSidebarLayoutCoordinator({
          backend: (window as any).go?.app?.App,
          store: {
              getLayout: () => {
                  const state = useStore.getState();
                  return {
                      connectionTags: state.connectionTags,
                      sidebarRootOrder: state.sidebarRootOrder,
                      rootSortMode: state.rootSortMode,
                      rootConnectionSortMode: state.rootConnectionSortMode,
                  };
              },
              replaceLayout: replaceConnectionSidebarLayout,
              subscribe: (listener) => useStore.subscribe((state, previousState) => {
                    if (
                        state.connectionTags !== previousState.connectionTags
                        || state.sidebarRootOrder !== previousState.sidebarRootOrder
                        || state.rootSortMode !== previousState.rootSortMode
                        || state.rootConnectionSortMode !== previousState.rootConnectionSortMode
                    ) {
                      listener();
                  }
              }),
          },
          onError: (error) => {
              console.warn('Failed to synchronize shared connection sidebar layout', error);
          },
          onSaveStateChange: (state) => {
              if (cancelled) return;
              if (state.status === 'saving') {
                  notificationApi.open({
                      key: notificationKey,
                      message: t('app.connection_sidebar_layout.saving'),
                      description: t('app.connection_sidebar_layout.saving_description'),
                      icon: <SyncOutlined spin />,
                      duration: 0,
                      placement: 'bottomRight',
                  });
                  return;
              }
              if (state.status === 'saved') {
                  notificationApi.success({
                      key: notificationKey,
                      message: t('app.connection_sidebar_layout.saved'),
                      description: t('app.connection_sidebar_layout.saved_description'),
                      duration: 2,
                      placement: 'bottomRight',
                  });
                  return;
              }
              if (state.status === 'error') {
                  const detail = state.error instanceof Error
                      ? state.error.message
                      : String(state.error);
                  notificationApi.error({
                      key: notificationKey,
                      message: t('app.connection_sidebar_layout.save_failed'),
                      description: t('app.connection_sidebar_layout.save_failed_description', { detail }),
                      btn: (
                          <Button
                            size="small"
                            type="primary"
                            onClick={() => void coordinator.retryPendingSave().catch(() => undefined)}
                          >
                            {t('app.connection_sidebar_layout.retry_save')}
                          </Button>
                      ),
                      duration: 0,
                      placement: 'bottomRight',
                  });
                  return;
              }
              notificationApi.warning({
                  key: notificationKey,
                  message: t('app.connection_sidebar_layout.conflict'),
                  description: t('app.connection_sidebar_layout.conflict_description'),
                  btn: (
                      <div style={{ display: 'flex', gap: 8 }}>
                          <Button
                            size="small"
                            onClick={() => {
                                coordinator.acceptRemoteLayout();
                                notificationApi.info({
                                    key: notificationKey,
                                    message: t('app.connection_sidebar_layout.remote_applied'),
                                    description: t('app.connection_sidebar_layout.remote_applied_description'),
                                    duration: 2,
                                    placement: 'bottomRight',
                                });
                            }}
                          >
                            {t('app.connection_sidebar_layout.refresh_remote')}
                          </Button>
                          <Button
                            size="small"
                            type="primary"
                            onClick={() => void coordinator.retryPendingSave().catch(() => undefined)}
                          >
                            {t('app.connection_sidebar_layout.retry_save')}
                          </Button>
                      </div>
                  ),
                  duration: 0,
                  placement: 'bottomRight',
              });
          },
          refreshIntervalMs: 2_000,
      });
      connectionSidebarLayoutCoordinatorRef.current = coordinator;
      const flushConnectionSidebarLayout = () => {
          void coordinator.flush().catch((error) => {
              console.warn('Failed to flush shared connection sidebar layout', error);
          });
      };
      const refreshConnectionSidebarLayout = () => {
          void coordinator.refresh().catch(() => undefined);
      };
      const refreshVisibleConnectionSidebarLayout = () => {
          if (document.visibilityState === 'visible') {
              refreshConnectionSidebarLayout();
          }
      };
      window.addEventListener('pagehide', flushConnectionSidebarLayout, true);
      window.addEventListener('beforeunload', flushConnectionSidebarLayout, true);
      window.addEventListener('focus', refreshConnectionSidebarLayout);
      document.addEventListener('visibilitychange', refreshVisibleConnectionSidebarLayout);
      void coordinator.bootstrap().finally(() => {
          if (!cancelled) {
              setHasLoadedConnectionSidebarLayout(true);
          }
      });

      return () => {
          cancelled = true;
          window.removeEventListener('pagehide', flushConnectionSidebarLayout, true);
          window.removeEventListener('beforeunload', flushConnectionSidebarLayout, true);
          window.removeEventListener('focus', refreshConnectionSidebarLayout);
          document.removeEventListener('visibilitychange', refreshVisibleConnectionSidebarLayout);
          notificationApi.destroy(notificationKey);
          coordinator.dispose();
          if (connectionSidebarLayoutCoordinatorRef.current === coordinator) {
              connectionSidebarLayoutCoordinatorRef.current = null;
          }
      };
  }, [hasLoadedSecureConfig, isStoreHydrated, notificationApi, replaceConnectionSidebarLayout, t]);

  useEffect(() => {
      let cancelled = false;
      let startupWindowTimer: number | null = null;
      let restoredOnce = false;
      const maxApplyAttempts = 8;
      const applyRetryDelayMs = 350;
      const settleDelayMs = 180;
      const startupRestoreGraceMs = 6000;
      let refreshWebViewBoundsUnavailableLogged = false;
      let refreshWebViewBoundsDisabled = false;
      const wait = (delayMs: number) => new Promise<void>((resolve) => window.setTimeout(resolve, delayMs));

      const waitForMaximisedState = (expected: boolean): Promise<boolean> => waitForWindowCondition({
          read: async () => (await WindowIsMaximised()) === expected,
          wait,
          isCancelled: () => cancelled,
          maxChecks: 16,
          intervalMs: 40,
      });

      const checkStartupPreferenceApplied = async (): Promise<boolean> => {
          try {
              const [isMaximised, size] = await Promise.all([
                  WindowIsMaximised(),
                  WindowGetSize(),
              ]);
              return isStartupMaximisedWindowSettled({
                  windowWidth: Number(size?.w),
                  windowHeight: Number(size?.h),
                  isMaximised,
                  isWindows: isWindowsPlatform(),
                  surfaceWidth: window.innerWidth,
                  surfaceHeight: window.innerHeight,
                  viewport: readCurrentVisibleViewport(),
              });
          } catch (_) {
              // ignore
          }
          return false;
      };

      const tryRefreshStartupWebViewBounds = async (): Promise<boolean> => {
          if (
              !isWindowsPlatform()
              || refreshWebViewBoundsDisabled
              || (window as any).__GONAVI_WEB_RUNTIME__?.buildType === 'web'
          ) {
              return false;
          }
          const backendApp = (window as any).go?.app?.App;
          if (typeof backendApp?.RefreshWebViewBounds !== 'function') {
              refreshWebViewBoundsDisabled = true;
              if (!refreshWebViewBoundsUnavailableLogged) {
                  refreshWebViewBoundsUnavailableLogged = true;
                  console.warn('RefreshWebViewBounds backend is unavailable during startup maximise');
              }
              return false;
          }
          try {
              const result = await backendApp.RefreshWebViewBounds();
              if (result?.success) {
                  window.dispatchEvent(new Event('resize'));
                  return true;
              }
              refreshWebViewBoundsDisabled = true;
              if (!refreshWebViewBoundsUnavailableLogged) {
                  refreshWebViewBoundsUnavailableLogged = true;
                  console.warn('RefreshWebViewBounds failed during startup maximise:', result?.message);
              }
          } catch (error) {
              refreshWebViewBoundsDisabled = true;
              if (!refreshWebViewBoundsUnavailableLogged) {
                  refreshWebViewBoundsUnavailableLogged = true;
                  console.warn('RefreshWebViewBounds call failed during startup maximise', error);
              }
          }
          return false;
      };

      const waitForNativeWindowBounds = (bounds: {
          width: number;
          height: number;
          x: number;
          y: number;
      }): Promise<boolean> => waitForWindowCondition({
          read: async () => {
              const [size, position] = await Promise.all([
                  WindowGetSize(),
                  WindowGetPosition(),
              ]);
              return Math.abs(Math.trunc(Number(size?.w)) - bounds.width) <= 2
                  && Math.abs(Math.trunc(Number(size?.h)) - bounds.height) <= 2
                  && Math.abs(Math.trunc(Number(position?.x)) - bounds.x) <= 2
                  && Math.abs(Math.trunc(Number(position?.y)) - bounds.y) <= 2;
          },
          wait,
          isCancelled: () => cancelled,
          maxChecks: 16,
          intervalMs: 40,
      });

      const waitForStartupPreferenceApplied = (): Promise<boolean> => waitForWindowCondition({
          read: checkStartupPreferenceApplied,
          wait,
          isCancelled: () => cancelled,
          maxChecks: 10,
          intervalMs: 40,
      });

      const repairStartupMaximisedSurface = async (): Promise<boolean> => {
          if (!isWindowsPlatform()) {
              return false;
          }
          markStartupWindowRestorePending(startupRestoreGraceMs);
          WindowUnmaximise();
          if (!await waitForMaximisedState(false)) {
              return false;
          }
          WindowMaximise();
          if (!await waitForMaximisedState(true)) {
              return false;
          }
          await tryRefreshStartupWebViewBounds();
          return waitForStartupPreferenceApplied();
      };

      const markStartupMaximised = () => {
          // 启动偏好成功后立刻同步实际窗口态，避免 settle 宽限期留下瞬态 normal。
          useStore.getState().setWindowState('maximized');
          clearStartupWindowRestorePending();
      };

      /** Maximise 多次失败时：退回普通窗口并铺满工作区，避免残留默认半窗。 */
      const applyWindowsWorkAreaFillFallback = async (): Promise<boolean> => {
          if (!isWindowsPlatform()) {
              return false;
          }
          try {
              markStartupWindowRestorePending(startupRestoreGraceMs);
              if (await WindowIsMaximised()) {
                  WindowUnmaximise();
                  if (!await waitForMaximisedState(false)) {
                      return false;
                  }
              }
              const viewport = readCurrentVisibleViewport();
              const nextBounds = resolveWorkAreaFillWindowBounds(viewport);
              const setPosition = resolveWailsWindowSetPosition(nextBounds, viewport, {
                  useMonitorLocalOrigin: true,
              });
              WindowSetPosition(setPosition.x, setPosition.y);
              WindowSetSize(nextBounds.width, nextBounds.height);
              const boundsApplied = await waitForNativeWindowBounds(nextBounds);
              if (!boundsApplied) {
                  return false;
              }
              await tryRefreshStartupWebViewBounds();
              const surfaceFilled = await waitForWindowCondition({
                  read: async () => isStartupWindowSurfaceCoveringViewport({
                      surfaceWidth: window.innerWidth,
                      surfaceHeight: window.innerHeight,
                      viewport: readCurrentVisibleViewport(),
                  }),
                  wait,
                  isCancelled: () => cancelled,
                  maxChecks: 10,
                  intervalMs: 40,
              });
              if (!surfaceFilled) return false;
              useStore.getState().setWindowBounds(nextBounds);
              useStore.getState().setWindowState('normal');
              void emitWindowDiagnostic('adjust:startup-work-area-fill-fallback', {
                  to: nextBounds,
              });
              return true;
          } catch (e) {
              console.warn('Failed to apply Windows work-area fill fallback', e);
              return false;
          }
      };

      // Windows、Linux 与 macOS 的启动偏好都使用普通窗口最大化，不进入系统全屏。
      // 第 1 次立即执行（delay=0），缩短普通窗口首帧到目标窗口态的过渡。
      const applyStartupWindowChrome = (attempt: number) => {
          if (startupWindowTimer !== null) {
              window.clearTimeout(startupWindowTimer);
          }
          const delayMs = attempt <= 1 ? 0 : applyRetryDelayMs;
          startupWindowTimer = window.setTimeout(() => {
              if (cancelled) {
                  return;
              }
              void Promise.resolve()
                  .then(async () => {
                      markStartupWindowRestorePending(startupRestoreGraceMs);
                      if (await checkStartupPreferenceApplied()) {
                          markStartupMaximised();
                          return;
                      }
                      try {
                          WindowMaximise();
                          if (await waitForMaximisedState(true)) {
                              await tryRefreshStartupWebViewBounds();
                          }
                      } catch (e) {
                          console.warn("Wails Window APIs unavailable", e);
                      }

                      if (await waitForStartupPreferenceApplied()) {
                          markStartupMaximised();
                          return;
                      }
                      if (attempt < maxApplyAttempts) {
                          applyStartupWindowChrome(attempt + 1);
                      } else {
                          // WebView2 controller bounds may remain at the initial 1440x900 even
                          // after WS_MAXIMIZE is set. Use one cold-start-only native transition
                          // if the zero-animation bounds refresh could not settle the surface.
                          if (await repairStartupMaximisedSurface()) {
                              markStartupMaximised();
                              return;
                          }
                          // 最终仍失败：Windows 铺满工作区兜底，再结束宽限
                          void emitWindowDiagnostic('warn:startup-maximise-failed', {
                              attempts: attempt,
                          });
                          const fallbackApplied = await applyWindowsWorkAreaFillFallback();
                          if (!fallbackApplied) {
                              void emitWindowDiagnostic('error:startup-work-area-fill-fallback-failed');
                          }
                          clearStartupWindowRestorePending();
                      }
                  });
          }, delayMs);
      };

      const applyRestoredWindowBounds = (bounds: {
          width: number;
          height: number;
          x: number;
          y: number;
      }) => {
          const state = useStore.getState();
          const viewport = readCurrentVisibleViewport();
          const nextBounds = resolveVisibleStartupWindowBounds(bounds, viewport);
          if (
              nextBounds.x !== bounds.x ||
              nextBounds.y !== bounds.y ||
              nextBounds.width !== bounds.width ||
              nextBounds.height !== bounds.height
          ) {
              void emitWindowDiagnostic('adjust:startup-window-bounds', {
                  from: bounds,
                  to: nextBounds,
              });
          }
          WindowSetSize(nextBounds.width, nextBounds.height);
          const setPosition = resolveWailsWindowSetPosition(nextBounds, viewport, {
              useMonitorLocalOrigin: isWindowsPlatform(),
          });
          WindowSetPosition(setPosition.x, setPosition.y);
          state.setWindowBounds(nextBounds);
          return nextBounds;
      };

      const restoreNormalWindowBounds = async (bounds: {
          width: number;
          height: number;
          x: number;
          y: number;
      }) => {
          try {
              if (await WindowIsFullscreen()) {
                  WindowUnfullscreen();
                  await new Promise((resolve) => window.setTimeout(resolve, settleDelayMs));
              }
              if (await WindowIsMaximised()) {
                  WindowUnmaximise();
                  await new Promise((resolve) => window.setTimeout(resolve, settleDelayMs));
              }
          } catch (e) {
              console.warn('Failed to restore normal window chrome', e);
          }
          const appliedBounds = applyRestoredWindowBounds(bounds);
          // Wails can finish the native normal-window transition before the
          // WebView2 controller receives its first size update. Wait for the
          // native rect, then explicitly resize the controller just as the
          // maximised startup path does.
          if (isWindowsPlatform()) {
              await waitForNativeWindowBounds(appliedBounds);
              await tryRefreshStartupWebViewBounds();
          }
          useStore.getState().setWindowState('normal');
      };

      const restoreWindowState = async () => {
          if (cancelled) return;
          // 仅在 hydration 完成后跑一次（或显式重入）；避免未水合默认态先写半窗 bounds
          if (!useStore.persist.hasHydrated()) {
              return;
          }
          if (restoredOnce) {
              return;
          }
          restoredOnce = true;

          const state = useStore.getState();
          const bounds = state.windowBounds;
          const restoreMode = resolveStartupWindowRestoreMode(
              state.startupFullscreen,
              state.windowState,
          );
          if (restoreMode !== 'normal') {
              markStartupWindowRestorePending(startupRestoreGraceMs);
              if (bounds && bounds.width >= 400 && bounds.height >= 300) {
                  try {
                      // Seed the OS restore rectangle before maximising so a later
                      // unmaximise returns to the last normal bounds. A frontend
                      // reload may already be maximised: SetSize in that state
                      // shrinks the HWND while its client area stays maximised.
                      if (!await WindowIsMaximised() && !await WindowIsFullscreen() && !cancelled) {
                          const appliedBounds = applyRestoredWindowBounds(bounds);
                          await waitForNativeWindowBounds(appliedBounds);
                      }
                  } catch (e) {
                      console.warn('Failed to prepare remembered normal window bounds', e);
                  }
              }
              if (cancelled) return;
              markStartupWindowRestorePending(startupRestoreGraceMs);
              applyStartupWindowChrome(1);
              return;
          }

          // Without a remembered maximised state, restore the last normal bounds.
          markStartupWindowRestorePending(startupRestoreGraceMs);
          const viewport = readCurrentVisibleViewport();
          try {
              if (!bounds || bounds.width < 400 || bounds.height < 300) {
                  if (isWindowsPlatform()) {
                      const nextBounds = resolveDefaultStartupWindowBounds(viewport);
                      await restoreNormalWindowBounds(nextBounds);
                      void emitWindowDiagnostic('adjust:startup-default-window-bounds', {
                          to: nextBounds,
                      });
                  } else {
                      state.setWindowState('normal');
                  }
                  return;
              }
              await restoreNormalWindowBounds(bounds);
          } catch (e) {
              console.warn('Failed to restore window bounds', e);
          } finally {
              clearStartupWindowRestorePending();
          }
      };

      if (useStore.persist.hasHydrated()) {
          void restoreWindowState();
      }
      const unsubscribeHydration = useStore.persist.onFinishHydration(() => {
          if (cancelled) {
              return;
          }
          // hydration 完成后再恢复，确保读到启动最大化偏好与 windowBounds。
          restoredOnce = false;
          void restoreWindowState();
      });

      return () => {
          cancelled = true;
          if (startupWindowTimer !== null) {
              window.clearTimeout(startupWindowTimer);
          }
          unsubscribeHydration();
      };
  }, []);

  // 定时保存窗口状态、尺寸与位置
  useEffect(() => {
      let cancelled = false;
      let hydrated = useStore.persist.hasHydrated();
      let eventSaveTimer: number | null = null;
      let boundsRepairTimer: number | null = null;
      let lastSaved = '';

      const saveWindowState = async () => {
          if (cancelled || !hydrated || isStartupWindowRestorePending()) {
              return;
          }
          try {
              const [isFs, isMax] = await Promise.all([
                  safeWindowRuntimeCall(() => WindowIsFullscreen(), false),
                  safeWindowRuntimeCall(() => WindowIsMaximised(), false),
              ]);

              // 启动窗口恢复尚未 settle 时，不保存中间态和中间尺寸。
              if (isStartupWindowRestorePending()) {
                  return;
              }

              // 保存窗口状态
              const store = useStore.getState();
              const newState = isFs ? 'fullscreen' : (isMax ? 'maximized' : 'normal');
              if (store.windowState !== newState) {
                  void emitWindowDiagnostic('transition:windowState', {
                      from: store.windowState,
                      to: newState,
                  });
                  store.setWindowState(newState);
              }

              // 只在普通窗口模式下保存尺寸和位置
              if (isFs || isMax) return;

              const [size, pos] = await Promise.all([
                  safeWindowRuntimeCall(() => WindowGetSize(), null),
                  safeWindowRuntimeCall(() => WindowGetPosition(), null),
              ]);
              if (!size || !pos || isStartupWindowRestorePending()) return;
              const w = Math.trunc(Number(size.w || 0));
              const h = Math.trunc(Number(size.h || 0));
              const x = Math.trunc(Number(pos.x || 0));
              const y = Math.trunc(Number(pos.y || 0));
               if (w < 400 || h < 300) return;

               const key = `${w},${h},${x},${y}`;
               if (key === lastSaved) return;
               lastSaved = key;
               if (Math.abs(x) > 5000 || Math.abs(y) > 5000) {
                   void emitWindowDiagnostic('anomaly:windowBounds', { width: w, height: h, x, y });
               }
               store.setWindowBounds({ width: w, height: h, x, y });
            } catch (e) {
                // 静默忽略
            }
      };
      captureMainWindowStateRef.current = saveWindowState;

      const scheduleWindowStateSave = (delayMs = 120) => {
          if (cancelled || !hydrated) {
              return;
          }
          if (eventSaveTimer !== null) {
              window.clearTimeout(eventSaveTimer);
          }
          eventSaveTimer = window.setTimeout(() => {
              eventSaveTimer = null;
              void saveWindowState();
          }, delayMs);
      };

      const repairRuntimeWindowBounds = async () => {
          if (cancelled || !hydrated) {
              return;
          }
          // 启动窗口恢复期间不要抢跑普通 bounds 校正。
          if (isStartupWindowRestorePending()) {
              return;
          }
          try {
              const [isFs, isMax] = await Promise.all([
                  safeWindowRuntimeCall(() => WindowIsFullscreen(), false),
                  safeWindowRuntimeCall(() => WindowIsMaximised(), false),
              ]);
              if (isFs || isMax) {
                  return;
              }
              const [size, pos] = await Promise.all([
                  safeWindowRuntimeCall(() => WindowGetSize(), null),
                  safeWindowRuntimeCall(() => WindowGetPosition(), null),
              ]);
              if (!size || !pos) {
                  return;
              }
              const currentBounds = {
                  width: Math.trunc(Number(size.w || 0)),
                  height: Math.trunc(Number(size.h || 0)),
                  x: Math.trunc(Number(pos.x || 0)),
                  y: Math.trunc(Number(pos.y || 0)),
              };
              if (currentBounds.width <= 0 || currentBounds.height <= 0) {
                  return;
              }
              const viewport = readCurrentVisibleViewport();
              const nextBounds = resolveVisibleStartupWindowBounds(currentBounds, viewport);
              if (
                  nextBounds.x === currentBounds.x &&
                  nextBounds.y === currentBounds.y &&
                  nextBounds.width === currentBounds.width &&
                  nextBounds.height === currentBounds.height
              ) {
                  return;
              }
              void emitWindowDiagnostic('adjust:runtime-window-bounds', {
                  from: currentBounds,
                  to: nextBounds,
              });
              WindowSetSize(nextBounds.width, nextBounds.height);
              const setPosition = resolveWailsWindowSetPosition(nextBounds, viewport, {
                  useMonitorLocalOrigin: isWindowsPlatform(),
              });
              WindowSetPosition(setPosition.x, setPosition.y);
              lastSaved = `${nextBounds.width},${nextBounds.height},${nextBounds.x},${nextBounds.y}`;
              useStore.getState().setWindowBounds(nextBounds);
              window.dispatchEvent(new Event('resize'));
          } catch {
              // Wails runtime window APIs are best-effort here.
          }
      };

      const scheduleWindowBoundsRepair = (delayMs = 80) => {
          if (cancelled || !hydrated) {
              return;
          }
          if (boundsRepairTimer !== null) {
              window.clearTimeout(boundsRepairTimer);
          }
          boundsRepairTimer = window.setTimeout(() => {
              boundsRepairTimer = null;
              void repairRuntimeWindowBounds();
          }, delayMs);
      };

      const handleWindowRuntimeChange = () => {
          scheduleWindowBoundsRepair();
          scheduleWindowStateSave(260);
      };

      const handleVisibilityChange = () => {
          if (document.visibilityState === 'visible') {
              scheduleWindowBoundsRepair();
              scheduleWindowStateSave(260);
          }
      };

      const handleWindowLifecycleFlush = () => {
          void saveWindowState();
      };

      if (hydrated) {
          scheduleWindowBoundsRepair(360);
          scheduleWindowStateSave(320);
      }
      const unsubscribeHydration = useStore.persist.onFinishHydration(() => {
          if (cancelled || hydrated) {
              return;
          }
          hydrated = true;
          scheduleWindowBoundsRepair(360);
          scheduleWindowStateSave(320);
      });

      const cleanupWindowActivityScheduler = installNativeWindowActivityScheduler({
          windowTarget: window,
          documentTarget: document,
          fallbackIntervalMs: WINDOW_STATE_FALLBACK_INTERVAL_MS,
          onFallback: () => {
              void saveWindowState();
          },
          handlers: {
              resize: handleWindowRuntimeChange,
              focus: handleWindowRuntimeChange,
              pageshow: handleWindowRuntimeChange,
              pagehide: handleWindowLifecycleFlush,
              beforeunload: handleWindowLifecycleFlush,
              visibilitychange: handleVisibilityChange,
          },
      });
      return () => {
          cancelled = true;
          if (captureMainWindowStateRef.current === saveWindowState) {
              captureMainWindowStateRef.current = async () => undefined;
          }
          if (eventSaveTimer !== null) {
              window.clearTimeout(eventSaveTimer);
          }
          if (boundsRepairTimer !== null) {
              window.clearTimeout(boundsRepairTimer);
          }
          cleanupWindowActivityScheduler();
          unsubscribeHydration();
      };
  }, []);

  useEffect(() => {
      if (!isWindowsPlatform()) {
          return;
      }

      let cancelled = false;
      let inFlight = false;
      let lastRatio = Number(window.devicePixelRatio) || 1;
      let lastFixAt = 0;
      let activationTimer: number | null = null;
      let resizeTimer: number | null = null;
      let minimisedCheckTimer: number | null = null;
      let minimisedSeen = false;
      let hiddenSeen = document.visibilityState === 'hidden';

      // Automatic scale-fix may call ResetWebViewZoom multiple times on startup.
      // The backend path depends on Wails unexported fields and can fail harmlessly;
      // log at most once so the console is not flooded with expected unavailability.
      let resetWebViewZoomUnavailableLogged = false;
      const tryResetWebViewZoomQuietly = async () => {
          try {
              const res = await (window as any).go?.app?.App?.ResetWebViewZoom?.();
              if (res?.success) {
                  return true;
              }
              if (!resetWebViewZoomUnavailableLogged) {
                  resetWebViewZoomUnavailableLogged = true;
                  console.warn('ResetWebViewZoom unavailable in fixWindowScaleIfNeeded:', res?.message);
              }
              return false;
          } catch (e) {
              if (!resetWebViewZoomUnavailableLogged) {
                  resetWebViewZoomUnavailableLogged = true;
                  console.warn('ResetWebViewZoom call failed in fixWindowScaleIfNeeded', e);
              }
              return false;
          }
      };

      let refreshWebViewBoundsUnavailableLogged = false;
      const tryRefreshWebViewBoundsQuietly = async (): Promise<boolean> => {
          try {
              const result = await (window as any).go?.app?.App?.RefreshWebViewBounds?.();
              if (result?.success) return true;
              if (!refreshWebViewBoundsUnavailableLogged) {
                  refreshWebViewBoundsUnavailableLogged = true;
                  console.warn('RefreshWebViewBounds unavailable in scale repair:', result?.message);
              }
          } catch (error) {
              if (!refreshWebViewBoundsUnavailableLogged) {
                  refreshWebViewBoundsUnavailableLogged = true;
                  console.warn('RefreshWebViewBounds call failed in scale repair', error);
              }
          }
          return false;
      };

      const fixWindowScaleIfNeeded = async (reason: WindowScaleFixReason) => {
          if (cancelled || inFlight) return;
          const now = Date.now();
          if (now - lastFixAt < 700) return;
          inFlight = true;
          try {
              await repairWindowsWindowScale({
                  reason,
                  readViewport: () => ({
                      innerWidth: window.innerWidth,
                      devicePixelRatio: Number(window.devicePixelRatio) || 1,
                      visualViewportScale: window.visualViewport?.scale,
                  }),
                  resetZoom: tryResetWebViewZoomQuietly,
                  refreshBounds: tryRefreshWebViewBoundsQuietly,
                  notifyResize: () => window.dispatchEvent(new Event('resize')),
                  isCancelled: () => cancelled,
              });
              lastFixAt = Date.now();
          } catch (error) {
              console.warn('Wails Window APIs unavailable in scale repair', error);
          } finally {
              inFlight = false;
          }
      };

      const rememberMinimisedState = async (): Promise<boolean> => {
          if (cancelled) return false;
          const isMinimised = await safeWindowRuntimeCall(() => WindowIsMinimised(), false);
          if (isMinimised) {
              minimisedSeen = true;
          }
          return isMinimised;
      };

      const rememberMinimisedStateSoon = () => {
          if (minimisedCheckTimer !== null) {
              window.clearTimeout(minimisedCheckTimer);
          }
          minimisedCheckTimer = window.setTimeout(() => {
              minimisedCheckTimer = null;
              if (cancelled) return;
              void rememberMinimisedState();
          }, 120);
      };

      const checkDevicePixelRatio = () => {
          if (cancelled) return;
          const currentRatio = Number(window.devicePixelRatio) || 1;
          if (Math.abs(currentRatio - lastRatio) < 0.02) {
              return;
          }
          lastRatio = currentRatio;
          if (minimisedSeen || hiddenSeen) {
              scheduleActivationFix();
              return;
          }
          void fixWindowScaleIfNeeded('ratio-change');
      };

      const scheduleDevicePixelRatioCheck = (trigger: WindowsScaleCheckTrigger) => {
          if (cancelled) return;
          const delayMs = resolveWindowsScaleCheckDelayMs(trigger);
          if (delayMs <= 0) {
              checkDevicePixelRatio();
              return;
          }

          if (resizeTimer !== null) {
              window.clearTimeout(resizeTimer);
          }
          resizeTimer = window.setTimeout(() => {
              resizeTimer = null;
              if (cancelled) return;
              checkDevicePixelRatio();
          }, delayMs);
      };

      const scheduleActivationFix = () => {
          if (cancelled) return;
          if (activationTimer !== null) {
              window.clearTimeout(activationTimer);
          }
          const delayMs = (minimisedSeen || hiddenSeen) ? 260 : 80;
          activationTimer = window.setTimeout(async () => {
              activationTimer = null;
              if (cancelled) return;
              if (await rememberMinimisedState()) {
                  return;
              }
              const reason: WindowScaleFixReason = (minimisedSeen || hiddenSeen) ? 'restore' : 'activation';
              minimisedSeen = false;
              hiddenSeen = false;
              void fixWindowScaleIfNeeded(reason);
          }, delayMs);
      };

      const handleWindowFocus = () => {
          if (cancelled) return;
          scheduleDevicePixelRatioCheck('focus');
          scheduleActivationFix();
      };

      const handleWindowBlur = () => {
          if (cancelled) return;
          if (document.visibilityState === 'hidden') {
              hiddenSeen = true;
          }
          rememberMinimisedStateSoon();
      };

      const handleVisibilityChange = () => {
          if (cancelled) return;
          if (document.visibilityState !== 'visible') {
              hiddenSeen = true;
              rememberMinimisedStateSoon();
              return;
          }
          scheduleDevicePixelRatioCheck('visibilitychange');
          scheduleActivationFix();
      };

      const handlePageShow = () => {
          if (cancelled) return;
          scheduleDevicePixelRatioCheck('pageshow');
          scheduleActivationFix();
      };

      const handleWindowResize = () => {
          rememberMinimisedStateSoon();
          scheduleDevicePixelRatioCheck('resize');
      };

      // Windows 冷启动：WebView2 首次布局常只铺满左上角一部分，任务栏恢复才会走 restore 修复。
      // 这里在启动后主动按 startup 原因做几次轻量 settle，避免用户必须双击任务栏。
      // 间隔需大于 fixWindowScaleIfNeeded 的 700ms 节流，确保多次都能真正执行。
      const startupLayoutFixTimers = [220, 1000, 1900].map((delayMs) => (
          window.setTimeout(() => {
              if (cancelled) return;
              void fixWindowScaleIfNeeded('startup');
          }, delayMs)
      ));
      const cleanupWindowActivityScheduler = installNativeWindowActivityScheduler({
          windowTarget: window,
          documentTarget: document,
          fallbackIntervalMs: WINDOWS_SCALE_FALLBACK_INTERVAL_MS,
          onFallback: () => {
              void rememberMinimisedState();
              checkDevicePixelRatio();
          },
          handlers: {
              resize: handleWindowResize,
              focus: handleWindowFocus,
              blur: handleWindowBlur,
              pageshow: handlePageShow,
              visibilitychange: handleVisibilityChange,
          },
      });

      return () => {
          cancelled = true;
          if (activationTimer !== null) {
              window.clearTimeout(activationTimer);
          }
          if (resizeTimer !== null) {
              window.clearTimeout(resizeTimer);
          }
          if (minimisedCheckTimer !== null) {
              window.clearTimeout(minimisedCheckTimer);
              minimisedCheckTimer = null;
          }
          for (const timer of startupLayoutFixTimers) {
              window.clearTimeout(timer);
          }
          cleanupWindowActivityScheduler();
      };
  }, []);

  const {
      bgContent,
      floatingLogButtonBgColor, floatingLogButtonBorderColor, floatingLogButtonShadow, floatingLogButtonTextColor,
      isSidebarNarrow, isSidebarUltraCompact,
      overlayTheme, renderUtilityModalTitle,
      sidebarHorizontalPadding,
      toolCenterContentPanelStyle, toolCenterDetailBodyStyle, toolCenterDetailPanelStyle,
      toolCenterModalSplitStyle, toolCenterModalWorkspaceStyle,
      toolCenterNavPanelStyle, utilityButtonStyle,
      utilityModalShellStyle, utilityMutedTextStyle, utilityPanelStyle,
  } = useAppUtilityStyles({
      blurFilter,
      darkMode,
      effectiveOpacity,
      effectiveUiScale,
      resolvedAppearance,
      sidebarWidth,
  });

  const addTab = useStore(state => state.addTab);
  const handleOpenDriverManagerWorkbench = useCallback(() => {
      const tab = buildDriverManagerWorkbenchTab();
      const wasDetached = useStore.getState().isWorkbenchTabDetached(tab.id);
      addTab(tab);
      if (!wasDetached) return;
      void openNativeWorkbenchTabWindow(tab.id).catch((error) => {
          message.error(error instanceof Error ? error.message : String(error));
      });
  }, [addTab]);
  const activeContext = useStore(state => state.activeContext);
  const connections = useStore(state => state.connections);
  const connectionTags = useStore(state => state.connectionTags);
  const [sidebarTitlebarSnapshot, setSidebarTitlebarSnapshot] = useState<TitlebarSidebarSnapshot>({
      selection: null,
      connectionStates: {},
  });
  const moveConnectionToTag = useStore(state => state.moveConnectionToTag);
  const moveConnectionsToTag = useStore(state => state.moveConnectionsToTag);
  const setConnectionDisplaySortMode = useStore(state => state.setConnectionDisplaySortMode);
  const connectionImportGroupOptions = useMemo(
      () => buildConnectionImportGroupOptions(connectionTags),
      [connectionTags],
  );
  useEffect(() => {
      if (
          connectionImportTargetTagId
          && !connectionTags.some((tag) => tag.id === connectionImportTargetTagId)
      ) {
          setConnectionImportTargetTagId('');
      }
  }, [connectionImportTargetTagId, connectionTags]);
  const tabs = useWorkbenchTabs();
  const activeTabId = useStore(state => state.activeTabId);
  const setActiveTab = useStore(state => state.setActiveTab);
  const savedQueries = useStore(state => state.savedQueries);
  const saveQuery = useStore(state => state.saveQuery);
  const activeWorkbenchTab = useMemo(
      () => activeTabId ? tabs.find(tab => tab.id === activeTabId) : undefined,
      [activeTabId, tabs],
  );
  const titlebarContext = useMemo(
      () => resolveTitlebarContext({
          activeContext,
          sidebarContext: sidebarTitlebarSnapshot.selection,
          activeTab: activeWorkbenchTab,
          connections,
      }),
      [activeContext, activeWorkbenchTab, connections, sidebarTitlebarSnapshot.selection],
  );
  // Keep primary-action semantics anchored to the active workbench context.
  // The title-bar summary may intentionally follow a separate Sidebar row.
  const currentPrimaryActionConnection = useMemo(() => {
      const connectionId = String(activeContext?.connectionId || activeWorkbenchTab?.connectionId || '').trim();
      return connections.find(connection => connection.id === connectionId) || null;
  }, [activeContext?.connectionId, activeWorkbenchTab?.connectionId, connections]);
  const explorerContextConnectionName = titlebarContext.connectionName
      || t('sidebar.active_connection.no_host_selected');
  const explorerContextTooltipText = [
      titlebarContext.connection ? explorerContextConnectionName : '',
      titlebarContext.databaseName,
      titlebarContext.tableName,
  ].filter(Boolean).join(' · ') || explorerContextConnectionName;
  const explorerContextTooltip = titlebarContext.connection
      ? explorerContextTooltipText
      : t('sidebar.active_connection.no_host_selected');
  const v2ExplorerContext = useMemo(() => ({
      active: Boolean(titlebarContext.connection),
      connectionName: explorerContextConnectionName,
      databaseName: titlebarContext.databaseName,
      objectName: titlebarContext.tableName,
      tooltip: explorerContextTooltip,
  }), [
      explorerContextConnectionName,
      explorerContextTooltip,
      titlebarContext.connection,
      titlebarContext.databaseName,
      titlebarContext.tableName,
  ]);
  const primaryActionIsMessageQueue = isMessageQueueDataSource(
      currentPrimaryActionConnection?.config,
  );
  const applicationQuitConfirmRef = useRef<{ destroy: () => void } | null>(null);
  const applicationQuitHandlingRef = useRef(false);
  const openSecurityUpdateSettings = useCallback((focusTarget?: SecurityUpdateSettingsFocusTarget | null) => withAISettingsLeaveGuard(aiSettingsLeaveGuardRef.current, () => {
      setIsSecurityUpdateIntroOpen(false);
      if (focusTarget !== undefined) {
          setSecurityUpdateSettingsFocusTarget(focusTarget);
          setSecurityUpdateSettingsFocusRequest((current) => current + 1);
      }
      setToolCenterBackGroupKey('config');
      setActiveSettingsCenterGroupKey('config');
      setActiveSettingsCenterPane({ key: 'security-update', group: 'config' });
      openSettingsCenterWorkbenchTab();
  }), []);
  const handleOpenSecurityUpdateSettings = useCallback((focusTarget: SecurityUpdateSettingsFocusTarget | null = null) => {
      openSecurityUpdateSettings(focusTarget);
  }, [openSecurityUpdateSettings]);
  const runSecurityUpdateRound = useCallback(async (mode: 'start' | 'retry' | 'restart') => {
      const backendApp = (window as any).go?.app?.App;
      const stageText = mode === 'start'
          ? t('app.security_update.stage.checking_saved_config')
          : (mode === 'retry'
              ? t('app.security_update.stage.verifying_result')
              : t('app.security_update.stage.updating_secure_storage'));
      const detailsWereOpen = isSettingsModalOpen && activeSettingsCenterPane?.key === 'security-update';
      setSecurityUpdateProgressStage(stageText);
      setIsSecurityUpdateProgressOpen(true);
      setIsSecurityUpdateIntroOpen(false);

      let nextStatus: SecurityUpdateStatus | null = null;
      let shouldOpenSettings = false;
      let refreshSettingsFocus = false;
      try {
          if (mode === 'start') {
              const result = await startSecurityUpdateFromBootstrap({
                  backend: backendApp,
                  replaceConnections,
                  replaceGlobalProxy,
                  t,
              });
              if (result.error) {
                  throw result.error;
              }
              nextStatus = normalizeSecurityUpdateStatus(result.status);
          } else if (mode === 'retry') {
              if (typeof backendApp?.RetrySecurityUpdateCurrentRound !== 'function') {
                  throw new Error(t('app.security_update.error.capability_unavailable'));
              }
              nextStatus = normalizeSecurityUpdateStatus(await backendApp.RetrySecurityUpdateCurrentRound({
                  migrationId: securityUpdateStatus.migrationId,
              }));
          } else {
              if (typeof backendApp?.RestartSecurityUpdate !== 'function') {
                  throw new Error(t('app.security_update.error.capability_unavailable'));
              }
              nextStatus = normalizeSecurityUpdateStatus(await backendApp.RestartSecurityUpdate({
                  migrationId: securityUpdateStatus.migrationId,
                  sourceType: 'current_app_saved_config',
                  rawPayload: securityUpdateRawPayload ?? '',
                  options: {
                      allowPartial: true,
                      writeBackup: true,
                  },
              }));
          }

          if (mode !== 'start') {
              nextStatus = await finalizeSecurityUpdateStatus({
                  backend: backendApp,
                  replaceConnections,
                  replaceGlobalProxy,
                  t,
              }, nextStatus);
          }

          shouldOpenSettings = nextStatus.overallStatus === 'needs_attention' || nextStatus.overallStatus === 'rolled_back';
          refreshSettingsFocus = shouldRefreshSecurityUpdateDetailsFocus({
              requestedOpen: shouldOpenSettings,
              wasOpen: detailsWereOpen,
          });
      } catch (err: any) {
          console.warn('Failed to execute security update round', err);
          setIsSecurityUpdateProgressOpen(false);
          if (detailsWereOpen) {
              openSecurityUpdateSettings();
          }
          void message.error(err?.message || t('app.security_update.message.not_finished_retry_later'));
          return;
      }

      if (!nextStatus) {
          setIsSecurityUpdateProgressOpen(false);
          return;
      }
      setIsSecurityUpdateProgressOpen(false);
      applySecurityUpdateStatus(nextStatus, {
          openSettings: shouldOpenSettings,
          refreshFocus: refreshSettingsFocus,
      });

      if (nextStatus.overallStatus === 'completed') {
          setSecurityUpdateHasLegacySensitiveItems(false);
          setSecurityUpdateRawPayload(null);
          void message.success(t('app.security_update.message.completed'));
      } else if (nextStatus.overallStatus === 'needs_attention') {
          void message.warning(t('app.security_update.message.needs_attention'));
      } else if (nextStatus.overallStatus === 'rolled_back') {
          void message.warning(t('app.security_update.message.rolled_back'));
      }
  }, [
      applySecurityUpdateStatus,
      activeSettingsCenterPane?.key,
      isSettingsModalOpen,
      normalizeSecurityUpdateStatus,
      openSecurityUpdateSettings,
      replaceConnections,
      replaceGlobalProxy,
      securityUpdateRawPayload,
      securityUpdateStatus.migrationId,
      t,
  ]);
  const handleStartSecurityUpdate = useCallback(() => {
      void runSecurityUpdateRound('start');
  }, [runSecurityUpdateRound]);
  const handlePrepareExternalMCPUse = useCallback(async () => {
      const backendApp = (window as any).go?.app?.App;
      const result = await prepareSecureConfigForExternalMCP({
          backend: backendApp,
          replaceConnections,
          replaceGlobalProxy,
          t,
      });
      if (result.error) {
          throw result.error;
      }
      if (!result.status) {
          return;
      }

      const nextStatus = normalizeSecurityUpdateStatus(result.status);
      const shouldOpenSettings = nextStatus.overallStatus === 'needs_attention' || nextStatus.overallStatus === 'rolled_back';
      applySecurityUpdateStatus(nextStatus, {
          openSettings: shouldOpenSettings,
          refreshFocus: shouldOpenSettings,
      });

      if (nextStatus.overallStatus === 'completed') {
          setSecurityUpdateHasLegacySensitiveItems(false);
          setSecurityUpdateRawPayload(null);
          return;
      }

      const hasConnectionIssue = nextStatus.issues.some((issue) =>
          issue.scope === 'connection' && issue.status !== 'updated',
      );
      if (nextStatus.overallStatus === 'rolled_back' || hasConnectionIssue) {
          throw new Error(t('app.security_update.message.needs_attention'));
      }
      if (nextStatus.overallStatus === 'needs_attention') {
          void message.warning(t('app.security_update.message.needs_attention'));
      }
  }, [
      applySecurityUpdateStatus,
      normalizeSecurityUpdateStatus,
      replaceConnections,
      replaceGlobalProxy,
      t,
  ]);
  const handleRetrySecurityUpdate = useCallback(() => {
      void runSecurityUpdateRound('retry');
  }, [runSecurityUpdateRound]);
  const handleRestartSecurityUpdate = useCallback(() => {
      void runSecurityUpdateRound('restart');
  }, [runSecurityUpdateRound]);
  const handlePostponeSecurityUpdate = useCallback(async () => {
      const backendApp = (window as any).go?.app?.App;
      setIsSecurityUpdateIntroOpen(false);
      try {
          if (typeof backendApp?.DismissSecurityUpdateReminder === 'function') {
              const nextStatus = mergeSecurityUpdateStatusWithLegacySource(
                  await backendApp.DismissSecurityUpdateReminder(),
                  securityUpdateRawPayload,
                  { t },
              );
              applySecurityUpdateStatus(nextStatus);
              return;
          }
          applySecurityUpdateStatus({
              overallStatus: 'postponed',
              canStart: true,
              canPostpone: true,
              summary: securityUpdateStatus.summary,
              issues: securityUpdateStatus.issues,
          });
      } catch (err: any) {
          console.warn('Failed to dismiss security update reminder', err);
          void message.error(err?.message || t('app.security_update.message.postpone_failed'));
      }
  }, [
      applySecurityUpdateStatus,
      securityUpdateRawPayload,
      securityUpdateStatus.issues,
      securityUpdateStatus.summary,
      t,
  ]);
  const handleSecurityUpdateIssueAction = useCallback((issue: SecurityUpdateIssue) => withAISettingsLeaveGuard(aiSettingsLeaveGuardRef.current, () => {
      const repairEntry = resolveSecurityUpdateRepairEntry(issue, connections, securityUpdateStatus, t);
      if (repairEntry.type === 'warning') {
          void message.warning(repairEntry.message);
          return;
      }
      if (repairEntry.type === 'connection') {
          closeSettingsCenterWorkbenchTab();
          setSecurityUpdateRepairSource(repairEntry.repairSource);
          setEditingConnection(repairEntry.connection);
          setIsModalOpen(true);
          return;
      }
      if (repairEntry.type === 'proxy') {
          closeSettingsCenterWorkbenchTab();
          setSecurityUpdateRepairSource(repairEntry.repairSource);
          setIsProxyModalOpen(true);
          return;
      }
      if (repairEntry.type === 'ai') {
          setSecurityUpdateRepairSource(repairEntry.repairSource);
          setFocusedAIProviderId(repairEntry.providerId);
          setAiSettingsSection('providers');
          setAiSettingsProviderView('workspace');
          setActiveSettingsCenterGroupKey('services');
          setActiveSettingsCenterPane({ key: 'ai', group: 'services' });
          openSettingsCenterWorkbenchTab();
          return;
      }
      if (repairEntry.type === 'retry') {
          void runSecurityUpdateRound('retry');
          return;
      }
      setSecurityUpdateRepairSource(null);
      openSecurityUpdateSettings(repairEntry.focusTarget);
  }), [connections, openSecurityUpdateSettings, runSecurityUpdateRound, securityUpdateStatus, t]);
  const useNativeMacWindowControls = isMacRuntime;
  const activeShortcutPlatform = getShortcutPlatform(isMacRuntime);
  const titleBarNewQueryShortcut = resolveTitleBarPrimaryActionShortcut(
      shortcutOptions,
      'newQueryTab',
      activeShortcutPlatform,
  );
  const titleBarNewConnectionShortcut = resolveTitleBarPrimaryActionShortcut(
      shortcutOptions,
      'newConnection',
      activeShortcutPlatform,
  );
  const macWindowDiagnosticsEnabled = shouldEnableMacWindowDiagnostics(
      isMacRuntime,
      import.meta.env.DEV,
      import.meta.env.VITE_GONAVI_ENABLE_MAC_WINDOW_DIAGNOSTICS,
  );
  useEffect(() => {
      return installGlobalImeCompositionTracking(window, document);
  }, []);
  // 启动发现更新时打开设置中心「关于」页（由 useAppUpdateManager 通过 bridge 调用）
  const updateCenterBridgeRef = useRef<{
      open: () => void;
      close: () => void;
      isOpen: () => boolean;
  } | null>(null);
  // 手动「检查更新」发现新版本时，由 useAppUpdateManager 触发打开更新日志弹窗
  const openReleaseNotesOnManualCheckRef = useRef<(() => void) | null>(null);
  const {
      aboutDisplayVersion,
      aboutInfo,
      aboutLoading,
      aboutUpdateStatus,
      canShowProgressEntry,
      changeUpdateChannel,
      checkForUpdates,
      downloadUpdate,
      formatBytes,
      handleInstallFromProgress,
      hideUpdateDownloadProgress,
      isBackgroundProgressForLatestUpdate,
      isCheckingForUpdates,
      isLatestUpdateDownloaded,
      isUpdateChannelLoading,
      isUpdateChannelSaving,
      installMode,
      lastUpdateInfo,
      markUpdateProgressDismissed,
      muteLatestUpdate,
      openDownloadedUpdateDirectory,
      prepareAboutSurface,
      showUpdateDownloadProgress,
      updateChannel,
      updateDownloadProgress,
      updateInstallAction,
  } = useAppUpdateManager({
      runtimeBuildType,
      t,
      updateCenterBridgeRef,
      onManualCheckHasUpdateRef: openReleaseNotesOnManualCheckRef,
  });
  const [aboutLastCheckedAt, setAboutLastCheckedAt] = useState('');
  const [releaseNotesModalOpen, setReleaseNotesModalOpen] = useState(false);
  const [releaseNotesReadTick, setReleaseNotesReadTick] = useState(0);
  useEffect(() => {
      if (!lastUpdateInfo) {
          return;
      }
      setAboutLastCheckedAt(formatAboutCheckedAt(new Date()));
  }, [
      lastUpdateInfo?.channel,
      lastUpdateInfo?.currentVersion,
      lastUpdateInfo?.hasUpdate,
      lastUpdateInfo?.latestVersion,
  ]);

  const releaseNotesReadKey = useMemo(
      () => buildReleaseNotesReadKey(lastUpdateInfo),
      [lastUpdateInfo?.channel, lastUpdateInfo?.latestVersion],
  );
  // releaseNotesReadTick 强制在 mark 后重算未读态
  const hasUnreadReleaseNotes = useMemo(() => {
      void releaseNotesReadTick;
      if (!lastUpdateInfo || !releaseNotesReadKey) return false;
      // 有正文或至少有 GitHub 链接时，未读才有提示意义
      if (!String(lastUpdateInfo.releaseNotes || '').trim() && !String(lastUpdateInfo.releaseNotesUrl || '').trim()) {
          return false;
      }
      return !isReleaseNotesRead(releaseNotesReadKey);
  }, [lastUpdateInfo, releaseNotesReadKey, releaseNotesReadTick]);

  const openReleaseNotesModal = useCallback(() => {
      if (!lastUpdateInfo) return;
      setReleaseNotesModalOpen(true);
  }, [lastUpdateInfo]);

  const closeReleaseNotesModal = useCallback(() => {
      setReleaseNotesModalOpen(false);
      hideUpdateDownloadProgress();
  }, [hideUpdateDownloadProgress]);

  const handleReleaseNotesModalOpen = useCallback(() => {
      if (!releaseNotesReadKey) return;
      if (markReleaseNotesRead(releaseNotesReadKey)) {
          setReleaseNotesReadTick((value) => value + 1);
      }
  }, [releaseNotesReadKey]);

  /** 下载与更新日志同窗：点下载即打开弹窗并开始下载 */
  const handleDownloadUpdateWithNotes = useCallback(() => {
      if (!lastUpdateInfo) return;
      setReleaseNotesModalOpen(true);
      void downloadUpdate(lastUpdateInfo, false);
  }, [downloadUpdate, lastUpdateInfo]);

  const releaseNotesModalVisible = releaseNotesModalOpen || updateDownloadProgress.open;

  const emitWindowDiagnostic = useCallback(async (stage: string, extra: Record<string, unknown> = {}) => {
      if (!macWindowDiagnosticsEnabled) {
          return;
      }
      const backendApp = (window as any).go?.app?.App;
      if (typeof backendApp?.LogWindowDiagnostic !== 'function') {
          return;
      }
      try {
          const [isFullscreen, isMaximised, isMinimised, isNormal, size, position] = await Promise.all([
              safeWindowRuntimeCall(() => WindowIsFullscreen(), false),
              safeWindowRuntimeCall(() => WindowIsMaximised(), false),
              safeWindowRuntimeCall(() => WindowIsMinimised(), false),
              safeWindowRuntimeCall(() => WindowIsNormal(), false),
              safeWindowRuntimeCall(() => WindowGetSize(), null),
              safeWindowRuntimeCall(() => WindowGetPosition(), null),
          ]);
          const payload = {
              seq: ++windowDiagSequenceRef.current,
              ts: new Date().toISOString(),
              stage,
              nativeControls: useNativeMacWindowControls,
              documentVisible: document.visibilityState,
              documentHasFocus: document.hasFocus(),
              devicePixelRatio: Number(window.devicePixelRatio) || 1,
              windowState: {
                  isFullscreen,
                  isMaximised,
                  isMinimised,
                  isNormal,
              },
              size: size ? { w: Math.trunc(Number(size.w || 0)), h: Math.trunc(Number(size.h || 0)) } : null,
              position: position ? { x: Math.trunc(Number(position.x || 0)), y: Math.trunc(Number(position.y || 0)) } : null,
              extra,
          };
          const signature = JSON.stringify({
              stage,
              nativeControls: payload.nativeControls,
              visible: payload.documentVisible,
              focus: payload.documentHasFocus,
              state: payload.windowState,
              size: payload.size,
              position: payload.position,
              extra,
          });
          const now = Date.now();
          if (signature === windowDiagLastSignatureRef.current && now-windowDiagLastAtRef.current < 250) {
              return;
          }
          windowDiagLastSignatureRef.current = signature;
          windowDiagLastAtRef.current = now;
          await backendApp.LogWindowDiagnostic(stage, JSON.stringify(payload));
      } catch (error) {
          console.warn('Failed to emit window diagnostic', error);
      }
  }, [macWindowDiagnosticsEnabled, useNativeMacWindowControls]);

  useEffect(() => {
      if (!macWindowDiagnosticsEnabled) {
          return;
      }

      let cancelled = false;
      let pollTimer: number | null = null;
      let burstTimer: number | null = null;

      const stopBurst = () => {
          if (pollTimer !== null) {
              window.clearInterval(pollTimer);
              pollTimer = null;
          }
          if (burstTimer !== null) {
              window.clearTimeout(burstTimer);
              burstTimer = null;
          }
      };

      const startBurst = (reason: string, extra: Record<string, unknown> = {}) => {
          if (cancelled) {
              return;
          }
          void emitWindowDiagnostic(`burst:start:${reason}`, extra);
          if (pollTimer === null) {
              pollTimer = window.setInterval(() => {
                  void emitWindowDiagnostic(`burst:tick:${reason}`);
              }, 250);
          }
          if (burstTimer !== null) {
              window.clearTimeout(burstTimer);
          }
          burstTimer = window.setTimeout(() => {
              stopBurst();
              void emitWindowDiagnostic(`burst:stop:${reason}`);
          }, 6000);
      };

      const handleFocus = () => {
          void emitWindowDiagnostic('event:focus');
      };
      const handleBlur = () => {
          void emitWindowDiagnostic('event:blur');
      };
      const handleResize = () => {
          void emitWindowDiagnostic('event:resize');
      };
      const handleVisibilityChange = () => {
          void emitWindowDiagnostic('event:visibilitychange', { visibility: document.visibilityState });
      };
      const handleEditableKeydown = (event: KeyboardEvent) => {
          if (!isEditableElement(event.target)) {
              return;
          }
          const key = String(event.key || '');
          const maybeFullscreenKey = key === 'Escape' || key.toLowerCase() === 'f' || key === 'Process';
          const hasModifier = event.ctrlKey || event.metaKey || event.altKey;
          startBurst('editable-keydown', {
              key,
              code: String(event.code || ''),
              ctrlKey: event.ctrlKey,
              metaKey: event.metaKey,
              altKey: event.altKey,
              shiftKey: event.shiftKey,
              maybeFullscreenKey,
              hasModifier,
          });
      };
      const handleCompositionStart = () => {
          startBurst('compositionstart');
      };
      const handleCompositionEnd = () => {
          startBurst('compositionend');
      };

      void emitWindowDiagnostic('session:start');
      window.addEventListener('focus', handleFocus);
      window.addEventListener('blur', handleBlur);
      window.addEventListener('resize', handleResize);
      window.addEventListener('keydown', handleEditableKeydown, true);
      window.addEventListener('compositionstart', handleCompositionStart, true);
      window.addEventListener('compositionend', handleCompositionEnd, true);
      document.addEventListener('visibilitychange', handleVisibilityChange);

      return () => {
          cancelled = true;
          stopBurst();
          window.removeEventListener('focus', handleFocus);
          window.removeEventListener('blur', handleBlur);
          window.removeEventListener('resize', handleResize);
          window.removeEventListener('keydown', handleEditableKeydown, true);
          window.removeEventListener('compositionstart', handleCompositionStart, true);
          window.removeEventListener('compositionend', handleCompositionEnd, true);
          document.removeEventListener('visibilitychange', handleVisibilityChange);
      };
  }, [emitWindowDiagnostic, macWindowDiagnosticsEnabled]);

  const handleNewQuery = useCallback(() => {
      const currentTab = activeTabId ? tabs.find(tab => tab.id === activeTabId) : undefined;
      // 只继承支持查询编辑器的活动连接；Nacos/JVM 等工作台活动时不预选连接，
      // 避免新建查询落入必然失败的 SQL 工作流。
      const validConnectionIds = new Set(
          connections
              .filter(connection => getDataSourceCapabilities(connection.config).supportsQueryEditor)
              .map(connection => connection.id),
      );
      const targetContext = resolveNewQueryContext({
          sidebarContext: activeContext,
          activeTab: currentTab,
          validConnectionIds,
      });
      const connection = connections.find(c => c.id === targetContext.connectionId);
      if (connection && isMessageQueueDataSource(connection.config)) {
          const dbName = resolveMessageQueueExecutionDbName(
              connection.config,
              targetContext.dbName,
          );
          addTab({
              id: `message-queue-${connection.id}-${encodeURIComponent(dbName || 'default')}`,
              title: `${connection.name} · ${t('message_queue_workbench.tab_kind')}`,
              type: 'message-queue',
              connectionId: connection.id,
              dbName,
              messageQueueAction: 'open',
              messageQueueRequestKey: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          });
          return;
      }
      const inheritsTableContext = canInheritNewQueryTableContext({
          activeTab: currentTab,
          targetContext,
      });
      const tableName = inheritsTableContext ? String(currentTab?.tableName || '').trim() : '';
      const contextualQuery = tableName && connection
          ? buildContextualNewQueryTemplate({
              dbType: resolveDataSourceType(connection.config),
              tableName,
              customTemplate: appearance.newQuerySqlTemplate,
          })
          : null;

      addTab({
          id: `query-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          title: t('query.new'),
          type: 'query',
          connectionId: targetContext.connectionId,
          dbName: targetContext.dbName,
          schemaName: targetContext.schemaName,
          query: contextualQuery ?? '',
      });
  }, [activeTabId, tabs, connections, activeContext, addTab, appearance.newQuerySqlTemplate, t]);

  const switchActiveTabByOffset = useCallback((offset: 1 | -1) => {
      if (tabs.length < 2) return;
      const activeIndex = tabs.findIndex(tab => tab.id === activeTabId);
      const baseIndex = activeIndex >= 0 ? activeIndex : 0;
      const nextIndex = (baseIndex + offset + tabs.length) % tabs.length;
      setActiveTab(tabs[nextIndex].id);
  }, [activeTabId, setActiveTab, tabs]);

  const resetApplicationQuitRequest = useCallback(() => {
      applicationQuitHandlingRef.current = false;
      applicationQuitConfirmRef.current = null;
      void CancelApplicationQuit();
  }, []);

  const forceQuitApplication = useCallback(async () => {
      const res = await ForceQuitApplication();
      if (res && res.success === false) {
          throw new Error(res.message || t('common.unknown'));
      }
  }, [t]);

  const handleApplicationQuitRequest = useCallback(async (
      confirmedAction?: ApplicationQuitConfirmedAction,
      cancelledAction?: () => void,
  ) => {
      if (applicationQuitHandlingRef.current) {
          return;
      }
      applicationQuitHandlingRef.current = true;

      const cancelRequest = () => {
          resetApplicationQuitRequest();
          cancelledAction?.();
      };

      const runConfirmedAction = async (): Promise<boolean> => {
          let accepted = false;
          try {
              const leaveGuard = aiSettingsLeaveGuardRef.current;
              if (leaveGuard && !(await leaveGuard())) {
                  cancelRequest();
                  return false;
              }
              await prepareApplicationQuitPersistence({
                  captureWindowState: () => captureMainWindowStateRef.current(),
                  flushDrafts: flushQueryTabDraftSnapshots,
                  flushAppState: async () => {
                      await flushAppStatePersistence();
                      await connectionSidebarLayoutCoordinatorRef.current?.flush();
                  },
              });
              if (confirmedAction) {
                  accepted = await confirmedAction();
              } else {
                  await forceQuitApplication();
                  accepted = true;
              }
          } catch (error) {
              cancelRequest();
              message.error(t('app.quit.message.quit_failed', {
                  detail: error instanceof Error ? error.message : String(error),
              }));
              return false;
          }
          if (!accepted) {
              cancelRequest();
          }
          return accepted;
      };

      let targets;
      try {
          await ensureSavedQueriesLoaded();
          const latestState = useStore.getState();
          targets = await collectApplicationQuitUnsavedSQLTargets(
              latestState.tabs,
              latestState.savedQueries,
          );
      } catch (error) {
          cancelRequest();
          message.error(t('app.quit.unsaved_sql.inspect_failed', {
              detail: error instanceof Error ? error.message : String(error),
          }));
          return;
      }

      if (targets.length === 0) {
          await runConfirmedAction();
          return;
      }

      const label = buildApplicationQuitUnsavedSQLLabel(targets);
      await new Promise<void>((resolve) => {
          let finished = false;
          const finish = () => {
              if (finished) return;
              finished = true;
              resolve();
          };
          const runConfirmedActionAndFinish = async () => {
              try {
                  await runConfirmedAction();
              } finally {
                  finish();
              }
          };

          let destroyConfirm: (() => void) | null = null;
          const confirmRef = Modal.confirm({
              title: t('app.quit.unsaved_sql.title'),
              content: t(targets.length === 1
                  ? 'app.quit.unsaved_sql.content_single'
                  : 'app.quit.unsaved_sql.content_multiple', { label }),
              okText: t('app.quit.unsaved_sql.save_exit'),
              cancelText: t('app.quit.unsaved_sql.cancel'),
              centered: true,
              closable: true,
              maskClosable: false,
              zIndex: applicationQuitModalZIndex,
              okButtonProps: { danger: true, type: 'primary' },
              footer: (_, { OkBtn, CancelBtn }) => (
                  <>
                      <Button
                        onClick={() => {
                            destroyConfirm?.();
                            applicationQuitConfirmRef.current = null;
                            void runConfirmedActionAndFinish();
                        }}
                      >
                          {t('app.quit.unsaved_sql.confirm_exit')}
                      </Button>
                      <CancelBtn />
                      <OkBtn />
                  </>
              ),
              onCancel: () => {
                  cancelRequest();
                  finish();
              },
              onOk: async () => {
                  try {
                      await saveLatestApplicationQuitUnsavedSQLState({
                          getState: () => {
                              const latestState = useStore.getState();
                              return {
                                  tabs: latestState.tabs,
                                  savedQueries: latestState.savedQueries,
                              };
                          },
                          updateTabs: (update) => {
                              useStore.setState((state) => ({ tabs: update(state.tabs) }));
                          },
                          saveQuery,
                      });
                      message.success(t('app.quit.unsaved_sql.saved'));
                  } catch (error) {
                      cancelRequest();
                      finish();
                      message.error(t('app.quit.unsaved_sql.save_failed_cancel_exit', {
                          detail: error instanceof Error ? error.message : String(error),
                      }));
                      throw error;
                  }
                  await runConfirmedActionAndFinish();
              },
          });
          destroyConfirm = confirmRef.destroy;
          applicationQuitConfirmRef.current = confirmRef;
      });
  }, [applicationQuitModalZIndex, ensureSavedQueriesLoaded, forceQuitApplication, resetApplicationQuitRequest, saveQuery, t]);

  const handleInstallUpdateRequest = useCallback(async () => {
      let pendingCloseInstanceCount: number | null = null;
      hideUpdateDownloadProgress();
      await handleApplicationQuitRequest(
          () => handleInstallFromProgress(false, (instanceCount) => {
              pendingCloseInstanceCount = instanceCount;
          }),
          () => {
              if (pendingCloseInstanceCount === null) {
                  showUpdateDownloadProgress();
              }
          },
      );
      if (pendingCloseInstanceCount === null) {
          return;
      }
      Modal.confirm({
          title: t('app.about.update_install_confirm.close_instances_title', { count: pendingCloseInstanceCount }),
          content: t('app.about.update_install_confirm.close_instances_content'),
          okText: t('app.about.update_install_confirm.close_instances_ok'),
          cancelText: t('common.cancel'),
          centered: true,
          closable: true,
          maskClosable: false,
          zIndex: applicationQuitModalZIndex,
          okButtonProps: { danger: true, type: 'primary' },
          onCancel: () => {
              showUpdateDownloadProgress();
          },
          onOk: async () => {
              await handleInstallFromProgress(true);
          },
      });
  }, [applicationQuitModalZIndex, handleApplicationQuitRequest, handleInstallFromProgress, hideUpdateDownloadProgress, showUpdateDownloadProgress, t]);

  useEffect(() => {
      const offBeforeClose = EventsOn('app:before-close-request', () => {
          void handleApplicationQuitRequest();
      });
      return () => {
          offBeforeClose();
      };
  }, [handleApplicationQuitRequest]);

  const closeConnectionPackageDialog = useCallback(() => {
      setConnectionPackageDialog(createClosedConnectionPackageDialogState());
      setPendingConnectionImportPayload(null);
      setConnectionImportNotice(null);
      setToolCenterBackGroupKey(null);
  }, []);

  const refreshConnectionsAfterImport = useCallback(async (importedViews: SavedConnection[]) => {
      const backendApp = (window as any).go?.app?.App;
      if (typeof backendApp?.GetSavedConnections === 'function') {
          let latestConnections: unknown;
          try {
              latestConnections = await GetSavedConnections();
          } catch (error) {
              const detail = error instanceof Error ? error.message : String(error ?? '').trim();
              throw new Error(
                  detail
                      ? t('app.connection_package.message.import_failed_with_error', { error: detail })
                      : t('app.connection_package.message.import_failed'),
              );
          }
          if (!Array.isArray(latestConnections)) {
              throw new Error(t('app.connection_package.error.refresh_failed_no_connections'));
          }
          replaceConnections(latestConnections as SavedConnection[]);
          return;
      }

      const latestConnections = useStore.getState().connections;
      replaceConnections(mergeSavedConnections(latestConnections, importedViews));
  }, [replaceConnections]);

  const importConnectionsPayload = useCallback(async (raw: string, password: string) => {
      const backendApp = (window as any).go?.app?.App;
      if (typeof backendApp?.ImportConnectionsPayload !== 'function') {
          throw new Error(t('app.connection_package.error.import_capability_unavailable'));
      }

      await connectionSidebarLayoutCoordinatorRef.current?.bootstrap();
      const targetTagId = String(connectionImportTargetTagId || '').trim();
      if (
          targetTagId
          && !useStore.getState().connectionTags.some((tag) => tag.id === targetTagId)
      ) {
          throw new Error(t('app.connection_package.import.target_group_unavailable'));
      }

      let importedRaw: unknown;
      try {
          importedRaw = await backendApp.ImportConnectionsPayload(raw, password);
      } catch (error) {
          if (isConnectionPackagePasswordRequiredError(error)) {
              throw error;
          }
          const detail = error instanceof Error ? error.message : String(error ?? '').trim();
          throw new Error(
              detail
                  ? t('app.connection_package.message.import_failed_with_error', { error: detail })
                  : t('app.connection_package.message.import_failed'),
          );
      }
      const imported = normalizeConnectionPackageImportPayload(importedRaw);
      if (!imported) {
          throw new Error(t('app.connection_package.error.import_no_connections'));
      }
      const importedConnectionIDs = imported.connections
          .map((connection) => String(connection.id || '').trim())
          .filter(Boolean);
      const preRefreshState = useStore.getState();
      const placement = resolveConnectionImportPlacement(
          importedConnectionIDs,
          targetTagId,
          preRefreshState.connectionTags,
      );
      placement.manualOrderTargetGroupIds.forEach((groupID) => {
          setConnectionDisplaySortMode(groupID, 'manual');
      });
      await refreshConnectionsAfterImport(imported.connections);
      if (placement.groupAssignment) {
          moveConnectionsToTag(
              placement.groupAssignment.connectionIds,
              placement.groupAssignment.targetGroupId,
          );
      }
      if (placement.manualOrderTargetGroupIds.length > 0) {
          try {
              await connectionSidebarLayoutCoordinatorRef.current?.flush();
          } catch (error) {
              const detail = error instanceof Error ? error.message : String(error ?? '').trim();
              throw new Error(t('app.connection_package.import.group_save_failed', { detail }));
          }
      }
      // Redis DB 别名存在前端 appearance，需随连接包一并恢复
      if (Object.keys(imported.redisDbAliases).length > 0) {
          const currentAliases = useStore.getState().appearance.redisDbAliases;
          useStore.getState().setAppearance({
              redisDbAliases: mergeRedisDbAliases(currentAliases, imported.redisDbAliases),
          });
      }
      return imported.connections;
  }, [connectionImportTargetTagId, moveConnectionsToTag, refreshConnectionsAfterImport, setConnectionDisplaySortMode, t]);

  const importConnectionPayloadFromFile = async (raw: string, sourceGroup?: ToolCenterGroupKey) => {
      const importKind = detectConnectionImportKind(raw);

      if (importKind === 'invalid') {
          setConnectionImportNotice(null);
          setConnectionPackageDialog((current) => ({
              ...current,
              mode: 'import',
              error: t('app.connection_package.message.unsupported_file_format'),
              confirmLoading: false,
          }));
          return;
      }

      try {
          setPendingConnectionImportPayload(null);
          setConnectionImportNotice(null);
          setConnectionPackageDialog((current) => ({
              ...current,
              mode: 'import',
              password: '',
              error: '',
              confirmLoading: true,
          }));
          const importedViews = await importConnectionsPayload(raw, '');
          if ((importKind === 'mysql-workbench-xml' || importKind === 'navicat-ncx') && importedViews.some(v => !v.hasPrimaryPassword)) {
              const warning = t('app.connection_package.message.imported_with_missing_passwords', { count: importedViews.length });
              setConnectionImportNotice({ type: 'warning', message: warning });
              void message.warning(warning);
          } else {
              const success = t('app.connection_package.message.imported_connections', { count: importedViews.length });
              setConnectionImportNotice({ type: 'success', message: success });
              void message.success(success);
          }
          setConnectionPackageDialog((current) => ({
              ...current,
              open: false,
              password: '',
              error: '',
              confirmLoading: false,
          }));
      } catch (e: any) {
          if (isConnectionPackagePasswordRequiredError(e)) {
              if (sourceGroup) {
                  setToolCenterBackGroupKey(sourceGroup);
                  setActiveSettingsCenterGroupKey(sourceGroup);
                  setActiveSettingsCenterPane({ key: 'import', group: sourceGroup });
              }
              setPendingConnectionImportPayload(raw);
              setConnectionPackageDialog({
                  open: true,
                  mode: 'import',
                  includeSecrets: true,
                  useFilePassword: false,
                  password: '',
                  error: '',
                  confirmLoading: false,
                  selectedConnectionIds: [],
              });
              return;
          }
          const detail = e?.message || t('app.connection_package.message.import_failed');
          setConnectionPackageDialog((current) => ({
              ...current,
              mode: 'import',
              error: detail,
              confirmLoading: false,
          }));
          void message.error(detail);
      }
  };

  const handleBrowserConnectionImportFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      const sourceGroup = browserConnectionImportSourceGroupRef.current;
      browserConnectionImportSourceGroupRef.current = undefined;
      event.target.value = '';
      if (!file) {
          return;
      }

      try {
          await importConnectionPayloadFromFile(await file.text(), sourceGroup);
      } catch (error) {
          const detail = error instanceof Error ? error.message : String(error ?? '').trim();
          const resolvedDetail = detail || t('app.connection_package.message.import_failed');
          setConnectionPackageDialog((current) => ({
              ...current,
              mode: 'import',
              error: resolvedDetail,
              confirmLoading: false,
          }));
          void message.error(resolvedDetail);
      }
  };

  const handleImportConnections = async (sourceGroup?: ToolCenterGroupKey) => {
      setToolCenterBackGroupKey(sourceGroup ?? null);
      setConnectionImportNotice(null);
      setConnectionPackageDialog((current) => ({
          ...current,
          mode: 'import',
          password: '',
          error: '',
          confirmLoading: false,
      }));
      if (sourceGroup) {
          setActiveSettingsCenterGroupKey(sourceGroup);
          setActiveSettingsCenterPane({ key: 'import', group: sourceGroup });
          openSettingsCenterWorkbenchTab();
      }
      if (isWebRuntime) {
          const input = browserConnectionImportInputRef.current;
          if (!input) {
              void message.error(t('app.connection_package.error.import_capability_unavailable'));
              return;
          }
          browserConnectionImportSourceGroupRef.current = sourceGroup;
          input.value = '';
          input.click();
          return;
      }

      const res = await (window as any).go.app.App.ImportConfigFile();
      if (!res.success) {
          if (res.message !== "已取消") {
              const detail = t('app.connection_package.message.import_failed_with_error', { error: res.message });
              setConnectionPackageDialog((current) => ({ ...current, error: detail }));
              void message.error(detail);
          }
          return;
      }

      const raw = typeof res.data === 'string' ? res.data : String(res.data ?? '');
      await importConnectionPayloadFromFile(raw, sourceGroup);
  };

  const handleExportConnections = async (sourceGroup?: ToolCenterGroupKey) => {
      setToolCenterBackGroupKey(sourceGroup ?? null);
      if (sourceGroup) {
          setActiveSettingsCenterGroupKey(sourceGroup);
          setActiveSettingsCenterPane({ key: 'export', group: sourceGroup });
          openSettingsCenterWorkbenchTab();
      }
      setConnectionPackageDialog({
          open: true,
          mode: 'export',
          includeSecrets: true,
          useFilePassword: false,
          password: '',
          error: '',
          confirmLoading: false,
          selectedConnectionIds: connections.map((item) => item.id),
      });
  };

  const handleConfirmConnectionPackageDialog = async () => {
      const backendApp = (window as any).go?.app?.App;
      const password = normalizeConnectionPackagePassword(connectionPackageDialog.password);

      if (connectionPackageDialog.mode === 'import' && !password) {
          setConnectionPackageDialog((current) => ({
              ...current,
              error: t('app.connection_package.error.restore_password_required'),
          }));
          return;
      }

      if (
          connectionPackageDialog.mode === 'export'
          && connectionPackageDialog.selectedConnectionIds.length === 0
      ) {
          setConnectionPackageDialog((current) => ({
              ...current,
              error: t('app.connection_package.error.no_selected_connections'),
          }));
          return;
      }

      if (
          connectionPackageDialog.mode === 'export'
          && connectionPackageDialog.includeSecrets
          && connectionPackageDialog.useFilePassword
          && !password
      ) {
          setConnectionPackageDialog((current) => ({
              ...current,
              error: t('app.connection_package.error.file_password_required'),
          }));
          return;
      }

      setConnectionPackageDialog((current) => ({
          ...current,
          password: (
              current.mode === 'export'
              && (!current.includeSecrets || !current.useFilePassword)
          ) ? '' : password,
          error: '',
          confirmLoading: true,
      }));

      try {
          if (connectionPackageDialog.mode === 'export') {
               const exportMethod = isWebRuntime
                   ? backendApp?.ExportConnectionsPayload
                   : backendApp?.ExportConnectionsPackage;
               if (typeof exportMethod !== 'function') {
                   throw new Error(t('app.connection_package.error.export_capability_unavailable'));
               }

               let res: unknown;
               try {
                   res = await exportMethod({
                      includeSecrets: connectionPackageDialog.includeSecrets,
                      filePassword: (
                          connectionPackageDialog.includeSecrets
                          && connectionPackageDialog.useFilePassword
                      ) ? password : '',
                      connectionIds: connectionPackageDialog.selectedConnectionIds,
                      // Redis DB 别名仅存前端，导出时注入连接包
                      redisDbAliases: useStore.getState().appearance.redisDbAliases,
                  });
              } catch (error) {
                  const detail = error instanceof Error ? error.message : String(error ?? '').trim();
                  throw new Error(
                      detail
                          ? `${t('app.connection_package.message.export_failed')}: ${detail}`
                          : t('app.connection_package.message.export_failed'),
                  );
              }
              const exportResult = resolveConnectionPackageExportResult(connectionPackageDialog, res);
              if (exportResult.kind === 'canceled') {
                  setConnectionPackageDialog(exportResult.nextDialog);
                  return;
              }
               if (exportResult.kind === 'failed') {
                   throw new Error(exportResult.error);
               }
               if (isWebRuntime) {
                   const content = typeof (res as any)?.data === 'string' ? (res as any).data : '';
                   if (!content || !downloadBrowserTextFile(content, 'connections.gonavi-conn', 'application/json;charset=utf-8')) {
                       throw new Error(t('app.connection_package.error.export_capability_unavailable'));
                   }
               }

              setConnectionPackageDialog((current) => ({
                  ...current,
                  password: '',
                  error: '',
                  confirmLoading: false,
              }));
              void message.success(t('app.connection_package.message.export_succeeded'));
              return;
          }

          if (!pendingConnectionImportPayload) {
              throw new Error(t('app.connection_package.error.missing_import_payload'));
          }

          const importedViews = await importConnectionsPayload(pendingConnectionImportPayload, password);
          const success = t('app.connection_package.message.imported_connections', { count: importedViews.length });
          setPendingConnectionImportPayload(null);
          setConnectionImportNotice({ type: 'success', message: success });
          setConnectionPackageDialog((current) => ({
              ...current,
              open: false,
              password: '',
              error: '',
              confirmLoading: false,
          }));
          void message.success(success);
      } catch (e: any) {
          setConnectionPackageDialog((current) => ({
              ...current,
              confirmLoading: false,
              error: e?.message || t(
                  current.mode === 'export'
                      ? 'app.connection_package.message.export_failed'
                      : 'app.connection_package.message.import_failed',
              ),
          }));
      }
  };

  const [toolCenterBackGroupKey, setToolCenterBackGroupKey] = useState<ToolCenterGroupKey | null>(null);
  const [isThemeModalOpen, setIsThemeModalOpen] = useState(false);
  type ThemeSettingsSection = 'theme' | 'appearance' | 'workspace';
  const THEME_SETTINGS_SECTION_STORAGE_KEY = 'gonavi.themeSettingsSection';
  const sanitizeThemeSettingsSection = useCallback((value: unknown): ThemeSettingsSection => {
      const normalized = String(value || '').trim().toLowerCase();
      if (normalized === 'appearance' || normalized === 'workspace') {
          return normalized;
      }
      return 'theme';
  }, []);
  const [themeModalSection, setThemeModalSection] = useState<ThemeSettingsSection>(() => {
      try {
          return sanitizeThemeSettingsSection(window.localStorage.getItem(THEME_SETTINGS_SECTION_STORAGE_KEY));
      } catch {
          return 'theme';
      }
  });
  useEffect(() => {
      try {
          window.localStorage.setItem(THEME_SETTINGS_SECTION_STORAGE_KEY, themeModalSection);
      } catch {
          // ignore persistence failures
      }
  }, [themeModalSection]);
  const [isLinuxCJKFontBannerDismissed, setIsLinuxCJKFontBannerDismissed] = useState(false);
  const [isAppearanceModalOpen, setIsAppearanceModalOpen] = useState(false);
  const [capturingShortcutAction, setCapturingShortcutAction] = useState<ShortcutAction | null>(null);
  const closeShortcutScopeRef = useRef<CloseShortcutScope>('workspace');
  const tabDisplaySettingsPanelRef = useRef<HTMLDivElement | null>(null);
  const [tabDisplaySettingsFocusRequest, setTabDisplaySettingsFocusRequest] = useState(0);
  const isThemeSettingsPaneOpen = activeSettingsCenterPane?.key === 'theme';
  useEffect(() => {
      setGlobalShortcutCaptureActive(Boolean(capturingShortcutAction));
      return () => setGlobalShortcutCaptureActive(false);
  }, [capturingShortcutAction]);
  useEffect(() => {
      const shouldLoadInstalledFonts =
          runtimePlatform === 'linux' || ((isThemeModalOpen || isThemeSettingsPaneOpen) && themeModalSection === 'appearance');
      if (!shouldLoadInstalledFonts) {
          return;
      }
      if (hasLoadedInstalledFontsRef.current || isFontFamiliesLoading) {
          return;
      }

      let cancelled = false;
      hasLoadedInstalledFontsRef.current = true;
      setIsFontFamiliesLoading(true);
      setFontFamiliesLoadError(null);

      ListInstalledFontFamilies()
          .then((result) => {
              if (cancelled) {
                  return;
              }
              if (!result?.success) {
                  throw new Error(String(result?.message || t('app.theme.font_family.load_failed')));
              }
              const nextFonts = Array.isArray(result?.data)
                  ? result.data
                      .map((item) => ({
                          family: sanitizeFontFamilyInput((item as InstalledFontFamily | Record<string, unknown>)?.family) || '',
                          path: typeof (item as InstalledFontFamily | Record<string, unknown>)?.path === 'string'
                              ? String((item as InstalledFontFamily | Record<string, unknown>).path)
                              : undefined,
                      }))
                      .filter((item) => item.family)
                  : EMPTY_INSTALLED_FONT_FAMILIES;
              setInstalledFontFamilies(nextFonts);
          })
          .catch((error) => {
              if (cancelled) {
                  return;
              }
              hasLoadedInstalledFontsRef.current = false;
              setFontFamiliesLoadError(String(error instanceof Error ? error.message : error || t('app.theme.font_family.load_failed')));
          })
          .finally(() => {
              if (!cancelled) {
                  setIsFontFamiliesLoading(false);
              }
          });

      return () => {
          cancelled = true;
      };
  }, [isThemeModalOpen, isThemeSettingsPaneOpen, runtimePlatform, t, themeModalSection]);

  useEffect(() => {
      if ((!isThemeModalOpen && !isThemeSettingsPaneOpen) || themeModalSection !== 'workspace' || tabDisplaySettingsFocusRequest === 0) {
          return;
      }
      const timer = window.setTimeout(() => {
          tabDisplaySettingsPanelRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
      }, 80);
      return () => window.clearTimeout(timer);
  }, [isThemeModalOpen, isThemeSettingsPaneOpen, themeModalSection, tabDisplaySettingsFocusRequest]);

  const shortcutConflictMap = useMemo(() => {
      const map: Partial<Record<ShortcutAction, ConflictInfo[]>> = {};
      for (const action of SHORTCUT_ACTION_ORDER) {
          const binding = resolveShortcutBinding(shortcutOptions, action, activeShortcutPlatform);
          if (!binding?.enabled || !binding.combo) continue;
          const conflicts = findReservedConflictsForAction(
              action,
              normalizeShortcutCombo(binding.combo),
              activeShortcutPlatform,
          );
          if (conflicts.length > 0) {
              map[action] = conflicts;
          }
      }
      return map;
  }, [activeShortcutPlatform, language, shortcutOptions]);
  const [isProxyModalOpen, setIsProxyModalOpen] = useState(false);
  const [proxyDraft, setProxyDraft] = useState<GlobalProxyConfig>(() => createGlobalProxyComparableDraft(globalProxy));
  const [proxyDraftClearPassword, setProxyDraftClearPassword] = useState(false);
  const [proxyApplying, setProxyApplying] = useState(false);
  const [proxyTestUrl, setProxyTestUrl] = useState(DEFAULT_GLOBAL_PROXY_TEST_URL);
  const [proxyTesting, setProxyTesting] = useState(false);
  const [proxyTestResult, setProxyTestResult] = useState<GlobalProxyTestResultState | null>(null);
  const [isDataRootModalOpen, setIsDataRootModalOpen] = useState(false);
  const [dataRootInfo, setDataRootInfo] = useState<any>(null);
  const [selectedDataRootPath, setSelectedDataRootPath] = useState('');
  const [selectedLogDirectoryPath, setSelectedLogDirectoryPath] = useState('');
  const [selectedSavedQueryDirectoryPath, setSelectedSavedQueryDirectoryPath] = useState('');
  const [dataRootLoading, setDataRootLoading] = useState(false);
  const [dataRootApplying, setDataRootApplying] = useState(false);
  const [logDirectoryApplying, setLogDirectoryApplying] = useState(false);
  const [savedQueryDirectoryApplying, setSavedQueryDirectoryApplying] = useState(false);
  const directorySettingsApplying = dataRootApplying || logDirectoryApplying || savedQueryDirectoryApplying;

  const aiPanelOverlayActive = aiPanelVisible && shouldOverlayAIPanel({
      viewportWidth,
      sidebarWidth: renderedSidebarWidth,
      panelWidth: DEFAULT_AI_PANEL_WIDTH,
  });
  const aiPanelFullscreenOverlay = aiPanelOverlayActive && shouldUseFullscreenAIPanelOverlay(viewportWidth);
  const aiPanelRenderWidth = aiPanelFullscreenOverlay
      ? resolveFullscreenAIPanelOverlayWidth(viewportWidth)
      : aiPanelOverlayActive
          ? resolveOverlayAIPanelWidth({
          viewportWidth,
          sidebarWidth: renderedSidebarWidth,
          panelWidth: DEFAULT_AI_PANEL_WIDTH,
          })
          : DEFAULT_AI_PANEL_WIDTH;
  const appliedGlobalProxyDraft = useMemo(() => (
      createGlobalProxyComparableDraft(globalProxy)
  ), [
      globalProxy.enabled,
      globalProxy.type,
      globalProxy.host,
      globalProxy.port,
      globalProxy.user,
      globalProxy.password,
      globalProxy.hasPassword,
  ]);
  const proxyDraftHost = String(proxyDraft.host || '').trim();
  const proxyDraftUser = String(proxyDraft.user || '').trim();
  const proxyDraftPort = Number(proxyDraft.port);
  const proxyDraftPortValid = Number.isFinite(proxyDraftPort) && proxyDraftPort > 0 && proxyDraftPort <= 65535;
  const proxyDraftValid = !proxyDraft.enabled || (proxyDraftHost !== '' && proxyDraftPortValid);
  const proxyDraftDirty = proxyDraftClearPassword || !areGlobalProxyDraftsEqual(proxyDraft, appliedGlobalProxyDraft);
  const proxyPanelOpen = isProxyModalOpen || activeSettingsCenterPane?.key === 'proxy';
  const proxyPanelWasOpenRef = useRef(false);
  const proxyStatusTone = proxyDraft.enabled
      ? (proxyDraftValid ? 'success' : 'warning')
      : 'info';
  const proxyStatusTitle = proxyDraft.enabled
      ? (proxyDraftValid ? t('app.proxy.status.enabled') : t('app.proxy.status.incomplete'))
      : t('app.proxy.status.disabled');
  const proxyStatusDescription = proxyDraft.enabled && proxyDraftValid
      ? t('app.proxy.status.enabled_description', {
          type: proxyDraft.type.toUpperCase(),
          endpoint: `${proxyDraftHost}:${proxyDraftPort}`,
      })
      : (proxyDraft.enabled
          ? t('app.proxy.status.incomplete_description')
          : t('app.proxy.status.disabled_description'));
  const proxyPresetItems = useMemo(() => ([
      { key: 'clash-mixed', label: t('app.proxy.preset.clash_mixed'), type: 'socks5' as const, host: '127.0.0.1', port: 7890 },
      { key: 'socks5-local', label: t('app.proxy.preset.socks5_local'), type: 'socks5' as const, host: '127.0.0.1', port: 1080 },
      { key: 'http-local', label: t('app.proxy.preset.http_local'), type: 'http' as const, host: '127.0.0.1', port: 8080 },
  ]), [t]);
  const proxyTestPresetItems = useMemo(() => ([
      { key: 'github-api', label: t('app.proxy.test.preset.github_api'), url: 'https://api.github.com/' },
      { key: 'github-release', label: t('app.proxy.test.preset.github_release'), url: 'https://github.com/Syngnat/GoNavi/releases/latest' },
      { key: 'go-module-proxy', label: t('app.proxy.test.preset.go_module_proxy'), url: 'https://proxy.golang.org/' },
      { key: 'baidu', label: t('app.proxy.test.preset.baidu'), url: 'https://www.baidu.com/' },
  ]), [t]);
  const proxyTestUrlTrimmed = String(proxyTestUrl || '').trim();
  const proxyCanTest = proxyDraft.enabled && proxyDraftValid && proxyTestUrlTrimmed !== '' && !proxyTesting;
  useEffect(() => {
      if (!proxyPanelOpen) {
          proxyPanelWasOpenRef.current = false;
          return;
      }
      if (proxyPanelWasOpenRef.current) {
          return;
      }
      proxyPanelWasOpenRef.current = true;
      setProxyDraft(appliedGlobalProxyDraft);
      setProxyDraftClearPassword(false);
  }, [appliedGlobalProxyDraft, proxyPanelOpen]);
  useEffect(() => {
      setProxyTestResult(null);
  }, [
      proxyDraft.enabled,
      proxyDraft.type,
      proxyDraft.host,
      proxyDraft.port,
      proxyDraft.user,
      proxyDraft.password,
      proxyDraftClearPassword,
      proxyTestUrlTrimmed,
  ]);
  const resetProxyDraftToCurrent = useCallback(() => {
      setProxyDraft(appliedGlobalProxyDraft);
      setProxyDraftClearPassword(false);
  }, [appliedGlobalProxyDraft]);
  const updateProxyDraftType = useCallback((type: GlobalProxyConfig['type']) => {
      setProxyDraft((current) => {
          const currentPort = Number(current.port);
          const previousDefault = getGlobalProxyDefaultPort(current.type);
          const shouldSwitchPort = !Number.isFinite(currentPort) || currentPort === previousDefault;
          return {
              ...current,
              type,
              port: shouldSwitchPort ? getGlobalProxyDefaultPort(type) : current.port,
          };
      });
  }, []);
  const applyProxyPreset = useCallback((preset: { type: GlobalProxyConfig['type']; host: string; port: number }) => {
      setProxyDraft((current) => ({
          ...current,
          enabled: true,
          type: preset.type,
          host: preset.host,
          port: preset.port,
      }));
  }, []);
  const handleTestGlobalProxyDraft = useCallback(async () => {
      if (!proxyDraft.enabled) {
          void message.warning(t('app.proxy.test.message.enable_first'));
          return;
      }
      if (!proxyDraftValid) {
          void message.warning(t('app.proxy.message.invalid_enabled'));
          return;
      }
      if (proxyTestUrlTrimmed === '') {
          void message.warning(t('app.proxy.test.message.url_required'));
          return;
      }
      const backendApp = (window as any).go?.app?.App;
      if (typeof backendApp?.TestGlobalProxyConnection !== 'function') {
          void message.error(t('app.proxy.test.message.unavailable'));
          return;
      }
      setProxyTesting(true);
      try {
          const res = await backendApp.TestGlobalProxyConnection({
              proxy: toSaveGlobalProxyInput({
                  ...proxyDraft,
                  host: proxyDraftHost,
                  user: proxyDraftUser,
                  port: proxyDraftPortValid ? proxyDraftPort : getGlobalProxyDefaultPort(proxyDraft.type),
                  clearPassword: proxyDraftClearPassword,
              }),
              url: proxyTestUrlTrimmed,
              timeoutSeconds: 8,
          });
          const data = (res?.data || {}) as Partial<GlobalProxyTestResultState>;
          const statusCode = Number(data.statusCode);
          setProxyTestResult({
              success: res?.success === true,
              message: res?.message || t('common.unknown'),
              url: data.url || proxyTestUrlTrimmed,
              finalUrl: data.finalUrl,
              statusCode: Number.isFinite(statusCode) ? statusCode : undefined,
              durationMs: typeof data.durationMs === 'number' ? data.durationMs : undefined,
              viaProxy: data.viaProxy === true,
          });
      } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err || t('common.unknown'));
          setProxyTestResult({
              success: false,
              message: errMsg,
              url: proxyTestUrlTrimmed,
          });
      } finally {
          setProxyTesting(false);
      }
  }, [
      proxyDraft,
      proxyDraftClearPassword,
      proxyDraftHost,
      proxyDraftPort,
      proxyDraftPortValid,
      proxyDraftUser,
      proxyDraftValid,
      proxyTestUrlTrimmed,
      t,
  ]);
  const handleApplyGlobalProxyDraft = useCallback(async () => {
      if (!proxyDraftValid) {
          void message.warning({
              content: t('app.proxy.message.invalid_enabled'),
              key: 'global-proxy-invalid',
          });
          return;
      }
      void message.destroy('global-proxy-invalid');
      const backendApp = (window as any).go?.app?.App;
      if (typeof backendApp?.SaveGlobalProxy !== 'function') {
          void message.error({
              content: t('app.proxy.message.save_failed', { error: t('common.unknown') }),
              key: 'global-proxy-sync-error',
          });
          return;
      }
      const saveInput = toSaveGlobalProxyInput({
          ...proxyDraft,
          host: proxyDraftHost,
          user: proxyDraftUser,
          port: proxyDraftPortValid ? proxyDraftPort : getGlobalProxyDefaultPort(proxyDraft.type),
          clearPassword: proxyDraftClearPassword,
      });
      setProxyApplying(true);
      try {
          const saved = await backendApp.SaveGlobalProxy(saveInput);
          const nextDraft = createGlobalProxyComparableDraft(saved || saveInput);
          replaceGlobalProxy(nextDraft);
          setProxyDraft(nextDraft);
          setProxyDraftClearPassword(false);
          void message.success({
              content: t('app.proxy.message.config_applied'),
              key: 'global-proxy-applied',
          });
      } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err || t('common.unknown'));
          void message.error({
              content: t('app.proxy.message.save_failed', { error: errMsg }),
              key: 'global-proxy-sync-error',
          });
      } finally {
          setProxyApplying(false);
      }
  }, [
      proxyDraft,
      proxyDraftClearPassword,
      proxyDraftHost,
      proxyDraftPort,
      proxyDraftPortValid,
      proxyDraftUser,
      proxyDraftValid,
      replaceGlobalProxy,
      t,
  ]);
  const closeConnectionHealthSettingsPane = useCallback(() => {
      setConnectionHealthTargetIds([]);
      setActiveSettingsCenterPane((current) => (
          current?.key === 'connection-health' ? resolveSettingsCenterGroupInitialPane('config') : current
      ));
  }, []);
  const clearSettingsCenterTransientPaneState = useCallback(() => {
      setCapturingShortcutAction(null);
      if (isConnectionPackageSettingsPaneKey(activeSettingsCenterPaneRef.current?.key)) {
          closeConnectionPackageDialog();
      }
      if (activeSettingsCenterPaneRef.current?.key === 'connection-health') {
          setConnectionHealthTargetIds([]);
      }
      if (activeSettingsCenterPaneRef.current?.key === 'ai') {
          setFocusedAIProviderId(undefined);
          setSecurityUpdateRepairSource(null);
      }
  }, [closeConnectionPackageDialog]);
  const handleOpenToolsModal = useCallback((group: ToolCenterGroupKey = 'config') => withAISettingsLeaveGuard(aiSettingsLeaveGuardRef.current, () => {
      clearSettingsCenterTransientPaneState();
      setToolCenterBackGroupKey(null);
      setActiveSettingsCenterGroupKey(group);
      setActiveSettingsCenterPane(resolveSettingsCenterGroupInitialPane(group));
      openSettingsCenterWorkbenchTab();
  }), [clearSettingsCenterTransientPaneState, openSettingsCenterWorkbenchTab]);
  const handleOpenSettingsModal = useCallback((group: SettingsCenterGroupKey = 'preferences') => withAISettingsLeaveGuard(aiSettingsLeaveGuardRef.current, () => {
      clearSettingsCenterTransientPaneState();
      setActiveSettingsCenterGroupKey(group);
      setActiveSettingsCenterPane(resolveSettingsCenterGroupInitialPane(group));
      openSettingsCenterWorkbenchTab();
  }), [clearSettingsCenterTransientPaneState, openSettingsCenterWorkbenchTab]);
  const handleOpenSettingsCenterPane = useCallback((group: SettingsCenterGroupKey, key: SettingsCenterPaneKey) => withAISettingsLeaveGuard(aiSettingsLeaveGuardRef.current, () => {
      clearSettingsCenterTransientPaneState();
      setActiveSettingsCenterGroupKey(group);
      setActiveSettingsCenterPane({ key, group });
      openSettingsCenterWorkbenchTab();
  }), [clearSettingsCenterTransientPaneState, openSettingsCenterWorkbenchTab]);
  const finalizeSecurityRepairReturnFromAISettings = useCallback(() => {
      const reopenSecurityUpdateDetails = shouldReopenSecurityUpdateDetails(securityUpdateRepairSource);
      setFocusedAIProviderId(undefined);
      setSecurityUpdateRepairSource(null);
      if (reopenSecurityUpdateDetails) {
          openSecurityUpdateSettings();
      }
  }, [openSecurityUpdateSettings, securityUpdateRepairSource]);
  const handleCancelSettingsCenterPane = useCallback(() => withAISettingsLeaveGuard(aiSettingsLeaveGuardRef.current, () => {
      const leavingAI = activeSettingsCenterPane?.key === 'ai';
      if (isConnectionPackageSettingsPaneKey(activeSettingsCenterPane?.key)) {
          closeConnectionPackageDialog();
      }
      if (activeSettingsCenterPane?.key === 'connection-health') {
          setConnectionHealthTargetIds([]);
      }
      setCapturingShortcutAction(null);
      setToolCenterBackGroupKey(null);
      setActiveSettingsCenterPane(null);
      closeSettingsCenterWorkbenchTab();
      if (leavingAI) {
          finalizeSecurityRepairReturnFromAISettings();
      }
  }), [activeSettingsCenterPane?.key, closeConnectionPackageDialog, closeSettingsCenterWorkbenchTab, finalizeSecurityRepairReturnFromAISettings]);
  const handleOpenDataSyncWorkbench = useCallback((entryMode: DataSyncEntryMode) => withAISettingsLeaveGuard(aiSettingsLeaveGuardRef.current, () => {
      addTab(buildDataSyncWorkbenchTab({ entryMode }));
  }), [addTab]);
  const isSettingsAboutPaneOpen = isSettingsModalOpen && activeSettingsCenterPane?.key === 'about-go-navi';
  const wasSettingsCenterTabOpenRef = useRef(false);
  useEffect(() => {
      const wasOpen = wasSettingsCenterTabOpenRef.current;
      wasSettingsCenterTabOpenRef.current = isSettingsModalOpen;
      if (!wasOpen || isSettingsModalOpen) {
          return;
      }
      // Tab closed via workbench chrome (X) — mirror cancel cleanup without re-entering leave guard.
      if (isConnectionPackageSettingsPaneKey(activeSettingsCenterPaneRef.current?.key)) {
          closeConnectionPackageDialog();
      }
      if (activeSettingsCenterPaneRef.current?.key === 'connection-health') {
          setConnectionHealthTargetIds([]);
      }
      const leavingAI = activeSettingsCenterPaneRef.current?.key === 'ai';
      setCapturingShortcutAction(null);
      setToolCenterBackGroupKey(null);
      setActiveSettingsCenterPane(null);
      if (leavingAI) {
          finalizeSecurityRepairReturnFromAISettings();
      }
  }, [closeConnectionPackageDialog, finalizeSecurityRepairReturnFromAISettings, isSettingsModalOpen]);
  const isSettingsAboutPaneOpenRef = useRef(false);
  useEffect(() => {
      isSettingsAboutPaneOpenRef.current = isSettingsAboutPaneOpen;
  }, [isSettingsAboutPaneOpen]);
  useEffect(() => {
      updateCenterBridgeRef.current = {
          open: () => {
              handleOpenSettingsCenterPane('about', 'about-go-navi');
          },
          close: () => {
              handleCancelSettingsCenterPane();
          },
          isOpen: () => isSettingsAboutPaneOpenRef.current,
      };
      return () => {
          updateCenterBridgeRef.current = null;
      };
  }, [handleCancelSettingsCenterPane, handleOpenSettingsCenterPane]);
  useEffect(() => {
      openReleaseNotesOnManualCheckRef.current = () => {
          setReleaseNotesModalOpen(true);
      };
      return () => {
          openReleaseNotesOnManualCheckRef.current = null;
      };
  }, []);
  useEffect(() => {
      if (!isSettingsAboutPaneOpen) {
          return;
      }
      prepareAboutSurface();
  }, [isSettingsAboutPaneOpen, prepareAboutSurface]);
  const handleOpenToolCenterPane = useCallback((group: ToolCenterGroupKey, key: ToolCenterPaneKey) => withAISettingsLeaveGuard(aiSettingsLeaveGuardRef.current, () => {
      clearSettingsCenterTransientPaneState();
      setToolCenterBackGroupKey(group);
      setActiveSettingsCenterGroupKey(group);
      setActiveSettingsCenterPane({ key, group });
      openSettingsCenterWorkbenchTab();
  }), [clearSettingsCenterTransientPaneState]);
  /** Title-bar / explorer settings entries → settings center navigation. */
  const handleTitleBarSettingsNavigation = useCallback((spec: {
    group: 'preferences' | 'services' | 'config' | 'workflow' | 'workspace' | 'about';
    pane?: string;
    action?: 'import-connections' | 'export-connections' | 'schema-compare' | 'data-compare' | 'sync' | 'drivers' | 'sql-audit';
  }) => withAISettingsLeaveGuard(aiSettingsLeaveGuardRef.current, () => {
      if (spec.action === 'import-connections') {
          handleOpenToolCenterPane('config', 'import');
          return;
      }
      if (spec.action === 'export-connections') {
          void handleExportConnections('config');
          return;
      }
      if (spec.action === 'schema-compare') {
          handleOpenDataSyncWorkbench('schemaCompare');
          return;
      }
      if (spec.action === 'data-compare') {
          handleOpenDataSyncWorkbench('dataCompare');
          return;
      }
      if (spec.action === 'sync') {
          handleOpenDataSyncWorkbench('sync');
          return;
      }
      if (spec.action === 'drivers') {
          handleOpenToolCenterPane('workspace', 'drivers');
          return;
      }
      if (spec.action === 'sql-audit') {
          handleCancelSettingsCenterPane();
          addTab(buildSqlAuditWorkbenchTab());
          return;
      }
      if (!spec.pane) {
          if (isToolCenterGroupKey(spec.group)) {
              handleOpenToolsModal(spec.group);
              return;
          }
          handleOpenSettingsModal(spec.group);
          return;
      }
      if (isToolCenterGroupKey(spec.group)) {
          handleOpenToolCenterPane(spec.group, spec.pane as ToolCenterPaneKey);
          return;
      }
      if (spec.group === 'preferences' && spec.pane === 'theme') {
          setThemeModalSection('theme');
          handleOpenSettingsCenterPane('preferences', 'theme');
          return;
      }
      if (spec.group === 'services' && spec.pane === 'ai') {
          setSecurityUpdateRepairSource(null);
          setFocusedAIProviderId(undefined);
          setAiSettingsSection('providers');
          setAiSettingsProviderView('workspace');
          handleOpenSettingsCenterPane('services', 'ai');
          return;
      }
      handleOpenSettingsCenterPane(spec.group, spec.pane as SettingsCenterPaneKey);
  }), [
      addTab,
      handleCancelSettingsCenterPane,
      handleExportConnections,
      handleOpenDataSyncWorkbench,
      handleOpenSettingsCenterPane,
      handleOpenSettingsModal,
      handleOpenToolCenterPane,
      handleOpenToolsModal,
  ]);
  const handleReturnToToolCenter = useCallback((closeChild?: () => void) => withAISettingsLeaveGuard(aiSettingsLeaveGuardRef.current, () => {
      const returnGroup = toolCenterBackGroupKey ?? 'config';
      closeChild?.();
      setToolCenterBackGroupKey(null);
      setActiveSettingsCenterGroupKey(returnGroup);
      setActiveSettingsCenterPane(resolveSettingsCenterGroupInitialPane(returnGroup));
      openSettingsCenterWorkbenchTab();
  }), [toolCenterBackGroupKey]);
  const handleFocusSidebarSearch = useCallback(() => {
      setIsSidebarCollapsed(false);
      window.setTimeout(() => {
          window.dispatchEvent(new CustomEvent('gonavi:focus-sidebar-search'));
      }, 0);
  }, []);
  const loadDataRootInfo = useCallback(async () => {
      setDataRootLoading(true);
      try {
          const res = await GetDataRootDirectoryInfo();
          if (!res?.success) {
              throw new Error(res?.message || t('app.data_root.message.load_failed'));
          }
          const data = (res?.data || {}) as any;
          setDataRootInfo(data);
          setSelectedDataRootPath(String(data.path || ''));
          setSelectedLogDirectoryPath(String(data.logDirectory || data.defaultLogDirectory || ''));
          setSelectedSavedQueryDirectoryPath(String(
              data.savedQueryDirectory || data.defaultSavedQueryDirectory || '',
          ));
      } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error || t('common.unknown'));
          void message.error(t('app.data_root.message.load_failed_with_error', { error: errMsg }));
      } finally {
          setDataRootLoading(false);
      }
  }, [t]);

  useEffect(() => {
      if (!isDataRootModalOpen && !activeSettingsCenterPane?.key.startsWith('data-root')) {
          return;
      }
      void loadDataRootInfo();
  }, [activeSettingsCenterPane?.key, isDataRootModalOpen, loadDataRootInfo]);

  const handleSelectDataRoot = useCallback(async () => {
      try {
          const res = await SelectDataRootDirectory(selectedDataRootPath || dataRootInfo?.path || '');
          if (!res?.success) {
              if (String(res?.message || '') !== '已取消') {
                  throw new Error(res?.message || t('app.data_root.message.select_failed'));
              }
              return;
          }
          const data = (res?.data || {}) as any;
          setSelectedDataRootPath(String(data.path || ''));
      } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error || t('common.unknown'));
          void message.error(t('app.data_root.message.select_failed_with_error', { error: errMsg }));
      }
  }, [dataRootInfo?.path, selectedDataRootPath, t]);

  const handleApplyDataRoot = useCallback(async (migrate: boolean, useDefaultPath = false) => {
      const nextPath = useDefaultPath ? String(dataRootInfo?.defaultPath || '') : String(selectedDataRootPath || '').trim();
      if (!nextPath) {
          void message.warning(t('app.data_root.message.select_valid_first'));
          return;
      }
      setDataRootApplying(true);
      try {
          const res = await ApplyDataRootDirectory(nextPath, migrate);
          if (!res?.success) {
              throw new Error(res?.message || t('app.data_root.message.apply_failed'));
          }
          const data = (res?.data || {}) as any;
          setDataRootInfo(data);
          setSelectedDataRootPath(String(data.path || nextPath));
          void message.success(res?.message || t('app.data_root.message.updated'));
      } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error || t('common.unknown'));
          void message.error(t('app.data_root.message.apply_failed_with_error', { error: errMsg }));
      } finally {
          setDataRootApplying(false);
      }
  }, [dataRootInfo?.defaultPath, selectedDataRootPath, t]);

  const handleOpenDataRoot = useCallback(async () => {
      try {
          const res = await OpenDataRootDirectory();
          if (!res?.success) {
              throw new Error(res?.message || t('app.data_root.message.open_failed'));
          }
      } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error || t('common.unknown'));
          void message.error(t('app.data_root.message.open_failed_with_error', { error: errMsg }));
      }
  }, [t]);

  const handleSelectLogDirectory = useCallback(async () => {
      try {
          const res = await SelectLogDirectory(
              selectedLogDirectoryPath || dataRootInfo?.logDirectory || dataRootInfo?.defaultLogDirectory || '',
          );
          if (!res?.success) {
              if (String(res?.message || '') !== '已取消') {
                  throw new Error(res?.message || t('common.unknown'));
              }
              return;
          }
          const data = (res?.data || {}) as any;
          setSelectedLogDirectoryPath(String(data.directory || ''));
      } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error || t('common.unknown'));
          void message.error(t('app.data_root.log_directory.message.select_failed_with_error', { error: errMsg }));
      }
  }, [dataRootInfo?.defaultLogDirectory, dataRootInfo?.logDirectory, selectedLogDirectoryPath, t]);

  const handleApplyLogDirectory = useCallback(async (useDefaultPath = false) => {
      const nextPath = useDefaultPath
          ? String(dataRootInfo?.defaultLogDirectory || '')
          : String(selectedLogDirectoryPath || '').trim();
      if (!nextPath) {
          void message.warning(t('app.data_root.log_directory.message.select_valid_first'));
          return;
      }
      setLogDirectoryApplying(true);
      try {
          const res = await ApplyLogDirectory(nextPath);
          if (!res?.success) {
              throw new Error(res?.message || t('common.unknown'));
          }
          const data = (res?.data || {}) as any;
          setDataRootInfo(data);
          setSelectedLogDirectoryPath(String(data.logDirectory || data.defaultLogDirectory || nextPath));
          void message.success(res?.message || t('app.data_root.log_directory.message.updated'));
      } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error || t('common.unknown'));
          void message.error(t('app.data_root.log_directory.message.apply_failed_with_error', { error: errMsg }));
      } finally {
          setLogDirectoryApplying(false);
      }
  }, [dataRootInfo?.defaultLogDirectory, selectedLogDirectoryPath, t]);

  const handleOpenLogDirectory = useCallback(async () => {
      try {
          const res = await OpenLogDirectory();
          if (!res?.success) {
              throw new Error(res?.message || t('common.unknown'));
          }
      } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error || t('common.unknown'));
          void message.error(t('app.data_root.log_directory.message.open_failed_with_error', { error: errMsg }));
      }
  }, [t]);

  const handleSelectSavedQueryDirectory = useCallback(async () => {
      try {
          const res = await SelectSavedQueryDirectory(
              selectedSavedQueryDirectoryPath
                  || dataRootInfo?.savedQueryDirectory
                  || dataRootInfo?.defaultSavedQueryDirectory
                  || '',
          );
          if (!res?.success) {
              const data = (res?.data || {}) as any;
              if (data.cancelled === true) return;
              throw new Error(res?.message || t('common.unknown'));
          }
          const data = (res?.data || {}) as any;
          setSelectedSavedQueryDirectoryPath(String(data.directory || ''));
      } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error || t('common.unknown'));
          void message.error(t('app.data_root.saved_query_directory.message.select_failed_with_error', { error: errMsg }));
      }
  }, [
      dataRootInfo?.defaultSavedQueryDirectory,
      dataRootInfo?.savedQueryDirectory,
      selectedSavedQueryDirectoryPath,
      t,
  ]);

  const handleApplySavedQueryDirectory = useCallback(async (useDefaultPath = false) => {
      const nextPath = useDefaultPath
          ? String(dataRootInfo?.defaultSavedQueryDirectory || '')
          : String(selectedSavedQueryDirectoryPath || '').trim();
      if (!nextPath) {
          void message.warning(t('app.data_root.saved_query_directory.message.select_valid_first'));
          return;
      }
      setSavedQueryDirectoryApplying(true);
      try {
          const res = await ApplySavedQueryDirectory(nextPath);
          if (!res?.success) {
              throw new Error(res?.message || t('common.unknown'));
          }
          const data = (res?.data || {}) as any;
          setDataRootInfo(data);
          setSelectedSavedQueryDirectoryPath(String(
              data.savedQueryDirectory || data.defaultSavedQueryDirectory || nextPath,
          ));
          try {
              const queries = await GetSavedQueries();
              replaceSavedQueries(Array.isArray(queries) ? queries : []);
              await reloadSavedQueryGroups();
          } catch (refreshError) {
              console.warn('Failed to refresh saved queries after changing their directory', refreshError);
          }
          void message.success(res?.message || t('app.data_root.saved_query_directory.message.updated'));
      } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error || t('common.unknown'));
          void message.error(t('app.data_root.saved_query_directory.message.apply_failed_with_error', { error: errMsg }));
      } finally {
          setSavedQueryDirectoryApplying(false);
      }
  }, [
      dataRootInfo?.defaultSavedQueryDirectory,
      reloadSavedQueryGroups,
      replaceSavedQueries,
      selectedSavedQueryDirectoryPath,
      t,
  ]);

  const handleOpenSavedQueryDirectory = useCallback(async () => {
      try {
          const res = await OpenSavedQueryDirectory();
          if (!res?.success) {
              throw new Error(res?.message || t('common.unknown'));
          }
      } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error || t('common.unknown'));
          void message.error(t('app.data_root.saved_query_directory.message.open_failed_with_error', { error: errMsg }));
      }
  }, [t]);

  const renderSavedQueryDirectorySettings = (readOnly = false) => (
      <DataDirectoryPage testId="saved-queries">
          <section className="gn-storage-panel gn-storage-panel--current" data-saved-query-directory-settings="true">
              <div className="gn-storage-panel__body">
                  <DirectorySectionHeading
                      title={t('app.data_root.current_location')}
                      description={t('app.data_root.saved_query_directory.current_description')}
                  />
                  <DirectoryPathDisplay
                      label={t('app.data_root.saved_query_directory.current_directory')}
                      path={dataRootInfo?.savedQueryDirectory || selectedSavedQueryDirectoryPath}
                      action={!readOnly ? (
                          <Button onClick={() => void handleOpenSavedQueryDirectory()}>
                              {t('app.data_root.action.open_current')}
                          </Button>
                      ) : undefined}
                  />
                  <DirectoryMetaGrid items={[{
                      label: t('app.data_root.saved_query_directory.default_directory'),
                      value: dataRootInfo?.defaultSavedQueryDirectory || '-',
                  }]} />
              </div>
          </section>

          {!readOnly && (
              <section className="gn-storage-panel">
                  <div className="gn-storage-panel__body">
                      <DirectorySectionHeading
                          title={t('app.data_root.change_location')}
                          description={t('app.data_root.saved_query_directory.change_description')}
                      />
                      <div className="gn-storage-path-editor">
                          <Input
                              readOnly
                              value={selectedSavedQueryDirectoryPath}
                              placeholder={t('app.data_root.saved_query_directory.placeholder')}
                              aria-label={t('app.data_root.saved_query_directory.title')}
                          />
                          <div className="gn-storage-path-editor__actions">
                              <Button
                                  icon={<FolderOpenOutlined />}
                                  disabled={directorySettingsApplying}
                                  onClick={() => void handleSelectSavedQueryDirectory()}
                              >
                                  {t('app.data_root.action.select')}
                              </Button>
                              <Button
                                  disabled={directorySettingsApplying}
                                  loading={savedQueryDirectoryApplying}
                                  onClick={() => void handleApplySavedQueryDirectory(true)}
                              >
                                  {t('app.data_root.action.restore_default_directory')}
                              </Button>
                          </div>
                      </div>
                      <DirectoryChoice
                          recommended
                          badge={t('app.data_root.recommended')}
                          title={t('app.data_root.saved_query_directory.apply_title')}
                          description={t('app.data_root.saved_query_directory.apply_description')}
                          action={(
                              <Button
                                  type="primary"
                                  disabled={directorySettingsApplying}
                                  loading={savedQueryDirectoryApplying}
                                  onClick={() => void handleApplySavedQueryDirectory(false)}
                              >
                                  {t('app.data_root.action.use_selected_directory')}
                              </Button>
                          )}
                      />
                  </div>
              </section>
          )}
      </DataDirectoryPage>
  );

  const renderLogDirectorySettings = (readOnly = false) => {
      const editable = dataRootInfo?.logDirectoryEditable !== false;
      const managedByEnvironment = dataRootInfo?.logDirectorySource === 'environment';
      const restartRequired = dataRootInfo?.logDirectoryRestartRequired === true;
      return (
          <section className="gn-storage-panel" data-log-directory-settings="true">
              <div className="gn-storage-panel__body">
                  <div className="gn-storage-panel__header">
                      <DirectorySectionHeading
                          title={t('app.data_root.log_directory.title')}
                          description={t('app.data_root.log_directory.description')}
                      />
                      {!readOnly && (
                          <Button onClick={() => void handleOpenLogDirectory()}>
                              {t('app.data_root.action.open_current')}
                          </Button>
                      )}
                  </div>
                  <div className="gn-storage-path-editor">
                      <Input
                          readOnly
                          disabled={!editable}
                          value={selectedLogDirectoryPath}
                          placeholder={t('app.data_root.log_directory.placeholder')}
                          aria-label={t('app.data_root.log_directory.title')}
                      />
                      {!readOnly && (
                          <div className="gn-storage-path-editor__actions">
                              <Button
                                  icon={<FolderOpenOutlined />}
                                  disabled={!editable || directorySettingsApplying}
                                  onClick={() => void handleSelectLogDirectory()}
                              >
                                  {t('app.data_root.action.select')}
                              </Button>
                              <Button
                                  disabled={!editable || directorySettingsApplying}
                                  loading={logDirectoryApplying}
                                  onClick={() => void handleApplyLogDirectory(true)}
                              >
                                  {t('app.data_root.action.restore_default_directory')}
                              </Button>
                              <Button
                                  type="primary"
                                  disabled={!editable || directorySettingsApplying}
                                  loading={logDirectoryApplying}
                                  onClick={() => void handleApplyLogDirectory(false)}
                              >
                                  {t('app.data_root.log_directory.action.save')}
                              </Button>
                          </div>
                      )}
                  </div>
                  <DirectoryMetaGrid items={[
                      { label: t('app.data_root.log_directory.current_file'), value: dataRootInfo?.logFilePath || '-' },
                      { label: t('app.data_root.log_directory.default_directory'), value: dataRootInfo?.defaultLogDirectory || '-' },
                  ]} />
                  {managedByEnvironment ? (
                      <Alert type="warning" showIcon message={t('app.data_root.log_directory.environment_hint')} />
                  ) : restartRequired ? (
                      <Alert type="info" showIcon message={t('app.data_root.log_directory.pending_restart')} />
                  ) : (
                      <DirectoryNote>{t('app.data_root.log_directory.restart_hint')}</DirectoryNote>
                  )}
              </div>
          </section>
      );
  };

  const renderDataDirectorySettings = (
      section: 'all' | 'application' | 'agent' | 'saved-queries' = 'all',
      readOnly = false,
  ) => {
      if (dataRootLoading) {
          return (
              <div style={{ padding: '28px 0', textAlign: 'center' }}>
                  <Spin />
              </div>
          );
      }
      return (
          <div
              style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: '12px 0' }}
              data-data-directory-layout="true"
          >
              {(section === 'all' || section === 'application') && (
              <DataDirectoryPage testId="application">
                  <section
                      className="gn-storage-panel gn-storage-panel--current"
                      data-data-directory-section="application"
                  >
                      <div className="gn-storage-panel__body">
                          <DirectorySectionHeading
                              title={t('app.data_root.current_location')}
                              description={t('app.data_root.application.current_description')}
                          />
                          <DirectoryPathDisplay
                              label={t('app.data_root.current_directory')}
                              path={dataRootInfo?.path || ''}
                              action={!readOnly ? (
                                  <Button onClick={() => void handleOpenDataRoot()}>
                                      {t('app.data_root.action.open_current')}
                                  </Button>
                              ) : undefined}
                          />
                          <div>
                              <div className="gn-storage-field-label">{t('app.data_root.application.stores')}</div>
                              <div className="gn-storage-tags">
                                  <span className="gn-storage-tag">{t('app.data_root.application.content.connections')}</span>
                                  <span className="gn-storage-tag">{t('app.data_root.application.content.ai_config')}</span>
                                  <span className="gn-storage-tag">{t('app.data_root.application.content.drivers')}</span>
                              </div>
                          </div>
                          <DirectoryMetaGrid items={[
                              { label: t('app.data_root.default_directory'), value: dataRootInfo?.defaultPath || '-' },
                              { label: t('app.data_root.driver_directory'), value: dataRootInfo?.driverPath || '-' },
                          ]} />
                      </div>
                  </section>

                  {!readOnly && (
                      <section className="gn-storage-panel">
                          <div className="gn-storage-panel__body">
                              <DirectorySectionHeading
                                  title={t('app.data_root.change_location')}
                                  description={t('app.data_root.change_location_description')}
                              />
                              <div className="gn-storage-path-editor">
                                  <Input
                                      readOnly
                                      value={selectedDataRootPath}
                                      placeholder={t('app.data_root.placeholder.select_new_directory')}
                                      aria-label={t('app.data_root.switch_target')}
                                  />
                                  <div className="gn-storage-path-editor__actions">
                                      <Button
                                          icon={<FolderOpenOutlined />}
                                          disabled={directorySettingsApplying}
                                          onClick={() => void handleSelectDataRoot()}
                                      >
                                          {t('app.data_root.action.select')}
                                      </Button>
                                      <Button
                                          disabled={directorySettingsApplying}
                                          loading={dataRootApplying}
                                          onClick={() => void handleApplyDataRoot(false, true)}
                                      >
                                          {t('app.data_root.action.restore_default_directory')}
                                      </Button>
                                  </div>
                              </div>
                              <div className="gn-storage-choice-grid">
                                  <DirectoryChoice
                                      title={t('app.data_root.action.switch_now')}
                                      description={t('app.data_root.switch_only_hint')}
                                      action={(
                                          <Button
                                              disabled={directorySettingsApplying}
                                              loading={dataRootApplying}
                                              onClick={() => void handleApplyDataRoot(false)}
                                          >
                                              {t('app.data_root.action.switch_now')}
                                          </Button>
                                      )}
                                  />
                                  <DirectoryChoice
                                      recommended
                                      badge={t('app.data_root.recommended')}
                                      title={t('app.data_root.action.migrate_now')}
                                      description={t('app.data_root.migrate_hint')}
                                      action={(
                                          <Button
                                              type="primary"
                                              disabled={directorySettingsApplying}
                                              loading={dataRootApplying}
                                              onClick={() => void handleApplyDataRoot(true)}
                                          >
                                              {t('app.data_root.action.migrate_now')}
                                          </Button>
                                      )}
                                  />
                              </div>
                              <DirectoryNote>{t('app.data_root.restart_hint')}</DirectoryNote>
                          </div>
                      </section>
                  )}

                  {renderLogDirectorySettings(readOnly)}
              </DataDirectoryPage>
              )}

              {(section === 'all' || section === 'agent') && <AgentDataSettingsPanel
                  readOnly={readOnly}
              />}

              {(section === 'all' || section === 'saved-queries') && renderSavedQueryDirectorySettings(readOnly)}
          </div>
      );
  };


  const {
      handleCloseLogPanel: handleCloseAppLogPanel,
      handleLogResizeStart,
      isLogPanelOpen,
      logGhostRef,
      logPanelHeight,
  } = useAppLogPanelResize();
  const handleToggleLogPanel = useCallback(() => {
      window.dispatchEvent(new CustomEvent('gonavi:show-sql-execution-log', { detail: { mode: 'open' } }));
  }, []);
  const handleCloseLogPanel = useCallback(() => {
      handleCloseAppLogPanel();
  }, [handleCloseAppLogPanel]);

  const openCreateConnection = useCallback((targetTagId?: string) => {
      const normalizedTargetTagId = String(targetTagId || '').trim();
      pendingConnectionTagIdRef.current = normalizedTargetTagId || null;
      setSecurityUpdateRepairSource(null);
      setEditingConnection(null);
      setIsConnectionModalMounted(true);
      setIsModalOpen(true);
  }, []);
  const handleCreateConnection = useCallback(() => openCreateConnection(), [openCreateConnection]);
  const handleCreateConnectionInGroup = useCallback(
      (targetTagId: string) => openCreateConnection(targetTagId),
      [openCreateConnection],
  );

  const handleEditConnection = useCallback((conn: SavedConnection) => {
      pendingConnectionTagIdRef.current = null;
      setSecurityUpdateRepairSource(null);
      setIsConnectionModalMounted(true);
      void (async () => {
          const backendApp = (window as any).go?.app?.App;
          let nextConnection = conn;
          if (typeof backendApp?.GetEditableSavedConnection === 'function') {
              try {
                  const editableConnection = await backendApp.GetEditableSavedConnection(conn.id);
                  if (editableConnection) {
                      nextConnection = editableConnection;
                  }
              } catch (error: any) {
                  const errorMessage = error?.message;
                  const detail = (
                      typeof errorMessage === 'string'
                          ? errorMessage
                          : (
                              typeof errorMessage === 'number'
                              || typeof errorMessage === 'boolean'
                                  ? String(errorMessage)
                                  : String(error ?? '')
                          )
                  ).trim();
                  void message.warning(
                      detail
                          ? t('app.connection.message.editable_load_failed_with_detail', { detail })
                          : t('app.connection.message.editable_load_failed')
                  );
              }
          }
          setEditingConnection(nextConnection);
          setIsModalOpen(true);
      })();
  }, [t]);

  useEffect(() => {
      if (connectionModalWarmupDoneRef.current) {
          return;
      }
      connectionModalWarmupDoneRef.current = true;
      const warmup = () => setIsConnectionModalMounted(true);
      if (typeof window === 'undefined') {
          warmup();
          return;
      }
      if (typeof window.requestIdleCallback === 'function') {
          const idleId = window.requestIdleCallback(() => warmup(), { timeout: 1200 });
          return () => window.cancelIdleCallback?.(idleId);
      }
      const timerId = window.setTimeout(warmup, 300);
      return () => window.clearTimeout(timerId);
  }, []);

  const handleConnectionSaved = useCallback(async (savedConnection: SavedConnection) => {
      const targetTagId = pendingConnectionTagIdRef.current;
      pendingConnectionTagIdRef.current = null;
      if (targetTagId && savedConnection?.id) {
          moveConnectionToTag(savedConnection.id, targetTagId);
      }

      if (!shouldRetrySecurityUpdateAfterRepairSave(securityUpdateRepairSource)) {
          return;
      }

      const backendApp = (window as any).go?.app?.App;
      if (securityUpdateStatus.migrationId) {
          if (typeof backendApp?.RetrySecurityUpdateCurrentRound !== 'function') {
              return;
          }

          const rawStatus = await backendApp.RetrySecurityUpdateCurrentRound({
              migrationId: securityUpdateStatus.migrationId,
          });
          const nextStatus = await finalizeSecurityUpdateStatus({
              backend: backendApp,
              replaceConnections,
              replaceGlobalProxy,
              t,
          }, normalizeSecurityUpdateStatus(rawStatus));

          applySecurityUpdateStatus(nextStatus, {
              openSettings: false,
          });

          if (nextStatus.overallStatus === 'completed') {
              setSecurityUpdateHasLegacySensitiveItems(false);
              setSecurityUpdateRawPayload(null);
          }
          return;
      }

      if (!securityUpdateRawPayload || !savedConnection?.id) {
          return;
      }

      const nextRawPayload = stripLegacyPersistedConnectionById(securityUpdateRawPayload, savedConnection.id);
      if (!nextRawPayload || nextRawPayload === securityUpdateRawPayload) {
          return;
      }

      window.localStorage.setItem(LEGACY_PERSIST_KEY, nextRawPayload);

      const rawStatus = typeof backendApp?.GetSecurityUpdateStatus === 'function'
          ? await backendApp.GetSecurityUpdateStatus()
          : securityUpdateStatus;
      const nextStatus = mergeSecurityUpdateStatusWithLegacySource(rawStatus, nextRawPayload, {
          previousStatus: securityUpdateStatus,
          t,
      });
      const nextHasLegacySensitiveItems = hasLegacyMigratableSensitiveItems(nextRawPayload);

      setSecurityUpdateRawPayload(nextRawPayload);
      setSecurityUpdateHasLegacySensitiveItems(nextHasLegacySensitiveItems);
      applySecurityUpdateStatus(nextStatus, {
          openSettings: false,
      });
  }, [
      applySecurityUpdateStatus,
      normalizeSecurityUpdateStatus,
      moveConnectionToTag,
      replaceConnections,
      replaceGlobalProxy,
      securityUpdateRawPayload,
      securityUpdateRepairSource,
      securityUpdateStatus,
      securityUpdateStatus.migrationId,
      t,
  ]);

  const handleCloseModal = () => {
      const reopenSecurityUpdateDetails = shouldReopenSecurityUpdateDetails(securityUpdateRepairSource);
      pendingConnectionTagIdRef.current = null;
      setIsModalOpen(false);
      setEditingConnection(null);
      setSecurityUpdateRepairSource(null);
      if (reopenSecurityUpdateDetails) {
          openSecurityUpdateSettings();
      }
  };
  const handleOpenConnectionHealth = useCallback((connectionIds: string[] = []) => {
      setConnectionHealthTargetIds(Array.from(new Set(connectionIds.filter((id) => String(id || '').trim() !== ''))));
      setToolCenterBackGroupKey('config');
      setActiveSettingsCenterGroupKey('config');
      setActiveSettingsCenterPane({ key: 'connection-health', group: 'config' });
      openSettingsCenterWorkbenchTab();
  }, [openSettingsCenterWorkbenchTab]);

  const handleOpenDriverManagerFromConnection = useCallback(() => {
      pendingConnectionTagIdRef.current = null;
      setIsModalOpen(false);
      setEditingConnection(null);
      setToolCenterBackGroupKey(null);
      handleOpenDriverManagerWorkbench();
  }, [handleOpenDriverManagerWorkbench]);

  const handleOpenGlobalProxySettings = useCallback(() => {
      setSecurityUpdateRepairSource(null);
      setIsProxyModalOpen(true);
  }, []);

  useEffect(() => {
      const openGlobalProxySettings = () => handleOpenGlobalProxySettings();
      window.addEventListener(OPEN_GLOBAL_PROXY_SETTINGS_EVENT, openGlobalProxySettings);
      return () => window.removeEventListener(OPEN_GLOBAL_PROXY_SETTINGS_EVENT, openGlobalProxySettings);
  }, [handleOpenGlobalProxySettings]);

  const handleCloseGlobalProxySettings = useCallback(() => {
      const reopenSecurityUpdateDetails = shouldReopenSecurityUpdateDetails(securityUpdateRepairSource);
      setIsProxyModalOpen(false);
      setSecurityUpdateRepairSource(null);
      if (reopenSecurityUpdateDetails) {
          openSecurityUpdateSettings();
      }
  }, [openSecurityUpdateSettings, securityUpdateRepairSource]);

  /** 从聊天面板等入口打开 AI 配置：走设置中心，不再弹独立 AISettingsModal */
  const handleOpenAISettings = useCallback((providerId?: string) => withAISettingsLeaveGuard(aiSettingsLeaveGuardRef.current, () => {
      setSecurityUpdateRepairSource(null);
      setFocusedAIProviderId(providerId);
      setAiSettingsSection('providers');
      setAiSettingsProviderView('workspace');
      setActiveSettingsCenterGroupKey('services');
      setActiveSettingsCenterPane({ key: 'ai', group: 'services' });
      openSettingsCenterWorkbenchTab();
  }), []);

  const handleAIPanelRenderError = useCallback((error: Error, errorInfo: React.ErrorInfo) => {
      try {
          (window as any).__gonaviLastAIPanelRenderError = {
              message: error?.message || '',
              stack: error?.stack || '',
              componentStack: errorInfo?.componentStack || '',
          };
      } catch {
          // ignore debug capture failures
      }
      console.error('AIChatPanel render error:', error, errorInfo);
  }, []);

  const handleRetryAIPanelRender = useCallback(() => {
      setAiPanelRenderNonce((current) => current + 1);
  }, []);

  const handleRetryAISettingsRender = useCallback(() => {
      setAiSettingsRenderNonce((current) => current + 1);
  }, []);

  const handleWebLogout = useCallback(async () => {
      try {
          await fetch('/__gonavi/auth/logout', {
              method: 'POST',
              credentials: 'same-origin',
          });
      } catch (_) {
          // ignore
      }
      window.location.assign('/login');
  }, []);

  const handleTitleBarWindowToggle = async (options?: { allowMacNativeFullscreen?: boolean }) => {
      const allowMacNativeFullscreen = options?.allowMacNativeFullscreen === true;
      const syncWindowStateFromRuntime = async () => {
          try {
              const [isFullscreen, isMaximised] = await Promise.all([
                  safeWindowRuntimeCall(() => WindowIsFullscreen(), false),
                  safeWindowRuntimeCall(() => WindowIsMaximised(), false),
              ]);
              useStore.getState().setWindowState(isFullscreen ? 'fullscreen' : (isMaximised ? 'maximized' : 'normal'));
          } catch {
              // ignore
          }
      };

      try {
          void emitWindowDiagnostic('action:titlebar-toggle:before');
          if (await WindowIsFullscreen()) {
              await WindowUnfullscreen();
              await syncWindowStateFromRuntime();
              void emitWindowDiagnostic('action:titlebar-toggle:after-unfullscreen');
              return;
          }
          if (allowMacNativeFullscreen && useNativeMacWindowControls && isMacRuntime) {
              await WindowFullscreen();
              await syncWindowStateFromRuntime();
              void emitWindowDiagnostic('action:titlebar-toggle:after-fullscreen');
              return;
          }
          const isMaximised = await safeWindowRuntimeCall(() => WindowIsMaximised(), false);
          if (isMaximised) {
              WindowUnmaximise();
          } else {
              // Preserve the latest normal bounds before the native maximise transition
              // makes WindowGetSize report the maximised surface.
              await captureMainWindowStateRef.current();
              WindowMaximise();
          }
          await waitForWindowCondition({
              read: async () => (await WindowIsMaximised()) !== isMaximised,
              wait: (delayMs) => new Promise((resolve) => window.setTimeout(resolve, delayMs)),
              maxChecks: 16,
              intervalMs: 40,
          });
          await syncWindowStateFromRuntime();
          void emitWindowDiagnostic('action:titlebar-toggle:after-set-maximise-state');
      } catch (_) {
          // ignore
      }
  };

  const handleTitleBarDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest('[data-no-titlebar-toggle="true"]')) {
          return;
      }
      void handleTitleBarWindowToggle({ allowMacNativeFullscreen: false });
  };

  // handleManualResetWindowZoom 由 resetWindowZoom 快捷键（默认 Ctrl+Shift+0）触发，
  // 作为自动路径失败时的兜底入口。
  //
  // 优先调 backend App.ResetWebViewZoom 走 WebView2 zoom reset（零动画零感知）；
  // 失败时回退到 Unmaximise→Maximise toggle —— 用户主动按了快捷键，预期看见动画。
  const handleManualResetWindowZoom = React.useCallback(async () => {
      if (!isWindowsPlatform()) {
          message.info(t('app.window_zoom.message.windows_only'));
          return;
      }
      try {
          const res = await (window as any).go?.app?.App?.ResetWebViewZoom?.();
          if (res?.success) {
              window.dispatchEvent(new Event('resize'));
              message.success(t('app.window_zoom.message.reset_success'));
              return;
          }
          console.warn('ResetWebViewZoom backend reported failure, falling back to maximise toggle:', res?.message);
      } catch (e) {
          console.warn('ResetWebViewZoom backend unavailable, falling back to maximise toggle', e);
      }
      try {
          const isFullscreen = await safeWindowRuntimeCall(() => WindowIsFullscreen(), false);
          if (isFullscreen) {
              message.info(t('app.window_zoom.message.fullscreen_exit_first'));
              return;
          }
          const isMaximised = await safeWindowRuntimeCall(() => WindowIsMaximised(), false);
          if (isMaximised) {
              WindowUnmaximise();
              await new Promise((resolve) => window.setTimeout(resolve, 96));
              WindowMaximise();
              await new Promise((resolve) => window.setTimeout(resolve, 96));
          } else {
              const size = await safeWindowRuntimeCall(() => WindowGetSize(), null);
              const width = Math.trunc(Number(size?.w) || 0);
              const height = Math.trunc(Number(size?.h) || 0);
              if (width > 0 && height > 0) {
                  WindowSetSize(getWindowsScaleFixNudgedWidth(width), height);
                  await new Promise((resolve) => window.setTimeout(resolve, 28));
                  WindowSetSize(width, height);
              }
          }
          window.dispatchEvent(new Event('resize'));
          message.success(t('app.window_zoom.message.reset_success_fallback'));
      } catch (e) {
          console.warn('Failed to reset window zoom', e);
          message.error(t('app.window_zoom.message.reset_failed'));
      }
  }, [t]);

  const {
      handleSidebarMouseDown,
      sidebarResizeHandleWidth,
      siderRef,
  } = useAppSidebarResize({
      effectiveUiScale,
      setSidebarWidth,
      sidebarWidth,
      sidebarCollapsed: isSidebarCollapsed,
  });

  // Apply the document theme before the first paint. V2 structural styles are
  // scoped by data-ui-version; a passive effect leaves one unstyled titlebar
  // frame where the centered context and its marker collapse into the legacy
  // flex layout.
  useLayoutEffect(() => {
    document.body.style.backgroundColor = 'transparent';
    document.body.style.color = darkMode ? '#ffffff' : '#000000';
    document.documentElement.style.colorScheme = darkMode ? 'dark' : 'light';
    document.body.setAttribute('data-theme', darkMode ? 'dark' : 'light');
    document.body.setAttribute('data-ui-version', 'v2');
    document.body.setAttribute('data-platform', documentPlatform);
    document.body.style.fontSize = `${effectiveFontSize}px`;
    document.body.style.setProperty('--gn-font-sans', resolvedUiFontFamily);
    document.body.style.setProperty('--gn-font-mono', resolvedMonoFontFamily);
    document.documentElement.style.setProperty('--gonavi-font-size', `${effectiveFontSize}px`);
    document.documentElement.style.setProperty('--gn-font-sans', resolvedUiFontFamily);
    document.documentElement.style.setProperty('--gn-font-mono', resolvedMonoFontFamily);
    document.documentElement.style.setProperty('--gn-ui-scale', `${effectiveUiScale}`);
    document.documentElement.style.setProperty('--gn-window-opacity', `${effectiveOpacity}`);
    document.documentElement.style.setProperty('--gn-window-opacity-percent', `${effectiveOpacity * 100}%`);
    document.documentElement.style.setProperty('--gn-font-size', `${effectiveFontSize}px`);
    document.documentElement.style.setProperty('--gn-font-size-sm', `${Math.max(10, Math.round(effectiveFontSize * 0.86))}px`);
    document.documentElement.style.setProperty('--gn-font-size-xs', `${Math.max(9, Math.round(effectiveFontSize * 0.76))}px`);
    document.documentElement.style.setProperty('--gn-font-size-mono', `${Math.max(10, Math.round(effectiveDataTableFontSize * 0.92))}px`);
    document.documentElement.style.setProperty('--gn-data-table-font-size', `${effectiveDataTableFontSize}px`);
    document.documentElement.style.setProperty('--gn-sidebar-tree-font-size', `${effectiveSidebarTreeFontSize}px`);
    document.documentElement.style.setProperty('--gn-sidebar-rail-scale', `${effectiveSidebarRailScale}`);
    document.documentElement.style.setProperty('--gn-control-height', `${tokenControlHeight}px`);
    document.documentElement.style.setProperty('--gn-control-height-sm', `${tokenControlHeightSM}px`);
  }, [
    darkMode,
    effectiveDataTableFontSize,
    effectiveFontSize,
    effectiveOpacity,
    resolvedMonoFontFamily,
    resolvedUiFontFamily,
    documentPlatform,
    effectiveSidebarRailScale,
    effectiveSidebarTreeFontSize,
    effectiveUiScale,
    tokenControlHeight,
    tokenControlHeightSM,
  ]);

  useEffect(() => {
      const handleOpenShortcutSettingsEvent = () => {
          handleOpenToolCenterPane('workspace', 'shortcut-settings');
      };
      window.addEventListener('gonavi:open-shortcut-settings', handleOpenShortcutSettingsEvent as EventListener);
      return () => {
          window.removeEventListener('gonavi:open-shortcut-settings', handleOpenShortcutSettingsEvent as EventListener);
      };
  }, [handleOpenToolCenterPane]);

  useEffect(() => {
      const handleOpenSnippetSettingsEvent = () => {
          handleOpenToolCenterPane('workspace', 'snippet-settings');
      };
      window.addEventListener('gonavi:open-snippet-settings', handleOpenSnippetSettingsEvent as EventListener);
      return () => {
          window.removeEventListener('gonavi:open-snippet-settings', handleOpenSnippetSettingsEvent as EventListener);
      };
  }, [handleOpenToolCenterPane]);

  useEffect(() => {
      const handleOpenTabDisplaySettingsEvent = () => withAISettingsLeaveGuard(aiSettingsLeaveGuardRef.current, () => {
          closeSettingsCenterWorkbenchTab();
          setThemeModalSection('workspace');
          setIsThemeModalOpen(true);
          setTabDisplaySettingsFocusRequest((current) => current + 1);
      });
      window.addEventListener('gonavi:open-tab-display-settings', handleOpenTabDisplaySettingsEvent as EventListener);
      return () => {
          window.removeEventListener('gonavi:open-tab-display-settings', handleOpenTabDisplaySettingsEvent as EventListener);
      };
  }, []);

  useEffect(() => {
      const handleCreateQueryTabEvent = () => {
          handleNewQuery();
      };
      window.addEventListener('gonavi:create-query-tab', handleCreateQueryTabEvent as EventListener);
      return () => {
          window.removeEventListener('gonavi:create-query-tab', handleCreateQueryTabEvent as EventListener);
      };
  }, [handleNewQuery]);

  useEffect(() => {
      if (!isMacRuntime || !useNativeMacWindowControls) {
          return;
      }

      const handleMacNativeEscapeCapture = (event: KeyboardEvent) => {
          if (!shouldSuppressMacNativeEscapeExit(
              isMacRuntime,
              useNativeMacWindowControls,
              useStore.getState().windowState === 'fullscreen',
              event,
              { isEditableTarget: isEditableElement(event.target) },
          )) {
              return;
          }
          event.preventDefault();
          event.stopPropagation();
      };

      window.addEventListener('keydown', handleMacNativeEscapeCapture, true);
      return () => {
          window.removeEventListener('keydown', handleMacNativeEscapeCapture, true);
      };
  }, [isMacRuntime, useNativeMacWindowControls]);

  useEffect(() => {
      const handleExplicitCloseShortcutScope = (event: Event) => {
          const nextScope = resolveCloseShortcutScopeFromTarget(event.target);
          if (nextScope) {
              closeShortcutScopeRef.current = nextScope;
          }
      };

      document.addEventListener('pointerdown', handleExplicitCloseShortcutScope, true);
      document.addEventListener('focusin', handleExplicitCloseShortcutScope, true);
      return () => {
          document.removeEventListener('pointerdown', handleExplicitCloseShortcutScope, true);
          document.removeEventListener('focusin', handleExplicitCloseShortcutScope, true);
      };
  }, []);

  useEffect(() => {
      const handleGlobalShortcut = (event: KeyboardEvent) => {
          // The recorder owns every key while it is active, including Cmd/Ctrl+W.
          if (capturingShortcutAction) {
              return;
          }

          const closeDecision = resolveCloseShortcutKeydownDecision({
              event,
              shortcutOptions,
              platform: activeShortcutPlatform,
              capturingShortcut: false,
              imeComposing: isImeComposingKeyEvent(event),
              interactionBlocked: isCloseShortcutInteractionBlocked(event.target, document),
          });
          if (closeDecision.preventDefault) {
              event.preventDefault();
          }
          if (closeDecision.kind === 'consume') {
              event.stopImmediatePropagation();
              return;
          }
          if (closeDecision.kind === 'close') {
              event.stopImmediatePropagation();
              if (closeShortcutScopeRef.current === 'workspace') {
                  dispatchCloseActiveWorkspaceTab();
              } else if (closeShortcutScopeRef.current === 'result') {
                  const currentState = useStore.getState();
                  const targetTabId = resolveDockedActiveTabId(
                      currentState.tabs,
                      currentState.activeTabId,
                      currentState.detachedWorkbenchWindows,
                  );
                  const outcome = dispatchCloseActiveResultTab(targetTabId);
                  if (outcome === 'hidden') {
                      closeShortcutScopeRef.current = 'blocked';
                  }
              }
              return;
          }

          const delegatedAction = closeDecision.kind === 'delegate'
              ? closeDecision.ownerAction
              : null;
          const matchedAction = SHORTCUT_ACTION_ORDER.find((action) => {
              if (action === 'closeActiveTab') {
                  return false;
              }
              if (delegatedAction && action !== delegatedAction) {
                  return false;
              }
              const meta = SHORTCUT_ACTION_META[action];
              if (meta.scope && meta.scope !== 'global') {
                  return false;
              }
              const binding = resolveShortcutBinding(shortcutOptions, action, activeShortcutPlatform);
              if (!binding?.enabled) {
                  return false;
              }
              if (isEditableElement(event.target) && !meta.allowInEditable) {
                  return false;
              }
              return isShortcutMatch(event, binding.combo);
          });

          if (!matchedAction) {
              return;
          }

          if (event.repeat && matchedAction === 'toggleAIPanel') {
              event.preventDefault();
              event.stopImmediatePropagation();
              return;
          }

          event.preventDefault();
          event.stopPropagation();

          switch (matchedAction) {
              case 'runQuery':
                  window.dispatchEvent(new CustomEvent('gonavi:run-active-query'));
                  break;
              case 'focusSidebarSearch':
                  handleFocusSidebarSearch();
                  break;
              case 'newQueryTab':
                  handleNewQuery();
                  break;
              case 'switchToNextTab':
                  switchActiveTabByOffset(1);
                  break;
              case 'switchToPreviousTab':
                  switchActiveTabByOffset(-1);
                  break;
              case 'newConnection':
                  handleCreateConnection();
                  break;
              case 'toggleAIPanel':
                  handleToggleOrFocusAIPanel();
                  break;
              case 'toggleLogPanel':
                  handleToggleLogPanel();
                  break;
              case 'toggleTheme':
                  selectPresetTheme(themeMode === 'dark' ? 'light' : 'dark');
                  break;
              case 'openShortcutManager':
                  handleOpenToolCenterPane('workspace', 'shortcut-settings');
                  break;
              case 'toggleMacFullscreen':
                  if (isMacRuntime && useNativeMacWindowControls) {
                      void handleTitleBarWindowToggle({ allowMacNativeFullscreen: true });
                  }
                  break;
              case 'resetWindowZoom':
                  void handleManualResetWindowZoom();
                  break;
          }
      };

      window.addEventListener('keydown', handleGlobalShortcut, true);
      return () => {
          window.removeEventListener('keydown', handleGlobalShortcut, true);
      };
  }, [activeShortcutPlatform, capturingShortcutAction, handleCreateConnection, handleFocusSidebarSearch, handleManualResetWindowZoom, handleNewQuery, handleOpenToolCenterPane, handleTitleBarWindowToggle, handleToggleLogPanel, handleToggleOrFocusAIPanel, isMacRuntime, selectPresetTheme, shortcutOptions, switchActiveTabByOffset, themeMode, useNativeMacWindowControls]);

  useEffect(() => {
      if (!capturingShortcutAction) {
          return;
      }

      const handleShortcutCapture = (event: KeyboardEvent) => {
          event.preventDefault();
          event.stopPropagation();

          if (event.key === 'Escape') {
              setCapturingShortcutAction(null);
              return;
          }

          const combo = eventToShortcut(event);
          if (!combo) {
              return;
          }

          const normalizedCombo = normalizeShortcutCombo(combo);
          if (!canRecordShortcutForAction(capturingShortcutAction, normalizedCombo)) {
              const meta = SHORTCUT_ACTION_META[capturingShortcutAction];
              void message.warning(meta.scope === 'aiComposer'
                  ? t('app.shortcuts.message.ai_send_limit')
                  : t('app.shortcuts.message.modifier_required'));
              return;
          }
          const conflictAction = SHORTCUT_ACTION_ORDER.find((action) => {
              if (action === capturingShortcutAction) {
                  return false;
              }
              const binding = resolveShortcutBinding(shortcutOptions, action, activeShortcutPlatform);
              if (!binding?.enabled) {
                  return false;
              }
              return normalizeShortcutCombo(binding.combo) === normalizedCombo;
          });
          if (conflictAction) {
              void message.warning(t('app.shortcuts.message.conflict', { action: SHORTCUT_ACTION_META[conflictAction].label }));
              return;
          }

          const reservedConflicts = findReservedConflictsForAction(
              capturingShortcutAction,
              normalizedCombo,
              activeShortcutPlatform,
          );
          if (reservedConflicts.length > 0) {
              const { hasMonaco, hasOther, monacoLabels, otherLabels, otherContexts } = splitConflictsByContext(reservedConflicts);
              if (hasMonaco) {
                  void message.info(t('app.shortcuts.message.reserved_conflict_info', { labels: monacoLabels }), 4);
              }
              if (hasOther) {
                  void message.warning(t('app.shortcuts.message.reserved_conflict_warning', { contexts: otherContexts, labels: otherLabels }), 4);
              }
          }

          updateShortcut(capturingShortcutAction, { combo: normalizedCombo, enabled: true }, activeShortcutPlatform);
          setCapturingShortcutAction(null);
      };

      window.addEventListener('keydown', handleShortcutCapture, true);
      return () => {
          window.removeEventListener('keydown', handleShortcutCapture, true);
      };
  }, [activeShortcutPlatform, capturingShortcutAction, shortcutOptions, t, updateShortcut]);

  const linuxResizeHandleStyleBase = {
      position: 'fixed',
      zIndex: 12000,
      background: 'transparent',
      WebkitAppRegion: 'drag',
      '--wails-draggable': 'drag',
      userSelect: 'none'
  } as any;

  const showLinuxResizeHandles = isLinuxRuntime;
  const resizeGuideColor = 'var(--gn-accent, #16a34a)';
  const v2AntPrimaryColor = customThemeAntTokens.primary ?? (darkMode ? '#22c55e' : '#16a34a');
  const v2AntPrimaryContrastColor = customThemeAntTokens.primaryContrast ?? '#ffffff';
  const v2AntPrimaryHoverColor = customThemeAntTokens.primaryHover ?? (darkMode ? '#4ade80' : '#15803d');
  const v2AntPrimaryActiveColor = customThemeAntTokens.primaryActive ?? (darkMode ? '#16a34a' : '#166534');
  const v2AntPrimaryBgColor = customThemeAntTokens.primaryBg ?? (darkMode ? 'rgba(34, 197, 94, 0.20)' : '#dcfce7');
  const v2AntPrimaryBgHoverColor = customThemeAntTokens.primaryBgHover ?? (darkMode ? 'rgba(34, 197, 94, 0.28)' : '#bbf7d0');
  const v2AntPrimaryBorderColor = customThemeAntTokens.primaryBorder ?? (darkMode ? 'rgba(34, 197, 94, 0.42)' : '#86efac');
  const v2AntPrimaryBorderHoverColor = customThemeAntTokens.primaryBorderHover ?? (darkMode ? 'rgba(74, 222, 128, 0.58)' : '#4ade80');
  const v2AntControlActiveBg = customThemeAntTokens.controlActiveBg ?? (darkMode ? 'rgba(34, 197, 94, 0.16)' : 'rgba(34, 197, 94, 0.10)');
  const v2AntControlActiveHoverBg = customThemeAntTokens.controlActiveHoverBg ?? (darkMode ? 'rgba(34, 197, 94, 0.24)' : 'rgba(34, 197, 94, 0.16)');
  const v2AntControlOutline = customThemeAntTokens.controlOutline ?? (darkMode ? 'rgba(34, 197, 94, 0.42)' : 'rgba(22, 163, 74, 0.22)');
  const v2AntBgContainer = customThemeAntTokens.bgContainer;
  const v2AntBgElevated = customThemeAntTokens.bgElevated;
  const v2AntFillAlter = customThemeAntTokens.fillAlter;
  const v2AntTextPrimary = customThemeAntTokens.textPrimary;
  const v2AntTextSecondary = customThemeAntTokens.textSecondary;
  const v2AntBorder = customThemeAntTokens.border;
  const v2AntRowHoverBg = customThemeAntTokens.rowHoverBg;
  const v2AntInfoColor = customThemeAntTokens.info ?? v2AntPrimaryColor;
  const antdTheme = useMemo(() => ({
      algorithm: darkMode ? theme.darkAlgorithm : theme.defaultAlgorithm,
      token: {
          fontSize: tokenFontSize,
          fontSizeSM: tokenFontSizeSM,
          fontSizeLG: tokenFontSizeLG,
          fontFamily: resolvedUiFontFamily,
          fontFamilyCode: resolvedMonoFontFamily,
          zIndexPopupBase: APP_OVERLAY_Z_INDEX_BASE,
          controlHeight: tokenControlHeight,
          controlHeightSM: tokenControlHeightSM,
          controlHeightLG: tokenControlHeightLG,
          colorBgLayout: 'transparent',
          colorBgContainer: v2AntBgContainer ?? (darkMode
              ? `rgba(29, 29, 29, ${effectiveOpacity})`
              : `rgba(255, 255, 255, ${effectiveOpacity})`),
          colorBgElevated: v2AntBgElevated ?? (darkMode
              ? '#1f1f1f'
              : '#ffffff'),
          colorFillAlter: v2AntFillAlter ?? (darkMode
              ? `rgba(38, 38, 38, ${effectiveOpacity})`
              : `rgba(250, 250, 250, ${effectiveOpacity})`),
          ...(v2AntTextPrimary ? { colorText: v2AntTextPrimary } : {}),
          ...(v2AntTextSecondary ? { colorTextSecondary: v2AntTextSecondary } : {}),
          ...(v2AntBorder ? {
              colorBorder: v2AntBorder,
              colorBorderSecondary: v2AntBorder,
          } : {}),
          colorPrimary: v2AntPrimaryColor,
          colorTextLightSolid: v2AntPrimaryContrastColor,
          colorPrimaryHover: v2AntPrimaryHoverColor,
          colorPrimaryActive: v2AntPrimaryActiveColor,
          colorInfo: v2AntInfoColor,
          colorLink: v2AntPrimaryColor,
          colorLinkHover: v2AntPrimaryHoverColor,
          colorLinkActive: v2AntPrimaryActiveColor,
          colorPrimaryBg: v2AntPrimaryBgColor,
          colorPrimaryBgHover: v2AntPrimaryBgHoverColor,
          colorPrimaryBorder: v2AntPrimaryBorderColor,
          colorPrimaryBorderHover: v2AntPrimaryBorderHoverColor,
          controlItemBgActive: v2AntControlActiveBg,
          controlItemBgActiveHover: v2AntControlActiveHoverBg,
          controlOutline: v2AntControlOutline,
      },
      components: {
          Layout: {
              bodyBg: 'transparent',
              headerBg: 'transparent',
              siderBg: 'transparent',
              triggerBg: 'transparent'
          },
          Table: {
              headerBg: 'transparent',
              rowHoverBg: v2AntRowHoverBg
                  ?? (darkMode ? 'rgba(255, 255, 255, 0.08)' : 'rgba(0, 0, 0, 0.02)'),
          },
          Tabs: {
              cardBg: 'transparent',
              itemActiveColor: v2AntPrimaryHoverColor,
              itemHoverColor: v2AntPrimaryHoverColor,
              itemSelectedColor: v2AntPrimaryColor,
              inkBarColor: v2AntPrimaryColor,
          }
      }
  }), [
      darkMode,
      effectiveOpacity,
      v2AntBgContainer,
      v2AntBgElevated,
      v2AntBorder,
      v2AntControlActiveBg,
      v2AntControlActiveHoverBg,
      v2AntControlOutline,
      v2AntFillAlter,
      v2AntInfoColor,
      v2AntPrimaryActiveColor,
      v2AntPrimaryBgColor,
      v2AntPrimaryBgHoverColor,
      v2AntPrimaryBorderColor,
      v2AntPrimaryBorderHoverColor,
      v2AntPrimaryColor,
      v2AntPrimaryContrastColor,
      v2AntPrimaryHoverColor,
      v2AntRowHoverBg,
      v2AntTextPrimary,
      v2AntTextSecondary,
      tokenControlHeight,
      tokenControlHeightLG,
      tokenControlHeightSM,
      tokenFontSize,
      tokenFontSizeLG,
      tokenFontSizeSM,
      resolvedMonoFontFamily,
      resolvedUiFontFamily,
  ]);
  const filterFontOption = useCallback((input: string, option?: { value?: string; label?: React.ReactNode }) => (
      matchFontFamilyOption(input, {
          value: String(option?.value || ''),
          label: String(option?.label || ''),
      })
  ), []);
  const renderFontOptionLabel = useCallback((option: FontFamilyOption) => (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, lineHeight: 1.35 }}>
          <span>{option.label}</span>
          <span style={{ fontSize: 11, color: darkMode ? 'rgba(255,255,255,0.45)' : 'rgba(16,24,40,0.45)' }}>
              {option.value}
          </span>
      </div>
  ), [darkMode]);
  const showLinuxCJKFontBanner = Boolean(
      linuxCJKFontInstallHint &&
      hasLoadedInstalledFontsRef.current &&
      !isFontFamiliesLoading &&
      !fontFamiliesLoadError &&
      !isLinuxCJKFontBannerDismissed,
  );
  const sidebarMetadataFieldItems = useMemo(() => {
      const labelByField: Record<SidebarTableMetadataField, string> = {
          comment: t('sidebar.v2_table_group_menu.show_table_comments'),
          rows: t('sidebar.v2_table_group_menu.display_table_rows'),
          size: t('sidebar.v2_table_group_menu.display_table_size'),
          createdAt: t('sidebar.v2_table_group_menu.display_create_time'),
          updatedAt: t('sidebar.v2_table_group_menu.display_update_time'),
      };
      return sidebarTableMetadataFieldOrder.map((field) => ({
          field,
          label: labelByField[field],
      }));
  }, [sidebarTableMetadataFieldOrder, t]);
  const toggleSidebarMetadataFieldFromSettings = useCallback((field: SidebarTableMetadataField, selected: boolean) => {
      setQueryOptions({
          sidebarTableMetadataFields: setSidebarTableMetadataFieldSelected(
              sidebarTableMetadataFields,
              field,
              selected,
              sidebarTableMetadataFieldOrder,
          ),
      });
  }, [setQueryOptions, sidebarTableMetadataFieldOrder, sidebarTableMetadataFields]);
  const handleSidebarMetadataDragEnd = useCallback((event: DragEndEvent) => {
      const activeField = String(event.active.id || '') as SidebarTableMetadataField;
      const overField = String(event.over?.id || '') as SidebarTableMetadataField;
      if (!overField || activeField === overField) {
          return;
      }
      const currentOrder = sidebarMetadataFieldItems.map((item) => item.field);
      const activeIndex = currentOrder.indexOf(activeField);
      const overIndex = currentOrder.indexOf(overField);
      if (activeIndex < 0 || overIndex < 0) {
          return;
      }
      const nextOrder = arrayMove(currentOrder, activeIndex, overIndex);
      setQueryOptions({
          sidebarTableMetadataFieldOrder: nextOrder,
          sidebarTableMetadataFields: applySidebarTableMetadataFieldOrder(
              sidebarTableMetadataFields,
              nextOrder,
          ),
      });
  }, [setQueryOptions, sidebarMetadataFieldItems, sidebarTableMetadataFields]);
  const renderProxySettingsContent = useCallback(() => {
      const fieldLabelStyle: React.CSSProperties = {
          marginBottom: 4,
          fontSize: 12,
          color: darkMode ? 'rgba(255,255,255,0.55)' : 'rgba(16,24,40,0.58)',
      };
      const narrow = viewportWidth < 760;
      const proxyStatusColor = proxyDraft.enabled
          ? (proxyDraftValid ? (darkMode ? '#4ade80' : '#16a34a') : (darkMode ? '#fbbf24' : '#d97706'))
          : (darkMode ? 'rgba(148,163,184,0.85)' : 'rgba(71,85,105,0.72)');
      const proxyTestAlertType = proxyTestResult
          ? (!proxyTestResult.success ? 'error' : ((proxyTestResult.statusCode || 0) >= 400 ? 'warning' : 'success'))
          : 'info';


      return (
          <div className="gonavi-proxy-settings" style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '8px 0 4px', minHeight: 0 }}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 12,
                  flexWrap: 'wrap',
                  padding: '10px 12px',
                  borderRadius: 10,
                  border: `1px solid ${darkMode ? 'rgba(148,163,184,0.18)' : 'rgba(15,23,42,0.08)'}`,
                  background: darkMode ? 'rgba(15,23,42,0.35)' : 'rgba(248,250,252,0.9)',
                }}
              >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, flexWrap: 'wrap' }}>
                      <Switch
                          aria-label={t('app.proxy.section_title')}
                          checked={proxyDraft.enabled}
                          onChange={(checked) => setProxyDraft((current) => ({ ...current, enabled: checked }))}
                      />
                      <span style={{ fontSize: 13, fontWeight: 600, color: overlayTheme.titleText }}>
                          {t(proxyDraft.enabled ? 'app.proxy.switch.enabled' : 'app.proxy.switch.disabled')}
                      </span>
                      <span
                        title={proxyStatusDescription}
                        style={{
                          fontSize: 12,
                          fontWeight: 500,
                          color: proxyStatusColor,
                          padding: '2px 8px',
                          borderRadius: 999,
                          border: `1px solid ${proxyStatusColor}33`,
                          background: `${proxyStatusColor}14`,
                          whiteSpace: 'nowrap',
                        }}
                      >
                          {proxyStatusTitle}
                      </span>
                      {proxyDraftDirty ? (
                          <span style={{ ...utilityMutedTextStyle, fontSize: 12 }}>{t('app.proxy.unsaved_hint')}</span>
                      ) : null}
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                      {proxyPresetItems.map((preset) => (
                          <Button key={preset.key} size="small" onClick={() => applyProxyPreset(preset)}>
                              {preset.label}
                          </Button>
                      ))}
                  </div>
              </div>

              <div style={{ ...utilityPanelStyle, display: 'flex', flexDirection: 'column', gap: 14 }}>
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: narrow ? '1fr' : 'minmax(160px, 0.9fr) minmax(180px, 1.6fr) 110px',
                      gap: 10,
                      alignItems: 'end',
                    }}
                  >
                      <div>
                          <div style={fieldLabelStyle}>{t('app.proxy.type')}</div>
                          <Segmented
                              block
                              value={proxyDraft.type}
                              options={[
                                  { label: t('app.proxy.type_socks5'), value: 'socks5' },
                                  { label: t('app.proxy.type_http'), value: 'http' },
                              ]}
                              onChange={(value) => updateProxyDraftType(value as GlobalProxyConfig['type'])}
                          />
                      </div>
                      <div>
                          <div style={fieldLabelStyle}>{t('app.proxy.host')}</div>
                          <Input
                              placeholder={t('app.proxy.host_placeholder')}
                              status={proxyDraft.enabled && proxyDraftHost === '' ? 'error' : undefined}
                              value={proxyDraft.host}
                              onChange={(e) => setProxyDraft((current) => ({ ...current, host: e.target.value }))}
                          />
                      </div>
                      <div>
                          <div style={fieldLabelStyle}>{t('app.proxy.port')}</div>
                          <InputNumber
                              min={1}
                              max={65535}
                              status={proxyDraft.enabled && !proxyDraftPortValid ? 'error' : undefined}
                              style={{ width: '100%' }}
                              value={proxyDraft.port}
                              onChange={(value) => setProxyDraft((current) => ({
                                  ...current,
                                  port: typeof value === 'number' ? value : getGlobalProxyDefaultPort(current.type),
                              }))}
                          />
                      </div>
                  </div>

                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: narrow ? '1fr' : '1fr 1fr',
                      gap: 10,
                      alignItems: 'end',
                    }}
                  >
                      <div>
                          <div style={fieldLabelStyle}>{t('app.proxy.username_optional')}</div>
                          <Input
                              placeholder="proxy-user"
                              value={proxyDraft.user}
                              onChange={(e) => setProxyDraft((current) => ({ ...current, user: e.target.value }))}
                          />
                      </div>
                      <div>
                          <div style={fieldLabelStyle}>{t('app.proxy.password_optional')}</div>
                          <Input.Password
                              placeholder="proxy-password"
                              value={proxyDraft.password}
                              onChange={(e) => {
                                  const nextPassword = e.target.value;
                                  setProxyDraft((current) => ({
                                      ...current,
                                      password: nextPassword,
                                      hasPassword: nextPassword !== '' ? true : current.hasPassword,
                                  }));
                                  setProxyDraftClearPassword(false);
                              }}
                          />
                      </div>
                  </div>

                  {proxyDraftClearPassword ? (
                      <Alert showIcon type="warning" message={t('app.proxy.clear_saved_password_pending')} />
                  ) : proxyDraft.hasPassword && proxyDraft.password === '' ? (
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                          <span style={utilityMutedTextStyle}>{t('app.proxy.password_saved_hint')}</span>
                          <Button
                              size="small"
                              onClick={() => {
                                  setProxyDraft((current) => ({ ...current, password: '', hasPassword: false }));
                                  setProxyDraftClearPassword(true);
                              }}
                          >
                              {t('app.proxy.clear_saved_password')}
                          </Button>
                      </div>
                  ) : null}
              </div>

              <div style={{ ...utilityPanelStyle, display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: narrow ? '1fr' : 'minmax(140px, 0.9fr) minmax(200px, 1.6fr) auto',
                      gap: 10,
                      alignItems: 'end',
                    }}
                  >
                      <div>
                          <div style={fieldLabelStyle}>{t('app.proxy.test.target_label')}</div>
                          <Select
                              value={proxyTestPresetItems.some((item) => item.url === proxyTestUrlTrimmed) ? proxyTestUrlTrimmed : undefined}
                              placeholder={t('app.proxy.test.target_label')}
                              style={{ width: '100%' }}
                              allowClear
                              options={proxyTestPresetItems.map((item) => ({
                                  value: item.url,
                                  label: item.label,
                              }))}
                              onChange={(value) => {
                                  if (typeof value === 'string' && value) {
                                      setProxyTestUrl(value);
                                  }
                              }}
                          />
                      </div>
                      <div>
                          <div style={fieldLabelStyle}>{t('app.proxy.test.title')}</div>
                          <Input
                              value={proxyTestUrl}
                              placeholder={t('app.proxy.test.target_placeholder')}
                              onChange={(event) => setProxyTestUrl(event.target.value)}
                              onPressEnter={() => {
                                  if (proxyCanTest) {
                                      void handleTestGlobalProxyDraft();
                                  }
                              }}
                          />
                      </div>
                      <Button
                          type="primary"
                          loading={proxyTesting}
                          disabled={!proxyCanTest}
                          onClick={handleTestGlobalProxyDraft}
                          style={{ minWidth: 96 }}
                      >
                          {t('app.proxy.test.action')}
                      </Button>
                  </div>
                  {!proxyDraft.enabled ? (
                      <div style={utilityMutedTextStyle}>{t('app.proxy.test.disabled_hint')}</div>
                  ) : null}
                  {proxyTestResult ? (
                      <Alert
                          showIcon
                          type={proxyTestAlertType}
                          message={proxyTestResult.message}
                          description={[
                              proxyTestResult.statusCode ? t('app.proxy.test.result.status', { status: proxyTestResult.statusCode }) : '',
                              typeof proxyTestResult.durationMs === 'number' ? t('app.proxy.test.result.duration', { duration: proxyTestResult.durationMs }) : '',
                              proxyTestResult.finalUrl && proxyTestResult.finalUrl !== proxyTestResult.url ? t('app.proxy.test.result.final_url', { url: proxyTestResult.finalUrl }) : '',
                          ].filter(Boolean).join('  ')}
                      />
                  ) : null}
              </div>

              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', paddingTop: 2 }}>
                  <div style={{ ...utilityMutedTextStyle, flex: '1 1 240px', fontSize: 12 }}>{t('app.proxy.scope_hint')}</div>
                  <div style={{ display: 'flex', gap: 8 }}>
                      <Button onClick={resetProxyDraftToCurrent} disabled={!proxyDraftDirty || proxyApplying}>
                          {t('app.proxy.reset')}
                      </Button>
                      <Button
                          type="primary"
                          loading={proxyApplying}
                          disabled={!proxyDraftDirty && !proxyApplying}
                          onClick={handleApplyGlobalProxyDraft}
                      >
                          {t('app.proxy.apply')}
                      </Button>
                  </div>
              </div>
          </div>
      );

  }, [
      applyProxyPreset,
      darkMode,
      overlayTheme.titleText,
      handleApplyGlobalProxyDraft,
      proxyApplying,
      proxyCanTest,
      proxyDraft.enabled,
      proxyDraft.hasPassword,
      proxyDraft.host,
      proxyDraft.password,
      proxyDraft.port,
      proxyDraft.type,
      proxyDraft.user,
      proxyDraftClearPassword,
      proxyDraftDirty,
      proxyDraftHost,
      proxyDraftPortValid,
      proxyDraftValid,
      proxyTestPresetItems,
      proxyTestResult,
      proxyTesting,
      proxyTestUrl,
      proxyTestUrlTrimmed,
      proxyPresetItems,
      proxyStatusDescription,
      proxyStatusTitle,
      resetProxyDraftToCurrent,
      t,
      handleTestGlobalProxyDraft,
      updateProxyDraftType,
      utilityMutedTextStyle,
      utilityPanelStyle,
      viewportWidth,
  ]);
  const downloadSourceItems: ReadonlyArray<{
      id: DownloadSourceId;
      labelKey: string;
      descKey: string;
      guideKey: string;
      tagKey: string;
      icon: React.ReactNode;
      iconColor: string;
      iconBg: string;
      tagColor: string;
      tagBg: string;
  }> = [
      {
          id: 'cst',
          labelKey: 'app.download_source.option.cst',
          descKey: 'app.download_source.option.cst.desc',
          guideKey: 'app.download_source.option.cst.guide',
          tagKey: 'app.download_source.option.cst.tag',
          icon: <ThunderboltOutlined />,
          iconColor: '#f59e0b',
          iconBg: 'rgba(245, 158, 11, 0.14)',
          tagColor: '#b45309',
          tagBg: 'rgba(245, 158, 11, 0.12)',
      },
      {
          id: 'bero',
          labelKey: 'app.download_source.option.bero',
          descKey: 'app.download_source.option.bero.desc',
          guideKey: 'app.download_source.option.bero.guide',
          tagKey: 'app.download_source.option.bero.tag',
          icon: <ApiOutlined />,
          iconColor: '#0ea5e9',
          iconBg: 'rgba(14, 165, 233, 0.14)',
          tagColor: '#0369a1',
          tagBg: 'rgba(14, 165, 233, 0.12)',
      },
      {
          id: 'github',
          labelKey: 'app.download_source.option.github',
          descKey: 'app.download_source.option.github.desc',
          guideKey: 'app.download_source.option.github.guide',
          tagKey: 'app.download_source.option.github.tag',
          icon: <GithubOutlined />,
          iconColor: darkMode ? '#cbd5e1' : '#475569',
          iconBg: darkMode ? 'rgba(203, 213, 225, 0.14)' : 'rgba(71, 85, 105, 0.14)',
          tagColor: darkMode ? '#e2e8f0' : '#1f2937',
          tagBg: darkMode ? 'rgba(203, 213, 225, 0.12)' : 'rgba(71, 85, 105, 0.12)',
      },
  ];

  const renderDownloadSourceSettingsContent = useCallback(() => {
      return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: '12px 0' }}>
              <div style={utilityPanelStyle}>
                  <div style={{ ...utilityMutedTextStyle, marginBottom: 14, lineHeight: 1.7 }}>
                      {t('app.download_source.description')}
                  </div>
                  <div
                      role="radiogroup"
                      aria-label={t('app.download_source.title')}
                      style={{
                          display: 'grid',
                          gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 240px), 1fr))',
                          gap: 12,
                      }}
                  >
                      {downloadSourceItems.map((source) => {
                          const isSelected = downloadSource === source.id;
                          const isDisabled = downloadSourceSaving;
                          const baseBorderColor = isSelected
                              ? overlayTheme.selectedText
                              : overlayTheme.divider;
                          const hoverBorderColor = overlayTheme.selectedText;
                          const selectedBackground = darkMode
                              ? 'rgba(255, 255, 255, 0.05)'
                              : 'rgba(22, 119, 255, 0.05)';
                          return (
                              <button
                                  key={source.id}
                                  type="button"
                                  role="radio"
                                  aria-checked={isSelected}
                                  disabled={isDisabled}
                                  onClick={() => void handleDownloadSourceChange(source.id)}
                                  data-download-source-card={source.id}
                                  data-selected={isSelected ? 'true' : 'false'}
                                  className="gonavi-download-source-card"
                                  style={{
                                      display: 'flex',
                                      flexDirection: 'column',
                                      gap: 12,
                                      padding: 14,
                                      borderRadius: 12,
                                      border: `2px solid ${baseBorderColor}`,
                                      background: isSelected ? selectedBackground : 'transparent',
                                      cursor: isDisabled ? 'not-allowed' : 'pointer',
                                      textAlign: 'left',
                                      transition: 'border-color 160ms ease, background 160ms ease, box-shadow 160ms ease',
                                      opacity: isDisabled ? 0.6 : 1,
                                      fontFamily: 'inherit',
                                      outline: 'none',
                                      minHeight: 132,
                                      boxShadow: isSelected
                                          ? `0 0 0 4px ${darkMode ? 'rgba(22,119,255,0.18)' : 'rgba(22,119,255,0.10)'}`
                                          : 'none',
                                      color: overlayTheme.titleText,
                                  }}
                                  onMouseEnter={(event) => {
                                      if (!isSelected && !isDisabled) {
                                          event.currentTarget.style.borderColor = hoverBorderColor;
                                          event.currentTarget.style.background = selectedBackground;
                                      }
                                  }}
                                  onMouseLeave={(event) => {
                                      if (!isSelected && !isDisabled) {
                                          event.currentTarget.style.borderColor = baseBorderColor;
                                          event.currentTarget.style.background = 'transparent';
                                      }
                                  }}
                                  onFocus={(event) => {
                                      if (!isSelected && !isDisabled) {
                                          event.currentTarget.style.borderColor = hoverBorderColor;
                                      }
                                  }}
                                  onBlur={(event) => {
                                      if (!isSelected && !isDisabled) {
                                          event.currentTarget.style.borderColor = baseBorderColor;
                                      }
                                  }}
                              >
                                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                                      <div
                                          style={{
                                              width: 36,
                                              height: 36,
                                              borderRadius: 10,
                                              display: 'grid',
                                              placeItems: 'center',
                                              background: source.iconBg,
                                              color: source.iconColor,
                                              fontSize: 18,
                                          }}
                                      >
                                          {source.icon}
                                      </div>
                                      {isSelected ? (
                                          <span
                                              style={{
                                                  display: 'inline-flex',
                                                  alignItems: 'center',
                                                  gap: 4,
                                                  padding: '3px 9px',
                                                  borderRadius: 999,
                                                  background: overlayTheme.selectedText,
                                                  color: '#fff',
                                                  fontSize: 11,
                                                  fontWeight: 600,
                                              }}
                                          >
                                              <CheckOutlined style={{ fontSize: 10 }} />
                                              {t('app.download_source.selected_badge')}
                                          </span>
                                      ) : null}
                                  </div>
                                  <div style={{ minWidth: 0 }}>
                                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                                          <span style={{ fontSize: 14, fontWeight: 700, color: overlayTheme.titleText }}>
                                              {t(source.labelKey)}
                                          </span>
                                          <span
                                              style={{
                                                  fontSize: 11,
                                                  fontWeight: 600,
                                                  padding: '1px 8px',
                                                  borderRadius: 999,
                                                  background: source.tagBg,
                                                  color: source.tagColor,
                                              }}
                                          >
                                              {t(source.tagKey)}
                                          </span>
                                      </div>
                                      <div style={{ marginTop: 8, fontSize: 13, fontWeight: 600, lineHeight: 1.6 }}>
                                          {t(source.guideKey)}
                                      </div>
                                      <div
                                          style={{
                                              marginTop: 6,
                                              fontSize: 12,
                                              color: overlayTheme.mutedText,
                                              lineHeight: 1.6,
                                          }}
                                      >
                                          {t(source.descKey)}
                                      </div>
                                  </div>
                              </button>
                          );
                      })}
                  </div>
                  <div
                      style={{
                          marginTop: 14,
                          display: 'flex',
                          alignItems: 'flex-start',
                          gap: 8,
                          padding: '10px 12px',
                          borderRadius: 10,
                          background: darkMode ? 'rgba(255,255,255,0.04)' : 'rgba(22,119,255,0.06)',
                          color: overlayTheme.mutedText,
                          fontSize: 12,
                          lineHeight: 1.7,
                      }}
                  >
                      <InfoCircleOutlined style={{ color: overlayTheme.selectedText, marginTop: 2, flexShrink: 0 }} />
                      <span>{t('app.download_source.fallback_hint')}</span>
                  </div>
              </div>
          </div>
      );
  }, [
      darkMode,
      downloadSource,
      downloadSourceSaving,
      handleDownloadSourceChange,
      overlayTheme.divider,
      overlayTheme.mutedText,
      overlayTheme.selectedText,
      overlayTheme.titleText,
      t,
      utilityMutedTextStyle,
      utilityPanelStyle,
  ]);
  const renderSidebarMetadataSettingsPane = useCallback(() => (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: '12px 0' }}>
          <div style={utilityPanelStyle}>
              <DndContext
                  sensors={sidebarMetadataDragSensors}
                  collisionDetection={closestCenter}
                  onDragEnd={handleSidebarMetadataDragEnd}
              >
                  <SortableContext
                      items={sidebarMetadataFieldItems.map((item) => item.field)}
                      strategy={verticalListSortingStrategy}
                  >
                      <div style={{ display: 'grid', gap: 0, borderTop: `1px solid ${overlayTheme.divider}` }}>
                          {sidebarMetadataFieldItems.map((item) => {
                              const checked = sidebarTableMetadataFields.includes(item.field);
                              return (
                                  <SidebarMetadataSortableRow
                                      key={item.field}
                                      field={item.field}
                                      label={item.label}
                                      checked={checked}
                                      dividerColor={overlayTheme.divider}
                                      titleColor={overlayTheme.titleText}
                                      mutedColor={utilityMutedTextStyle.color as string}
                                      onToggle={(selected) => toggleSidebarMetadataFieldFromSettings(item.field, selected)}
                                  />
                              );
                          })}
                      </div>
                  </SortableContext>
              </DndContext>
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <Button
                  onClick={() => {
                      setQueryOptions({
                          sidebarTableMetadataFields: DEFAULT_SIDEBAR_TABLE_METADATA_FIELDS,
                          sidebarTableMetadataFieldOrder: [...SIDEBAR_TABLE_METADATA_FIELDS],
                      });
                  }}
              >
                  {t('app.theme.action.restore_defaults')}
              </Button>
          </div>
      </div>
  ), [
      overlayTheme.divider,
      overlayTheme.titleText,
      setQueryOptions,
      sidebarMetadataFieldItems,
      sidebarMetadataDragSensors,
      handleSidebarMetadataDragEnd,
      sidebarTableMetadataFields,
      t,
      toggleSidebarMetadataFieldFromSettings,
      utilityMutedTextStyle,
      utilityPanelStyle,
  ]);
  const renderSidebarObjectVisibilitySettingsPane = useCallback(() => {
      const hiddenObjectGroups = new Set(appearance.sidebarHiddenObjectGroups);
      const objectGroupItems: Array<{ key: SidebarObjectGroupKey; label: string }> = [
          { key: 'savedQueries', label: t('sidebar.tree.saved_queries') },
          { key: 'tables', label: t('sidebar.object_group.tables') },
          { key: 'views', label: t('sidebar.object_group.views') },
          { key: 'materializedViews', label: t('sidebar.object_group.materialized_views') },
          { key: 'routines', label: t('sidebar.object_group.routines') },
          { key: 'triggers', label: t('sidebar.object_group.triggers') },
          { key: 'events', label: t('sidebar.object_group.events') },
          { key: 'sequences', label: t('sidebar.object_group.sequences') },
          { key: 'packages', label: t('sidebar.object_group.packages') },
      ];
      const setObjectGroupVisible = (key: SidebarObjectGroupKey, visible: boolean) => {
          const nextHiddenObjectGroups = visible
              ? appearance.sidebarHiddenObjectGroups.filter((item) => item !== key)
              : Array.from(new Set([...appearance.sidebarHiddenObjectGroups, key]));
          setAppearance({ sidebarHiddenObjectGroups: nextHiddenObjectGroups });
      };

      return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: '12px 0' }}>
              <div style={utilityPanelStyle}>
                  <div style={{ display: 'grid', gap: 0, borderTop: `1px solid ${overlayTheme.divider}` }}>
                      {objectGroupItems.map((item) => (
                          <div
                              key={item.key}
                              data-sidebar-object-group-setting={item.key}
                              style={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'space-between',
                                  gap: 12,
                                  minHeight: 36,
                                  padding: '0 2px',
                                  borderBottom: `1px solid ${overlayTheme.divider}`,
                              }}
                          >
                              <span>{item.label}</span>
                              <Switch
                                  checked={!hiddenObjectGroups.has(item.key)}
                                  aria-label={item.label}
                                  onChange={(visible) => setObjectGroupVisible(item.key, visible)}
                              />
                          </div>
                      ))}
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap', marginTop: 14 }}>
                      <Button onClick={() => setAppearance({ sidebarHiddenObjectGroups: [] })}>
                          {t('app.settings.sidebar_objects.action.show_all')}
                      </Button>
                      <Button
                          type="primary"
                          onClick={() => setAppearance({
                              sidebarHiddenObjectGroups: SIDEBAR_OBJECT_GROUP_KEYS.filter((key) => key !== 'tables'),
                          })}
                      >
                          {t('app.settings.sidebar_objects.action.tables_only')}
                      </Button>
                  </div>
              </div>
          </div>
      );
  }, [
      appearance.sidebarHiddenObjectGroups,
      overlayTheme.divider,
      setAppearance,
      t,
      utilityMutedTextStyle,
      utilityPanelStyle,
  ]);
  const updateInstallActionLabel = updateInstallAction === 'install-and-restart'
      ? t('app.about.action.install_and_restart')
      : (updateInstallAction === 'launch-installer'
          ? t('app.about.action.launch_installer')
          : t('app.about.action.restart_to_update'));
  const updateDownloadActionLabel = lastUpdateInfo?.packageType === 'msi'
      ? t('app.about.action.download_msi_update')
      : (lastUpdateInfo?.packageType === 'portable'
          ? t('app.about.action.download_portable_update')
          : t('app.about.action.download_update'));
  const renderAboutUpdateActions = () => [
      isBackgroundProgressForLatestUpdate && !isLatestUpdateDownloaded ? (
          <Button key="progress" icon={<DownloadOutlined />} onClick={showUpdateDownloadProgress}>{t('app.about.action.download_progress')}</Button>
      ) : null,
      lastUpdateInfo?.hasUpdate && !isLatestUpdateDownloaded && !isBackgroundProgressForLatestUpdate ? (
          <Button key="mute" onClick={muteLatestUpdate}>{t('app.about.action.mute_this_version')}</Button>
      ) : null,
      <Button
          key="check"
          icon={<CloudDownloadOutlined />}
          loading={isCheckingForUpdates}
          onClick={() => checkForUpdates(false, true)}
      >
          {t('app.about.action.check_updates')}
      </Button>,
      lastUpdateInfo?.hasUpdate && !isLatestUpdateDownloaded && !isBackgroundProgressForLatestUpdate ? (
          <Button key="download" type="primary" icon={<DownloadOutlined />} onClick={handleDownloadUpdateWithNotes}>{updateDownloadActionLabel}</Button>
      ) : null,
      isLatestUpdateDownloaded ? (
          <Button key="open-install-directory" onClick={openDownloadedUpdateDirectory}>
              {t('app.about.action.open_install_directory')}
          </Button>
      ) : null,
      isLatestUpdateDownloaded ? (
          <Button
              key="restart-to-update"
              type="primary"
              icon={<SyncOutlined />}
              onClick={() => { void handleInstallUpdateRequest(); }}
          >
              {updateInstallActionLabel}
          </Button>
      ) : null,
  ].filter(Boolean);

  const renderAboutSettingsContent = () => (
      aboutLoading ? (
          <div style={{ padding: '16px 0', textAlign: 'center' }}>
              <Spin />
          </div>
      ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div style={utilityPanelStyle}>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 12 }}>
                      <div>
                          <div style={{ marginBottom: 6, fontWeight: 600 }}>{t('app.about.field.version')}</div>
                          <div style={utilityMutedTextStyle}>{aboutDisplayVersion}</div>
                      </div>
                      <div>
                          <div style={{ marginBottom: 6, fontWeight: 600 }}>{t('app.about.field.author')}</div>
                          <div style={utilityMutedTextStyle}>{aboutInfo?.author || t('common.unknown')}</div>
                      </div>
                      <div style={{ gridColumn: '1 / -1' }}>
                          <div style={{ marginBottom: 6, fontWeight: 600 }}>{t('app.about.field.update_status')}</div>
                          <div style={utilityMutedTextStyle}>{aboutUpdateStatus || t('app.about.update_status.not_checked')}</div>
                      </div>
                      <div style={{ gridColumn: '1 / -1' }}>
                          <div style={{ marginBottom: 6, fontWeight: 600 }}>{t('app.about.field.update_channel')}</div>
                          <Select
                              value={updateChannel}
                              options={[
                                  { value: 'latest', label: t('app.about.update_channel.latest') },
                                  { value: 'dev', label: t('app.about.update_channel.dev') },
                              ]}
                              onChange={(value) => {
                                  void changeUpdateChannel(String(value));
                              }}
                              loading={isUpdateChannelLoading}
                              disabled={
                                  isUpdateChannelLoading
                                  || isUpdateChannelSaving
                                  || updateDownloadProgress.status === 'start'
                                  || updateDownloadProgress.status === 'downloading'
                              }
                              style={{ width: 220, maxWidth: '100%' }}
                          />
                      </div>
                      {aboutInfo?.communityUrl ? (
                          <div style={{ gridColumn: '1 / -1' }}>
                              <div style={{ marginBottom: 6, fontWeight: 600 }}>{t('app.about.field.community')}</div>
                              <a onClick={(e) => { e.preventDefault(); if (aboutInfo?.communityUrl) BrowserOpenURL(aboutInfo.communityUrl); }} href={aboutInfo.communityUrl}>{t('app.about.community.ai_book')}</a>
                          </div>
                      ) : null}
                  </div>
              </div>
              <div style={utilityPanelStyle}>
                  <div style={{ marginBottom: 10, fontWeight: 600 }}>{t('app.about.project_links')}</div>
                  <div style={{ display: 'grid', gap: 10 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <GithubOutlined />
                          {aboutInfo?.repoUrl ? (
                              <a onClick={(e) => { e.preventDefault(); if (aboutInfo?.repoUrl) BrowserOpenURL(aboutInfo.repoUrl); }} href={aboutInfo.repoUrl}>{aboutInfo.repoUrl}</a>
                          ) : t('common.unknown')}
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <BugOutlined />
                          {aboutInfo?.issueUrl ? (
                              <a onClick={(e) => { e.preventDefault(); if (aboutInfo?.issueUrl) BrowserOpenURL(aboutInfo.issueUrl); }} href={aboutInfo.issueUrl}>{aboutInfo.issueUrl}</a>
                          ) : t('common.unknown')}
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <CloudDownloadOutlined />
                          {aboutInfo?.releaseUrl ? (
                              <a onClick={(e) => { e.preventDefault(); if (aboutInfo?.releaseUrl) BrowserOpenURL(aboutInfo.releaseUrl); }} href={aboutInfo.releaseUrl}>{aboutInfo.releaseUrl}</a>
                          ) : t('common.unknown')}
                      </div>
                  </div>
              </div>
          </div>
      )
  );

  const renderSettingsCenterAboutProjectEntry = ({
      icon,
      logoSrc,
      title,
      description,
      url,
      copyText,
  }: {
      icon?: React.ReactNode;
      logoSrc?: string;
      title: string;
      description: string;
      url?: string;
      copyText?: string;
  }) => (
      <button
        className={`gonavi-about-project-entry${logoSrc ? ' is-sponsor' : ''}`}
        type="button"
        onClick={() => {
            if (copyText) {
                void navigator.clipboard.writeText(copyText).then(() => {
                    void message.success(t('app.about.project.wechat.copied'));
                });
                return;
            }
            if (url) {
                BrowserOpenURL(url);
            }
        }}
        disabled={!url && !copyText}
        style={{
            width: '100%',
            display: 'flex',
            alignItems: logoSrc ? 'center' : 'flex-start',
            gap: 10,
            padding: '10px 12px',
            border: `1px solid ${darkMode ? 'rgba(255,255,255,0.10)' : 'rgba(16,24,40,0.10)'}`,
            borderRadius: 8,
            background: darkMode ? 'rgba(255,255,255,0.03)' : 'rgba(255,255,255,0.72)',
            color: darkMode ? 'rgba(255,255,255,0.90)' : '#101828',
            cursor: url || copyText ? 'pointer' : 'not-allowed',
            opacity: url || copyText ? 1 : 0.58,
            textAlign: 'left',
        }}
      >
          {logoSrc ? (
              <img className="gonavi-about-project-entry-logo" src={logoSrc} alt="" />
          ) : (
              <span style={{ fontSize: 18, display: 'grid', placeItems: 'center', marginTop: 1, color: overlayTheme.iconColor }}>
                  {icon}
              </span>
          )}
          <span style={{ minWidth: 0, flex: 1 }}>
              <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                  <span style={{ fontSize: 13, fontWeight: 700, lineHeight: 1.35 }}>{title}</span>
                  {copyText
                    ? <CopyOutlined style={{ color: overlayTheme.mutedText, fontSize: 12, flexShrink: 0 }} />
                    : <RightOutlined style={{ color: overlayTheme.mutedText, fontSize: 12, flexShrink: 0 }} />}
              </span>
              <span style={{ ...utilityMutedTextStyle, display: 'block', marginTop: 3, lineHeight: 1.4 }}>{description}</span>
          </span>
      </button>
  );

  const renderSettingsCenterAboutPane = () => {
      if (aboutLoading) {
          return (
              <div style={{ padding: '16px 0', textAlign: 'center' }}>
                  <Spin />
              </div>
          );
      }

      const hasUpdate = Boolean(lastUpdateInfo?.hasUpdate);
      const latestVersionText = lastUpdateInfo?.latestVersion || t('common.unknown');
      const currentVersionText = lastUpdateInfo?.currentVersion || aboutDisplayVersion;
      const releaseTimeText = formatAboutReleaseTime(lastUpdateInfo?.releasePublishedAt);
      const canOpenReleaseNotes = Boolean(lastUpdateInfo);
      const packageType = ['portable', 'msi', 'dmg', 'archive'].includes(String(lastUpdateInfo?.packageType || ''))
          ? String(lastUpdateInfo?.packageType)
          : 'unknown';
      const mutedText = utilityMutedTextStyle.color;
      const dividerColor = darkMode ? 'rgba(255,255,255,0.09)' : 'rgba(16,24,40,0.09)';
      const versionRows: Array<[string, React.ReactNode]> = [
          [t('app.about.version.current'), currentVersionText],
          [t('app.about.version.latest'), latestVersionText],
          [t('app.about.version.release_time'), releaseTimeText],
          [
              t('app.about.version.release_notes'),
              (
                  <Button
                      type="link"
                      size="small"
                      disabled={!canOpenReleaseNotes}
                      onClick={openReleaseNotesModal}
                      style={{ padding: 0, height: 'auto', fontWeight: 600 }}
                  >
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                          {t('app.about.release_notes.action.view')}
                          {hasUnreadReleaseNotes ? (
                              <span
                                  aria-label={t('app.about.release_notes.unread_badge')}
                                  style={{
                                      width: 7,
                                      height: 7,
                                      borderRadius: 999,
                                      background: darkMode ? '#4ade80' : '#16a34a',
                                  }}
                              />
                          ) : null}
                      </span>
                  </Button>
              ),
          ],
          ...(installMode === 'msi' || installMode === 'portable'
              ? [[t('app.about.version.install_mode'), t(`app.about.install_mode.${installMode}`)] as [string, React.ReactNode]]
              : []),
          ...(hasUpdate && packageType !== 'unknown'
              ? [[t('app.about.version.package_type'), t(`app.about.package_type.${packageType}`)] as [string, React.ReactNode]]
              : []),
      ];

      const aboutDownloadSourceDot = (darkMode
          ? { cst: '#f59e0b', bero: '#38bdf8', github: '#cbd5e1' }
          : { cst: '#d97706', bero: '#0284c7', github: '#475569' })[downloadSource] || '#94a3b8';

      return (
          <div className="gonavi-about-pane">
              <section className="gonavi-about-identity" aria-label="GoNavi">
                  <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontSize: 18, lineHeight: 1.15, fontWeight: 800, color: overlayTheme.titleText }}>GoNavi</div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 4, flexWrap: 'wrap', color: mutedText, fontWeight: 600, fontSize: 12 }}>
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                              <UserOutlined />
                              {aboutInfo?.author || t('common.unknown')}
                          </span>
                      </div>
                  </div>
              </section>

              <section className="gonavi-about-section" aria-label={t('app.about.version_update.title')}>
                  <div className="gonavi-about-setting">
                      <div className="gonavi-about-field">
                          <div className="gonavi-about-field-label" style={{ color: overlayTheme.titleText }}>{t('app.about.field.update_channel')}</div>
                          <Segmented
                            className="gonavi-about-update-channel"
                            value={updateChannel}
                            options={[
                                { value: 'latest', label: t('app.about.update_channel.latest') },
                                { value: 'dev', label: t('app.about.update_channel.dev') },
                            ]}
                            onChange={(value) => {
                                void changeUpdateChannel(String(value));
                            }}
                            disabled={
                                isUpdateChannelLoading
                                || isUpdateChannelSaving
                                || updateDownloadProgress.status === 'start'
                                || updateDownloadProgress.status === 'downloading'
                            }
                          />
                      </div>
                      <div className="gonavi-about-field-hint" style={utilityMutedTextStyle}>
                          {updateChannel === 'dev'
                              ? t('app.about.version_update.channel_hint.dev')
                              : t('app.about.version_update.channel_hint.latest')}
                      </div>
                  </div>
                  <div className="gonavi-about-setting">
                      <div className="gonavi-about-field">
                          <div className="gonavi-about-field-label" style={{ color: overlayTheme.titleText }}>{t('app.about.field.auto_check_updates')}</div>
                          <span className="gonavi-about-field-control">
                            <Switch
                              checked={autoCheckForUpdates}
                              onChange={(checked) => setAutoCheckForUpdates(checked)}
                            />
                          </span>
                      </div>
                      {autoCheckForUpdates ? (
                          <>
                              <div className="gonavi-about-field">
                                  <div className="gonavi-about-field-label" style={{ color: overlayTheme.titleText }}>{t('app.about.field.auto_check_interval')}</div>
                                  <Select
                                    className="gonavi-about-auto-check-interval"
                                    value={autoCheckForUpdatesIntervalMinutes}
                                    options={AUTO_CHECK_FOR_UPDATES_INTERVAL_OPTIONS.map((minutes) => ({
                                      value: minutes,
                                      label: minutes >= 60 && minutes % 60 === 0
                                        ? t('app.about.auto_check_interval.hours', { hours: minutes / 60 })
                                        : t('app.about.auto_check_interval.minutes', { minutes }),
                                    }))}
                                    onChange={(value) => setAutoCheckForUpdatesIntervalMinutes(Number(value))}
                                  />
                              </div>
                              <div className="gonavi-about-field-hint" style={utilityMutedTextStyle}>{t('app.about.version_update.auto_check_hint')}</div>
                          </>
                      ) : (
                          <div className="gonavi-about-field-hint" style={utilityMutedTextStyle}>{t('app.about.version_update.auto_check_disabled_hint')}</div>
                      )}
                  </div>
                  <div className="gonavi-about-facts" style={{ borderTop: `1px solid ${dividerColor}` }}>
                      {versionRows.map(([label, value]) => (
                          <div key={label} className="gonavi-about-fact">
                              <div className="gonavi-about-field-label" style={{ color: overlayTheme.titleText }}>{label}</div>
                              <div style={{ color: label === t('app.about.version.latest') && hasUpdate ? (darkMode ? '#86efac' : '#16a34a') : mutedText, fontWeight: label === t('app.about.version.latest') && hasUpdate ? 700 : 500, lineHeight: 1.45, minWidth: 0, overflowWrap: 'anywhere' }}>
                                  {value}
                              </div>
                          </div>
                      ))}
                  </div>
                  <div
                    className="gonavi-about-download-source"
                    data-download-source={downloadSource}
                    style={{
                        borderColor: dividerColor,
                        background: darkMode ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.02)',
                    }}
                  >
                    <span
                      aria-hidden="true"
                      className="gonavi-about-download-source-dot"
                      style={{ background: aboutDownloadSourceDot }}
                    />
                    <span className="gonavi-about-download-source-label" style={{ color: mutedText }}>
                        {t('driver_manager.mirror_source.label')}
                    </span>
                    <span className="gonavi-about-download-source-value" style={{ color: overlayTheme.titleText }}>
                        {t(`app.download_source.option.${downloadSource}`)}
                    </span>
                    <Button
                      type="link"
                      size="small"
                      onClick={() => void handleDownloadSourceChange(getNextDownloadSource(downloadSource))}
                      loading={downloadSourceSaving}
                      disabled={downloadSourceSaving}
                      className="gonavi-about-download-source-switch"
                    >
                        {t('driver_manager.mirror_source.switch')}
                    </Button>
                  </div>
              </section>

              <section className="gonavi-about-section" aria-labelledby="gonavi-about-project-heading">
                  <div id="gonavi-about-project-heading" className="gonavi-about-section-title" style={{ color: overlayTheme.titleText }}>
                      {t('app.about.project_links')}
                  </div>
                  <div className="gonavi-about-link-grid">
                      {renderSettingsCenterAboutProjectEntry({
                          icon: <GithubOutlined />,
                          title: t('app.about.project.github.title'),
                          description: t('app.about.project.github.description'),
                          url: aboutInfo?.repoUrl,
                      })}
                      {renderSettingsCenterAboutProjectEntry({
                          icon: <MessageOutlined />,
                          title: t('app.about.project.issues.title'),
                          description: t('app.about.project.issues.description'),
                          url: aboutInfo?.issueUrl,
                      })}
                      {renderSettingsCenterAboutProjectEntry({
                          icon: <FileTextOutlined />,
                          title: t('app.about.project.releases.title'),
                          description: t('app.about.project.releases.description'),
                          url: lastUpdateInfo?.releaseNotesUrl || aboutInfo?.releaseUrl,
                      })}
                      {renderSettingsCenterAboutProjectEntry({
                          icon: <WechatOutlined />,
                          title: t('app.about.project.wechat.title'),
                          description: t('app.about.project.wechat.description'),
                          copyText: t('app.about.project.wechat.id'),
                      })}
                  </div>
              </section>

              <section className="gonavi-about-section" aria-labelledby="gonavi-about-sponsors-heading">
                  <div id="gonavi-about-sponsors-heading" className="gonavi-about-section-title" style={{ color: overlayTheme.titleText }}>
                      {t('app.about.sponsors')}
                  </div>
                  <div className="gonavi-about-link-grid">
                      {renderSettingsCenterAboutProjectEntry({
                          logoSrc: '/sponsors/hualong-mark.png',
                          title: t('app.about.project.hualong.title'),
                          description: t('app.about.project.hualong.description'),
                          url: 'https://api.hualong.online/',
                      })}
                  </div>
              </section>
          </div>
      );
  };

  const renderSettingsCenterAboutFooter = () => (
      <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginLeft: 'auto' }}>
          {renderAboutUpdateActions()}
      </div>
  );

  const renderThemeSettingsSection = (title: React.ReactNode, children: React.ReactNode, hint?: React.ReactNode) => (
      <section className="gonavi-settings-section">
          {title ? <div className="gonavi-settings-section-title">{title}</div> : null}
          {hint ? <div className="gonavi-settings-section-hint">{hint}</div> : null}
          <div>{children}</div>
      </section>
  );

  const renderThemeSettingsRow = ({
      label,
      hint,
      control,
      stacked = false,
      controlOnly = false,
  }: {
      label?: React.ReactNode;
      hint?: React.ReactNode;
      control: React.ReactNode;
      stacked?: boolean;
      /** 分区标题已说明用途时，只渲染控件，避免标题重复 */
      controlOnly?: boolean;
  }) => (
      <div className={`gonavi-settings-row${stacked || controlOnly ? ' is-stacked' : ''}${controlOnly ? ' is-control-only' : ''}`}>
          {!controlOnly ? (
              <div>
                  <div className="gonavi-settings-label">{label}</div>
                  {hint ? <div className="gonavi-settings-label-hint">{hint}</div> : null}
              </div>
          ) : null}
          <div className="gonavi-settings-control">{control}</div>
      </div>
  );

  const renderThemeModePreview = (preview: 'light' | 'dark' | 'system') => (
      <div
        aria-hidden
        className={`gonavi-settings-mode-preview${preview === 'system' ? ' is-system' : ''}`}
      >
          {(preview === 'light' || preview === 'system') ? (
              <div className="gonavi-settings-mode-preview-pane is-light">
                  <span className="gonavi-settings-mode-preview-line" />
                  <span className="gonavi-settings-mode-preview-line" />
                  <span className="gonavi-settings-mode-preview-line" />
              </div>
          ) : null}
          {(preview === 'dark' || preview === 'system') ? (
              <div className="gonavi-settings-mode-preview-pane is-dark">
                  <span className="gonavi-settings-mode-preview-line" />
                  <span className="gonavi-settings-mode-preview-line" />
                  <span className="gonavi-settings-mode-preview-line" />
              </div>
          ) : null}
      </div>
  );

  const themeSettingsSections = [
      { value: 'theme' as const, label: t('app.theme.nav.theme.title'), icon: <SkinOutlined /> },
      { value: 'appearance' as const, label: t('app.theme.nav.appearance.title'), icon: <BgColorsOutlined /> },
      { value: 'workspace' as const, label: t('app.theme.nav.workspace.title'), icon: <AppstoreOutlined /> },
  ];

  const renderThemeSettingsContentV2 = (options?: { hideSectionTabs?: boolean }) => (
              <div className="gonavi-theme-settings" style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 10,
                  padding: '4px 4px 0',
                  height: '100%',
                  minHeight: 0,
                  overflow: 'hidden',
                  boxSizing: 'border-box',
              }}>
                  {options?.hideSectionTabs ? null : (
                  <div style={{ flexShrink: 0, display: 'grid', gap: 4 }}>
                      <div className="gonavi-settings-tabs" role="tablist" aria-label={t('app.settings.entry.theme.title')}>
                          {themeSettingsSections.map((item, itemIndex) => {
                              const active = themeModalSection === item.value;
                              return (
                                  <button
                                      key={item.value}
                                      id={`gonavi-theme-settings-tab-${item.value}`}
                                      type="button"
                                      role="tab"
                                      aria-selected={active}
                                      aria-controls={`gonavi-theme-settings-panel-${item.value}`}
                                      tabIndex={active ? 0 : -1}
                                      className={`gonavi-settings-tab${active ? ' is-active' : ''}`}
                                      onClick={() => setThemeModalSection(item.value)}
                                      onKeyDown={(event) => {
                                          if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) {
                                              return;
                                          }
                                          event.preventDefault();
                                          const nextIndex = event.key === 'Home'
                                              ? 0
                                              : event.key === 'End'
                                                  ? themeSettingsSections.length - 1
                                                  : event.key === 'ArrowRight'
                                                      ? (itemIndex + 1) % themeSettingsSections.length
                                                      : (itemIndex - 1 + themeSettingsSections.length) % themeSettingsSections.length;
                                          setThemeModalSection(themeSettingsSections[nextIndex].value);
                                          const tabs = event.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role="tab"]');
                                          tabs?.[nextIndex]?.focus();
                                      }}
                                  >
                                      <span className="gonavi-settings-tab-icon">{item.icon}</span>
                                      <span>{item.label}</span>
                                  </button>
                              );
                          })}
                      </div>
                  </div>
                  )}
                  <div
                    key={themeModalSection}
                    id={`gonavi-theme-settings-panel-${themeModalSection}`}
                    role={options?.hideSectionTabs ? undefined : 'tabpanel'}
                    aria-labelledby={options?.hideSectionTabs ? undefined : `gonavi-theme-settings-tab-${themeModalSection}`}
                    className="gonavi-settings-center-pane-scroll"
                    style={{
                        minWidth: 0,
                        minHeight: 0,
                        flex: 1,
                        overflowY: 'auto',
                        /* visible：避免 Slider 两端手柄被横向裁切 */
                        overflowX: 'visible',
                        overscrollBehavior: 'contain',
                        paddingRight: 4,
                        paddingLeft: 2,
                        paddingBottom: 20,
                        scrollbarGutter: 'auto',
                    }}
                  >
                      {themeModalSection === 'theme' ? (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                              {renderThemeSettingsSection(
                                  t('app.theme.mode_title'),
                                  <div className="gonavi-settings-mode-grid" role="radiogroup" aria-label={t('app.theme.mode_title')}>
                                      {([
                                          { key: 'light' as const, label: t('app.theme.mode.light.label'), preview: 'light' as const },
                                          { key: 'dark' as const, label: t('app.theme.mode.dark.label'), preview: 'dark' as const },
                                          { key: 'system' as const, label: t('app.theme.mode.system.label'), preview: 'system' as const },
                                      ]).map((item, itemIndex, themeItems) => {
                                          const active = effectiveThemePreference === item.key;
                                          return (
                                              <button
                                                  key={item.key}
                                                  type="button"
                                                  role="radio"
                                                  aria-checked={active}
                                                  tabIndex={effectiveThemePreference === item.key ? 0 : -1}
                                                  className={`gonavi-settings-mode-tile${active ? ' is-active' : ''}`}
                                                  onClick={() => selectPresetTheme(item.key)}
                                                  onKeyDown={(event) => {
                                                      if (!['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
                                                          return;
                                                      }
                                                      event.preventDefault();
                                                      const nextIndex = event.key === 'Home'
                                                          ? 0
                                                          : event.key === 'End'
                                                              ? themeItems.length - 1
                                                              : event.key === 'ArrowRight' || event.key === 'ArrowDown'
                                                                  ? (itemIndex + 1) % themeItems.length
                                                                  : (itemIndex - 1 + themeItems.length) % themeItems.length;
                                                      selectPresetTheme(themeItems[nextIndex].key);
                                                      const radios = event.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role="radio"]');
                                                      radios?.[nextIndex]?.focus();
                                                  }}
                                              >
                                                  {renderThemeModePreview(item.preview)}
                                                  <div className="gonavi-settings-mode-meta">
                                                      <span className="gonavi-settings-mode-label">{item.label}</span>
                                                      {active ? <CheckOutlined className="gonavi-settings-mode-check" /> : null}
                                                  </div>
                                              </button>
                                          );
                                      })}
                                  </div>,
                              )}
                              {renderThemeSettingsSection(
                                  t('app.theme.custom.title'),
                                  <CustomThemeManager />,
                              )}
                              {renderThemeSettingsSection(
                                  t('app.theme.toolbar_buttons.title'),
                                  <ToolbarButtonAppearanceSettings />,
                                  t('app.theme.toolbar_buttons.description'),
                              )}
                              {renderThemeSettingsSection(
                                  t('app.theme.ui_version.sidebar_search.title'),
                                  <div className="gonavi-settings-pills" role="group" aria-label={t('app.theme.ui_version.sidebar_search.title')}>
                                      {([
                                          { value: 'command' as const, label: t('app.theme.ui_version.sidebar_search.command') },
                                          { value: 'filter' as const, label: t('app.theme.ui_version.sidebar_search.filter') },
                                      ]).map((item) => {
                                          const active = (appearance.v2SidebarSearchMode ?? 'command') === item.value;
                                          return (
                                              <button
                                                  key={item.value}
                                                  type="button"
                                                  className={`gonavi-settings-pill${active ? ' is-active' : ''}`}
                                                  aria-pressed={active}
                                                  onClick={() => setAppearance({ v2SidebarSearchMode: item.value })}
                                              >
                                                  {item.label}
                                              </button>
                                          );
                                      })}
                                  </div>,
                                  t('app.theme.ui_version.sidebar_search.hint'),
                              )}
                          </div>
                      ) : themeModalSection === 'appearance' ? (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                              {renderThemeSettingsSection(
                                  // 设置中心侧栏已显示「显示与字体」，内容区不再重复分区标题
                                  options?.hideSectionTabs ? null : t('app.theme.nav.appearance.title'),
                                  <>
                                      {renderThemeSettingsRow({
                                          label: t('app.theme.appearance.ui_scale_title'),
                                          hint: t('app.theme.appearance.ui_scale_hint'),
                                          stacked: true,
                                          control: (
                                              <ThemeSettingsSlider
                                                  min={MIN_UI_SCALE}
                                                  max={MAX_UI_SCALE}
                                                  step={0.05}
                                                  marks={UI_SCALE_SLIDER_MARKS}
                                                  value={effectiveUiScale}
                                                  unit="percent"
                                                  onChange={(v) => setUiScale(v)}
                                              />
                                          ),
                                      })}
                                      {renderThemeSettingsRow({
                                          label: t('app.theme.appearance.font_size_title'),
                                          stacked: true,
                                          control: (
                                              <ThemeSettingsSlider
                                                  min={MIN_FONT_SIZE}
                                                  max={MAX_FONT_SIZE}
                                                  step={1}
                                                  marks={FONT_SIZE_SLIDER_MARKS}
                                                  value={effectiveFontSize}
                                                  unit="px"
                                                  onChange={(v) => setFontSize(v)}
                                              />
                                          ),
                                      })}
                                      {renderThemeSettingsRow({
                                          label: t('app.theme.appearance.sidebar_rail_scale_title'),
                                          hint: t('app.theme.appearance.sidebar_rail_scale_hint'),
                                          stacked: true,
                                          control: (
                                              <ThemeSettingsSlider
                                                  min={MIN_V2_SIDEBAR_RAIL_SCALE}
                                                  max={MAX_V2_SIDEBAR_RAIL_SCALE}
                                                  step={0.05}
                                                  marks={SIDEBAR_RAIL_SCALE_SLIDER_MARKS}
                                                  value={effectiveSidebarRailScale}
                                                  unit="percent"
                                                  onChange={(value) => setAppearance({
                                                      v2SidebarRailScale: sanitizeV2SidebarRailScale(value),
                                                  })}
                                              />
                                          ),
                                      })}
                                      {renderThemeSettingsRow({
                                          label: t('app.theme.appearance.single_database_expansion_title'),
                                          hint: t('app.theme.appearance.single_database_expansion_hint'),
                                          control: (
                                              <Switch
                                                  checked={appearance.sidebarSingleDatabaseExpansion === true}
                                                  onChange={(checked) => setAppearance({ sidebarSingleDatabaseExpansion: checked })}
                                              />
                                          ),
                                      })}
                                  </>,
                              )}
                              {renderThemeSettingsSection(
                                  t('app.theme.font_family.title'),
                                  <>
                                      <div style={{ padding: '8px 0' }}>
                                          <div className="gonavi-settings-label" style={{ marginBottom: 8 }}>{t('app.theme.font_family.ui_title')}</div>
                                          <Select
                                              allowClear
                                              showSearch
                                              optionFilterProp="label"
                                              loading={isFontFamiliesLoading}
                                              placeholder={DEFAULT_UI_FONT_FAMILY}
                                              value={appearance.customUIFontFamily ?? undefined}
                                              onChange={(value) => setAppearance({
                                                  customUIFontFamily: sanitizeFontFamilyInput(value),
                                              })}
                                              onClear={() => setAppearance({ customUIFontFamily: null })}
                                              options={uiFontOptions.map((option) => ({
                                                  value: option.value,
                                                  label: option.label,
                                              }))}
                                              filterOption={filterFontOption}
                                              popupMatchSelectWidth
                                              style={{ width: '100%' }}
                                              optionRender={(option) => renderFontOptionLabel({
                                                  value: String(option.data.value),
                                                  label: String(option.data.label),
                                              })}
                                          />
                                          <div className="gonavi-settings-inline-meta">
                                              {fontFamiliesLoadError
                                                  ? t('app.theme.font_family.load_failed_fallback', { error: fontFamiliesLoadError })
                                                  : (installedFontFamilies.length > 0
                                                      ? t('app.theme.font_family.loaded_ui_hint', { count: installedFontFamilies.length })
                                                      : t('app.theme.font_family.loading_ui_hint'))}
                                          </div>
                                          {linuxCJKFontInstallHint && hasLoadedInstalledFontsRef.current && !isFontFamiliesLoading && !fontFamiliesLoadError ? (
                                              <div className="gonavi-settings-alert" style={{ borderColor: darkMode ? 'rgba(250,204,21,0.28)' : 'rgba(217,119,6,0.22)', background: darkMode ? 'rgba(250,204,21,0.08)' : 'rgba(251,191,36,0.12)', color: darkMode ? 'rgba(254,249,195,0.92)' : '#92400e' }}>
                                                  {t('app.theme.font_family.linux_cjk_install_prefix')}
                                                  <span style={{ fontFamily: 'var(--gn-font-mono)', marginLeft: 6 }}>{linuxCJKFontInstallHint}</span>
                                                  {t('app.theme.font_family.linux_cjk_install_suffix')}
                                              </div>
                                          ) : null}
                                      </div>
                                      <div style={{ padding: '8px 0', borderTop: '1px solid var(--gn-settings-line)' }}>
                                          <div className="gonavi-settings-label" style={{ marginBottom: 8 }}>{t('app.theme.font_family.mono_title')}</div>
                                          <Select
                                              allowClear
                                              showSearch
                                              optionFilterProp="label"
                                              loading={isFontFamiliesLoading}
                                              placeholder={DEFAULT_MONO_FONT_FAMILY}
                                              value={appearance.customMonoFontFamily ?? undefined}
                                              onChange={(value) => setAppearance({
                                                  customMonoFontFamily: sanitizeFontFamilyInput(value),
                                              })}
                                              onClear={() => setAppearance({ customMonoFontFamily: null })}
                                              options={monoFontOptions.map((option) => ({
                                                  value: option.value,
                                                  label: option.label,
                                              }))}
                                              filterOption={filterFontOption}
                                              popupMatchSelectWidth
                                              style={{ width: '100%' }}
                                              optionRender={(option) => renderFontOptionLabel({
                                                  value: String(option.data.value),
                                                  label: String(option.data.label),
                                              })}
                                          />
                                          <div className="gonavi-settings-inline-meta">
                                              {fontFamiliesLoadError
                                                  ? t('app.theme.font_family.mono_fallback_hint')
                                                  : t('app.theme.font_family.mono_hint')}
                                          </div>
                                      </div>
                                  </>,
                              )}
                              {renderThemeSettingsSection(
                                  t('app.theme.appearance.transparency_blur_title'),
                                  <>
                                      {renderThemeSettingsRow({
                                          label: t('app.theme.appearance.enable_transparency_blur'),
                                          hint: t('app.theme.appearance.enable_transparency_blur_hint'),
                                          control: (
                                              <Switch
                                                  checked={appearance.enabled !== false}
                                                  onChange={(checked) => setAppearance({ enabled: checked })}
                                              />
                                          ),
                                      })}
                                      <div style={{ opacity: appearance.enabled !== false ? 1 : 0.55 }}>
                                          {renderThemeSettingsRow({
                                              label: t('app.theme.appearance.opacity_title'),
                                              stacked: true,
                                              control: (
                                                  <ThemeSettingsSlider
                                                      min={0.1}
                                                      max={1.0}
                                                      step={0.05}
                                                      marks={OPACITY_SLIDER_MARKS}
                                                      disabled={appearance.enabled === false}
                                                      value={appearance.opacity ?? 1.0}
                                                      unit="percent"
                                                      onChange={(v) => setAppearance({ opacity: v })}
                                                  />
                                              ),
                                          })}
                                          {isWindowsPlatform() ? (
                                              <div className="gonavi-settings-inline-meta">{t('app.theme.appearance.windows_acrylic_hint')}</div>
                                          ) : (
                                              renderThemeSettingsRow({
                                                  label: t('app.theme.appearance.blur_title'),
                                                  hint: t('app.theme.appearance.blur_hint'),
                                                  stacked: true,
                                                  control: (
                                                      <ThemeSettingsSlider
                                                          min={0}
                                                          max={20}
                                                          step={1}
                                                          marks={BLUR_SLIDER_MARKS}
                                                          disabled={appearance.enabled === false}
                                                          value={appearance.blur ?? 0}
                                                          unit="px"
                                                          onChange={(v) => setAppearance({ blur: v })}
                                                      />
                                                  ),
                                              })
                                          )}
                                      </div>
                                  </>,
                              )}
                          </div>
                      ) : (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                              {renderThemeSettingsSection(
                                  t('app.theme.query_template.title'),
                                  <>
                                      <div className="gonavi-settings-section-hint" style={{ marginTop: 0 }}>{t('app.theme.query_template.description')}</div>
                                      <Input.TextArea
                                          value={newQuerySqlTemplate}
                                          autoSize={{ minRows: 3, maxRows: 8 }}
                                          spellCheck={false}
                                          onChange={(event) => setAppearance({ newQuerySqlTemplate: event.target.value })}
                                          style={{ fontFamily: 'var(--gn-font-mono)' }}
                                      />
                                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginTop: 8 }}>
                                          <div className="gonavi-settings-inline-meta" style={{ marginTop: 0 }}>{t('app.theme.query_template.hint')}</div>
                                          <Button
                                              size="small"
                                              disabled={appearance.newQuerySqlTemplate === null}
                                              onClick={() => setAppearance({ newQuerySqlTemplate: null })}
                                          >
                                              {t('app.theme.query_template.reset_default')}
                                          </Button>
                                      </div>
                                  </>,
                              )}
                              {renderThemeSettingsSection(
                                  t('app.theme.table_alias.title'),
                                  <div style={{ display: 'grid', gap: 12 }}>
                                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                                          <div className="gonavi-settings-section-hint" style={{ marginTop: 0 }}>
                                              {t('app.theme.table_alias.description')}
                                          </div>
                                          <Switch
                                              checked={appearance.autoAddTableAlias !== false}
                                              onChange={(checked) => setAppearance({ autoAddTableAlias: checked })}
                                          />
                                      </div>
                                      <div style={{ display: 'grid', gap: 8 }}>
                                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                                              <div>
                                                  <div>{t('app.theme.table_alias.custom_prefix.title')}</div>
                                                  <div className="gonavi-settings-section-hint" style={{ marginTop: 2 }}>
                                                      {t('app.theme.table_alias.custom_prefix.description')}
                                                  </div>
                                              </div>
                                              <Switch
                                                  checked={appearance.customTableAliasPrefixEnabled}
                                                  disabled={appearance.autoAddTableAlias === false}
                                                  onChange={(checked) => setAppearance({ customTableAliasPrefixEnabled: checked })}
                                              />
                                          </div>
                                          <Input
                                              value={appearance.customTableAliasPrefix}
                                              maxLength={24}
                                              placeholder={t('app.theme.table_alias.custom_prefix.placeholder')}
                                              disabled={appearance.autoAddTableAlias === false || !appearance.customTableAliasPrefixEnabled}
                                              onChange={(event) => setAppearance({ customTableAliasPrefix: event.target.value })}
                                          />
                                      </div>
                                  </div>,
                              )}
                              <section className="gonavi-settings-section" ref={tabDisplaySettingsPanelRef}>
                                  <div className="gonavi-settings-section-title">{t('app.theme.tab_display.title')}</div>
                                  <div className="gonavi-settings-section-hint">{t('app.theme.tab_display.description')}</div>
                                  {renderThemeSettingsRow({
                                      label: t('app.theme.tab_display.title'),
                                      stacked: true,
                                      control: (
                                          <Segmented
                                              className="gonavi-settings-segmented-choice"
                                              block
                                              options={[
                                                  { label: t('app.theme.tab_display.layout.single'), value: 'single' },
                                                  { label: t('app.theme.tab_display.layout.double'), value: 'double' },
                                              ]}
                                              value={tabDisplaySettings.layout}
                                              onChange={(value) => setTabDisplayLayout(value as TabDisplayLayout)}
                                          />
                                      ),
                                  })}
                                  {renderThemeSettingsRow({
                                      label: t('app.theme.tab_display.environment_accent_thickness'),
                                      hint: t('app.theme.tab_display.environment_accent_thickness_hint'),
                                      stacked: true,
                                      control: (
                                          <ThemeSettingsSlider
                                              min={MIN_TAB_ENVIRONMENT_ACCENT_THICKNESS}
                                              max={MAX_TAB_ENVIRONMENT_ACCENT_THICKNESS}
                                              step={1}
                                              marks={TAB_ENVIRONMENT_ACCENT_THICKNESS_SLIDER_MARKS}
                                              value={effectiveTabEnvironmentAccentThickness}
                                              unit="px"
                                              onChange={(value) => setAppearance({
                                                  tabEnvironmentAccentThickness: sanitizeTabEnvironmentAccentThickness(value),
                                              })}
                                          />
                                      ),
                                  })}
                                  <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
{tabDisplayElementOrder.map((key) => {
                                          const checked = visibleTabDisplayElementKeys.has(key);
                                          const row = tabDisplaySettings.secondaryElements.includes(key) ? 'secondary' : 'primary';
                                          const currentRowElements = row === 'secondary'
                                              ? tabDisplaySettings.secondaryElements
                                              : tabDisplaySettings.primaryElements;
                                          const indexInRow = currentRowElements.indexOf(key);
                                          const canMoveUp = checked && indexInRow > 0;
                                          const canMoveDown = checked && indexInRow >= 0 && indexInRow < currentRowElements.length - 1;
                                          const isFocused = focusedTabDisplayElementKey === key;
                                          return (
                                              <div
                                                  key={key}
                                                  role="button"
                                                  tabIndex={0}
                                                  onClick={() => setFocusedTabDisplayElementKey(key)}
                                                  onKeyDown={(event) => {
                                                      if (event.key === 'Enter' || event.key === ' ') {
                                                          event.preventDefault();
                                                          setFocusedTabDisplayElementKey(key);
                                                      }
                                                  }}
                                                  style={{
                                                      display: 'grid',
                                                      gridTemplateColumns: 'minmax(0, 1fr) auto',
                                                      gap: 10,
                                                      alignItems: 'center',
                                                      padding: '8px 2px 8px 10px',
                                                      borderRadius: 0,
                                                      border: 'none',
                                                      borderLeft: `3px solid ${isFocused
                                                          ? (v2AntPrimaryColor)
                                                          : 'transparent'}`,
                                                      borderBottom: `1px solid ${overlayTheme.divider}`,
                                                      boxShadow: 'none',
                                                      background: isFocused
                                                          ? (v2AntPrimaryBgColor)
                                                          : 'transparent',
                                                      cursor: 'pointer',
                                                      transition: 'border-color 140ms ease, background-color 140ms ease',
                                                  }}
                                              >
                                                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                                                      <span style={{
                                                          width: 22,
                                                          height: 22,
                                                          borderRadius: 0,
                                                          display: 'inline-flex',
                                                          alignItems: 'center',
                                                          justifyContent: 'center',
                                                          flexShrink: 0,
                                                          fontFamily: resolvedMonoFontFamily,
                                                          fontSize: 'var(--gn-font-size-sm, 12px)',
                                                          fontWeight: 600,
                                                          background: 'transparent',
                                                          color: isFocused
                                                              ? (v2AntPrimaryColor)
                                                              : (darkMode ? 'rgba(255,255,255,0.56)' : 'rgba(16,24,40,0.5)'),
                                                      }}>
                                                          {checked && indexInRow >= 0 ? indexInRow + 1 : '-'}
                                                      </span>
                                                      <Switch
                                                          size="small"
                                                          checked={checked}
                                                          onClick={(_, event) => event.stopPropagation()}
                                                          onChange={(nextChecked) => updateTabDisplayElementVisibility(key, nextChecked)}
                                                      />
                                                      <div style={{ minWidth: 0 }}>
                                                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                                                              <span style={{ fontWeight: 600 }}>{getTabDisplayElementLabel(key)}</span>
                                                              {isFocused ? (
                                                                  <span style={{
                                                                      fontSize: 'var(--gn-font-size-sm, 12px)',
                                                                      lineHeight: '16px',
                                                                      padding: '0 6px',
                                                                      borderRadius: 999,
                                                                      background: v2AntPrimaryBgColor,
                                                                      color: v2AntPrimaryColor,
                                                                  }}>
                                                                      {t('app.theme.tab_display.badge.current')}
                                                                  </span>
                                                              ) : null}
                                                              {checked && tabDisplaySettings.layout === 'double' ? (
                                                                  <span style={{
                                                                      fontSize: 'var(--gn-font-size-sm, 12px)',
                                                                      lineHeight: '16px',
                                                                      padding: '0 6px',
                                                                      borderRadius: 999,
                                                                      background: row === 'secondary'
                                                                          ? (darkMode ? 'rgba(56,189,248,0.14)' : 'rgba(2,132,199,0.08)')
                                                                          : (darkMode ? 'rgba(34,197,94,0.14)' : 'rgba(22,163,74,0.08)'),
                                                                      color: row === 'secondary'
                                                                          ? (darkMode ? '#7dd3fc' : '#0369a1')
                                                                          : (darkMode ? '#86efac' : '#15803d'),
                                                                  }}>
                                                                      {row === 'secondary'
                                                                          ? t('app.theme.tab_display.row.secondary')
                                                                          : t('app.theme.tab_display.row.primary')}
                                                                  </span>
                                                              ) : null}
                                                          </div>
                                                          <div style={{ ...utilityMutedTextStyle, marginTop: 2 }}>{getTabDisplayElementDescription(key)}</div>
                                                      </div>
                                                  </div>
                                                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                                      {tabDisplaySettings.layout === 'double' && checked ? (
                                                          <Segmented
                                                              size="small"
                                                              options={[
                                                                  { label: t('app.theme.tab_display.row.primary'), value: 'primary' },
                                                                  { label: t('app.theme.tab_display.row.secondary'), value: 'secondary' },
                                                              ]}
                                                              value={row}
                                                              onChange={(value) => setTabDisplayElementRow(key, value as 'primary' | 'secondary')}
                                                              onClick={(event) => event.stopPropagation()}
                                                          />
                                                      ) : null}
                                                      <Button
                                                          size="small"
                                                          disabled={!canMoveUp}
                                                          onClick={(event) => {
                                                              event.stopPropagation();
                                                              moveTabDisplayElement(key, -1);
                                                          }}
                                                      >
                                                          {t('app.theme.tab_display.action.move_up')}
                                                      </Button>
                                                      <Button
                                                          size="small"
                                                          disabled={!canMoveDown}
                                                          onClick={(event) => {
                                                              event.stopPropagation();
                                                              moveTabDisplayElement(key, 1);
                                                          }}
                                                      >
                                                          {t('app.theme.tab_display.action.move_down')}
                                                      </Button>
                                                  </div>
                                              </div>
                                          );
                                      })}
                                  </div>
                                  <div className="gonavi-settings-inline-meta">
                                      {t('app.theme.tab_display.preview.prefix')}
                                      {tabDisplaySettings.layout === 'double' ? `${t('app.theme.tab_display.row.primary')} ` : ''}
                                      {tabDisplaySettings.primaryElements.map(getTabDisplayElementLabel).join(' / ') || t('app.theme.tab_display.preview.default_label')}
                                      {tabDisplaySettings.layout === 'double' && tabDisplaySettings.secondaryElements.length > 0
                                          ? t('app.theme.tab_display.preview.secondary', {
                                              labels: tabDisplaySettings.secondaryElements.map(getTabDisplayElementLabel).join(' / '),
                                          })
                                          : ''}
                                      {focusedTabDisplayElementKey
                                          ? t('app.theme.tab_display.preview.focused', {
                                              label: getTabDisplayElementLabel(focusedTabDisplayElementKey),
                                          })
                                          : ''}
                                  </div>
                              </section>
                              {renderThemeSettingsSection(
                                  t('app.theme.data_table.title'),
                                  <>
                                      {renderThemeSettingsRow({
                                          label: t('app.theme.data_table.vertical_borders'),
                                          hint: t('app.theme.data_table.vertical_borders_hint'),
                                          control: (
                                              <Switch
                                                  checked={appearance.showDataTableVerticalBorders === true}
                                                  onChange={(checked) => setAppearance({ showDataTableVerticalBorders: checked })}
                                              />
                                          ),
                                      })}
                                      {renderThemeSettingsRow({
                                          label: t('app.theme.data_table.row_number'),
                                          hint: t('app.theme.data_table.row_number_hint'),
                                          control: (
                                              <Switch
                                                  checked={appearance.showDataTableRowNumber !== false}
                                                  onChange={(checked) => setAppearance({ showDataTableRowNumber: checked })}
                                              />
                                          ),
                                      })}
                                      {renderThemeSettingsRow({
                                          label: t('app.theme.data_table.table_double_click_action'),
                                          hint: t('app.theme.data_table.table_double_click_action_hint'),
                                          stacked: true,
                                          control: (
                                              <Segmented
                                                  className="gonavi-settings-segmented-choice"
                                                  block
                                                  options={[
                                                      { label: t('app.theme.data_table.table_double_click_action.open_data'), value: 'open-data' },
                                                      { label: t('app.theme.data_table.table_double_click_action.open_design'), value: 'open-design' },
                                                  ]}
                                                  value={tableDoubleClickAction}
                                                  onChange={(value) => setAppearance({ tableDoubleClickAction: value as 'open-data' | 'open-design' })}
                                              />
                                          ),
                                      })}
                                      {renderThemeSettingsRow({
                                          label: t('app.theme.data_table.query_ctrl_click_action'),
                                          hint: t('app.theme.data_table.query_ctrl_click_action_hint'),
                                          stacked: true,
                                          control: (
                                              <Segmented
                                                  className="gonavi-settings-segmented-choice"
                                                  block
                                                  options={[
                                                      { label: t('app.theme.data_table.query_ctrl_click_action.open_design'), value: 'open-design' },
                                                      { label: t('app.theme.data_table.query_ctrl_click_action.locate'), value: 'locate' },
                                                  ]}
                                                  value={queryTableCtrlClickAction}
                                                  onChange={(value) => setAppearance({ queryTableCtrlClickAction: value as QueryTableCtrlClickAction })}
                                              />
                                          ),
                                      })}
                                      {renderThemeSettingsRow({
                                          label: t('app.theme.data_table.density'),
                                          hint: t('app.theme.data_table.density_hint'),
                                          stacked: true,
                                          control: (
                                              <Segmented
                                                  className="gonavi-settings-segmented-choice"
                                                  block
                                                  options={DENSITY_OPTIONS.map((option) => ({
                                                      ...option,
                                                      label: t(`app.theme.data_table.density.${option.value}`),
                                                  }))}
                                                  value={appearance.dataTableDensity}
                                                  onChange={(value) => setAppearance({ dataTableDensity: sanitizeDataTableDensity(value) })}
                                              />
                                          ),
                                      })}
                                      {renderThemeSettingsRow({
                                          label: (
                                              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                                                  <span>{t('app.theme.data_table.sql_editor_font_size')}</span>
                                                  <Button
                                                      size="small"
                                                      type={sqlEditorFontSizeFollowsGlobal ? 'primary' : 'default'}
                                                      onClick={() => setAppearance({
                                                          sqlEditorFontSizeFollowGlobal: !sqlEditorFontSizeFollowsGlobal,
                                                          sqlEditorFontSize: sqlEditorFontSizeFollowsGlobal
                                                              ? sanitizeSqlEditorFontSize(appearance.sqlEditorFontSize)
                                                              : null,
                                                      })}
                                                  >
                                                      {t('app.theme.data_table.follow_global')}
                                                  </Button>
                                              </span>
                                          ),
                                          stacked: true,
                                          control: (
                                              <ThemeSettingsSlider
                                                  min={MIN_SQL_EDITOR_FONT_SIZE}
                                                  max={MAX_SQL_EDITOR_FONT_SIZE}
                                                  step={1}
                                                  marks={SQL_EDITOR_FONT_SLIDER_MARKS}
                                                  disabled={sqlEditorFontSizeFollowsGlobal}
                                                  value={effectiveSqlEditorFontSize}
                                                  unit="px"
                                                  onChange={(value) => setAppearance({
                                                      sqlEditorFontSize: sanitizeSqlEditorFontSize(value),
                                                      sqlEditorFontSizeFollowGlobal: false,
                                                  })}
                                              />
                                          ),
                                      })}
                                      {renderThemeSettingsRow({
                                          label: (
                                              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                                                  <span>{t('app.theme.data_table.font_size')}</span>
                                                  <Button
                                                      size="small"
                                                      type={dataTableFontSizeFollowsGlobal ? 'primary' : 'default'}
                                                      onClick={() => setAppearance({
                                                          dataTableFontSizeFollowGlobal: !dataTableFontSizeFollowsGlobal,
                                                          dataTableFontSize: dataTableFontSizeFollowsGlobal
                                                              ? sanitizeDataTableFontSize(appearance.dataTableFontSize)
                                                              : null,
                                                      })}
                                                  >
                                                      {t('app.theme.data_table.follow_global')}
                                                  </Button>
                                              </span>
                                          ),
                                          stacked: true,
                                          control: (
                                              <ThemeSettingsSlider
                                                  min={10}
                                                  max={18}
                                                  step={1}
                                                  marks={DATA_TABLE_FONT_SLIDER_MARKS}
                                                  disabled={dataTableFontSizeFollowsGlobal}
                                                  value={effectiveDataTableFontSize}
                                                  unit="px"
                                                  onChange={(value) => setAppearance({
                                                      dataTableFontSize: sanitizeDataTableFontSize(value),
                                                      dataTableFontSizeFollowGlobal: false,
                                                  })}
                                              />
                                          ),
                                      })}
                                      {renderThemeSettingsRow({
                                          label: (
                                              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                                                  <span>{t('app.theme.data_table.sidebar_tree_font_size')}</span>
                                                  <Button
                                                      size="small"
                                                      type={sidebarTreeFontSizeFollowsGlobal ? 'primary' : 'default'}
                                                      onClick={() => setAppearance({
                                                          sidebarTreeFontSizeFollowGlobal: !sidebarTreeFontSizeFollowsGlobal,
                                                          sidebarTreeFontSize: sidebarTreeFontSizeFollowsGlobal
                                                              ? sanitizeSidebarTreeFontSize(appearance.sidebarTreeFontSize)
                                                              : null,
                                                      })}
                                                  >
                                                      {t('app.theme.data_table.follow_global')}
                                                  </Button>
                                              </span>
                                          ),
                                          stacked: true,
                                          control: (
                                              <ThemeSettingsSlider
                                                  min={10}
                                                  max={18}
                                                  step={1}
                                                  marks={DATA_TABLE_FONT_SLIDER_MARKS}
                                                  disabled={sidebarTreeFontSizeFollowsGlobal}
                                                  value={effectiveSidebarTreeFontSize}
                                                  unit="px"
                                                  onChange={(value) => setAppearance({
                                                      sidebarTreeFontSize: sanitizeSidebarTreeFontSize(value),
                                                      sidebarTreeFontSizeFollowGlobal: false,
                                                  })}
                                              />
                                          ),
                                      })}
                                  </>,
                              )}
                              {renderThemeSettingsSection(
                                  t('app.theme.startup_window.title'),
                                  renderThemeSettingsRow({
                                      label: t('app.theme.startup_window.maximised'),
                                      hint: t('app.theme.startup_window.hint'),
                                      control: (
                                          <Switch checked={startupMaximised} onChange={(checked) => setStartupMaximised(checked)} />
                                      ),
                                  }),
                              )}
                              <div style={{ display: 'flex', justifyContent: 'flex-end', paddingTop: 12 }}>
                                  <Button
                                      onClick={() => {
                                          setUiScale(DEFAULT_UI_SCALE);
                                          setFontSize(DEFAULT_FONT_SIZE);
                                          setAppearance({ ...DEFAULT_APPEARANCE });
                                      }}
                                  >
                                      {t('app.theme.action.restore_defaults')}
                                  </Button>
                              </div>
                          </div>
                      )}
                  </div>
              </div>
  );


  const renderThemeSettingsContent = (options?: { hideSectionTabs?: boolean }) => (
    renderThemeSettingsContentV2(options)
  );

  type SettingsCenterNavigationItem = {
      key: string;
      icon: React.ReactNode;
      title: string;
      description: string;
      onClick: () => void;
      children?: ReadonlyArray<SettingsCenterNavigationItem>;
  };

  type SettingsCenterNavigationGroup = {
      key: SettingsCenterGroupKey;
      icon: React.ReactNode;
      title: string;
      description: string;
      items: ReadonlyArray<SettingsCenterNavigationItem>;
  };

  const settingsCenterGroups: SettingsCenterNavigationGroup[] = [
      {
          key: 'preferences' as const,
          icon: <SettingOutlined />,
          title: t('app.settings.group.preferences.title'),
          description: t('app.settings.group.preferences.description'),
          items: [
              {
                  key: 'language',
                  icon: <GlobalOutlined />,
                  title: t('settings.language.title'),
                  description: t('settings.language.description'),
                  onClick: () => handleOpenSettingsCenterPane('preferences', 'language'),
              },
              {
                  key: 'theme',
                  icon: <SkinOutlined />,
                  title: t('app.settings.entry.theme.title'),
                  description: t('app.settings.entry.theme.description'),
                  onClick: () => {
                      setThemeModalSection('theme');
                      handleOpenSettingsCenterPane('preferences', 'theme');
                  },
                  children: themeSettingsSections.map((section) => ({
                      key: `theme-${section.value}`,
                      icon: section.icon,
                      title: section.label,
                      description: section.value === 'appearance'
                          ? t('app.theme.nav.appearance.description')
                          : section.value === 'workspace'
                              ? t('app.theme.nav.workspace.description')
                              : t('app.theme.nav.theme.description'),
                      onClick: () => {
                          setThemeModalSection(section.value);
                          handleOpenSettingsCenterPane('preferences', 'theme');
                      },
                  })),
              },
              {
                  key: 'brand-icon',
                  icon: <AppstoreOutlined />,
                  title: t('app.settings.entry.brand_icon.title'),
                  description: t('app.settings.entry.brand_icon.description'),
                  onClick: () => handleOpenSettingsCenterPane('preferences', 'brand-icon'),
              },
              {
                  key: 'sidebar-metadata',
                  icon: <TableOutlined />,
                  title: t('app.settings.sidebar_metadata.title'),
                  description: t('app.settings.sidebar_metadata.description'),
                  onClick: () => handleOpenSettingsCenterPane('preferences', 'sidebar-metadata'),
              },
              {
                  key: 'sidebar-objects',
                  icon: <FolderOpenOutlined />,
                  title: t('app.settings.sidebar_objects.title'),
                  description: t('app.settings.sidebar_objects.description'),
                  onClick: () => handleOpenSettingsCenterPane('preferences', 'sidebar-objects'),
              },
          ],
      },
      {
          key: 'services' as const,
          icon: <GlobalOutlined />,
          title: t('app.settings.group.services.title'),
          description: t('app.settings.group.services.description'),
          items: [
              {
                  key: 'proxy',
                  icon: <GlobalOutlined />,
                  title: t('app.settings.entry.proxy.title'),
                  description: t('app.settings.entry.proxy.description'),
                  onClick: () => handleOpenSettingsCenterPane('services', 'proxy'),
              },
              {
                  key: 'download-source',
                  icon: <CloudDownloadOutlined />,
                  title: t('app.settings.entry.download_source.title'),
                  description: t('app.settings.entry.download_source.description'),
                  onClick: () => handleOpenSettingsCenterPane('services', 'download-source'),
              },
              ...(isWebRuntime ? [{
                  key: 'web-auth' as const,
                  icon: <SafetyCertificateOutlined />,
                  title: t('app.settings.entry.web_auth.title'),
                  description: t('app.settings.entry.web_auth.description'),
                  onClick: () => handleOpenSettingsCenterPane('services', 'web-auth'),
              }] : []),
              {
                  key: 'cloud-backup',
                  icon: <CloudDownloadOutlined />,
                  title: t('app.settings.entry.cloud_backup.title'),
                  description: t('app.settings.entry.cloud_backup.description'),
                  onClick: () => handleOpenSettingsCenterPane('services', 'cloud-backup'),
              },
              {
                  key: 'ai',
                  icon: <RobotOutlined />,
                  title: t('app.settings.entry.ai.title'),
                  description: t('app.settings.entry.ai.description'),
                  onClick: () => {
                      setSecurityUpdateRepairSource(null);
                      setFocusedAIProviderId(undefined);
                      setAiSettingsSection('providers');
                      setAiSettingsProviderView('workspace');
                      handleOpenSettingsCenterPane('services', 'ai');
                  },
                  children: AI_SETTINGS_NAV_ITEMS.map((item) => ({
                      key: `ai-${item.key}`,
                      icon: item.icon,
                      title: t(item.titleKey),
                      description: t(item.descriptionKey),
                      onClick: () => {
                          setSecurityUpdateRepairSource(null);
                          setFocusedAIProviderId(item.key === 'providers' ? focusedAIProviderId : undefined);
                          setAiSettingsSection(item.key);
                          setAiSettingsProviderView('workspace');
                          handleOpenSettingsCenterPane('services', 'ai');
                      },
                      children: item.key === 'providers' ? [{
                          key: 'ai-providers-connected',
                          icon: item.icon,
                          title: t('ai_settings.provider.configured'),
                          description: t('ai_settings.provider.configured_hint'),
                          onClick: () => {
                              setSecurityUpdateRepairSource(null);
                              setAiSettingsSection('providers');
                              setAiSettingsProviderView('connected');
                              handleOpenSettingsCenterPane('services', 'ai');
                          },
                      }] : undefined,
                  })),
              },
          ],
      },
      {
          key: 'about' as const,
          icon: <InfoCircleOutlined />,
          title: t('app.settings.entry.about.title'),
          description: t('app.settings.entry.about.description'),
          items: [],
      },
  ];
  const isSettingsCenterContainedScrollPane =
      activeSettingsCenterPane?.key === 'theme' || activeSettingsCenterPane?.key === 'ai';
  const isV2ThemeSettingsPane = activeSettingsCenterPane?.key === 'theme';
  const activeSettingsCenterDetailPanelStyle: React.CSSProperties = {
      ...toolCenterDetailPanelStyle,
      padding: '0 4px 0 0',
      border: 'none',
      borderBottom: 'none',
      borderRadius: 0,
      background: 'transparent',
  };
  const settingsCenterDetailBodyStyle: React.CSSProperties = isSettingsCenterContainedScrollPane
      ? {
          ...toolCenterDetailBodyStyle,
          overflowY: 'hidden',
          // v2 主题设置页含 Slider 手柄横向伸出，hidden 会裁切贴边圆点
          overflowX: isV2ThemeSettingsPane ? 'visible' : 'hidden',
          // 右侧只留给内层滚动容器，避免 padding + 滚动条叠出大块空白
          paddingRight: 0,
          paddingLeft: isV2ThemeSettingsPane ? 4 : undefined,
      }
      : {
          ...toolCenterDetailBodyStyle,
          paddingRight: 0,
      };
  const renderSettingsCenterPane = () => {
      if (!activeSettingsCenterPane) {
          return null;
      }
      if (activeSettingsCenterPane.key === 'language') {
          return (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: '12px 0' }}>
                  <div style={utilityPanelStyle}>
                      <LanguageSettingsPanel />
                  </div>
              </div>
          );
      }
      if (activeSettingsCenterPane.key === 'theme') {
          return (
              <div style={{ height: '100%', minHeight: 0 }}>
                  {renderThemeSettingsContent({ hideSectionTabs: true })}
              </div>
          );
      }
      if (activeSettingsCenterPane.key === 'brand-icon') {
          return (
              <div style={{ padding: '16px 0 20px' }}>
                  <BrandIconPicker
                    value={brandIconId}
                    darkMode={darkMode}
                    accentColor={overlayTheme.selectedText}
                    ariaLabel={t('app.settings.entry.brand_icon.title')}
                    onChange={(id: BrandIconId) => {
                        setBrandIconId(id);
                        message.success(t('app.settings.entry.brand_icon.applied'));
                    }}
                  />
              </div>
          );
      }
      if (activeSettingsCenterPane.key === 'sidebar-metadata') {
          return renderSidebarMetadataSettingsPane();
      }
      if (activeSettingsCenterPane.key === 'sidebar-objects') {
          return renderSidebarObjectVisibilitySettingsPane();
      }
      if (activeSettingsCenterPane.key === 'proxy') {
          return renderProxySettingsContent();
      }
      if (activeSettingsCenterPane.key === 'download-source') {
          return renderDownloadSourceSettingsContent();
      }
      if (activeSettingsCenterPane.key === 'web-auth') {
          return (
              <WebAuthSettingsPanel
                darkMode={darkMode}
                dividerColor={overlayTheme.divider}
                mutedColor={String(utilityMutedTextStyle.color || overlayTheme.mutedText)}
                titleColor={overlayTheme.titleText}
              />
          );
      }
      if (activeSettingsCenterPane.key === 'cloud-backup') {
          return (
              <CloudBackupSettings t={t} />
          );
      }
      if (activeSettingsCenterPane.key === 'ai') {
          return (
              <div style={{ height: '100%', minHeight: 0 }}>
                  <AIPanelErrorBoundary
                    key={`ai-settings-${aiSettingsRenderNonce}`}
                    onError={handleAIPanelRenderError}
                    fallback={(error) => (
                      <Alert
                        type="error"
                        showIcon
                        message={t('app.ai_panel.error.title')}
                        description={error?.message || t('app.ai_panel.error.description')}
                        action={(
                          <Button size="small" onClick={handleRetryAISettingsRender}>
                            {t('app.ai_panel.action.reload')}
                          </Button>
                        )}
                      />
                    )}
                  >
                    <React.Suspense
                      fallback={(
                        <div style={{ height: '100%', display: 'grid', placeItems: 'center' }} aria-busy="true">
                          <Spin />
                        </div>
                      )}
                    >
                      <LazyAISettingsContent
                        active={isSettingsModalOpen && activeSettingsCenterPane.key === 'ai'}
                        darkMode={darkMode}
                        overlayTheme={overlayTheme}
                        focusProviderId={focusedAIProviderId}
                        hideSidebar
                        section={aiSettingsSection}
                        onSectionChange={(section) => {
                            setAiSettingsSection(section);
                            setAiSettingsProviderView('workspace');
                        }}
                        providersView={aiSettingsSection === 'providers' ? aiSettingsProviderView : 'workspace'}
                        onProvidersViewChange={setAiSettingsProviderView}
                        onCloseHost={handleCancelSettingsCenterPane}
                        onBeforeExternalMCPUse={handlePrepareExternalMCPUse}
                        onLeaveGuardChange={registerAISettingsLeaveGuard}
                        confirmationZIndex={applicationQuitModalZIndex + 100}
                      />
                    </React.Suspense>
                  </AIPanelErrorBoundary>
              </div>
          );
      }
      if (activeSettingsCenterPane.key === 'about-go-navi') {
          return renderSettingsCenterAboutPane();
      }
      return null;
  };

  const sidebarPanelCollapseLabel = t('app.sidebar.collapse');
  const sidebarPanelExpandLabel = t('app.sidebar.expand');
  const sidebarPanelToggleLabel = isSidebarCollapsed ? sidebarPanelExpandLabel : sidebarPanelCollapseLabel;

  return (
    <ConfigProvider
        locale={getAntdLocale(language)}
        componentSize={appComponentSize}
        theme={antdTheme}
    >
        {notificationContextHolder}
        <CustomThemeStyleHost
            contextKey={customThemeStyleContextKey}
            onAntTokensChange={setComputedCustomThemeAntTokens}
        />
        <ToolbarAppearanceStyleHost />
        <Layout
          className="gn-v2-app-root"
          data-gonavi-close-shortcut-scope="workspace"
          data-empty-workbench={tabs.length === 0 ? 'true' : 'false'}
          data-collapsed-sidebar-actions-docked={
              isCollapsedSidebarActionsDocked ? 'true' : 'false'
          }
          data-security-update-banner-visible={isSecurityUpdateBannerVisible ? 'true' : 'false'}
          style={{
            height: '100vh',
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column',
            background: 'transparent',
            borderRadius: showLinuxResizeHandles ? 0 : 'var(--gonavi-border-radius)',
            clipPath: showLinuxResizeHandles ? 'none' : 'inset(0 round var(--gonavi-border-radius))',
            backdropFilter: blurFilter,
            WebkitBackdropFilter: blurFilter,
            ['--gn-v2-empty-workbench-titlebar-overlap' as any]: `${titleBarLayout.emptyWorkbenchTopOffset}px`,
          }}
        >
          <input
            ref={browserConnectionImportInputRef}
            type="file"
            accept=".gonavi-conn,.json,.xml,.ncx"
            style={{ display: 'none' }}
            onChange={(event) => { void handleBrowserConnectionImportFileChange(event); }}
          />
          {/* Custom Title Bar */}
          <div
            className={[
              'gn-v2-titlebar',
              useNativeMacWindowControls ? 'gn-v2-titlebar-native-mac' : '',
              isCollapsedSidebarActionsDocked ? 'gn-v2-titlebar-collapsed-docked' : '',
            ].filter(Boolean).join(' ')}
            onDoubleClick={handleTitleBarDoubleClick}
            style={{
                height: titleBarHeight,
                flexShrink: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'flex-start',
                // Match the titlebar to the adjacent theme surface with its compensated opacity.
                background: 'var(--gn-bg-titlebar)',
                borderBottom: 'none',
                userSelect: 'none',
                WebkitAppRegion: isWebRuntime ? 'no-drag' : 'drag',
                '--wails-draggable': isWebRuntime ? 'no-drag' : 'drag',
                '--gn-titlebar-action-height': `${titleBarLayout.actionHeight}px`,
                '--gn-titlebar-divider-height': `${titleBarLayout.dividerHeight}px`,
                '--gn-titlebar-collapsed-upper-height': `${titleBarLayout.upperBandHeight}px`,
                '--gn-titlebar-window-controls-width': `${isWebRuntime ? titleBarButtonWidth : (useNativeMacWindowControls ? 0 : titleBarButtonWidth * 3)}px`,
                '--gn-titlebar-native-content-offset': `${getMacNativeTitlebarContentOffset(titleBarHeight, useNativeMacWindowControls)}px`,
                paddingLeft: getMacNativeTitlebarPaddingLeft(effectiveUiScale, useNativeMacWindowControls),
                paddingRight: getMacNativeTitlebarPaddingRight(effectiveUiScale, useNativeMacWindowControls),
                fontSize: tokenFontSize
            } as any}
          >
              <div className="gonavi-titlebar-leading">
                  <div
                    data-titlebar-brand-region="true"
                    style={{ display: 'flex', alignItems: 'center', gap: Math.max(6, Math.round(8 * effectiveUiScale)), fontWeight: 700, minWidth: 0, letterSpacing: '-0.01em' }}
                  >
                      <span>GoNavi</span>
                  </div>
                  <TitleBarPrimaryActions
                    newQueryLabel={t(primaryActionIsMessageQueue
                      ? 'message_queue_workbench.action.open'
                      : 'query.new')}
                    newConnectionLabel={t('connection.new')}
                    newQueryShortcut={titleBarNewQueryShortcut}
                    newConnectionShortcut={titleBarNewConnectionShortcut}
                    onNewQuery={handleNewQuery}
                    onNewConnection={handleCreateConnection}
                    connectionGroupLabel={t('connection.sidebar.management.title')}
                    onConnectionGroupManagement={() => setIsConnectionGroupManagementOpen(true)}
                  />
                  <div id="gonavi-titlebar-quick-actions" className="gonavi-titlebar-quick-actions-slot" />
              </div>
              {isCollapsedSidebarActionsDocked && (
                  <div
                    ref={setCollapsedSidebarActionsTarget}
                    className="gn-v2-collapsed-sidebar-actions"
                    data-collapsed-sidebar-actions="true"
                    data-no-titlebar-toggle="true"
                    role="toolbar"
                    aria-label={t('sidebar.rail.system_actions')}
                    onDoubleClick={(event) => event.stopPropagation()}
                  />
              )}
              {/* Collapsed sidebar titlebar actions end */}
              <div className="gn-v2-titlebar-right">
                  <TitleBarSystemActions
                    aiAssistantLabel={t('app.sidebar.ai_assistant')}
                    settingsLabel={t('app.sidebar.settings')}
                    aiActive={aiPanelVisible}
                    onToggleAI={handleToggleOrFocusAIPanel}
                    onOpenSettings={handleOpenSettingsModal}
                  />
                  {isWebRuntime ? (
                      <div
                        onDoubleClick={(e) => e.stopPropagation()}
                        style={{ display: 'flex', alignItems: 'center', gap: 8, WebkitAppRegion: 'no-drag', '--wails-draggable': 'no-drag' } as any}
                      >
                          <Tooltip title="退出当前 Web 会话">
                              <Button
                                type="text"
                                icon={<PoweroffOutlined />}
                                className="titlebar-web-logout-btn"
                                style={{ height: '100%', borderRadius: 8, width: titleBarButtonWidth }}
                                onClick={() => { void handleWebLogout(); }}
                              />
                          </Tooltip>
                      </div>
                  ) : useNativeMacWindowControls ? null : (
                      <div
                        className="titlebar-window-controls"
                        data-no-titlebar-toggle="true"
                        onDoubleClick={(e) => e.stopPropagation()}
                        style={{ display: 'flex', height: '100%', WebkitAppRegion: 'no-drag', '--wails-draggable': 'no-drag' } as any}
                      >
                          <Button
                            type="text"
                            icon={<TitleBarMinimizeIcon />}
                            className="titlebar-window-control-btn"
                            style={{ height: '100%', borderRadius: 0, width: titleBarButtonWidth }}
                            onClick={WindowMinimise}
                          />
                          <Button
                            type="text"
                            icon={titleBarToggleIconKey === 'restore' ? <TitleBarRestoreIcon /> : <TitleBarMaximizeIcon />}
                            className="titlebar-window-control-btn"
                            style={{ height: '100%', borderRadius: 0, width: titleBarButtonWidth }}
                            onClick={() => { void handleTitleBarWindowToggle(); }}
                          />
                          <Button
                            type="text"
                            icon={<TitleBarCloseIcon />}
                            danger
                            className="titlebar-close-btn titlebar-window-control-btn"
                            style={{ height: '100%', borderRadius: 0, width: titleBarButtonWidth }}
                            onClick={() => { void handleApplicationQuitRequest(); }}
                          />
                      </div>
                  )}
              </div>
          </div>

          {showLinuxCJKFontBanner && (
              <LinuxCJKFontBanner
                darkMode={darkMode}
                installHint={linuxCJKFontInstallHint || ''}
                onOpenFontSettings={() => {
                        setThemeModalSection('appearance');
                        setIsThemeModalOpen(true);
                }}
                onDismiss={() => setIsLinuxCJKFontBannerDismissed(true)}
              />
          )}

          <Layout style={{ flex: 1, minHeight: 0, minWidth: 0 }}>
          <Sider
            ref={siderRef}
            width={sidebarWidth}
            collapsible
            collapsed={isSidebarCollapsed}
            collapsedWidth={sidebarCollapsedWidth}
            trigger={null}
            data-sidebar-panel="true"
            data-sidebar-collapsed={isSidebarCollapsed}
            data-sidebar-actions-placement={isCollapsedSidebarActionsDocked ? 'titlebar' : 'fixed-rail'}
            className="gn-v2-app-sider"
            style={{
                borderRight: 'none',
                position: 'relative',
                background: 'var(--gn-bg-panel-2)',
                ['--gonavi-sidebar-collapsed-width' as any]: `${sidebarCollapsedWidth}px`,
                ['--gonavi-sidebar-resize-inner-hit-width' as any]: `${sidebarResizeHandleWidth / 2}px`,
            }}
          >
            <div
                ref={sidebarContentRef}
                data-sidebar-content="true"
                aria-hidden={isCollapsedSidebarActionsDocked ? true : undefined}
                style={{
                    height: '100%',
                    display: 'flex',
                    flexDirection: 'column',
                    overflow: 'hidden',
                }}
            >
                <div style={{ flex: 1, overflow: 'hidden', paddingBottom: 0, paddingRight: 0, position: 'relative' }}>
                    <div style={{ height: '100%', opacity: connectionWorkbenchState.ready ? 1 : 0.72, pointerEvents: connectionWorkbenchState.ready ? 'auto' : 'none' }}>
                        <Sidebar
                            onCreateConnection={handleCreateConnection}
                            onCreateConnectionInGroup={handleCreateConnectionInGroup}
                            onEditConnection={handleEditConnection}
                            onOpenSettings={handleOpenSettingsModal}
                            onOpenSettingsNavigation={handleTitleBarSettingsNavigation}
                            isWebRuntime={isWebRuntime}
                            onOpenDataSyncWorkbench={handleOpenDataSyncWorkbench}
                            onToggleAI={handleToggleOrFocusAIPanel}
                            onToggleLogPanel={handleToggleLogPanel}
                            v2ExplorerContext={v2ExplorerContext}
                            collapsedSidebarActionsTarget={collapsedSidebarActionsTarget}
                            onFocusCommandSearch={handleFocusSidebarSearch}
                            onCollapseSidebar={handleCollapseSidebarPanel}
                            onExpandSidebar={handleExpandSidebarPanel}
                            onEnsureSidebarExpanded={isSidebarCollapsed ? handleExpandSidebarPanel : undefined}
                            onTitlebarSnapshotChange={setSidebarTitlebarSnapshot}
                            collapseSidebarLabel={sidebarPanelCollapseLabel}
                            collapseSidebarButtonRef={sidebarExplorerToggleRef}
                            expandSidebarLabel={sidebarPanelExpandLabel}
                            expandSidebarButtonRef={sidebarCollapsedToggleRef}
                        />
                    </div>
                    {!connectionWorkbenchState.ready && (
                        <div
                            style={{
                                position: 'absolute',
                                inset: 0,
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                padding: 16,
                                background: darkMode ? 'rgba(7, 12, 20, 0.42)' : 'rgba(255, 255, 255, 0.58)',
                                backdropFilter: 'blur(4px)',
                                zIndex: 1,
                            }}
                        >
                            <div
                                style={{
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    gap: 10,
                                    padding: '10px 14px',
                                    borderRadius: 999,
                                    background: darkMode ? 'rgba(15, 23, 36, 0.86)' : 'rgba(255, 255, 255, 0.94)',
                                    border: darkMode ? '1px solid rgba(255,255,255,0.08)' : '1px solid rgba(22,32,51,0.08)',
                                    boxShadow: darkMode ? '0 12px 24px rgba(0,0,0,0.26)' : '0 12px 24px rgba(15,23,42,0.08)',
                                    color: darkMode ? 'rgba(255,255,255,0.88)' : '#162033',
                                    fontSize: 12,
                                    fontWeight: 500,
                                }}
                            >
                                <Spin size="small" />
                                <span>{connectionWorkbenchState.message}</span>
                            </div>
                        </div>
                    )}
                </div>


            </div>
            {!isSidebarCollapsed && <div
                data-sidebar-resize-handle="true"
                onMouseDown={handleSidebarMouseDown}
                onContextMenu={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                }}
                role="separator"
                aria-orientation="vertical"
                title={t('app.sidebar.resize_width')}
                style={{
                    position: 'absolute',
                    right: -(sidebarResizeHandleWidth / 2),
                    top: 0,
                    bottom: 0,
                    width: sidebarResizeHandleWidth,
                    cursor: 'col-resize',
                    zIndex: 3,
                    touchAction: 'none',
                    userSelect: 'none',
                    WebkitUserSelect: 'none',
                    background: 'transparent',
                }}
            />}
          </Sider>
           <Content
             style={{ background: 'var(--gn-bg-panel-2)', overflow: 'hidden', display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}
           >
             {isSecurityUpdateBannerVisible && (
                <SecurityUpdateBanner
                  status={securityUpdateStatus}
                  darkMode={darkMode}
                  overlayTheme={overlayTheme}
                  surfaceOpacity={effectiveOpacity}
                  onStart={handleStartSecurityUpdate}
                  onRetry={handleRetrySecurityUpdate}
                  onRestart={handleRestartSecurityUpdate}
                  onOpenDetails={() => handleOpenSecurityUpdateSettings(
                      hasSecurityUpdateRecentResult(securityUpdateStatus) ? 'recent_result' : null,
                  )}
                  onDismiss={() => setIsSecurityUpdateBannerDismissed(true)}
                />
             )}
             <div style={{ flex: 1, minHeight: 0, minWidth: 0, overflow: 'hidden', display: 'flex', flexDirection: 'row', position: 'relative' }}>
               <div style={{ flex: 1, minHeight: 0, minWidth: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column', background: 'transparent', marginBottom: isLogPanelOpen ? 8 : 0, borderRadius: isLogPanelOpen ? 'var(--gonavi-border-radius)' : 0, clipPath: isLogPanelOpen ? 'inset(0 round var(--gonavi-border-radius))' : 'none' }}>
                  <TabManager onFocusSidebarSearch={handleFocusSidebarSearch} />
                  <FloatingWorkbenchWindows />
                  <FloatingQueryResultWindows />
                  <NativeDetachedWindowController
                    onOpenAISettings={handleOpenAISettings}
                    onToggleAI={handleToggleOrFocusAIPanel}
                  />
               </div>

               {aiPanelVisible && !aiChatDetached && (
                  <div
                    className={aiPanelOverlayActive ? 'gn-v2-ai-panel-overlay' : undefined}
                    style={aiPanelOverlayActive
                      ? aiPanelFullscreenOverlay
                        ? {
                            position: 'fixed',
                            top: titleBarHeight,
                            right: 0,
                            bottom: 0,
                            left: 0,
                            display: 'flex',
                            justifyContent: 'flex-end',
                            pointerEvents: 'none',
                            zIndex: 14,
                          }
                        : { position: 'absolute', inset: 0, display: 'flex', justifyContent: 'flex-end', pointerEvents: 'none', zIndex: 14 }
                      : { position: 'relative', display: 'flex', flexShrink: 0, overflow: 'visible' }}
                  >
                      {aiPanelOverlayActive && (
                          <button
                            type="button"
                            className="gn-v2-ai-panel-backdrop"
                            aria-label={t('app.ai_panel.aria.close')}
                            onClick={handleCloseAIPanel}
                            style={{
                              position: 'absolute',
                              inset: 0,
                              border: 0,
                              padding: 0,
                              background: darkMode ? 'rgba(3, 7, 18, 0.26)' : 'rgba(248, 250, 252, 0.38)',
                              backdropFilter: 'blur(2px)',
                              pointerEvents: 'auto',
                            }}
                          />
                      )}
                      <div
                        className={`gn-v2-ai-panel-dock${aiPanelOverlayActive ? ' is-overlay' : ''}`}
                        style={aiPanelOverlayActive
                          ? {
                              position: 'relative',
                              display: 'flex',
                              height: '100%',
                              pointerEvents: 'auto',
                              zIndex: 1,
                              boxShadow: '0 18px 48px rgba(15, 23, 42, 0.18)',
                            }
                          : undefined}
                      >

                      <AIPanelErrorBoundary
                        key={aiPanelRenderNonce}
                        onError={handleAIPanelRenderError}
                        fallback={(error) => (
                          <div
                            style={{
                              width: aiPanelRenderWidth,
                              minWidth: 0,
                              height: '100%',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              padding: 20,
                              background: bgContent,
                              color: darkMode ? 'rgba(255,255,255,0.88)' : '#162033',
                            }}
                          >
                            <div
                              style={{
                                width: '100%',
                                maxWidth: 360,
                                display: 'grid',
                                gap: 12,
                                padding: 18,
                                borderRadius: 16,
                                border: darkMode ? '1px solid rgba(255,255,255,0.12)' : '1px solid rgba(15,23,42,0.08)',
                                background: darkMode ? 'rgba(15,23,42,0.72)' : 'rgba(255,255,255,0.94)',
                                boxShadow: darkMode ? '0 16px 36px rgba(0,0,0,0.32)' : '0 16px 36px rgba(15,23,42,0.12)',
                              }}
                            >
                              <div style={{ fontSize: 15, fontWeight: 600 }}>{t('app.ai_panel.error.title')}</div>
                              <div style={{ fontSize: 12, lineHeight: 1.6, color: darkMode ? 'rgba(255,255,255,0.68)' : '#526075' }}>
                                {t('app.ai_panel.error.description')}
                              </div>
                              {error?.message && (
                                <div
                                  style={{
                                    fontSize: 12,
                                    lineHeight: 1.5,
                                    wordBreak: 'break-word',
                                    padding: '10px 12px',
                                    borderRadius: 10,
                                    background: darkMode ? 'rgba(2,6,23,0.7)' : 'rgba(248,250,252,0.92)',
                                    border: darkMode ? '1px solid rgba(148,163,184,0.18)' : '1px solid rgba(148,163,184,0.22)',
                                  }}
                                >
                                  {error.message}
                                </div>
                              )}
                              <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                                <Button aria-label={t('app.ai_panel.aria.close')} onClick={handleCloseAIPanel}>{t('app.ai_panel.action.close')}</Button>
                                <Button type="primary" onClick={handleRetryAIPanelRender}>{t('app.ai_panel.action.reload')}</Button>
                              </div>
                            </div>
                          </div>
                        )}
                      >
                        <React.Suspense
                          fallback={(
                            <div
                              style={{
                                width: aiPanelRenderWidth,
                                height: '100%',
                                display: 'grid',
                                placeItems: 'center',
                                background: bgContent,
                              }}
                              aria-busy="true"
                            >
                              <Spin />
                            </div>
                          )}
                        >
                          <LazyAIChatPanel
                            width={aiPanelRenderWidth}
                            darkMode={darkMode}
                            bgColor={bgContent}
                            presentation="dock"
                            onClose={handleCloseAIPanel}
                            onDetach={handleDetachAIPanel}
                            onRegisterTerminalGuard={registerAIPanelTerminalGuard}
                            onOpenSettings={(providerId) => {
                              handleOpenAISettings(providerId);
                            }}
                            overlayTheme={overlayTheme}
                          />
                        </React.Suspense>
                      </AIPanelErrorBoundary>
                      </div>
                  </div>
               )}
               {aiPanelVisible && aiChatDetached && !hasNativeDetachedWindowManager() && (
                  <FloatingAIChatWindow
                    darkMode={darkMode}
                    bgColor={bgContent}
                    overlayTheme={overlayTheme}
                    renderNonce={aiPanelRenderNonce}
                    onOpenSettings={(providerId) => handleOpenAISettings(providerId)}
                    onRenderError={handleAIPanelRenderError}
                    onRetryRender={handleRetryAIPanelRender}
                    onRegisterTerminalGuard={registerAIPanelTerminalGuard}
                  />
               )}
             </div>

          </Content>
          </Layout>
          {isConnectionModalMounted && (
          <ConnectionModal
            open={isModalOpen}
            onClose={handleCloseModal}
            initialValues={editingConnection}
            modalZIndex={isConnectionGroupManagementOpen ? APP_NESTED_MODAL_Z_INDEX : undefined}
            onOpenDriverManager={handleOpenDriverManagerFromConnection}
            onSaved={handleConnectionSaved}
            onOpenConnectionHealth={(connection) => {
              handleCloseModal();
              handleOpenConnectionHealth([connection.id]);
            }}
          />
          )}
          {isSettingsModalOpen && (() => {
            const toolCenterGroups: SettingsCenterNavigationGroup[] = [
              {
                key: 'config',
                icon: <SettingOutlined />,
                title: t('app.tools.group.config.title'),
                description: t('app.tools.group.config.description'),
                items: [
                  {
                    key: 'import',
                    icon: <UploadOutlined />,
                    title: t('app.tools.entry.import.title'),
                    description: t('app.tools.entry.import.description'),
                    onClick: () => {
                      handleOpenToolCenterPane('config', 'import');
                    },
                  },
                  {
                    key: 'export',
                    icon: <DownloadOutlined />,
                    title: t('app.tools.entry.export.title'),
                    description: t('app.tools.entry.export.description'),
                    onClick: () => {
                      handleOpenToolCenterPane('config', 'export');
                      void handleExportConnections('config');
                    },
                  },
                  {
                    key: 'connection-health',
                    icon: <SafetyCertificateOutlined />,
                    title: t('app.tools.entry.connection_health.title'),
                    description: t('app.tools.entry.connection_health.description'),
                    onClick: () => {
                      handleOpenToolCenterPane('config', 'connection-health');
                      handleOpenConnectionHealth();
                    },
                  },
                  {
                    key: 'data-root',
                    icon: <HddOutlined />,
                    title: t('app.tools.entry.data_root.title'),
                    description: t('app.tools.entry.data_root.description'),
                    onClick: () => {
                      handleOpenToolCenterPane('config', 'data-root-application');
                    },
                    children: [
                      {
                        key: 'data-root-application',
                        icon: <HddOutlined />,
                        title: t('app.data_root.current_directory'),
                        description: t('app.data_root.description'),
                        onClick: () => handleOpenToolCenterPane('config', 'data-root-application'),
                      },
                      {
                        key: 'data-root-agent',
                        icon: <RobotOutlined />,
                        title: t('app.data_root.agent_data.title'),
                        description: t('app.data_root.agent_data.description'),
                        onClick: () => handleOpenToolCenterPane('config', 'data-root-agent'),
                      },
                      {
                        key: 'data-root-saved-queries',
                        icon: <FileTextOutlined />,
                        title: t('app.data_root.saved_query_directory.title'),
                        description: t('app.data_root.saved_query_directory.description'),
                        onClick: () => handleOpenToolCenterPane('config', 'data-root-saved-queries'),
                      },
                    ],
                  },
                  {
                    key: 'security-update',
                    icon: <SafetyCertificateOutlined />,
                    title: t('app.tools.entry.security_update.title'),
                    description: securityUpdateEntryVisibility.showDetailEntry || securityUpdateHasLegacySensitiveItems
                      ? t('app.tools.entry.security_update.status_description', { status: securityUpdateStatusMeta.label })
                      : t('app.tools.entry.security_update.description'),
                    onClick: () => {
                      handleOpenToolCenterPane('config', 'security-update');
                    },
                  },
                ],
              },
              {
                key: 'workflow',
                icon: <SwitcherOutlined />,
                title: t('app.tools.group.workflow.title'),
                description: t('app.tools.group.workflow.description'),
                items: [
                  {
                    key: 'schema-compare',
                    icon: <AppstoreOutlined />,
                    title: t('app.tools.entry.schema_compare.title'),
                    description: t('app.tools.entry.schema_compare.description'),
                    onClick: () => {
                      handleOpenDataSyncWorkbench('schemaCompare');
                    },
                  },
                  {
                    key: 'data-compare',
                    icon: <SwitcherOutlined />,
                    title: t('app.tools.entry.data_compare.title'),
                    description: t('app.tools.entry.data_compare.description'),
                    onClick: () => {
                      handleOpenDataSyncWorkbench('dataCompare');
                    },
                  },
                  {
                    key: 'sync',
                    icon: <UploadOutlined rotate={90} />,
                    title: t('app.tools.entry.sync.title'),
                    description: t('app.tools.entry.sync.description'),
                    onClick: () => {
                      handleOpenDataSyncWorkbench('sync');
                    },
                  },
                ],
              },
              {
                key: 'workspace',
                icon: <CodeOutlined />,
                title: t('app.tools.group.workspace.title'),
                description: t('app.tools.group.workspace.description'),
                items: [
                  {
                    key: 'drivers',
                    icon: <SettingOutlined />,
                    title: t('app.tools.entry.drivers.title'),
                    description: t('app.tools.entry.drivers.description'),
                    onClick: () => {
                      handleOpenToolCenterPane('workspace', 'drivers');
                    },
                  },
                  {
                    key: 'snippet-settings',
                    icon: <CodeOutlined />,
                    title: t('app.tools.entry.snippets.title'),
                    description: t('app.tools.entry.snippets.description'),
                    onClick: () => {
                      handleOpenToolCenterPane('workspace', 'snippet-settings');
                    },
                  },
                  {
                    key: 'shortcut-settings',
                    icon: <LinkOutlined />,
                    title: t('app.tools.entry.shortcuts.title'),
                    description: t('app.tools.entry.shortcuts.description'),
                    onClick: () => {
                      handleOpenToolCenterPane('workspace', 'shortcut-settings');
                    },
                  },
                  {
                    key: 'sql-audit',
                    icon: <AuditOutlined />,
                    title: t('app.tools.entry.sql_audit.title'),
                    description: t('app.tools.entry.sql_audit.description'),
                    onClick: () => {
                      handleCancelSettingsCenterPane();
                      addTab(buildSqlAuditWorkbenchTab());
                    },
                  },
                  {
                    key: 'request-diagnostics',
                    icon: <BugOutlined />,
                    title: '请求诊断',
                    description: '按请求 ID 查看默认脱敏、可复制导出的调用追踪。',
                    onClick: () => {
                      handleCancelSettingsCenterPane();
                      addTab(buildRequestDiagnosticsWorkbenchTab());
                    },
                  },
                ],
              },
            ];
            const combinedSettingsCenterGroups = [
              ...settingsCenterGroups.filter((group) => group.key !== 'about'),
              ...toolCenterGroups,
              ...settingsCenterGroups.filter((group) => group.key === 'about'),
            ];
            const activeSettingsCenterGroup = combinedSettingsCenterGroups.find(
              (group) => group.key === activeSettingsCenterGroupKey,
            ) ?? combinedSettingsCenterGroups[0];
            const activeSettingsCenterTreeItemKey = activeSettingsCenterPane?.key === 'theme'
              ? `theme-${themeModalSection}`
              : activeSettingsCenterPane?.key === 'ai'
                ? (aiSettingsSection === 'providers' && aiSettingsProviderView === 'connected'
                    ? 'ai-providers-connected'
                    : `ai-${aiSettingsSection}`)
                : (activeSettingsCenterPane?.key ?? null);
            const activeSettingsCenterPaneItem = activeSettingsCenterPane
              ? (
                  findSettingsCenterTreeItem(
                    combinedSettingsCenterGroups,
                    activeSettingsCenterPane.group,
                    activeSettingsCenterTreeItemKey,
                  )
                  ?? findSettingsCenterTreeItem(
                    combinedSettingsCenterGroups,
                    activeSettingsCenterPane.group,
                    activeSettingsCenterPane.key,
                  )
                )
              : null;
            const isActiveToolCenterPane = activeSettingsCenterPane
              ? isToolCenterGroupKey(activeSettingsCenterPane.group)
              : false;
            if (!activeSettingsCenterGroup) {
              return null;
            }
            const activateSettingsCenterGroup = (group: typeof combinedSettingsCenterGroups[number]) => {
              if (isToolCenterGroupKey(group.key)) {
                handleOpenToolsModal(group.key);
                return;
              }
              handleOpenSettingsModal(group.key);
            };
            const renderToolCenterPane = () => {
              if (!activeSettingsCenterPane || !isToolCenterGroupKey(activeSettingsCenterPane.group)) {
                return null;
              }

              if (activeSettingsCenterPane.key === 'import') {
                return (
                  <ConnectionImportSettingsPanel
                    groupOptions={connectionImportGroupOptions}
                    targetGroupId={connectionImportTargetTagId}
                    password={connectionPackageDialog.mode === 'import' ? connectionPackageDialog.password : ''}
                    protectedPackageReady={Boolean(pendingConnectionImportPayload)}
                    busy={connectionPackageDialog.mode === 'import' && connectionPackageDialog.confirmLoading}
                    error={connectionPackageDialog.mode === 'import' ? connectionPackageDialog.error : ''}
                    notice={connectionImportNotice}
                    onTargetGroupChange={(groupID) => {
                        setConnectionImportTargetTagId(groupID);
                        setConnectionImportNotice(null);
                        setConnectionPackageDialog((current) => ({ ...current, error: '' }));
                    }}
                    onChooseFile={() => void handleImportConnections('config')}
                    onPasswordChange={(value) => {
                        setConnectionPackageDialog((current) => ({
                            ...current,
                            password: value,
                            error: '',
                        }));
                    }}
                    onConfirmProtectedPackage={() => void handleConfirmConnectionPackageDialog()}
                    onDiscardProtectedPackage={() => {
                        setPendingConnectionImportPayload(null);
                        setConnectionPackageDialog((current) => ({
                            ...current,
                            open: false,
                            password: '',
                            error: '',
                            confirmLoading: false,
                        }));
                    }}
                  />
                );
              }

              if (isConnectionPackageSettingsPaneKey(activeSettingsCenterPane.key)) {
                if (!connectionPackageDialog.open) {
                  return (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: '12px 0' }}>
                      <div style={utilityPanelStyle}>
                        <div style={utilityMutedTextStyle}>
                          {t('app.tools.entry.export.description')}
                        </div>
                        <div style={{ marginTop: 12, ...utilityMutedTextStyle }}>
                          {t('app.connection_package.message.no_connections_to_export')}
                        </div>
                      </div>
                    </div>
                  );
                }
                return (
                  <ConnectionPackagePasswordModal
                    embedded
                    open={connectionPackageDialog.open}
                    title={connectionPackageDialog.mode === 'export'
                        ? t('app.connection_package.dialog.export_title')
                        : t('app.connection_package.dialog.import_password_title')}
                    mode={connectionPackageDialog.mode}
                    includeSecrets={connectionPackageDialog.includeSecrets}
                    useFilePassword={connectionPackageDialog.useFilePassword}
                    password={connectionPackageDialog.password}
                    error={connectionPackageDialog.error}
                    confirmLoading={connectionPackageDialog.confirmLoading}
                    connectionOptions={connections.map((item) => ({
                      value: item.id,
                      label: item.name || item.id,
                      type: item.config?.type,
                    }))}
                    selectedConnectionIds={connectionPackageDialog.selectedConnectionIds}
                    onSelectedConnectionIdsChange={(ids) => {
                        setConnectionPackageDialog((current) => ({
                            ...current,
                            selectedConnectionIds: ids,
                            error: '',
                        }));
                    }}
                    confirmText={connectionPackageDialog.mode === 'export'
                        ? t('app.connection_package.action.start_export')
                        : t('app.connection_package.action.start_import')}
                    onIncludeSecretsChange={(value) => {
                        setConnectionPackageDialog((current) => ({
                            ...current,
                            includeSecrets: value,
                            useFilePassword: value ? current.useFilePassword : false,
                            password: value ? current.password : '',
                            error: '',
                        }));
                    }}
                    onUseFilePasswordChange={(value) => {
                        setConnectionPackageDialog((current) => ({
                            ...current,
                            useFilePassword: value,
                            password: value ? current.password : '',
                            error: '',
                        }));
                    }}
                    onPasswordChange={(value) => {
                        setConnectionPackageDialog((current) => ({
                            ...current,
                            password: value,
                            error: '',
                        }));
                    }}
                    onConfirm={() => {
                        void handleConfirmConnectionPackageDialog();
                    }}
                    onCancel={closeConnectionPackageDialog}
                  />
                );
              }

              if (activeSettingsCenterPane.key === 'connection-health') {
                return (
                  <ConnectionHealthModal
                    embedded
                    open
                    targetConnectionIds={connectionHealthTargetIds}
                    onClose={closeConnectionHealthSettingsPane}
                  />
                );
              }

              if (activeSettingsCenterPane.key.startsWith('data-root')) {
                const dataDirectorySection = activeSettingsCenterPane.key === 'data-root-agent'
                  ? 'agent'
                  : activeSettingsCenterPane.key === 'data-root-saved-queries'
                    ? 'saved-queries'
                    : 'application';
                if (isWebRuntime) {
                  return renderDataDirectorySettings(dataDirectorySection, true);
                }
                return (
                  <Modal
                    embedded
                    open
                    title={null}
                    closable={false}
                    onCancel={handleCancelSettingsCenterPane}
                    footer={[
                      <Button key="close" type="primary" onClick={handleCancelSettingsCenterPane}>
                        {t('common.close')}
                      </Button>,
                    ]}
                    styles={{
                      header: { background: 'transparent', borderBottom: 'none', paddingBottom: 8 },
                      body: { paddingTop: 8 },
                      footer: { background: 'transparent', borderTop: 'none', paddingTop: 10 },
                    }}
                  >
                    {renderDataDirectorySettings(dataDirectorySection)}
                  </Modal>
                );
              }

              if (activeSettingsCenterPane.key === 'security-update') {
                return (
                  <SecurityUpdateSettingsModal
                    embedded
                    open
                    darkMode={darkMode}
                    overlayTheme={overlayTheme}
                    surfaceOpacity={effectiveOpacity}
                    status={securityUpdateStatus}
                    focusTarget={securityUpdateSettingsFocusTarget}
                    focusRequest={securityUpdateSettingsFocusRequest}
                    onClose={handleCancelSettingsCenterPane}
                    onStart={handleStartSecurityUpdate}
                    onRetry={handleRetrySecurityUpdate}
                    onRestart={handleRestartSecurityUpdate}
                    onIssueAction={handleSecurityUpdateIssueAction}
                  />
                );
              }

              if (activeSettingsCenterPane.key === 'drivers') {
                return (
                  <div style={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                    <DriverManagerModal
                      embedded
                      open
                      onClose={handleCancelSettingsCenterPane}
                      onOpenGlobalProxySettings={() => handleOpenSettingsCenterPane('services', 'proxy')}
                      onSwitchDownloadSource={() => void handleDownloadSourceChange(getNextDownloadSource(downloadSource))}
                      downloadSourceSwitching={downloadSourceSaving}
                      downloadSource={downloadSource}
                    />
                  </div>
                );
              }

              if (activeSettingsCenterPane.key === 'snippet-settings') {
                return (
                  <SnippetSettingsModal
                    embedded
                    open
                    onClose={handleCancelSettingsCenterPane}
                    darkMode={darkMode}
                    overlayTheme={overlayTheme}
                  />
                );
              }

              if (activeSettingsCenterPane.key === 'shortcut-settings') {
                return (
                  <Modal
                    embedded
                    open
                    title={null}
                    closable={false}
                    onCancel={() => {
                      setCapturingShortcutAction(null);
                      handleCancelSettingsCenterPane();
                    }}
                    footer={(
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <Button
                        key="reset"
                        style={{ marginRight: 'auto' }}
                        onClick={() => {
                           resetShortcutOptions();
                           setCapturingShortcutAction(null);
                           void message.success(t('app.shortcuts.message.restored_defaults'));
                        }}
                      >
                        {t('app.shortcuts.action.restore_defaults')}
                      </Button>
                      <Button
                        key="close"
                        type="primary"
                        onClick={() => {
                          setCapturingShortcutAction(null);
                          handleCancelSettingsCenterPane();
                        }}
                      >
                         {t('common.close')}
                      </Button>
                      </div>
                    )}
                    styles={{
                      header: { background: 'transparent', borderBottom: 'none', paddingBottom: 8 },
                      body: { paddingTop: 8, overflow: 'hidden', flex: 1, minHeight: 0 },
                      footer: { background: 'transparent', borderTop: 'none', paddingTop: 10 },
                    }}
                  >
                    <div data-gonavi-shortcut-modal-scroll="true" className="gonavi-settings-center-pane-scroll" style={{ height: '100%', overflowY: 'auto', overflowX: 'hidden', display: 'flex', flexDirection: 'column', gap: 16, paddingTop: 8, paddingRight: 4 }}>
                      <div style={utilityPanelStyle}>
                        <div style={{ fontSize: 12, color: darkMode ? 'rgba(255,255,255,0.5)' : 'rgba(16,24,40,0.55)' }}>
                             {t('app.shortcuts.capture_hint')}
                        </div>
                      </div>
                      {SHORTCUT_ACTION_ORDER.map((action) => {
                        const meta = SHORTCUT_ACTION_META[action];
                        if (meta.platformOnly === 'mac' && !isMacRuntime) {
                            return null;
                        }
                        const binding = resolveShortcutBinding(shortcutOptions, action, activeShortcutPlatform);
                        const isCapturing = capturingShortcutAction === action;
                        const conflicts = shortcutConflictMap[action];
                        const conflictInfo = conflicts?.length ? splitConflictsByContext(conflicts) : null;
                        return (
                            <div
                                key={action}
                                style={{
                                    ...utilityPanelStyle,
                                    display: 'grid',
                                    gridTemplateColumns: '1fr auto',
                                    gap: 12,
                                    alignItems: 'center',
                                    padding: '10px 12px',
                                }}
                            >
                                <div>
                                    <div style={{ fontWeight: 500 }}>{meta.label}</div>
                                    <div style={{ fontSize: 12, color: darkMode ? 'rgba(255,255,255,0.5)' : 'rgba(16,24,40,0.55)' }}>{meta.description}</div>
                                    {conflictInfo && (
                                        <div style={{ fontSize: 11, color: darkMode ? '#faad14' : '#d48806', marginTop: 2 }}>
                                            {conflictInfo.hasMonaco && (
                                                <>⚠ {t('app.shortcuts.message.reserved_conflict_info', { labels: conflictInfo.monacoLabels })}</>
                                             )}
                                             {conflictInfo.hasOther && (
                                                <>⚠ {t('app.shortcuts.message.reserved_conflict_warning', { contexts: conflictInfo.otherContexts, labels: conflictInfo.otherLabels })}</>
                                             )}
                                        </div>
                                    )}
                                </div>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                    <Input
                                        readOnly
                                        value={isCapturing ? t('app.shortcuts.capture_waiting') : getShortcutDisplayLabel(binding.combo, activeShortcutPlatform)}
                                        style={{ width: 180, fontFamily: resolvedMonoFontFamily }}
                                    />
                                    <Button
                                        size="small"
                                        onClick={() => setCapturingShortcutAction((prev) => (prev === action ? null : action))}
                                    >
                                        {isCapturing ? t('common.cancel') : t('app.shortcuts.action.record')}
                                    </Button>
                                    <Switch
                                        checked={binding.enabled}
                                        onChange={(checked) => updateShortcut(action, { enabled: checked }, activeShortcutPlatform)}
                                    />
                                </div>
                            </div>
                        );
                      })}
                    </div>
                  </Modal>
                );
              }

              return null;
            };

            return (
              <SettingsCenterWorkbenchRegistrar>
                <div
                  className={`gonavi-settings-center-modal gonavi-settings-center-workbench${activeSettingsCenterPane?.key === 'ai' ? ' gonavi-provider-settings-host' : ''}`}
                  style={{
                    height: '100%',
                    minHeight: 0,
                    display: 'flex',
                    flexDirection: 'column',
                    overflow: 'hidden',
                    background: 'transparent',
                  }}
                >
                <div style={{ ...toolCenterModalWorkspaceStyle, flex: 1, minHeight: 0, padding: '4px 0 8px 8px' }}>
                    <div className="gonavi-settings-center-layout" style={toolCenterModalSplitStyle}>
                    <div className="gonavi-settings-center-groups" style={toolCenterNavPanelStyle}>
                      <SettingsCenterTreeNav
                        groups={combinedSettingsCenterGroups}
                        activeGroupKey={activeSettingsCenterGroup.key}
                        activeItemKey={activeSettingsCenterTreeItemKey}
                        darkMode={darkMode}
                        overlayTheme={overlayTheme}
                        ariaLabel={t('app.settings.title')}
                        onSelectGroup={(groupKey) => {
                          const group = combinedSettingsCenterGroups.find((entry) => entry.key === groupKey);
                          if (group) {
                            activateSettingsCenterGroup(group);
                          }
                        }}
                      />
                    </div>
                    <div
                      className="gonavi-settings-center-content"
                      style={toolCenterContentPanelStyle}
                    >
                      {activeSettingsCenterPane ? (
                        <div style={activeSettingsCenterDetailPanelStyle}>
                          {/* 侧栏树已显示当前项，内容区不再重复标题/说明 */}
                          <div
                            key={activeSettingsCenterPane.key}
                            style={isActiveToolCenterPane ? toolCenterDetailBodyStyle : settingsCenterDetailBodyStyle}
                          >
                            {isActiveToolCenterPane ? renderToolCenterPane() : renderSettingsCenterPane()}
                          </div>
                          {!isActiveToolCenterPane && activeSettingsCenterPane.key === 'about-go-navi' && (
                            <div
                              style={{
                                display: 'flex',
                                justifyContent: 'flex-end',
                                alignItems: 'center',
                                gap: 8,
                                paddingTop: 10,
                                marginTop: 10,
                                flexShrink: 0,
                              }}
                            >
                              {renderSettingsCenterAboutFooter()}
                            </div>
                          )}
                        </div>
                      ) : (
                        <div style={activeSettingsCenterDetailPanelStyle}>
                          <div style={{ display: 'grid', gap: 4 }}>
                            <div style={{ fontSize: 'calc(var(--gn-font-size, 14px) * 1.14)', fontWeight: 700, color: overlayTheme.titleText }}>{activeSettingsCenterGroup.title}</div>
                            <div style={utilityMutedTextStyle}>{activeSettingsCenterGroup.description}</div>
                          </div>
                          <div style={{ flex: 1 }} />
                        </div>
                      )}
                    </div>
                  </div>
                </div>
                </div>
              </SettingsCenterWorkbenchRegistrar>
            );
          })()}
          {isDataRootModalOpen && (
          <Modal
            title={renderUtilityModalTitle(
              <HddOutlined />,
              t('app.data_root.title'),
              t('app.data_root.description'),
            )}
            open={isDataRootModalOpen}
            onCancel={() => {
              setIsDataRootModalOpen(false);
              setToolCenterBackGroupKey(null);
            }}
            footer={[
              <Button
                key="close"
                onClick={() => {
                  setIsDataRootModalOpen(false);
                  setToolCenterBackGroupKey(null);
                }}
              >
                {t('common.close')}
              </Button>,
              toolCenterBackGroupKey === 'config' ? (
                <Button
                  key="back"
                  onClick={() => handleReturnToToolCenter(() => setIsDataRootModalOpen(false))}
                >
                  {t('common.back_to_previous')}
                </Button>
              ) : null,
            ]}
            width={720}
            styles={{ content: utilityModalShellStyle, header: { background: 'transparent', borderBottom: 'none', paddingBottom: 8 }, body: { paddingTop: 8 }, footer: { background: 'transparent', borderTop: 'none', paddingTop: 10 } }}
          >
            {renderDataDirectorySettings()}
          </Modal>
          )}
          <SecurityUpdateIntroModal
            open={isSecurityUpdateIntroOpen}
            loading={isSecurityUpdateProgressOpen}
            darkMode={darkMode}
            overlayTheme={overlayTheme}
            surfaceOpacity={effectiveOpacity}
            onStart={handleStartSecurityUpdate}
            onPostpone={handlePostponeSecurityUpdate}
            onViewDetails={() => handleOpenSecurityUpdateSettings()}
          />
          <SecurityUpdateProgressModal
            open={isSecurityUpdateProgressOpen}
            zIndex={settingsChildModalZIndex}
            stageText={securityUpdateProgressStage}
            overlayTheme={overlayTheme}
            surfaceOpacity={effectiveOpacity}
          />
          <ConnectionPackagePasswordModal
            open={connectionPackageDialog.open && !(isSettingsModalOpen && isConnectionPackageSettingsPaneKey(activeSettingsCenterPane?.key))}
            title={connectionPackageDialog.mode === 'export'
                ? t('app.connection_package.dialog.export_title')
                : t('app.connection_package.dialog.import_password_title')}
            mode={connectionPackageDialog.mode}
            includeSecrets={connectionPackageDialog.includeSecrets}
            useFilePassword={connectionPackageDialog.useFilePassword}
            password={connectionPackageDialog.password}
            error={connectionPackageDialog.error}
            confirmLoading={connectionPackageDialog.confirmLoading}
            connectionOptions={connections.map((item) => ({ value: item.id, label: item.name || item.id }))}
            selectedConnectionIds={connectionPackageDialog.selectedConnectionIds}
            onSelectedConnectionIdsChange={(ids) => {
                setConnectionPackageDialog((current) => ({
                    ...current,
                    selectedConnectionIds: ids,
                    error: '',
                }));
            }}
            confirmText={connectionPackageDialog.mode === 'export'
                ? t('app.connection_package.action.start_export')
                : t('app.connection_package.action.start_import')}
            onBack={toolCenterBackGroupKey === 'config' ? () => handleReturnToToolCenter(closeConnectionPackageDialog) : undefined}
            onIncludeSecretsChange={(value) => {
                setConnectionPackageDialog((current) => ({
                    ...current,
                    includeSecrets: value,
                    useFilePassword: value ? current.useFilePassword : false,
                    password: value ? current.password : '',
                    error: '',
                }));
            }}
            onUseFilePasswordChange={(value) => {
                setConnectionPackageDialog((current) => ({
                    ...current,
                    useFilePassword: value,
                    password: value ? current.password : '',
                    error: '',
                }));
            }}
            onPasswordChange={(value) => {
                setConnectionPackageDialog((current) => ({
                    ...current,
                    password: value,
                    error: '',
                }));
            }}
            onConfirm={() => {
                void handleConfirmConnectionPackageDialog();
            }}
            onCancel={closeConnectionPackageDialog}
          />
          <UpdateReleaseNotesModal
              open={releaseNotesModalVisible}
              onClose={closeReleaseNotesModal}
              onOpen={handleReleaseNotesModalOpen}
              darkMode={darkMode}
              version={lastUpdateInfo?.latestVersion || updateDownloadProgress.version}
              channel={lastUpdateInfo?.channel}
              releaseName={lastUpdateInfo?.releaseName}
              releasePublishedAt={lastUpdateInfo?.releasePublishedAt}
              releaseNotes={lastUpdateInfo?.releaseNotes}
              releaseNotesUrl={lastUpdateInfo?.releaseNotesUrl || aboutInfo?.releaseUrl}
              zIndex={settingsChildModalZIndex}
              downloadProgress={
                  updateDownloadProgress.status === 'idle'
                      ? null
                      : {
                          status: updateDownloadProgress.status,
                          percent: updateDownloadProgress.percent,
                          downloaded: updateDownloadProgress.downloaded,
                          total: updateDownloadProgress.total,
                          message: updateDownloadProgress.message,
                      }
              }
              formatBytes={formatBytes}
              progressHint={
                  updateInstallAction === 'restart'
                      ? t('app.about.download_progress.complete_hint')
                      : t('app.about.download_progress.installer_complete_hint')
              }
              footerActions={[
                  lastUpdateInfo?.releaseNotesUrl || aboutInfo?.releaseUrl ? (
                      <Button
                          key="github"
                          onClick={() => {
                              const url = lastUpdateInfo?.releaseNotesUrl || aboutInfo?.releaseUrl;
                              if (!url) return;
                              try { BrowserOpenURL(url); } catch { window.open(url, '_blank', 'noopener,noreferrer'); }
                          }}
                      >
                          {t('app.about.release_notes.modal.open_github')}
                      </Button>
                  ) : null,
                  (updateDownloadProgress.status === 'start' || updateDownloadProgress.status === 'downloading') ? (
                      <Button
                          key="background"
                          onClick={() => {
                              markUpdateProgressDismissed();
                              closeReleaseNotesModal();
                          }}
                      >
                          {t('app.about.action.hide_to_background')}
                      </Button>
                  ) : null,
                  lastUpdateInfo?.hasUpdate
                      && !isLatestUpdateDownloaded
                      && updateDownloadProgress.status !== 'start'
                      && updateDownloadProgress.status !== 'downloading' ? (
                      <Button
                          key="download"
                          type="primary"
                          icon={<DownloadOutlined />}
                          onClick={handleDownloadUpdateWithNotes}
                      >
                          {updateDownloadActionLabel}
                      </Button>
                  ) : null,
                  isLatestUpdateDownloaded || updateDownloadProgress.status === 'done' ? (
                      <Button key="open-install-directory" onClick={openDownloadedUpdateDirectory}>
                          {t('app.about.action.open_install_directory')}
                      </Button>
                  ) : null,
                  isLatestUpdateDownloaded || updateDownloadProgress.status === 'done' ? (
                      <Button
                          key="restart"
                          type="primary"
                          icon={<SyncOutlined />}
                          onClick={() => { void handleInstallUpdateRequest(); }}
                      >
                          {updateInstallActionLabel}
                      </Button>
                  ) : null,
                  (updateDownloadProgress.status !== 'start' && updateDownloadProgress.status !== 'downloading') ? (
                      <Button key="close" onClick={closeReleaseNotesModal}>
                          {t('common.close')}
                      </Button>
                  ) : null,
              ].filter(Boolean) as React.ReactNode[]}
          />

          {isThemeModalOpen && (
          <Modal
              title={renderUtilityModalTitle(
                  themeModalSection === 'theme'
                      ? <SkinOutlined />
                      : themeModalSection === 'appearance'
                          ? <BgColorsOutlined />
                          : <AppstoreOutlined />,
                  themeModalSection === 'theme'
                      ? t('app.theme.theme_settings_title')
                      : themeModalSection === 'appearance'
                          ? t('app.theme.appearance_settings_title')
                          : t('app.theme.workspace_settings_title'),
                  themeModalSection === 'theme'
                      ? t('app.theme.theme_settings_description')
                      : themeModalSection === 'appearance'
                          ? t('app.theme.appearance_settings_description')
                          : t('app.theme.workspace_settings_description')
              )}
              open={isThemeModalOpen}
              onCancel={() => { setIsThemeModalOpen(false); }}
              footer={null}
              width={820}
              styles={{ content: utilityModalShellStyle, header: { background: 'transparent', borderBottom: 'none', paddingBottom: 8 }, body: { paddingTop: 8, height: 620, overflow: 'hidden' }, footer: { background: 'transparent', borderTop: 'none', paddingTop: 10 } }}
          >
              {renderThemeSettingsContent()}
          </Modal>
          )}

          {isProxyModalOpen && (
          <Modal
              title={renderUtilityModalTitle(<GlobalOutlined />, t('app.proxy.title'), t('app.proxy.description'))}
              open={isProxyModalOpen}
              zIndex={settingsChildModalZIndex}
              onCancel={handleCloseGlobalProxySettings}
              footer={null}
              width={680}
              styles={{ content: utilityModalShellStyle, header: { background: 'transparent', borderBottom: 'none', paddingBottom: 8 }, body: { paddingTop: 8 }, footer: { background: 'transparent', borderTop: 'none', paddingTop: 10 } }}
          >
              {renderProxySettingsContent()}
          </Modal>
          )}

          {showLinuxResizeHandles && (
              <>
                  {/* Linux Mint 下 frameless 仅局部可缩放：补四边四角命中层 */}
                  <div style={{ ...linuxResizeHandleStyleBase, top: 0, left: 14, right: 14, height: 6, cursor: 'ns-resize' }} />
                  <div style={{ ...linuxResizeHandleStyleBase, bottom: 0, left: 14, right: 14, height: 6, cursor: 'ns-resize' }} />
                  <div style={{ ...linuxResizeHandleStyleBase, top: 14, bottom: 14, left: 0, width: 6, cursor: 'ew-resize' }} />
                  <div style={{ ...linuxResizeHandleStyleBase, top: 14, bottom: 14, right: 0, width: 6, cursor: 'ew-resize' }} />

                  <div style={{ ...linuxResizeHandleStyleBase, top: 0, left: 0, width: 14, height: 14, cursor: 'nwse-resize' }} />
                  <div style={{ ...linuxResizeHandleStyleBase, top: 0, right: 0, width: 14, height: 14, cursor: 'nesw-resize' }} />
                  <div style={{ ...linuxResizeHandleStyleBase, bottom: 0, left: 0, width: 14, height: 14, cursor: 'nesw-resize' }} />
                  <div style={{ ...linuxResizeHandleStyleBase, bottom: 0, right: 0, width: 14, height: 14, cursor: 'nwse-resize' }} />
              </>
          )}

          <ConnectionGroupManagementModal
            open={isConnectionGroupManagementOpen}
            onClose={() => setIsConnectionGroupManagementOpen(false)}
            onOpenTagForm={(parentTagId) => window.dispatchEvent(new CustomEvent('gonavi:open-connection-tag-form', { detail: { parentTagId } }))}
            onCreateConnectionInGroup={handleCreateConnectionInGroup}
            onEditConnection={handleEditConnection}
            onCloseTabsByConnection={closeTabsByConnection}
            onConnectionGroupDeleted={async () => {
              await connectionSidebarLayoutCoordinatorRef.current?.refresh().catch(() => undefined);
            }}
          />

          {/* Ghost Resize Line for Log Panel */}
          <div
              ref={logGhostRef}
              style={{
                  position: 'fixed',
                  left: renderedSidebarWidth, // Start from the rendered sidebar edge
                  right: 0,
                  height: '4px',
                  background: resizeGuideColor,
                  zIndex: 9999,
                  pointerEvents: 'none',
                  display: 'none',
                  cursor: 'row-resize'
              }}
          />
        </Layout>
    </ConfigProvider>
  );
}

export default App;
