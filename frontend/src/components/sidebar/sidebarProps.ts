import type { DataSyncEntryModeAlias } from '../dataSyncEntryMode';
import type { SettingsCenterNavigationTarget } from '../settings/settingsCenterMenuCatalog';
import React from 'react';
import { SavedConnection } from '../../types';
import type { TitlebarSidebarSnapshot } from '../../utils/titlebarContext';
import type { V2ExplorerContext } from './V2ExplorerContextSummary';

export interface SidebarProps {
  onCreateConnection?: () => void;
  onCreateConnectionInGroup?: (targetTagId: string) => void;
  onEditConnection?: (conn: SavedConnection) => void;
  onOpenSettings?: () => void;
  /**
   * Open a settings-center group/pane, tool-center entry, or run a settings action
   * (import/export connections, data-sync, driver manager, sql audit). Mirrors 设置 left-nav groups.
   */
  onOpenSettingsNavigation?: (spec: SettingsCenterNavigationTarget) => void;
  onCheckUpdate?: () => void; // 标题栏「关于 → 检查更新」，与 macOS 菜单栏一致
  activeSettingsCenterPaneKey?: string | null; // 设置中心当前面板 key，用于点亮工具条入口
  hideTitlebarAboutAction?: boolean; // macOS 的「关于」走原生菜单栏，不再渲染到工具条
  hideTitlebarDriverAction?: boolean; // macOS 的「驱动管理」走原生菜单栏，不再渲染到工具条
  /** Whether web-only settings entries (e.g. browser auth) should appear. */
  isWebRuntime?: boolean;
  onOpenDataSyncWorkbench?: (entryMode: DataSyncEntryModeAlias) => void;
  onToggleAI?: () => void;
  onToggleLogPanel?: () => void;
  v2ExplorerContext?: V2ExplorerContext;
  /** 标题栏第二行的工具条宿主；存在时搜索/定位/回顶/更多按钮常驻此处，explorer 头部不再渲染（折叠按钮由 App 持有）。 */
  collapsedSidebarActionsTarget?: HTMLElement | null;
  onTitlebarSnapshotChange?: (snapshot: React.SetStateAction<TitlebarSidebarSnapshot>) => void;
  onFocusCommandSearch?: () => void;
  onCollapseSidebar?: () => void;
  onExpandSidebar?: () => void;
  /** Expands a collapsed explorer before a locate request changes its selection. */
  onEnsureSidebarExpanded?: () => void;
  collapseSidebarLabel?: string;
  collapseSidebarButtonRef?: React.Ref<HTMLButtonElement>;
  expandSidebarLabel?: string;
  expandSidebarButtonRef?: React.Ref<HTMLButtonElement>;
}
