import React from 'react';

export type SidebarPanelOutlinedProps = Omit<React.HTMLAttributes<HTMLSpanElement>, 'children'>;

/**
 * 侧栏开关图标：圆角方框 + 左侧竖线，展开 / 收起共用同一图形（状态由 aria-expanded 表达）。
 *
 * 渲染约定与 antd 图标一致（span.anticon + 1em SVG + currentColor），可直接放进 icon 槽；
 * 不依赖 @ant-design/icons，测试里 mock 图标库时不受影响。
 */
const SidebarPanelOutlined: React.FC<SidebarPanelOutlinedProps> = ({ className, ...rest }) => (
  <span
    role="img"
    aria-label="sidebar"
    {...rest}
    className={`anticon gn-sidebar-panel-icon${className ? ` ${className}` : ''}`}
  >
    <svg
      viewBox="0 0 24 24"
      width="1em"
      height="1em"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <path d="M9.5 4v16" />
    </svg>
  </span>
);

export default SidebarPanelOutlined;
