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
 * - toolbar：默认。桌面端常驻标题栏第二行或独立工具条下方，其他平台在 explorer 头部。
 * - rail：固定在连接树左侧的侧边栏里竖排，展开、折叠都不动。
 */
export type SidebarActionsPlacement = 'toolbar' | 'rail';

export interface TitlebarActionsPlacementSettings {
  titlebarActionsPlacement: TitlebarActionsPlacement;
  titlebarActionsDisplay: TitlebarActionsDisplay;
  sidebarActionsPlacement: SidebarActionsPlacement;
}

/**
 * 新用户（本地没有任何配置）的默认值：标题栏 GoNavi 右侧 + 图标 + 精简名称。
 * 首次启动时持久化层拿不到 appearance，直接使用这里的默认外观。
 */
export const DEFAULT_TITLEBAR_ACTIONS_PLACEMENT_SETTINGS: TitlebarActionsPlacementSettings = {
  titlebarActionsPlacement: 'titlebar',
  titlebarActionsDisplay: 'icon-text',
  sidebarActionsPlacement: 'toolbar',
};

/**
 * 老配置缺字段时的回退：保持升级前的独立工具条，避免界面突变；
 * 之后切到标题栏时默认纯文字。
 */
export const LEGACY_TITLEBAR_ACTIONS_PLACEMENT_SETTINGS: TitlebarActionsPlacementSettings = {
  titlebarActionsPlacement: 'toolbar',
  titlebarActionsDisplay: 'text',
  sidebarActionsPlacement: 'toolbar',
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

// 侧栏按钮位置新老用户默认一致（toolbar），缺字段或非法值都回退到它。
const sanitizeSidebarActionsPlacement = (value: unknown): SidebarActionsPlacement => (
  value === 'rail' ? 'rail' : 'toolbar'
);

/** 归一化已持久化的外观：未知值或缺字段按老用户处理，回退到升级前的布局。 */
export const sanitizeTitlebarActionsPlacementSettings = (
  value: Partial<TitlebarActionsPlacementSettings> | undefined,
): TitlebarActionsPlacementSettings => ({
  titlebarActionsPlacement: sanitizeTitlebarActionsPlacement(value?.titlebarActionsPlacement),
  titlebarActionsDisplay: sanitizeTitlebarActionsDisplay(value?.titlebarActionsDisplay),
  sidebarActionsPlacement: sanitizeSidebarActionsPlacement(value?.sidebarActionsPlacement),
});
