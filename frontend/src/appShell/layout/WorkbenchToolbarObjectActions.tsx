import React from 'react';
import { Dropdown, type MenuProps } from 'antd';
import { DownOutlined } from '@ant-design/icons';

// 工具条上的「对象类」按钮组（Navicat 原型 toolbar）：
// 表 / 视图 / 函数 / 事件 / 查询 / 备份 │ 打开表 / 设计表 │ 导入向导 / 导出向导 │ 模型。
//
// 仅出现在独立工具条形态；按钮视觉复用
// `.gn-titlebar-toolbar .gonavi-titlebar-primary-action` 的既有契约
// （图标在上、文字在下），这里只负责内容、分组与禁用态。

/** 「其它」下拉里的菜单项（次级能力收拢，保持顶栏场景菜单的克制）。 */
export type WorkbenchToolbarObjectMenuChild =
  | {
      type: 'menu-item';
      key: string;
      label: string;
      icon: React.ReactNode;
      title?: string;
      disabled: boolean;
      active?: boolean;
      onClick: () => void;
    }
  | { type: 'divider'; key: string };

export type WorkbenchToolbarObjectActionItem =
  | {
      type: 'button';
      key: string;
      label: string;
      title: string;
      icon: React.ReactNode;
      disabled: boolean;
      onClick: () => void;
      // 激活态（如开关类按钮）。
      active?: boolean;
    }
  | { type: 'divider'; key: string }
  | {
      // 「其它」下拉：把次级能力收进一个入口，顶栏只保留高频对象操作。
      type: 'overflow';
      key: string;
      label: string;
      title?: string;
      children: WorkbenchToolbarObjectMenuChild[];
    };

export interface WorkbenchToolbarObjectActionsProps {
  items: WorkbenchToolbarObjectActionItem[];
}

const renderObjectActionContent = (label: string, icon: React.ReactNode): React.ReactNode => (
  <>
    <span className="gn-titlebar-toolbar-item-icon" data-titlebar-toolbar-icon="true" aria-hidden="true">
      {icon}
    </span>
    <span className="gn-titlebar-toolbar-item-label">{label}</span>
  </>
);

const renderOverflowMenuItems = (
  children: WorkbenchToolbarObjectMenuChild[],
): MenuProps['items'] => children.map((child) => (
  child.type === 'divider'
    ? { key: child.key, type: 'divider' as const }
    : {
        key: child.key,
        icon: child.icon,
        label: child.label,
        disabled: child.disabled,
        onClick: child.onClick,
      }
));

const WorkbenchToolbarObjectActions: React.FC<WorkbenchToolbarObjectActionsProps> = ({ items }) => (
  <div
    className="gonavi-titlebar-primary-actions"
    data-gonavi-workbench-object-actions="true"
    data-no-titlebar-toggle="true"
    onDoubleClick={(event) => event.stopPropagation()}
  >
    {items.map(item => {
      if (item.type === 'divider') {
        return (
          <span key={item.key} className="gn-titlebar-toolbar-divider" aria-hidden="true" />
        );
      }
      if (item.type === 'overflow') {
        return (
          <Dropdown
            key={item.key}
            trigger={['click']}
            menu={{ items: renderOverflowMenuItems(item.children) }}
          >
            <button
              type="button"
              className="gonavi-titlebar-primary-action"
              aria-label={item.label}
              title={item.title}
              aria-haspopup="menu"
              data-gonavi-workbench-object-action={item.key}
              onClick={(event) => event.stopPropagation()}
            >
              {renderObjectActionContent(item.label, <DownOutlined />)}
            </button>
          </Dropdown>
        );
      }
      return (
        <button
          key={item.key}
          type="button"
          className="gonavi-titlebar-primary-action"
          aria-label={item.label}
          title={item.title}
          disabled={item.disabled}
          data-gonavi-workbench-object-action={item.key}
          data-titlebar-toolbar-item-active={item.active ? 'true' : undefined}
          onClick={item.onClick}
        >
          {renderObjectActionContent(item.label, item.icon)}
        </button>
      );
    })}
  </div>
);

export default WorkbenchToolbarObjectActions;
