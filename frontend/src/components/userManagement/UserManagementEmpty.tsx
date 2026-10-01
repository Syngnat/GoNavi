import type { ReactNode } from 'react';

interface UserManagementEmptyProps {
  icon: ReactNode;
  text: ReactNode;
  /** 紧凑模式用于列表 / 树等小区域。 */
  compact?: boolean;
  className?: string;
}

/** 用户管理统一空状态：主题色图标 + 说明文案，替代 antd 灰色占位插画。 */
export default function UserManagementEmpty({ icon, text, compact, className }: UserManagementEmptyProps) {
  const classes = ['gn-user-mgmt-empty-state', compact ? 'is-compact' : '', className || ''].filter(Boolean).join(' ');
  return (
    <div className={classes} role="status">
      <span className="gn-user-mgmt-empty-icon" aria-hidden="true">{icon}</span>
      <span className="gn-user-mgmt-empty-text">{text}</span>
    </div>
  );
}
