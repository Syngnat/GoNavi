import React from 'react';

import { useI18n } from '../../i18n/provider';
import type { TitlebarActionsDisplay, TitlebarActionsPlacement } from '../../utils/titlebarActionsPlacement';
import TitleBarPrimaryActions from '../TitleBarPrimaryActions';
import TitleBarToolBar from './TitleBarToolBar';
import TitleBarToolBarAiAction from './TitleBarToolBarAiAction';

import './titleBarActionRow.css';

/** Sidebar 通过 portal 注入「数据工作流 / SQL 工具 / 用户管理」的插槽 id。 */
export const TITLEBAR_QUICK_ACTIONS_SLOT_ID = 'gonavi-titlebar-quick-actions';

export interface TitleBarActionRowProps {
  placement: TitlebarActionsPlacement;
  /** 仅标题栏形态生效：纯文字 / 纯图标 / 图标 + 精简名称；工具条固定图标 + 文字。 */
  display?: TitlebarActionsDisplay;
  /** 当前主操作是消息队列工作台时，「新建查询」换成「打开消息队列」。 */
  messageQueuePrimary: boolean;
  newQueryShortcut?: string;
  newConnectionShortcut?: string;
  onNewQuery: () => void;
  onNewConnection: () => void;
  onManageConnectionGroups: () => void;
  aiActive: boolean;
  onToggleAI: () => void;
  /** 跟在 AI 之后的槽位（macOS 的驱动管理 / 关于），非 macOS 不传。 */
  trailingSlot?: React.ReactNode;
}

/**
 * 「新建连接 / 新建查询 / 管理连接分组 / 快捷入口 / AI」这一行。
 *
 * - toolbar：包进标题栏下方的独立工具条，图标 + 文字。
 * - titlebar：内联到标题栏 GoNavi 右侧。容器用 display: contents，
 *   子元素直接参与 .gonavi-titlebar-leading 的弹性布局，
 *   App.css 里改版前的标题栏样式原样生效；图标、完整名称与精简名称的
 *   显隐由容器上的 data-titlebar-actions-display 驱动作用域样式切换。
 */
export default function TitleBarActionRow({
  placement,
  display = 'text',
  messageQueuePrimary,
  newQueryShortcut,
  newConnectionShortcut,
  onNewQuery,
  onNewConnection,
  onManageConnectionGroups,
  aiActive,
  onToggleAI,
  trailingSlot,
}: TitleBarActionRowProps) {
  const { t } = useI18n();
  const inline = placement === 'titlebar';
  const shortLabels = inline ? {
    newConnection: t('app.titlebar.short_label.new_connection'),
    newQuery: t(messageQueuePrimary ? 'app.titlebar.short_label.message_workbench' : 'app.titlebar.short_label.new_query'),
    connectionGroup: t('app.titlebar.short_label.connection_groups'),
  } : undefined;
  const actions = (
    <>
      <TitleBarPrimaryActions
        newQueryLabel={t(messageQueuePrimary ? 'message_queue_workbench.action.open' : 'query.new')}
        newConnectionLabel={t('connection.new')}
        newQueryShortcut={newQueryShortcut}
        newConnectionShortcut={newConnectionShortcut}
        onNewQuery={onNewQuery}
        onNewConnection={onNewConnection}
        connectionGroupLabel={t('connection.sidebar.management.title')}
        onConnectionGroupManagement={onManageConnectionGroups}
        shortLabels={shortLabels}
      />
      <div id={TITLEBAR_QUICK_ACTIONS_SLOT_ID} className="gonavi-titlebar-quick-actions-slot" />
      <TitleBarToolBarAiAction
        label={t('app.titlebar.toolbar.ai')}
        title={t('app.sidebar.ai_assistant')}
        active={aiActive}
        onClick={onToggleAI}
      />
      {trailingSlot}
    </>
  );

  if (inline) {
    return (
      <div
        className="gonavi-titlebar-inline-actions"
        data-titlebar-actions-placement="titlebar"
        data-titlebar-actions-display={display}
        role="group"
        aria-label={t('app.titlebar.toolbar.aria')}
      >
        {actions}
      </div>
    );
  }
  return <TitleBarToolBar ariaLabel={t('app.titlebar.toolbar.aria')}>{actions}</TitleBarToolBar>;
}
