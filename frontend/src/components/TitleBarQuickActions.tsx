import React, { useState } from 'react';
import { Dropdown, Tooltip } from 'antd';
import type { MenuProps } from 'antd';
import { MoreOutlined } from '@ant-design/icons';
import { renderV2ActionMenuPopup } from './common/V2ActionMenuPopup';

export interface TitleBarQuickAction {
  key: string;
  label: string;
  icon: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  priority?: 'primary' | 'secondary';
  menu?: TitleBarQuickAction[];
}

interface TitleBarQuickActionsProps {
  label: string;
  moreLabel: string;
  actions: TitleBarQuickAction[];
  /** Rendered after the "more" dropdown as standalone buttons (outside the menu). */
  trailingActions?: TitleBarQuickAction[];
}

const TitleBarQuickActions: React.FC<TitleBarQuickActionsProps> = ({ label, moreLabel, actions, trailingActions }) => {
  // Hide tooltips while a dropdown is open so they don't stack on the menu.
  const [openMenuKey, setOpenMenuKey] = useState<string | null>(null);

  const primaryActions = actions.filter((action) => action.priority !== 'secondary');
  const secondaryActions = actions.filter((action) => action.priority === 'secondary');
  const buildMenuItems = (menuActions: TitleBarQuickAction[]): MenuProps['items'] => menuActions.map((action) => ({
    key: action.key,
    icon: action.icon,
    label: action.label,
    onClick: action.menu?.length ? undefined : action.onClick,
    disabled: action.disabled,
    children: action.menu ? buildMenuItems(action.menu) : undefined,
    popupClassName: action.menu?.length ? 'gn-v2-titlebar-quick-submenu' : undefined,
  }));
  const menuItems = buildMenuItems(secondaryActions);
  const dropdownMenuProps = {
    items: menuItems,
    className: 'gn-v2-titlebar-quick-menu',
    subMenuOpenDelay: 0.08,
    subMenuCloseDelay: 0.12,
  } satisfies MenuProps;

  const handleMenuOpenChange = (key: string, open: boolean) => {
    setOpenMenuKey((current) => {
      if (open) return key;
      return current === key ? null : current;
    });
  };

  const renderStandaloneAction = (action: TitleBarQuickAction) => (
    action.menu && action.menu.length > 0 ? (
      <Tooltip
        key={action.key}
        title={action.menu.map((menuAction) => menuAction.label).join('、')}
        placement="bottom"
        mouseEnterDelay={0.75}
        open={openMenuKey === action.key ? false : undefined}
      >
        <Dropdown
          menu={{ items: buildMenuItems(action.menu), className: 'gn-v2-titlebar-quick-menu' }}
          trigger={['click']}
          placement="bottomLeft"
          rootClassName="gn-v2-titlebar-quick-dropdown gn-v2-action-menu-popup-host"
          popupRender={(menu) => renderV2ActionMenuPopup(menu, true, {
            title: action.label,
            meta: label,
            icon: action.icon,
            showHeader: false,
          })}
          open={openMenuKey === action.key}
          onOpenChange={(open) => handleMenuOpenChange(action.key, open)}
        >
          <button
            type="button"
            className="gn-v2-titlebar-quick-action gn-v2-titlebar-quick-menu"
            data-titlebar-quick-menu={action.key}
            data-no-titlebar-toggle="true"
            aria-label={action.label}
          >
            {action.icon}
            <span>{action.label}</span>
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
        >
          {action.icon}
          <span>{action.label}</span>
        </button>
      </Tooltip>
    )
  );

  return (
    <div className="gn-v2-titlebar-quick-actions" data-titlebar-quick-actions="true" data-no-titlebar-toggle="true" role="group" aria-label={label}>
      <div className="gn-v2-titlebar-quick-primary">
        {primaryActions.map(renderStandaloneAction)}
      </div>
      {secondaryActions.length > 0 && (
        <Tooltip
          title={secondaryActions.map((action) => action.label).join('、')}
          placement="bottom"
          mouseEnterDelay={0.75}
          open={openMenuKey === '__more__' ? false : undefined}
        >
          <Dropdown
            menu={dropdownMenuProps}
            trigger={['click']}
            placement="bottomLeft"
            rootClassName="gn-v2-titlebar-quick-dropdown gn-v2-action-menu-popup-host"
            popupRender={(menu) => renderV2ActionMenuPopup(menu, true, {
              title: moreLabel,
              meta: label,
              icon: <MoreOutlined />,
              showHeader: false,
            })}
            open={openMenuKey === '__more__'}
            onOpenChange={(open) => handleMenuOpenChange('__more__', open)}
          >
            <button
              type="button"
              className="gn-v2-titlebar-quick-more"
              data-no-titlebar-toggle="true"
              aria-label={moreLabel}
              data-titlebar-quick-more="true"
            >
              <MoreOutlined aria-hidden="true" />
              <span className="gn-v2-titlebar-quick-label">{moreLabel}</span>
            </button>
          </Dropdown>
        </Tooltip>
      )}
      {trailingActions && trailingActions.length > 0 && (
        <div className="gn-v2-titlebar-quick-primary">
          {trailingActions.map(renderStandaloneAction)}
        </div>
      )}
    </div>
  );
};

export default TitleBarQuickActions;
