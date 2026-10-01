import React from 'react';

import { createGnIcon } from './gnIcon';

/**
 * GoNavi 图标家族：同一个功能在所有位置只用同一个图标。
 *
 * 分区：
 * - 侧栏工具：搜索、定位、回顶、连接操作
 * - 对象类型：全部、表、视图、序列、函数与存储过程、包、事件、Nacos
 * - 全局动作：新建连接、新建查询（与标题栏同一图形，标题栏用彩色版）
 * - 数据预览：工具栏、底部视图切换、结果视图、列头
 */

const Dot: React.FC<{ cx: number; cy: number; r?: number }> = ({ cx, cy, r = 1.25 }) => (
  <circle cx={cx} cy={cy} r={r} fill="currentColor" stroke="none" />
);

/* ───────── 侧栏工具 ───────── */

export const GnSearchIcon = createGnIcon('search', (
  <>
    <circle cx="10.6" cy="10.6" r="6.4" />
    <path d="m15.3 15.3 5.2 5.2" />
  </>
));

/** 定位当前表：地图定位针。 */
export const GnLocateIcon = createGnIcon('locate', (
  <>
    <path d="M12 21.3c-4-3.3-6.7-6.6-6.7-10.3a6.7 6.7 0 0 1 13.4 0c0 3.7-2.7 7-6.7 10.3z" />
    <circle cx="12" cy="11" r="2.4" />
  </>
));

export const GnScrollTopIcon = createGnIcon('scroll-top', (
  <>
    <path d="M5.5 4.5h13" />
    <path d="M12 20V9" />
    <path d="m6.6 13.6 5.4-5.4 5.4 5.4" />
  </>
));

/** 连接操作：圆内三点，比单独的竖点更像“更多操作”的按钮。 */
export const GnConnectionMenuIcon = createGnIcon('connection-menu', (
  <>
    <circle cx="12" cy="12" r="9" />
    <Dot cx={7.9} cy={12} r={1.3} />
    <Dot cx={12} cy={12} r={1.3} />
    <Dot cx={16.1} cy={12} r={1.3} />
  </>
));

/* ───────── 对象类型（侧栏过滤 / 分组共用） ───────── */

/** 全部对象：叠层，与“表”的网格明确区分。 */
export const GnAllObjectsIcon = createGnIcon('all-objects', (
  <>
    <path d="M12 3.6 3.6 8l8.4 4.4L20.4 8z" />
    <path d="m3.6 12 8.4 4.4 8.4-4.4" />
    <path d="m3.6 16 8.4 4.4 8.4-4.4" />
  </>
));

export const GnTableIcon = createGnIcon('table', (
  <>
    <rect x="3.5" y="4.5" width="17" height="15" rx="2.6" />
    <path d="M3.5 9.8h17M9.6 9.8v9.7" />
  </>
));

export const GnViewIcon = createGnIcon('view', (
  <>
    <path d="M2.7 12S6.1 5.7 12 5.7 21.3 12 21.3 12 17.9 18.3 12 18.3 2.7 12 2.7 12z" />
    <circle cx="12" cy="12" r="2.9" />
  </>
));

/** 序列：井号，表达“编号 / 自增”。 */
export const GnSequenceIcon = createGnIcon('sequence', (
  <path d="M9.3 4 7.6 20M16.4 4l-1.7 16M4.6 9h15.2M4.2 15h15.2" />
));

/** 函数与存储过程：函数符号 ƒ。 */
export const GnFunctionIcon = createGnIcon('function', (
  <>
    <path d="M15.8 4.3c-2.3-.7-3.9.4-4.3 2.7l-1.8 10c-.4 2.2-2 3.3-4.3 2.7" />
    <path d="M7.2 11.4h7.7" />
  </>
));

export const GnPackageIcon = createGnIcon('package', (
  <>
    <path d="M12 3.2 20 7.6v8.8l-8 4.4-8-4.4V7.6z" />
    <path d="m4.3 7.9 7.7 4.2 7.7-4.2M12 12.1v8.6" />
  </>
));

/** 事件（定时任务）：日历里的时钟指针。 */
export const GnEventIcon = createGnIcon('event', (
  <>
    <rect x="3.5" y="5" width="17" height="15.5" rx="2.6" />
    <path d="M8 3v4M16 3v4M3.5 10h17" />
    <path d="M12 12.8v3l2.1 1.3" />
  </>
));

