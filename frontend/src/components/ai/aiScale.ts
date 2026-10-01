/**
 * AI 聊天面板的内联尺寸：按字号设置与界面缩放换算（1 单位 = 默认设置下 1px）。
 * 与 AIChatPanel.css 里的 --gn-ai-unit 同源，保证内联样式和样式表一起缩放。
 */
export const aiPx = (value: number): string => `calc(${value} * var(--gn-ai-unit, 1px))`;
