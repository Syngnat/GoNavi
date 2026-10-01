/**
 * 标题栏工作台入口（用户管理、会话工作台等）的手写 SVG 图标。
 *
 * 与 gonaviTitlebarIcons.tsx 同一套规范：24x24 视口、实心色块 + 白色圆角细节线，
 * 配色统一取 GONAVI_TITLEBAR_ICON_COLORS，随主题的 --gn-titlebar-icon-* 变量换色。
 */

import { GONAVI_TITLEBAR_ICON_COLORS, resolveSize, type GonaviTitlebarIconProps } from './gonaviTitlebarIcons';

/**
 * 人像 + 盾牌（用户管理）：主体色人像表示账号，右下强调色盾牌表示权限。
 * 盾牌描白边，保证在人像之上叠放时轮廓清晰。
 */
export function TitlebarUserManagementIcon({ size, className }: GonaviTitlebarIconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={resolveSize(size)}
      height={resolveSize(size)}
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="9.6" cy="7.4" r="3.9" style={{ fill: GONAVI_TITLEBAR_ICON_COLORS.primary }} />
      <path
        d="M2.6 20.4c0-4.1 3.1-7.2 7-7.2 1.9 0 3.6.7 4.9 1.9V20.4Z"
        style={{ fill: GONAVI_TITLEBAR_ICON_COLORS.primary }}
      />
      <path
        d="M17.8 11.6 22 13.2v3.4c0 2.5-1.7 4.5-4.2 5.4-2.5-.9-4.2-2.9-4.2-5.4v-3.4Z"
        stroke="#fff"
        strokeWidth="1.2"
        strokeLinejoin="round"
        style={{ fill: GONAVI_TITLEBAR_ICON_COLORS.accent }}
      />
      <path
        d="M16.1 16.7l1.2 1.2 2.3-2.4"
        stroke="#fff"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}

/**
 * 叠放会话卡片 + 心跳线（会话工作台）：后方浅色卡片表示多个会话，
 * 前方主体色卡片上的白色心跳线表示正在运行的活动。
 * 不用节点连线，避免与「数据工作流」的节点图混淆。
 */
export function TitlebarSessionIcon({ size, className }: GonaviTitlebarIconProps) {
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
        x="6.6"
        y="2.8"
        width="14.8"
        height="11.4"
        rx="2.8"
        style={{ fill: GONAVI_TITLEBAR_ICON_COLORS.primarySoft }}
      />
      <rect
        x="2.6"
        y="7.6"
        width="15.6"
        height="13.4"
        rx="3"
        stroke="#fff"
        strokeWidth="1.2"
        style={{ fill: GONAVI_TITLEBAR_ICON_COLORS.primary }}
      />
      <path
        d="M5.4 14.6h2.3l1.4-2.8 2.2 5.4 1.5-2.6h2.4"
        stroke="#fff"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}