/** 触发器：闪电。 */
export const GnBoltIcon = createGnIcon('bolt', (
  <path d="M13.4 2.8 5.2 13.6h6l-.9 7.6 8.5-11h-6.1z" />
));

/** 物化视图：眼睛下方叠放的数据层，与“视图”区分。 */
export const GnMaterializedViewIcon = createGnIcon('materialized-view', (
  <>
    <path d="M3.6 9.4S6.6 4 12 4s8.4 5.4 8.4 5.4S17.4 14.8 12 14.8 3.6 9.4 3.6 9.4z" />
    <circle cx="12" cy="9.4" r="2.5" />
    <path d="m4 17.6 8 3.6 8-3.6" />
  </>
));

export const GnCloudIcon = createGnIcon('cloud', (
  <path d="M7.5 18.6h9.2a4 4 0 0 0 .7-7.9 5.6 5.6 0 0 0-10.8 1.5 3.3 3.3 0 0 0 .9 6.4z" />
));

/** 配置文件：文档 + 文本行。 */
export const GnConfigFileIcon = createGnIcon('config-file', (
  <>
    <path d="M6 3.5h8.2l4.3 4.3V19a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 19V5A1.5 1.5 0 0 1 6 3.5z" />
    <path d="M14 3.5v4.6h4.5M8 12.6h8M8 16.2h5.4" />
  </>
));

/* ───────── 全局动作（与标题栏同一图形） ───────── */

/** 新建连接：斜置插头 + 加号角标（与标题栏 TitlebarPlugIcon 同一造型）。 */
export const GnNewConnectionIcon = createGnIcon('new-connection', (
  <>
    <g transform="rotate(-45 13 11)">
      <rect x="8.5" y="7.6" width="9" height="6.8" rx="2.2" />
      <path d="M17.5 9.4h2.6M17.5 12.6h2.6M8.5 11H5.4" />
    </g>
    <circle cx="17.8" cy="17.8" r="4.2" />
    <path d="M17.8 15.9v3.8m-1.9-1.9h3.8" />
  </>
));

/** 新建查询：表格 + 加号角标（图形来自标题栏 TitlebarGridIcon）。 */
export const GnNewQueryIcon = createGnIcon('new-query', (
  <>
    <path d="M14.2 17.6H5.4A2.4 2.4 0 0 1 3 15.2V5.9a2.4 2.4 0 0 1 2.4-2.4h13.2A2.4 2.4 0 0 1 21 5.9v4.5" />
    <path d="M3 9h18M8.6 9v8.6" />
    <circle cx="17.6" cy="17.6" r="4.4" />
    <path d="M17.6 15.6v4m-2-2h4" />
  </>
));

/* ───────── 数据预览：工具栏 ───────── */

export const GnRefreshIcon = createGnIcon('refresh', (
  <>
    <path d="M20 12a8 8 0 1 1-2.5-5.8" />
    <path d="M20.2 4v4.8h-4.8" />
  </>
));

export const GnFilterIcon = createGnIcon('filter', (
  <path d="M4 5.4h16l-6.2 7.5v5.9l-3.6 1.7v-7.6z" />
));

/** 新增行：已有的一行 + 下方加号。 */
export const GnAddRowIcon = createGnIcon('add-row', (
  <>
    <rect x="3.5" y="3.8" width="17" height="6.6" rx="2.2" />
    <path d="M12 14v6.4M8.8 17.2h6.4" />
  </>
));

export const GnTrashIcon = createGnIcon('trash', (
  <>
    <path d="M4.5 7h15M9.6 7V4.7c0-.6.5-1.1 1.1-1.1h2.6c.6 0 1.1.5 1.1 1.1V7" />
    <path d="m6.5 7 .8 11.9a1.7 1.7 0 0 0 1.7 1.6h6a1.7 1.7 0 0 0 1.7-1.6L17.5 7" />
    <path d="M10.2 11v5.6M13.8 11v5.6" />
  </>
));

/** 撤销（如撤销删除标记）：向左折返箭头。 */
export const GnUndoIcon = createGnIcon('undo', (
  <>
    <path d="M8.6 4.8 3.9 9.5l4.7 4.7" />
    <path d="M4.2 9.5h9.4a5.6 5.6 0 0 1 0 11.2H9.6" />
  </>
));

