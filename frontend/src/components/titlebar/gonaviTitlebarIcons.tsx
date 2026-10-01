/**
 * 标题栏功能工具条的手写 SVG 图标集。
 *
 * 不用 @ant-design/icons 的原因：参考稿里的图标是约 2.4px 粗描边的圆润风格，
 * antd outlined 图标描边只有约 1px，直接引用会和参考稿明显不一致。
 *
 * 所有图标共用 24x24 视口与同一套配色，颜色集中在 GONAVI_TITLEBAR_ICON_COLORS，
 * 便于后续按主题统一调整；填充色走 currentColor 的图标只用于单色场景。
 */

import './titlebarIconTokens.css';

/**
 * 图标配色：全部走 CSS 变量（定义见 titlebarIconTokens.css），回退值为参考稿取色。
 * 内置主题与用户自定义 CSS 主题都可以覆盖 --gn-titlebar-icon-* 来换色。
 * SVG 的 fill/stroke 属性不支持 var()，因此图标里一律通过 style 应用这些值。
 */
export const GONAVI_TITLEBAR_ICON_COLORS = {
  /** 主体色（插头、表格、数据库柱体、SQL 方块、AI 主星、设置齿轮） */
  primary: 'var(--gn-titlebar-icon-primary, #3b82f6)',
  /** 主体浅色（表格网格线），默认由主体色派生 */
  primarySoft: 'var(--gn-titlebar-icon-primary-soft, #7fb0f7)',
  /** 亮点色（节点图顶部节点、AI 辅星），默认由主体色派生 */
  highlight: 'var(--gn-titlebar-icon-highlight, #4b9bff)',
  /** 强调色（标题栏的驱动包立方体、关于圆形） */
  accent: 'var(--gn-titlebar-icon-accent, #4c3fd6)',
  /** 新增角标色 */
  badge: 'var(--gn-titlebar-icon-badge, #3bb54a)',
  /** 暖色（主题太阳 / 月亮） */
  warm: 'var(--gn-titlebar-icon-warm, #f59e0b)',
} as const;

export interface GonaviTitlebarIconProps {
  /** 渲染边长，默认由 CSS 变量 --gn-toolbar-icon-size 控制。 */
  size?: number | string;
  className?: string;
}

export const resolveSize = (size?: number | string): number | string => size ?? '100%';

/** AI 双星图形（大星 + 右下小星），标题栏与各处 AI 入口共用，保证全局 AI 标识一致。 */
export const AI_SPARK_MAJOR_PATH = 'M11.4 3.2 12.9 8.1 17.8 9.6 12.9 11.1 11.4 16 9.9 11.1 5 9.6 9.9 8.1Z';
export const AI_SPARK_MINOR_PATH = 'M18.1 14.4 18.85 16.75 21.2 17.5 18.85 18.25 18.1 20.6 17.35 18.25 15 17.5 17.35 16.75Z';

