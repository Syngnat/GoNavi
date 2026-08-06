import React, { useState } from 'react';
import { Dropdown, Tooltip } from 'antd';
import type { MenuProps } from 'antd';
import { MoreOutlined } from '@ant-design/icons';

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
}

const TitleBarQuickActions: React.FC<TitleBarQuickActionsProps> = ({ label, moreLabel, actions }) => {
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

  return (
    <div className="gn-v2-titlebar-quick-actions" data-titlebar-quick-actions="true" role="group" aria-label={label}>
      <div className="gn-v2-titlebar-quick-primary">
        {primaryActions.map((action) => (
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
                rootClassName="gn-v2-titlebar-quick-dropdown"
                open={openMenuKey === action.key}
                onOpenChange={(open) => handleMenuOpenChange(action.key, open)}
              >
                <button
                  type="button"
                  className="gn-v2-titlebar-quick-action gn-v2-titlebar-quick-menu"
                  data-titlebar-quick-menu={action.key}
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
                aria-label={action.label}
                disabled={action.disabled}
                onClick={action.onClick}
              >
                {action.icon}
                <span>{action.label}</span>
              </button>
            </Tooltip>
          )
        ))}
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
            rootClassName="gn-v2-titlebar-quick-dropdown"
            open={openMenuKey === '__more__'}
            onOpenChange={(open) => handleMenuOpenChange('__more__', open)}
          >
            <button
              type="button"
              className="gn-v2-titlebar-quick-more"
              aria-label={moreLabel}
              data-titlebar-quick-more="true"
            >
              <MoreOutlined aria-hidden="true" />
              <span>{moreLabel}</span>
            </button>
          </Dropdown>
        </Tooltip>
      )}
    </div>
  );
};

export default TitleBarQuickActions;