/** 回滚全部改动：逆时针回退箭头，与“撤销”“历史”区分。 */
export const GnRollbackIcon = createGnIcon('rollback', (
  <>
    <path d="M4 12a8 8 0 1 0 2.5-5.8" />
    <path d="M3.8 4v4.8h4.8" />
  </>
));

/** 单元格选择模式：虚线选框 + 光标。 */
export const GnCellSelectIcon = createGnIcon('cell-select', (
  <>
    <rect x="3.5" y="4" width="13.5" height="12" rx="2.2" strokeDasharray="2.7 2.7" />
    <path d="m12.6 12.6 7.6 2.9-3.3 1.4-1.4 3.3z" />
  </>
));

export const GnCopyIcon = createGnIcon('copy', (
  <>
    <rect x="8.6" y="8.6" width="11.4" height="11.9" rx="2.3" />
    <path d="M15.6 8.6V6.3a2.3 2.3 0 0 0-2.3-2.3H6.3A2.3 2.3 0 0 0 4 6.3v7.1a2.3 2.3 0 0 0 2.3 2.3h2.3" />
  </>
));

/** 复制（含列名）：剪贴板 + 文本行。 */
export const GnClipboardIcon = createGnIcon('clipboard', (
  <>
    <rect x="5" y="4.6" width="14" height="16.4" rx="2.3" />
    <path d="M9.2 4.6v-.9c0-.5.4-.9.9-.9h3.8c.5 0 .9.4.9.9v.9" />
    <path d="M8.6 11h6.8M8.6 15h4.4" />
  </>
));

export const GnPencilIcon = createGnIcon('pencil', (
  <>
    <path d="M4.2 19.8 5 16 15.6 5.4a2 2 0 0 1 2.8 0l.2.2a2 2 0 0 1 0 2.8L8 19z" />
    <path d="m14 7 3 3" />
  </>
));

/** 向下填充 / 应用模板：箭头落到底线。 */
export const GnFillDownIcon = createGnIcon('fill-down', (
  <>
    <path d="M12 3.5v12" />
    <path d="m6.6 10.6 5.4 5.4 5.4-5.4" />
    <path d="M5.5 20.4h13" />
  </>
));

/** 统计总数：求和符号 Σ。 */
export const GnSigmaIcon = createGnIcon('sigma', (
  <path d="M17.6 5.4H6.8l5.6 6.6-5.6 6.6h10.8" />
));

export const GnSaveIcon = createGnIcon('save', (
  <>
    <path d="M6 3.5h9.8l4.7 4.7V18a2.5 2.5 0 0 1-2.5 2.5H6A2.5 2.5 0 0 1 3.5 18V6A2.5 2.5 0 0 1 6 3.5z" />
    <path d="M7.6 3.7v4.6h6.8V3.7" />
    <rect x="7.2" y="13.2" width="9.6" height="7.2" rx="1" />
  </>
));

/** SQL 文本：文档 + 尖括号，用于“预览 SQL / 查看 DDL”。 */
export const GnSqlDocIcon = createGnIcon('sql-doc', (
  <>
    <path d="M6 3.5h8.2l4.3 4.3V19a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 19V5A1.5 1.5 0 0 1 6 3.5z" />
    <path d="M14 3.5v4.6h4.5" />
    <path d="m10 11.6-2.4 2.3 2.4 2.3M14 11.6l2.4 2.3-2.4 2.3" />
  </>
));

/** 提交方式：两组滑杆。 */
export const GnSlidersIcon = createGnIcon('sliders', (
  <>
    <path d="M4 7h8.4M17.4 7H20M4 17h2.6M11.6 17H20" />
    <circle cx="14.9" cy="7" r="2.5" />
    <circle cx="9.1" cy="17" r="2.5" />
  </>
));

/** 导入：箭头落入托盘。 */
export const GnImportIcon = createGnIcon('import', (
  <>
    <path d="M12 3.5v11" />
    <path d="m7.6 10.4 4.4 4.4 4.4-4.4" />
    <path d="M4.5 15.6v2.9a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-2.9" />
  </>
));