/** 插头（新建连接）：斜置插头本体 + 左下引线 + 右下绿色加号角标。 */
export function TitlebarPlugIcon({ size, className }: GonaviTitlebarIconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={resolveSize(size)}
      height={resolveSize(size)}
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {/* 左下引线 */}
      <path
        d="M7.6 16.4 3.6 20.4"
        strokeWidth="2.4"
        strokeLinecap="round"
        fill="none"
        style={{ stroke: GONAVI_TITLEBAR_ICON_COLORS.primary }}
      />
      {/* 插头本体 */}
      <path
        d="M8.4 14.2c-.9-.9-.9-2.3 0-3.2l4.3-4.3c.9-.9 2.3-.9 3.2 0l3.4 3.4c.9.9.9 2.3 0 3.2l-4.3 4.3c-.9.9-2.3.9-3.2 0z"
        style={{ fill: GONAVI_TITLEBAR_ICON_COLORS.primary }}
      />
      {/* 插脚 */}
      <path
        d="M15.9 3.7 17.6 2m1.9 3.8L21.2 4"
        strokeWidth="2.2"
        strokeLinecap="round"
        fill="none"
        style={{ stroke: GONAVI_TITLEBAR_ICON_COLORS.primary }}
      />
      {/* 加号角标 */}
      <circle cx="18.4" cy="18.4" r="4.4" style={{ fill: GONAVI_TITLEBAR_ICON_COLORS.badge }} />
      <path
        d="M18.4 16.4v4m-2-2h4"
        stroke="#fff"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** 表格（新建查询）：顶行与左列实心、右下留空的网格，带绿色加号角标。 */
export function TitlebarGridIcon({ size, className }: GonaviTitlebarIconProps) {
  const soft = GONAVI_TITLEBAR_ICON_COLORS.primarySoft;
  const primary = GONAVI_TITLEBAR_ICON_COLORS.primary;
  return (
    <svg
      viewBox="0 0 24 24"
      width={resolveSize(size)}
      height={resolveSize(size)}
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {/* 表头行 */}
      <rect x="2.6" y="3.4" width="18.8" height="5.2" style={{ fill: primary }} />
      {/* 表头列 */}
      <rect x="2.6" y="3.4" width="5.4" height="14.6" style={{ fill: primary }} />
      {/* 其余单元格：浅蓝描边 */}
      <g style={{ fill: soft }}>
        <rect x="9.6" y="10.2" width="5" height="3.2" />
        <rect x="16.2" y="10.2" width="5.2" height="3.2" />
        <rect x="9.6" y="15" width="5" height="3" />
        <rect x="16.2" y="15" width="5.2" height="3" />
      </g>
      {/* 加号角标 */}
      <circle cx="18.6" cy="18.4" r="4.4" style={{ fill: GONAVI_TITLEBAR_ICON_COLORS.badge }} />
      <path
        d="M18.6 16.4v4m-2-2h4"
        stroke="#fff"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** 数据库柱体（管理连接分组）：三层堆叠的圆柱。 */
export function TitlebarDatabaseIcon({ size, className }: GonaviTitlebarIconProps) {
  const primary = GONAVI_TITLEBAR_ICON_COLORS.primary;
  return (
    <svg
      viewBox="0 0 24 24"
      width={resolveSize(size)}
      height={resolveSize(size)}
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {/* 顶层：完整椭圆 + 柱身 */}
      <path
        d="M12 2.4c4 0 7.2 1.3 7.2 2.9v3.2c0 1.6-3.2 2.9-7.2 2.9S4.8 10.1 4.8 8.5V5.3c0-1.6 3.2-2.9 7.2-2.9z"
        style={{ fill: primary }}
      />
      {/* 中段 */}
      <path
        d="M4.8 12.2c1.4 1.1 4.1 1.8 7.2 1.8s5.8-.7 7.2-1.8v3.4c0 1.6-3.2 2.9-7.2 2.9s-7.2-1.3-7.2-2.9z"
        style={{ fill: primary }}
      />
      {/* 底段 */}
      <path
        d="M4.8 17.6c1.4 1.1 4.1 1.8 7.2 1.8s5.8-.7 7.2-1.8v2.5c0 1.6-3.2 2.9-7.2 2.9s-7.2-1.3-7.2-2.9z"
        style={{ fill: primary }}
      />
      {/* 分段之间留白 */}
      <path d="M4.8 11.3c1.4 1.1 4.1 1.8 7.2 1.8s5.8-.7 7.2-1.8" stroke="#fff" strokeWidth="1.1" fill="none" />
      <path d="M4.8 16.7c1.4 1.1 4.1 1.8 7.2 1.8s5.8-.7 7.2-1.8" stroke="#fff" strokeWidth="1.1" fill="none" />
    </svg>
  );
}

/** 节点图（数据工作流）：三个实心圆由直线连接，与工具条其它按钮同用主体色系。 */
export function TitlebarGraphIcon({ size, className }: GonaviTitlebarIconProps) {
  const primary = GONAVI_TITLEBAR_ICON_COLORS.primary;
  return (
    <svg
      viewBox="0 0 24 24"
      width={resolveSize(size)}
      height={resolveSize(size)}
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {/* 连线先画，节点覆盖在上层 */}
      <path
        d="M11.4 6.6 8.2 16.4m5.4-9.4 4 9m-8.4-.2 6.6.2"
        strokeWidth="1.6"
        fill="none"
        style={{ stroke: primary }}
      />
      <circle cx="12" cy="5.2" r="2.9" style={{ fill: GONAVI_TITLEBAR_ICON_COLORS.highlight }} />
      <circle cx="7.2" cy="17.6" r="2.9" style={{ fill: primary }} />
      <circle cx="17.8" cy="16.8" r="2.9" style={{ fill: primary }} />
    </svg>
  );
}

/** 终端方块（SQL 工具）：蓝色圆角方块内白色提示符。 */
export function TitlebarSqlToolIcon({ size, className }: GonaviTitlebarIconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={resolveSize(size)}
      height={resolveSize(size)}
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <rect
        x="2.2"
        y="4.2"
        width="19.6"
        height="15.6"
        rx="3.2"
        style={{ fill: GONAVI_TITLEBAR_ICON_COLORS.primary }}
      />
      <path
        d="M6.8 9.4 9.6 12l-2.8 2.6"
        stroke="#fff"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      <path
        d="M11.8 15.4h4.6"
        stroke="#fff"
        strokeWidth="1.9"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * 驱动包（驱动管理）：强调色立方体 + 白色棱线，对应「驱动包」的安装 / 导入导出。
 * 不用齿轮，避免与标题栏「设置」的齿轮图标混淆。
 */
export function TitlebarDriverIcon({ size, className }: GonaviTitlebarIconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={resolveSize(size)}
      height={resolveSize(size)}
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M12 2.4 20.6 7.2v9.6L12 21.6 3.4 16.8V7.2Z"
        strokeWidth="1.2"
        strokeLinejoin="round"
        style={{ fill: GONAVI_TITLEBAR_ICON_COLORS.accent, stroke: GONAVI_TITLEBAR_ICON_COLORS.accent }}
      />
      <path
        d="M4.2 7.6 12 12l7.8-4.4M12 12v8.8M7.9 5.1l8 4.5"
        fill="none"
        stroke="#fff"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** 关于：紫色实心圆 + 白色 i。 */
export function TitlebarInfoIcon({ size, className }: GonaviTitlebarIconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={resolveSize(size)}
      height={resolveSize(size)}
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="12" cy="12" r="9.8" style={{ fill: GONAVI_TITLEBAR_ICON_COLORS.accent }} />
      <circle cx="12" cy="7.4" r="1.5" fill="#fff" />
      <rect x="10.9" y="10.2" width="2.2" height="7.2" rx="1.1" fill="#fff" />
    </svg>
  );
}

/** 主题：暖色太阳（实心圆 + 8 条射线）。胶囊「主题」段使用。 */
export function TitlebarSunIcon({ size, className }: GonaviTitlebarIconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={resolveSize(size)}
      height={resolveSize(size)}
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="12" cy="12" r="4.6" style={{ fill: GONAVI_TITLEBAR_ICON_COLORS.warm }} />
      <g strokeWidth="2.1" strokeLinecap="round" style={{ stroke: GONAVI_TITLEBAR_ICON_COLORS.warm }}>
        <path d="M12 1.9v2.6M12 19.5v2.6M1.9 12h2.6M19.5 12h2.6" />
        <path d="M4.9 4.9 6.7 6.7M17.3 17.3l1.8 1.8M19.1 4.9l-1.8 1.8M6.7 17.3l-1.8 1.8" />
      </g>
    </svg>
  );
}

/** 暗色：暖色实心月牙，与亮色时的太阳成对出现在胶囊「主题」段。 */
export function TitlebarMoonIcon({ size, className }: GonaviTitlebarIconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={resolveSize(size)}
      height={resolveSize(size)}
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M20.6 14.2A8.8 8.8 0 1 1 9.8 3.4a7 7 0 0 0 10.8 10.8Z"
        strokeWidth="1.2"
        strokeLinejoin="round"
        style={{ fill: GONAVI_TITLEBAR_ICON_COLORS.warm, stroke: GONAVI_TITLEBAR_ICON_COLORS.warm }}
      />
    </svg>
  );
}

/** 主体色实心齿轮，中心孔 evenodd 镂空（暗色主题下不露白底），胶囊「偏好设置」段使用。 */
export function TitlebarSettingsIcon({ size, className }: GonaviTitlebarIconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={resolveSize(size)}
      height={resolveSize(size)}
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M10.0 2.3h4l.5 2.5 2 1.1 2.4-.9 2 3.5-1.9 1.6v2.3l1.9 1.6-2 3.5-2.4-.9-2 1.1-.5 2.5h-4l-.5-2.5-2-1.1-2.4.9-2-3.5 1.9-1.6v-2.3L3.1 8.5l2-3.5 2.4.9 2-1.1zM12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 1 0 0-7z"
        fillRule="evenodd"
        strokeWidth="0.8"
        strokeLinejoin="round"
        style={{ fill: GONAVI_TITLEBAR_ICON_COLORS.primary, stroke: GONAVI_TITLEBAR_ICON_COLORS.primary }}
      />
    </svg>
  );
}

/** AI 助手：主四角星 + 右上小辅星，走 currentColor 跟随按钮文字色。 */
export function TitlebarSparkIcon({ size, className }: GonaviTitlebarIconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={resolveSize(size)}
      height={resolveSize(size)}
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <path
        d={AI_SPARK_MAJOR_PATH}
        fill="currentColor"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path
        d={AI_SPARK_MINOR_PATH}
        fill="currentColor"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** AI（工具条彩色版）：主体色主星 + 亮点色辅星，与工具条其它按钮同色系，不单独用强调色。 */
export function TitlebarSparkColorIcon({ size, className }: GonaviTitlebarIconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={resolveSize(size)}
      height={resolveSize(size)}
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <path
        d={AI_SPARK_MAJOR_PATH}
        strokeWidth="1.6"
        strokeLinejoin="round"
        style={{ fill: GONAVI_TITLEBAR_ICON_COLORS.primary, stroke: GONAVI_TITLEBAR_ICON_COLORS.primary }}
      />
      <path
        d={AI_SPARK_MINOR_PATH}
        strokeWidth="1.3"
        strokeLinejoin="round"
        style={{ fill: GONAVI_TITLEBAR_ICON_COLORS.highlight, stroke: GONAVI_TITLEBAR_ICON_COLORS.highlight }}
      />
    </svg>
  );
}
