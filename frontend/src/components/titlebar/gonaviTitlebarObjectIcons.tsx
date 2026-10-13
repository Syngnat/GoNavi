/**
 * 工具条「对象类」按钮的手绘线条图标（表 / 视图 / 函数 / 事件 / 查询 / 备份 /
 * 打开表 / 设计表 / 导入 / 导出 / 模型）。
 *
 * 线稿与配色对齐 Navicat 高保真原型（navicat-prototype.html 的 SVG 库）：
 * 16 视口、约 1.25 描边、每个按钮一个固定主色，深浅主题下均可读。
 * 颜色不走 CSS 变量：原型语义就是「每按钮一色」。
 */

import { resolveSize, type GonaviTitlebarIconProps } from './gonaviTitlebarIcons';

interface LineIconProps extends GonaviTitlebarIconProps {
  color?: string;
}

const lineSvgProps = (size: number | string | undefined, className: string | undefined, color: string) => ({
  viewBox: '0 0 16 16',
  width: resolveSize(size),
  height: resolveSize(size),
  className,
  'aria-hidden': true as const,
  focusable: 'false' as const,
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.25,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  style: { color },
});

/** 表（对象列表）：网格。 */
export function TitlebarTableIcon({ size, className, color = '#4f8ef7' }: LineIconProps) {
  return (
    <svg {...lineSvgProps(size, className, color)}>
      <rect x="1.7" y="2.7" width="12.6" height="10.8" rx="1.1" />
      <path d="M1.7 6.1h12.6M1.7 9.4h12.6M6 6.1v7.4M10.5 6.1v7.4" />
    </svg>
  );
}

/** 视图：眼睛。 */
export function TitlebarViewIcon({ size, className, color = '#e8862f' }: LineIconProps) {
  return (
    <svg {...lineSvgProps(size, className, color)}>
      <path d="M1.6 8s2.6-4.4 6.4-4.4S14.4 8 14.4 8 11.8 12.4 8 12.4 1.6 8 1.6 8z" />
      <circle cx="8" cy="8" r="1.9" />
    </svg>
  );
}

/** 函数：斜体 fx。 */
export function TitlebarFunctionIcon({ size, className, color = '#9b59c8' }: LineIconProps) {
  return (
    <svg {...lineSvgProps(size, className, color)}>
      <text x="2.2" y="12" fontSize="10.5" fontStyle="italic" fontFamily="Georgia,serif" fill="currentColor" stroke="none">fx</text>
    </svg>
  );
}

/** 事件：时钟。 */
export function TitlebarEventIcon({ size, className, color = '#5aa0e0' }: LineIconProps) {
  return (
    <svg {...lineSvgProps(size, className, color)}>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4.6V8l2.5 1.5" />
    </svg>
  );
}

/** 查询（收藏查询）：报表页。 */
export function TitlebarSavedQueryIcon({ size, className, color = '#e05a5a' }: LineIconProps) {
  return (
    <svg {...lineSvgProps(size, className, color)}>
      <path d="M3 1.7h6.4L13 5.3v9H3z" />
      <path d="M9.4 1.7v3.6H13" />
      <path d="M5.7 12V9.9M8 12V7.8M10.3 12V8.9" />
    </svg>
  );
}

/** 备份：循环箭头。 */
export function TitlebarBackupIcon({ size, className, color = '#7a86a3' }: LineIconProps) {
  return (
    <svg {...lineSvgProps(size, className, color)}>
      <path d="M13.1 8a5.1 5.1 0 1 1-1.6-3.7" />
      <path d="M13.1 2.6V5h-2.5" />
    </svg>
  );
}

/** 打开表：网格 + 播放角标，强调色。 */
export function TitlebarOpenTableIcon({ size, className, color = '#15803d' }: LineIconProps) {
  return (
    <svg {...lineSvgProps(size, className, color)}>
      <rect x="1.7" y="2.7" width="10.8" height="10.8" rx="1.1" />
      <path d="M1.7 6.1h10.8M1.7 9.4h10.8M5.6 6.1v7.4" />
      <path d="M12.2 8.6l2.8 1.7-2.8 1.7z" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** 设计表：魔棒，强调色。 */
export function TitlebarDesignTableIcon({ size, className, color = '#15803d' }: LineIconProps) {
  return (
    <svg {...lineSvgProps(size, className, color)}>
      <path d="M2.8 13.2 10 6" />
      <path d="M11.6 2.2l.7 1.6 1.6.7-1.6.7-.7 1.6-.7-1.6-1.6-.7 1.6-.7z" fill="currentColor" stroke="none" />
      <path d="M13.2 10.4l.4 1 1 .4-1 .4-.4 1-.4-1-1-.4 1-.4z" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** 导入向导：下载入托盘。 */
export function TitlebarImportIcon({ size, className, color = '#2fa7a0' }: LineIconProps) {
  return (
    <svg {...lineSvgProps(size, className, color)}>
      <path d="M8 1.8v7.4M5 6.3l3 3 3-3" />
      <path d="M2.4 11.2v2.4h11.2v-2.4" />
    </svg>
  );
}

/** 导出向导：上传出托盘。 */
export function TitlebarExportIcon({ size, className, color = '#2fa7a0' }: LineIconProps) {
  return (
    <svg {...lineSvgProps(size, className, color)}>
      <path d="M8 9.4V2M5 5l3-3 3 3" />
      <path d="M2.4 11.2v2.4h11.2v-2.4" />
    </svg>
  );
}

/** 模型（ER）：三卡片连线。 */
export function TitlebarErModelIcon({ size, className, color = '#c05bd8' }: LineIconProps) {
  return (
    <svg {...lineSvgProps(size, className, color)}>
      <rect x="1.5" y="1.7" width="5" height="4.4" rx=".8" />
      <rect x="9.5" y="1.7" width="5" height="4.4" rx=".8" />
      <rect x="5.5" y="10" width="5" height="4.4" rx=".8" />
      <path d="M4 6.1v2.4h8V6.1M8 8.5V10" />
    </svg>
  );
}

/** 外部 SQL 文件：文件夹 + 折角文件。 */
export function TitlebarExternalSqlIcon({ size, className, color = '#d9972f' }: LineIconProps) {
  return (
    <svg {...lineSvgProps(size, className, color)}>
      <path d="M1.7 3.2h4.3l1.4 1.9h6.9v8.6a.9.9 0 0 1-.9.9H2.6a.9.9 0 0 1-.9-.9z" />
      <path d="M9.8 14.6V5.1h4.5v.2" />
      <path d="M9.9 5.2 12.6 8h-2.7z" fill="currentColor" stroke="none" />
    </svg>
  );
}