/** 导出：箭头离开托盘。 */
export const GnExportIcon = createGnIcon('export', (
  <>
    <path d="M12 14.5v-11" />
    <path d="m7.6 7.6 4.4-4.4 4.4 4.4" />
    <path d="M4.5 15.6v2.9a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-2.9" />
  </>
));

/* ───────── 数据预览：底部视图与结果视图 ───────── */

/** 表结构设计：表格 + 右下角铅笔。 */
export const GnTableDesignIcon = createGnIcon('table-design', (
  <>
    <path d="M13 19.5H6.1a2.6 2.6 0 0 1-2.6-2.6V7.1a2.6 2.6 0 0 1 2.6-2.6h11.8a2.6 2.6 0 0 1 2.6 2.6V11" />
    <path d="M3.5 9.8h17M9.6 9.8v9.7" />
    <path d="m13.6 20.4.5-2.4 4.7-4.7a1.3 1.3 0 0 1 1.8 0l.1.1a1.3 1.3 0 0 1 0 1.8L16 19.9z" />
  </>
));

/** 字段信息：带项目符号的列表。 */
export const GnFieldsIcon = createGnIcon('fields', (
  <>
    <path d="M9.6 6.5H20M9.6 12H20M9.6 17.5H20" />
    <Dot cx={4.8} cy={6.5} r={1.4} />
    <Dot cx={4.8} cy={12} r={1.4} />
    <Dot cx={4.8} cy={17.5} r={1.4} />
  </>
));

/** ER 图：两个实体 + 关联线。 */
export const GnErDiagramIcon = createGnIcon('er-diagram', (
  <>
    <rect x="3" y="3.8" width="8" height="6.2" rx="1.6" />
    <rect x="13" y="14" width="8" height="6.2" rx="1.6" />
    <path d="M11 6.9h3.2a2.2 2.2 0 0 1 2.2 2.2V14" />
  </>
));

/** SQL 日志：终端提示符。 */
export const GnLogIcon = createGnIcon('sql-log', (
  <>
    <rect x="3.5" y="4" width="17" height="16" rx="2.6" />
    <path d="m7.6 9.4 2.7 2.3-2.7 2.3M12.6 14.6h3.8" />
  </>
));

/** 列显示：三列。 */
export const GnColumnsIcon = createGnIcon('columns', (
  <>
    <rect x="3.5" y="4.5" width="17" height="15" rx="2.6" />
    <path d="M9.2 4.5v15M14.8 4.5v15" />
  </>
));

/** 跳转到列：箭头到达竖线。 */
export const GnJumpColumnIcon = createGnIcon('jump-column', (
  <>
    <path d="M3.5 12h12.4" />
    <path d="m10.8 6.8 5.2 5.2-5.2 5.2" />
    <path d="M20.5 5v14" />
  </>
));

/** 结果视图 · JSON。 */
export const GnJsonIcon = createGnIcon('json', (
  <>
    <path d="M8.6 4.2c-2 0-2.8.9-2.8 2.7v2.1c0 1.5-.7 2.4-2.3 3 1.6.6 2.3 1.5 2.3 3v2.1c0 1.8.8 2.7 2.8 2.7" />
    <path d="M15.4 4.2c2 0 2.8.9 2.8 2.7v2.1c0 1.5.7 2.4 2.3 3-1.6.6-2.3 1.5-2.3 3v2.1c0 1.8-.8 2.7-2.8 2.7" />
  </>
));

/** 结果视图 · 文本。 */
export const GnTextViewIcon = createGnIcon('text-view', (
  <path d="M4.5 6.5h15M4.5 11h15M4.5 15.5h15M4.5 20h8.6" />
));

/* ───────── AI 聊天 ───────── */

export const GnPlusIcon = createGnIcon('plus', <path d="M12 5v14M5 12h14" />);

/** 文件夹：合上的。 */
export const GnFolderIcon = createGnIcon('folder', (
  <path d="M3.5 7.4A2.4 2.4 0 0 1 5.9 5h3.5a2 2 0 0 1 1.5.7l1 1.2a2 2 0 0 0 1.5.7h4.7a2.4 2.4 0 0 1 2.4 2.4v7.6a2.4 2.4 0 0 1-2.4 2.4H5.9a2.4 2.4 0 0 1-2.4-2.4z" />
));

