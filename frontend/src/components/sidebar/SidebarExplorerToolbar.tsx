import React from 'react';
import { Button, Tooltip, type TooltipProps } from 'antd';
import {
  GnConnectionMenuIcon,
  GnLocateIcon,
  GnScrollTopIcon,
  GnSearchIcon,
} from '../icons/gnIcons';
import SidebarPanelOutlined from '../icons/SidebarPanelOutlined';

// 侧栏工具条（搜索 / 定位 / 回顶 / 更多 / 折叠）的展示组件，从 Sidebar.tsx 抽出。
// 摆放位置由外观设置决定：桌面端默认常驻标题栏第二行（App.tsx 的 docked host），
// 其余平台渲染在 explorer 头部；选择「侧边栏」时竖排在连接树左侧的固定 rail 里。

type TooltipPlacement = TooltipProps['placement'];

export type V2ExplorerToolbarActionLabels = {
  objectActions: string;
  locateCurrentTable: string;
  locateCurrentTableUnavailable: string;
  scrollToTop: string;
  connectionActions: string;
};

export type V2ExplorerToolbarToggleAction = {
  label: string;
  onClick: () => void;
  buttonRef?: React.Ref<HTMLButtonElement>;
  placement: 'explorer-toolbar' | 'docked-titlebar' | 'rail-collapse' | 'rail-expand';
  expanded: boolean;
};

export const SidebarToggleButton: React.FC<{
  action: V2ExplorerToolbarToggleAction;
  tooltipPlacement?: TooltipPlacement;
}> = ({ action, tooltipPlacement = 'bottom' }) => (
  <Tooltip title={action.label} placement={tooltipPlacement} mouseEnterDelay={0.35}>
    <Button
      ref={action.buttonRef}
      size="small"
      type="text"
      className="gonavi-sidebar-collapse-trigger gn-v2-explorer-tool"
      data-sidebar-collapse-trigger="true"
      data-sidebar-toggle-placement={action.placement}
      aria-label={action.label}
      aria-controls="gonavi-sidebar-tree-panel"
      aria-expanded={action.expanded}
      icon={<SidebarPanelOutlined />}
      onClick={action.onClick}
    />
  </Tooltip>
);

export const V2ExplorerSearchAction: React.FC<{
  label: string;
  onClick: () => void;
  tooltipPlacement?: TooltipPlacement;
}> = ({ label, onClick, tooltipPlacement = 'bottom' }) => (
  <div
    className="gn-v2-explorer-action-group is-search"
    role="group"
    aria-label={label}
    data-v2-sidebar-search-mode="command"
  >
    <Tooltip title={label} placement={tooltipPlacement} mouseEnterDelay={0.35}>
      <Button
        size="small"
        type="text"
        className="gn-v2-explorer-tool"
        icon={<GnSearchIcon />}
        aria-label={label}
        data-sidebar-command-search-action="true"
        data-v2-command-search-icon-only="true"
        onClick={onClick}
      />
    </Tooltip>
  </div>
);

export const V2ExplorerToolbarActions: React.FC<{
  labels: V2ExplorerToolbarActionLabels;
  canLocateActiveTab: boolean;
  hasActiveConnection: boolean;
  onLocateCurrentTable: () => void;
  onScrollToTop: () => void;
  onOpenConnectionActions: (event: React.MouseEvent<HTMLElement>) => void;
  toggleAction?: V2ExplorerToolbarToggleAction;
  tooltipPlacement?: TooltipPlacement;
}> = ({
  labels,
  canLocateActiveTab,
  hasActiveConnection,
  onLocateCurrentTable,
  onScrollToTop,
  onOpenConnectionActions,
  toggleAction,
  tooltipPlacement = 'bottom',
}) => (
  <>
    <div className="gn-v2-explorer-action-group is-navigation" role="group" aria-label={labels.objectActions}>
      <Tooltip
        title={canLocateActiveTab ? labels.locateCurrentTable : labels.locateCurrentTableUnavailable}
        placement={tooltipPlacement}
        mouseEnterDelay={0.35}
      >
        <span
          className="gn-v2-explorer-action-wrap"
          tabIndex={canLocateActiveTab ? undefined : 0}
          aria-label={canLocateActiveTab ? undefined : labels.locateCurrentTableUnavailable}
        >
          <Button
            size="small"
            type="text"
            className="gn-v2-explorer-tool"
            icon={<GnLocateIcon />}
            aria-label={labels.locateCurrentTable}
            data-sidebar-locate-current-tab-action="true"
            disabled={!canLocateActiveTab}
            onClick={onLocateCurrentTable}
          />
        </span>
      </Tooltip>
      <Tooltip title={labels.scrollToTop} placement={tooltipPlacement} mouseEnterDelay={0.35}>
        <Button
          size="small"
          type="text"
          className="gn-v2-explorer-tool"
          icon={<GnScrollTopIcon />}
          aria-label={labels.scrollToTop}
          data-sidebar-scroll-to-top-action="true"
          onClick={onScrollToTop}
        />
      </Tooltip>
    </div>
    <div className="gn-v2-explorer-action-group is-connection" role="group" aria-label={labels.connectionActions}>
      <Tooltip title={labels.connectionActions} placement={tooltipPlacement} mouseEnterDelay={0.35}>
        <span
          className="gn-v2-explorer-action-wrap"
          tabIndex={hasActiveConnection ? undefined : 0}
          aria-label={hasActiveConnection ? undefined : labels.connectionActions}
        >
          <Button
            size="small"
            type="text"
            className="gn-v2-explorer-tool"
            icon={<GnConnectionMenuIcon />}
            aria-label={labels.connectionActions}
            aria-haspopup="menu"
            data-sidebar-active-connection-actions="true"
            disabled={!hasActiveConnection}
            onClick={onOpenConnectionActions}
          />
        </span>
      </Tooltip>
    </div>
    {toggleAction && <SidebarToggleButton action={toggleAction} tooltipPlacement={tooltipPlacement} />}
  </>
);

