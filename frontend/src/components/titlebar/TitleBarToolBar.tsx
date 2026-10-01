import React from 'react';

import './titleBarToolBar.css';

export interface TitleBarToolBarProps {
  /** 工具条的无障碍名称。 */
  ariaLabel: string;
  /**
   * 条带内联样式。
   *
   * 工具条要在水平方向与标题栏品牌区对齐，而 mac 原生红绿灯留白由
   * `getMacNativeTitlebarPaddingLeft` 在 App 侧算出来，所以这里透传，
   * 避免在 CSS 里重新推导一份偏移量。
   */
  style?: React.CSSProperties;
  children: React.ReactNode;
}

/**
 * 标题栏下方独立的功能工具条。
 *
 * 参考稿把「新建连接 / 新建查询 / 管理连接分组 / 数据工作流 / SQL 工具 /
 * 驱动管理 / 关于」放在标题栏之外的第二条带里。这里只负责条带本身与
 * 布局，按钮由调用方按顺序塞进来——其中后两组来自 Sidebar 的 portal
 * 插槽，所以本组件不做数据编排。
 */
export default function TitleBarToolBar({
  ariaLabel,
  style,
  children,
}: TitleBarToolBarProps) {
  return (
    <div
      className="gn-titlebar-toolbar"
      data-gonavi-titlebar-toolbar="true"
      role="toolbar"
      aria-label={ariaLabel}
      style={style}
    >
      {children}
    </div>
  );
}
