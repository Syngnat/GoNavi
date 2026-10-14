/**
 * 「新建连接 / 新建查询 / … / AI」这一行功能入口的摆放位置。
 *
 * - toolbar：标题栏下方独立工具条，图标 + 文字。
 * - titlebar：标题栏 GoNavi 右侧，沿用工具条改版前的标题栏样式。
 */
export type TitlebarActionsPlacement = 'toolbar' | 'titlebar';

/**
 * 放在标题栏时的显示方式；工具条固定为图标 + 文字，不受影响。
 *
 * - text：纯文字（与改版前一致）。
 * - icon：纯图标，名称见悬浮提示。
 * - icon-text：图标 + 精简名称，完整名称见悬浮提示。
 */
export type TitlebarActionsDisplay = 'text' | 'icon' | 'icon-text';

/**
 * 侧栏工具按钮（搜索 / 定位 / 回顶 / 连接操作 / 折叠）的摆放位置。
 *
 * - rail：默认。固定在连接树左侧的侧边栏里竖排，展开、折叠都不动。
 * - toolbar：常驻标题栏第二行或独立工具条下方，其他平台在 explorer 头部。
 */
export type SidebarActionsPlacement = 'toolbar' | 'rail';

export interface TitlebarActionsPlacementSettings {
  titlebarActionsPlacement: TitlebarActionsPlacement;
  titlebarActionsDisplay: TitlebarActionsDisplay;
  sidebarActionsPlacement: SidebarActionsPlacement;
}

/**
 * 新用户（本地没有任何配置）的默认值：独立工具条 + 左侧侧边栏竖排工具按钮
 * （Navicat 式骨架）。「功能入口位置」在 classic / Navicat 两种布局下都生效；
 * 选「独立工具条」时 Navicat 风格的功能入口与对象按钮（表 / 视图 / 函数…）
 * 同行渲染，选「标题栏」时对象工具条独立成行。
 */
export const DEFAULT_TITLEBAR_ACTIONS_PLACEMENT_SETTINGS: TitlebarActionsPlacementSettings = {
  titlebarActionsPlacement: 'toolbar',
  titlebarActionsDisplay: 'icon-text',
  sidebarActionsPlacement: 'rail',
};

/**
 * 老配置缺字段时的回退：与新用户默认一致。
 * 已持久化的合法取值不会被改写——只影响缺字段/非法值的兜底。
 */
export const LEGACY_TITLEBAR_ACTIONS_PLACEMENT_SETTINGS: TitlebarActionsPlacementSettings = {
  ...DEFAULT_TITLEBAR_ACTIONS_PLACEMENT_SETTINGS,
};

const sanitizeTitlebarActionsPlacement = (value: unknown): TitlebarActionsPlacement => (
  value === 'toolbar' || value === 'titlebar'
    ? value
    : LEGACY_TITLEBAR_ACTIONS_PLACEMENT_SETTINGS.titlebarActionsPlacement
);

const sanitizeTitlebarActionsDisplay = (value: unknown): TitlebarActionsDisplay => (
  value === 'text' || value === 'icon' || value === 'icon-text'
    ? value
    : LEGACY_TITLEBAR_ACTIONS_PLACEMENT_SETTINGS.titlebarActionsDisplay
);

// 侧栏按钮位置回落到默认的「左侧侧边栏」；只有显式选过「顶部工具条」才保持。
const sanitizeSidebarActionsPlacement = (value: unknown): SidebarActionsPlacement => (
  value === 'toolbar' ? 'toolbar' : 'rail'
);

/** 归一化已持久化的外观：未知值或缺字段回退到默认布局（标题栏 GoNavi 右侧）。 */
export const sanitizeTitlebarActionsPlacementSettings = (
  value: Partial<TitlebarActionsPlacementSettings> | undefined,
): TitlebarActionsPlacementSettings => ({
  titlebarActionsPlacement: sanitizeTitlebarActionsPlacement(value?.titlebarActionsPlacement),
  titlebarActionsDisplay: sanitizeTitlebarActionsDisplay(value?.titlebarActionsDisplay),
  sidebarActionsPlacement: sanitizeSidebarActionsPlacement(value?.sidebarActionsPlacement),
});
