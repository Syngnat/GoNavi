import React from 'react';

import { AI_SPARK_MAJOR_PATH, AI_SPARK_MINOR_PATH } from '../titlebar/gonaviTitlebarIcons';

export type AiSparkOutlinedProps = Omit<React.HTMLAttributes<HTMLSpanElement>, 'children'>;

/**
 * 全局统一的 AI 标识图标（与标题栏 AI 入口同一图形），用来替代旧的 RobotOutlined。
 *
 * 按 antd 图标的约定渲染：外层 span.anticon、SVG 为 1em + currentColor，
 * 因此可以直接放进 Button/Menu/Avatar 的 icon 槽，字号与颜色随上下文走。
 * 不依赖 @ant-design/icons 的 Icon 组件，测试里 mock 图标库时不受影响。
 * viewBox 收紧到星形外接框，使视觉尺寸与相邻的 antd 图标一致。
 */
const AiSparkOutlined: React.FC<AiSparkOutlinedProps> = ({ className, ...rest }) => (
  <span
    role="img"
    aria-label="ai"
    {...rest}
    className={`anticon gn-ai-spark-icon${className ? ` ${className}` : ''}`}
  >
    <svg viewBox="3 2 20 20" width="1em" height="1em" fill="currentColor" aria-hidden="true" focusable="false">
      <path d={AI_SPARK_MAJOR_PATH} stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <path d={AI_SPARK_MINOR_PATH} stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  </span>
);

export default AiSparkOutlined;
