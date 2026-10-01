import React from 'react';

export type GnIconProps = Omit<React.HTMLAttributes<HTMLSpanElement>, 'children'>;

/** 图标线宽（24x24 视口内的单位）；小字号下约 1.1~1.3px，比 antd outlined 更清晰。 */
export const GN_ICON_STROKE_WIDTH = 2;

/**
 * GoNavi 自绘线性图标的工厂。
 *
 * 渲染约定与 antd 图标一致（span.anticon + 1em SVG + currentColor），
 * 可以直接放进 Button / Menu 的 icon 槽，字号与颜色随上下文；
 * 不依赖 @ant-design/icons，测试里 mock 图标库时不受影响。
 * 同一套线宽、圆角、留白，保证不同位置的图标看起来是一个家族。
 */
export const createGnIcon = (name: string, children: React.ReactNode): React.FC<GnIconProps> => {
  const GnIcon: React.FC<GnIconProps> = ({ className, ...rest }) => (
    <span
      role="img"
      aria-label={name}
      {...rest}
      className={`anticon gn-icon gn-icon-${name}${className ? ` ${className}` : ''}`}
    >
      <svg
        viewBox="0 0 24 24"
        width="1em"
        height="1em"
        fill="none"
        stroke="currentColor"
        strokeWidth={GN_ICON_STROKE_WIDTH}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
      >
        {children}
      </svg>
    </span>
  );
  GnIcon.displayName = `GnIcon(${name})`;
  return GnIcon;
};
