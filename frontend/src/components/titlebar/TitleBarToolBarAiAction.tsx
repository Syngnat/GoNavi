import { TitlebarSparkColorIcon } from './gonaviTitlebarIcons';

export interface TitleBarToolBarAiActionProps {
  label: string;
  /** 完整名称，用作无障碍名与悬浮提示（标签只显示「AI」两个字）。 */
  title: string;
  active: boolean;
  onClick: () => void;
}

/**
 * 工具条里的 AI 入口（图标 + 文字）。
 *
 * 各平台统一放在工具条「SQL 工具」右侧；样式沿用工具条按钮的通用类名，激活态与
 * 「驱动管理」共用同一个 data 标记。
 */
export default function TitleBarToolBarAiAction({ label, title, active, onClick }: TitleBarToolBarAiActionProps) {
  return (
    <button
      type="button"
      className="gn-v2-titlebar-quick-action"
      data-gonavi-ai-toolbar-action="true"
      data-titlebar-toolbar-item-active={active ? 'true' : undefined}
      data-no-titlebar-toggle="true"
      aria-label={title}
      aria-pressed={active}
      title={title}
      onClick={onClick}
    >
      <span className="gn-titlebar-toolbar-item-icon" data-titlebar-toolbar-icon="ai" aria-hidden="true">
        <TitlebarSparkColorIcon size="100%" />
      </span>
      <span className="gn-titlebar-toolbar-item-label">{label}</span>
    </button>
  );
}
