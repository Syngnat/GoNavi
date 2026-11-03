// 主工作区标签栏的外观样式：card = 现状卡片式，underline = 下划线式，pill = 胶囊式。
export const TAB_APPEARANCE_STYLES = ['card', 'underline', 'pill'] as const;

export type TabAppearanceStyle = typeof TAB_APPEARANCE_STYLES[number];

// 标签关闭按钮相对标签名称的位置：right = 现状（名称右侧），left = 名称左侧。
export const TAB_CLOSE_BUTTON_POSITIONS = ['left', 'right'] as const;

export type TabCloseButtonPosition = typeof TAB_CLOSE_BUTTON_POSITIONS[number];

// 默认值与现状一致；旧配置缺字段、值为 null 或脏数据时同样回退到这两个值。
export const DEFAULT_TAB_APPEARANCE_STYLE: TabAppearanceStyle = 'card';

export const DEFAULT_TAB_CLOSE_BUTTON_POSITION: TabCloseButtonPosition = 'right';

// 设置面板下拉项的文案键；文案由 shared/i18n 提供，这里只引用键名。
export const TAB_APPEARANCE_STYLE_LABEL_KEYS: Record<TabAppearanceStyle, string> = {
  card: 'app.theme.tab_appearance.style.card',
  underline: 'app.theme.tab_appearance.style.underline',
  pill: 'app.theme.tab_appearance.style.pill',
};

export const TAB_CLOSE_BUTTON_POSITION_LABEL_KEYS: Record<TabCloseButtonPosition, string> = {
  left: 'app.theme.tab_appearance.close_position.left',
  right: 'app.theme.tab_appearance.close_position.right',
};

// 已持久化的标签样式：只认清单里的取值，其余（缺字段、null、脏值）回退默认。
export const sanitizeTabAppearanceStyle = (value: unknown): TabAppearanceStyle => (
  TAB_APPEARANCE_STYLES.find((style) => style === value) ?? DEFAULT_TAB_APPEARANCE_STYLE
);

// 已持久化的关闭按钮位置：只认清单里的取值，其余（缺字段、null、脏值）回退默认。
export const sanitizeTabCloseButtonPosition = (value: unknown): TabCloseButtonPosition =>
  TAB_CLOSE_BUTTON_POSITIONS.find((position) => position === value)
  ?? DEFAULT_TAB_CLOSE_BUTTON_POSITION;
