import React, { useState } from 'react';
import { Dropdown, Tooltip } from 'antd';
import type { MenuProps } from 'antd';
import { renderV2ActionMenuPopup } from './common/V2ActionMenuPopup';

import './titlebarQuickMenu.css';

export interface TitleBarQuickAction {
  key: string;
  label: string;
  /** 标题栏「图标 + 文字」模式的精简名称；显示与否由样式按模式决定。 */
  shortLabel?: string;
  icon?: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  priority?: 'primary' | 'secondary';
  // 插件工具入口放在 AI 按钮之后，其他工具保持原有位置。
  afterAI?: boolean;
  /**
   * 是否处于激活态。
   *
   * 参考稿里「驱动管理」在打开时是淡紫底 + 紫字，用它跟其余按钮区分。
   */
  active?: boolean;
  /** 前插一条竖分隔线；参考稿用它在「数据工作流」与「SQL 工具」之间分组。 */
  dividerBefore?: boolean;
  /** Additional class for sizing or styling one popup without changing other menus. */
  popupClassName?: string;
  /** Fires when the dropdown opens; lazy menus load their entries there instead of at startup. */
  onMenuOpen?: () => void;
  /** Disabled placeholder shown while a lazy menu is empty, loading or unavailable. */
  emptyMenuLabel?: string;
  menu?: TitleBarQuickAction[];
}

interface TitleBarQuickActionsProps {
  label: string;
  actions: TitleBarQuickAction[];
  trailingActions?: TitleBarQuickAction[];
}

const TitleBarQuickActions: React.FC<TitleBarQuickActionsProps> = ({ label, actions, trailingActions }) => {
  // Hide tooltips while a dropdown is open so they don't stack on the menu.
  const [openMenuKey, setOpenMenuKey] = useState<string | null>(null);

  const primaryActions = actions.filter((action) => action.priority !== 'secondary');
  const buildMenuItems = (menuActions: TitleBarQuickAction[]): MenuProps['items'] => menuActions.map((action) => ({
    key: action.key,
    icon: action.icon,
    label: action.label,
    onClick: action.menu !== undefined ? undefined : action.onClick,
    disabled: action.disabled,
    children: action.menu !== undefined ? buildActionMenuItems(action) : undefined,
    popupClassName: action.menu !== undefined ? 'gn-v2-titlebar-quick-submenu' : undefined,
  }));

  const buildActionMenuItems = (action: TitleBarQuickAction): MenuProps['items'] => {
    const items = buildMenuItems(action.menu ?? []);
    if ((items?.length ?? 0) === 0 && action.emptyMenuLabel) {
      return [{ key: action.key + '-empty', label: action.emptyMenuLabel, disabled: true }];
    }
    return items;
  };

  const handleMenuOpenChange = (key: string, open: boolean) => {
    setOpenMenuKey((current) => {
      if (open) return key;
      return current === key ? null : current;
    });
  };

  /**
   * 工具条按钮内容：图标在上、文案在下。
   *
   * 图标标记用 `data-titlebar-toolbar-icon` 而不是 `data-titlebar-icon`：
   * 后者是「快捷入口图标」的既有标记，两处语义不同，混用会让断言互相干扰。
   */
  const renderToolbarContent = (action: TitleBarQuickAction) => (
    <>
      {action.icon && (
        <span className="gn-titlebar-toolbar-item-icon" data-titlebar-toolbar-icon={action.key} aria-hidden="true">
          {action.icon}
        </span>
      )}
      <span className={`gn-titlebar-toolbar-item-label${action.shortLabel ? ' has-short-label' : ''}`}>{action.label}</span>
      {action.shortLabel && <span className="gn-titlebar-toolbar-item-short-label" aria-hidden="true">{action.shortLabel}</span>}
    </>
  );

  const renderStandaloneAction = (action: TitleBarQuickAction) => (
    action.menu !== undefined ? (
      <Tooltip
        key={action.key}
        title={action.menu.length > 0 ? action.menu.map((menuAction) => menuAction.label).join('、') : action.label}
        placement="bottom"
        mouseEnterDelay={0.75}
        open={openMenuKey === action.key ? false : undefined}
      >
        <Dropdown
          menu={{ items: buildActionMenuItems(action), className: 'gn-v2-titlebar-quick-menu' }}
          trigger={['click']}
          placement="bottomLeft"
          rootClassName={`gn-v2-titlebar-quick-dropdown gn-v2-action-menu-popup-host${action.popupClassName ? ` ${action.popupClassName}` : ''}`}
          popupRender={(menu) => renderV2ActionMenuPopup(menu, true, {
            title: action.label,
            meta: label,
            icon: action.icon,
            showHeader: false,
          })}
          open={openMenuKey === action.key}
          onOpenChange={(open) => {
            if (open) action.onMenuOpen?.();
            handleMenuOpenChange(action.key, open);
          }}
        >
          <button
            type="button"
            className="gn-v2-titlebar-quick-action gn-v2-titlebar-quick-menu"
            data-titlebar-quick-menu={action.key}
            data-no-titlebar-toggle="true"
            aria-label={action.label}
            data-titlebar-toolbar-item-active={action.active ? 'true' : undefined}
            aria-current={action.active ? 'true' : undefined}
          >
            {renderToolbarContent(action)}
          </button>
        </Dropdown>
      </Tooltip>
    ) : (
      <Tooltip key={action.key} title={action.label} placement="bottom" mouseEnterDelay={0.75}>
        <button
          type="button"
          className="gn-v2-titlebar-quick-action"
          data-titlebar-quick-action={action.key}
          data-no-titlebar-toggle="true"
          aria-label={action.label}
          disabled={action.disabled}
          onClick={action.onClick}
          data-titlebar-toolbar-item-active={action.active ? 'true' : undefined}
          aria-current={action.active ? 'true' : undefined}
        >
          {renderToolbarContent(action)}
        </button>
      </Tooltip>
    )
  );

  return (
    <div className="gn-v2-titlebar-quick-actions" data-titlebar-quick-actions="true" data-no-titlebar-toggle="true" role="group" aria-label={label}>
      <div className="gn-v2-titlebar-quick-primary">
        {primaryActions.map((action) => (
          <React.Fragment key={action.key}>
            {action.dividerBefore && <span className="gn-titlebar-toolbar-divider" role="separator" aria-orientation="vertical" />}
            {renderStandaloneAction(action)}
          </React.Fragment>
        ))}
      </div>
      {trailingActions && trailingActions.length > 0 && (
        <div className="gn-v2-titlebar-quick-primary">
          {trailingActions.map(renderStandaloneAction)}
        </div>
      )}
    </div>
  );
};

export default TitleBarQuickActions;
