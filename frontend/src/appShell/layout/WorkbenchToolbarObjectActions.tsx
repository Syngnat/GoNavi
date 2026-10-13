import React from 'react';

/**
 * 工具条上的「对象类」按钮组（Navicat 原型 toolbar）：
 * 表 / 视图 / 函数 / 事件 / 查询 / 备份 │ 打开表 / 设计表 │ 导入向导 / 导出向导 │ 模型。
 *
 * 仅出现在独立工具条形态；按钮视觉复用
 * `.gn-titlebar-toolbar .gonavi-titlebar-primary-action` 的既有契约
 * （图标在上、文字在下），这里只负责内容、分组与禁用态。
 */

export type WorkbenchToolbarObjectActionItem =
  | {
      type: 'button';
      key: string;
      label: string;
      title: string;
      icon: React.ReactNode;
      disabled: boolean;
      onClick: () => void;
      /** 激活态（如开关类按钮）。 */
      active?: boolean;
    }
  | { type: 'divider'; key: string };

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

const WorkbenchToolbarObjectActions: React.FC<WorkbenchToolbarObjectActionsProps> = ({ items }) => (
  <div
    className="gonavi-titlebar-primary-actions"
    data-gonavi-workbench-object-actions="true"
    data-no-titlebar-toggle="true"
    onDoubleClick={(event) => event.stopPropagation()}
  >
    {items.map(item => (item.type === 'divider' ? (
      <span key={item.key} className="gn-titlebar-toolbar-divider" aria-hidden="true" />
    ) : (
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
    )))}
  </div>
);

export default WorkbenchToolbarObjectActions;