/** 文件夹：打开的，前面一片斜掀起。 */
export const GnFolderOpenIcon = createGnIcon('folder-open', (
  <>
    <path d="M3.5 17.4V6.9A2.4 2.4 0 0 1 5.9 4.5h3.5a2 2 0 0 1 1.5.7l.9 1.1a2 2 0 0 0 1.5.7h3.7a2.4 2.4 0 0 1 2.4 2.4v1.4" />
    <path d="M3.6 19h14.2a1.7 1.7 0 0 0 1.6-1.2l1.9-5.6a1.2 1.2 0 0 0-1.1-1.6H7.6a1.7 1.7 0 0 0-1.6 1.2z" />
  </>
));

/** 索引：按顺序排列的行 + 向下的箭头。 */
export const GnIndexIcon = createGnIcon('index', (
  <>
    <path d="M4 6.5h9M4 12h6.5M4 17.5h4" />
    <path d="M18 6v12M14.8 15l3.2 3.2 3.2-3.2" />
  </>
));

/** 外键 / 关联：两环相扣的链节。 */
export const GnLinkIcon = createGnIcon('link', (
  <>
    <path d="M9.8 14.2a3.6 3.6 0 0 0 5.1 0l3.2-3.2a3.6 3.6 0 0 0-5.1-5.1l-1 1" />
    <path d="M14.2 9.8a3.6 3.6 0 0 0-5.1 0L5.9 13a3.6 3.6 0 0 0 5.1 5.1l1-1" />
  </>
));

/** 下拉箭头：菜单/下拉触发器。 */
export const GnChevronDownIcon = createGnIcon('chevron-down', <path d="m5 9 7 7 7-7" />);

/** 更多：横向三点，点用粗描边画成实心圆点。 */
export const GnMoreIcon = createGnIcon('more', <path strokeWidth={4} d="M5.5 12h.01M12 12h.01M18.5 12h.01" />);

/** 自动换行：两行文字，第二行折返并带回车箭头。 */
export const GnWrapIcon = createGnIcon('wrap', (
  <>
    <path d="M4 6h16" />
    <path d="M4 12h12.5a3.25 3.25 0 0 1 0 6.5H12" />
    <path d="m14.6 16.4-2.6 2.1 2.6 2.1" />
    <path d="M4 18.5h4" />
  </>
));

/** 美化：魔术棒 + 星光，和“自动换行”的多行图形、AI 的星标区分开。 */
export const GnFormatIcon = createGnIcon('format', (
  <>
    <path d="M4.2 19.8 13 11" />
    <path d="M17.2 3.2c.4 2.5 1.7 3.8 4.2 4.2-2.5.4-3.8 1.7-4.2 4.2-.4-2.5-1.7-3.8-4.2-4.2 2.5-.4 3.8-1.7 4.2-4.2z" />
    <path strokeWidth={2.8} d="M6.4 6.2h.01M19.2 17.4h.01" />
  </>
));

/** 全屏：四角向外。 */
export const GnFullscreenIcon = createGnIcon('fullscreen', (
  <path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5" />
));

/** 退出全屏：四角向内。 */
export const GnFullscreenExitIcon = createGnIcon('fullscreen-exit', (
  <path d="M9 4v5H4M20 9h-5V4M15 20v-5h5M4 15h5v5" />
));

/** 时钟：延迟提交。 */
export const GnClockIcon = createGnIcon('clock', (
  <>
    <circle cx="12" cy="12" r="8.6" />
    <path d="M12 7.4V12l3.1 1.9" />
  </>
));

export const GnCloseIcon = createGnIcon('close', <path d="m6.2 6.2 11.6 11.6M17.8 6.2 6.2 17.8" />);

/** 设置：八齿齿轮 + 中心孔。 */
export const GnSettingsIcon = createGnIcon('settings', (
  <>
    <path d="M19.2 10.3 L21.5 10.7 L21.5 13.3 L19.2 13.7 L18.3 15.9 L19.7 17.8 L17.8 19.7 L15.9 18.3 L13.7 19.2 L13.3 21.5 L10.7 21.5 L10.3 19.2 L8.1 18.3 L6.2 19.7 L4.3 17.8 L5.7 15.9 L4.8 13.7 L2.5 13.3 L2.5 10.7 L4.8 10.3 L5.7 8.1 L4.3 6.2 L6.2 4.3 L8.1 5.7 L10.3 4.8 L10.7 2.5 L13.3 2.5 L13.7 4.8 L15.9 5.7 L17.8 4.3 L19.7 6.2 L18.3 8.1z" />
    <circle cx="12" cy="12" r="2.9" />
  </>
));