/**
 * 标题栏第二行的常驻工具条宿主。Sidebar 把搜索/定位/回顶/更多 portal 到 slot；
 * 折叠按钮由 App 持有并直接渲染在这里，切换折叠时不会重渲染 explorer。
 */
export const DockedSidebarActionsHost: React.FC<{
  label: string;
  slotRef: React.Ref<HTMLDivElement>;
  /** titlebar：标题栏第二行（内联功能入口）；below-toolbar：独立工具条下方的一行。 */
  placement: 'titlebar' | 'below-toolbar';
  collapsed: boolean;
  toggleLabel: string;
  onToggle: () => void;
  toggleButtonRef?: React.Ref<HTMLButtonElement>;
}> = ({ label, slotRef, placement, collapsed, toggleLabel, onToggle, toggleButtonRef }) => (
  <div
    className={placement === 'below-toolbar'
      ? 'gn-v2-collapsed-sidebar-actions is-below-toolbar'
      : 'gn-v2-collapsed-sidebar-actions'}
    data-collapsed-sidebar-actions="true"
    data-no-titlebar-toggle="true"
    role="toolbar"
    aria-label={label}
    onDoubleClick={(event) => event.stopPropagation()}
  >
    <div ref={slotRef} className="gn-v2-collapsed-sidebar-actions-slot" />
    <SidebarToggleButton
      action={{
        label: toggleLabel,
        onClick: onToggle,
        buttonRef: toggleButtonRef,
        placement: 'docked-titlebar',
        expanded: !collapsed,
      }}
    />
  </div>
);

/**
 * 侧边栏（固定 rail）里竖排的同一组按钮，折叠 / 展开按钮排在第一位。
 * 折叠 / 展开各有一个按钮占同一位置，由 Sider 的 data-sidebar-collapsed 决定显示哪一个，
 * 各自持有焦点交接用的 ref。
 */
export const V2RailExplorerActions: React.FC<{
  label: string;
  searchAction?: { label: string; onClick: () => void };
  toolbar: Omit<React.ComponentProps<typeof V2ExplorerToolbarActions>, 'toggleAction' | 'tooltipPlacement'>;
  collapseAction?: Omit<V2ExplorerToolbarToggleAction, 'placement' | 'expanded'>;
  expandAction?: Omit<V2ExplorerToolbarToggleAction, 'placement' | 'expanded'>;
}> = ({ label, searchAction, toolbar, collapseAction, expandAction }) => (
  <div className="gn-v2-rail-explorer-actions" role="toolbar" aria-orientation="vertical" aria-label={label}>
    {collapseAction && (
      <SidebarToggleButton
        action={{ ...collapseAction, placement: 'rail-collapse', expanded: true }}
        tooltipPlacement="right"
      />
    )}
    {expandAction && (
      <SidebarToggleButton
        action={{ ...expandAction, placement: 'rail-expand', expanded: false }}
        tooltipPlacement="right"
      />
    )}
    {searchAction && (
      <V2ExplorerSearchAction label={searchAction.label} onClick={searchAction.onClick} tooltipPlacement="right" />
    )}
    <V2ExplorerToolbarActions {...toolbar} tooltipPlacement="right" />
  </div>
);
