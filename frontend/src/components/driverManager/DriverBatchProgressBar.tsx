import { Button, Popover, Progress, Space, Typography } from 'antd';
import React from 'react';

const { Text } = Typography;

// 驱动页顶部的批量进度条。
//
// 从 DriverManagerModal 提取：批量安装/重装/卸载与驱动包导出都需要同一条
// 「图标 + 标题 + 描述 + 进度 + 右侧动作」的呈现，各自拼一遍会走形。
// 样式类 .driver-manager-batch-bar* 本就是通用的，组件只负责组装。

export type DriverBatchProgressBarProps = {
  icon: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  percent: number;
  /**
   * 「详情」气泡内容，逐项渲染。必须是数组而非 Fragment：antd 的 Space 用
   * React.Children.toArray 取子元素，该方法不展开 Fragment，包一层会让所有
   * 条目塌成单个子元素、彼此失去间距。
   */
  details?: React.ReactNode[];
  /** 「详情」按钮文案，与 details 配对使用。 */
  detailLabel?: React.ReactNode;
  /** 右侧其余动作，渲染在详情按钮之后。 */
  actions?: React.ReactNode;
};

export const DriverBatchProgressBar: React.FC<DriverBatchProgressBarProps> = ({
  icon,
  title,
  description,
  percent,
  detailLabel,
  details,
  actions,
}) => {
  const safePercent = Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : 0;
  const hasDetails = Array.isArray(details) && details.length > 0;
  return (
    <div className="driver-manager-batch-bar">
      <div className="driver-manager-batch-bar-icon" aria-hidden="true">
        {icon}
      </div>
      <div className="driver-manager-batch-bar-text">
        <Text strong>{title}</Text>
        {description ? <Text type="secondary">{description}</Text> : null}
      </div>
      <div className="driver-manager-batch-bar-progress">
        <Progress percent={safePercent} status="active" showInfo={false} size="small" />
        <Text className="driver-manager-batch-bar-percent">{Math.round(safePercent)}%</Text>
      </div>
      {hasDetails || actions ? (
        <div className="driver-manager-batch-bar-actions">
          {hasDetails ? (
            <Popover
              trigger="click"
              placement="bottomRight"
              content={(
                <Space direction="vertical" size={4} style={{ minWidth: 180 }}>
                  {details}
                </Space>
              )}
            >
              <Button size="small">{detailLabel}</Button>
            </Popover>
          ) : null}
          {actions}
        </div>
      ) : null}
    </div>
  );
};

export default DriverBatchProgressBar;