/** 历史：带指针的逆时针箭头。 */
export const GnHistoryIcon = createGnIcon('history', (
  <>
    <path d="M4 12a8 8 0 1 0 2.5-5.8" />
    <path d="M3.8 4v4.8h4.8" />
    <path d="M12 8v4.3l2.8 1.7" />
  </>
));

/** 自动洞察：灯泡。 */
export const GnInsightIcon = createGnIcon('insight', (
  <>
    <path d="M12 3.4a6 6 0 0 0-3.6 10.8c.7.6 1.1 1.4 1.1 2.2v.9h5v-.9c0-.8.4-1.6 1.1-2.2A6 6 0 0 0 12 3.4z" />
    <path d="M9.6 20.4h4.8" />
  </>
));

/** 新对话：对话气泡 + 加号。 */
export const GnNewChatIcon = createGnIcon('new-chat', (
  <>
    <path d="M20.4 12.4v3.9a2.4 2.4 0 0 1-2.4 2.4h-7.4l-4.6 3v-3H6A2.4 2.4 0 0 1 3.6 16.3V7.9A2.4 2.4 0 0 1 6 5.5h6.4" />
    <path d="M17.6 3.2v5.6M14.8 6h5.6" />
  </>
));

/** 弹出为独立窗口。 */
export const GnPopoutIcon = createGnIcon('popout', (
  <>
    <path d="M14 4h6v6M20 4l-8.6 8.6" />
    <path d="M18 14v3.5a2.5 2.5 0 0 1-2.5 2.5h-9A2.5 2.5 0 0 1 4 17.5v-9A2.5 2.5 0 0 1 6.5 6H10" />
  </>
));

/** 收回到侧栏。 */
export const GnDockIcon = createGnIcon('dock', (
  <>
    <path d="M4 9.2h5.2V4M9.2 9.2 3.8 3.8" />
    <path d="M20 14.8h-5.2V20M14.8 14.8l5.4 5.4" />
  </>
));

/** 上传附件：回形针。 */
export const GnAttachIcon = createGnIcon('attach', (
  <path d="m20 11.4-7.8 7.8a5 5 0 0 1-7.1-7.1l8.3-8.3a3.3 3.3 0 0 1 4.7 4.7l-8.3 8.3a1.7 1.7 0 0 1-2.4-2.4l7.6-7.6" />
));

/** 斜杠命令：方框里的斜杠。 */
export const GnSlashCommandIcon = createGnIcon('slash-command', (
  <>
    <rect x="3.5" y="4" width="17" height="16" rx="3.2" />
    <path d="m14.3 8-4.6 8" />
  </>
));

export const GnSendIcon = createGnIcon('send', (
  <>
    <path d="M20.6 3.4 3.4 10.5l6.9 2.7 2.7 6.9z" />
    <path d="M20.6 3.4 10.3 13.2" />
  </>
));

/** 停止：实心圆角方块。 */
export const GnStopIcon = createGnIcon('stop', (
  <rect x="6.6" y="6.6" width="10.8" height="10.8" rx="2.6" fill="currentColor" />
));

export const GnDatabaseIcon = createGnIcon('database', (
  <>
    <ellipse cx="12" cy="6.2" rx="7.5" ry="2.9" />
    <path d="M4.5 6.2v11.6c0 1.6 3.4 2.9 7.5 2.9s7.5-1.3 7.5-2.9V6.2" />
    <path d="M4.5 12c0 1.6 3.4 2.9 7.5 2.9s7.5-1.3 7.5-2.9" />
  </>
));

/** 优化建议：仪表盘指针。 */
export const GnGaugeIcon = createGnIcon('gauge', (
  <>
    <path d="M4.7 17.6a8.6 8.6 0 1 1 14.6 0" />
    <path d="m12 13.8 3.6-4.8" />
    <circle cx="12" cy="13.8" r="1.2" fill="currentColor" />
  </>
));
