import React from 'react';
import { t } from '../../i18n';

/** 列表宽度的持久化键与拖拽约束：窄下限保住筛选栏，右侧保留详情最小空间。 */
export const SESSION_AGENT_LIST_WIDTH_KEY = 'gonavi.sessionAgent.listWidth';
export const SESSION_AGENT_LIST_MIN_WIDTH = 240;
export const SESSION_AGENT_LIST_RESERVE = 420;
// 详情展开时的默认窄栏宽度。必须给「确定宽度」：组头是整行 flex 容器，
// 只写 flex-basis:auto 会按内容宽度撑开（实测能到 880px），把详情挤出
// 视口。
export const SESSION_AGENT_LIST_DEFAULT_WIDTH = 340;
// 拖拽可以临时拉宽，但持久化上限跟随新的默认占比：更宽的历史值在下次
// 启动时按超限丢弃，回落默认宽度。
const SESSION_AGENT_LIST_MAX_STORED_WIDTH = 520;

export const loadSessionAgentListWidth = (): number | undefined => {
  try {
    const raw = window.localStorage.getItem(SESSION_AGENT_LIST_WIDTH_KEY);
    const parsed = raw ? Number.parseInt(raw, 10) : NaN;
    if (
      Number.isFinite(parsed) &&
      parsed >= SESSION_AGENT_LIST_MIN_WIDTH &&
      parsed <= SESSION_AGENT_LIST_MAX_STORED_WIDTH
    ) {
      return parsed;
    }
  } catch {
    // 存储不可用时回退 CSS 默认宽度。
  }
  return undefined;
};

export const saveSessionAgentListWidth = (width: number): void => {
  try {
    window.localStorage.setItem(SESSION_AGENT_LIST_WIDTH_KEY, String(width));
  } catch {
    // 持久化失败不阻断本次会话内的拖拽结果。
  }
};

/**
 * 列表与详情之间的拖拽分割条：拖动期间直接改 DOM flexBasis 保持跟手，
 * 松手后提交宽度（状态 + localStorage）。窄屏（≤900px）由 CSS 隐藏。
 */
export const SessionAgentListResizeDivider: React.FC<{
  onCommit: (width: number) => void;
}> = ({ onCommit }) => {
  const handleMouseDown = React.useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      event.preventDefault();
      const target = event.currentTarget.previousElementSibling as HTMLElement | null;
      if (!target) return;
      const container = target.parentElement;
      const containerWidth = container?.offsetWidth || window.innerWidth;
      const maxWidth = Math.min(
        SESSION_AGENT_LIST_MAX_STORED_WIDTH,
        Math.max(
          SESSION_AGENT_LIST_MIN_WIDTH + 80,
          containerWidth - SESSION_AGENT_LIST_RESERVE,
        ),
      );
      const startX = event.clientX;
      const startWidth = target.offsetWidth;

      const overlay = document.createElement('div');
      overlay.style.cssText =
        'position:fixed;top:0;left:0;right:0;bottom:0;cursor:col-resize;z-index:9999;';
      document.body.appendChild(overlay);

      let currentWidth = startWidth;
      const cleanup = (commit: boolean) => {
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', finish);
        window.removeEventListener('blur', abort);
        if (overlay.isConnected) overlay.remove();
        if (commit) onCommit(currentWidth);
      };
      const abort = () => cleanup(false);
      const finish = () => cleanup(true);
      const handleMouseMove = (moveEvent: MouseEvent) => {
        if (moveEvent.buttons === 0) {
          finish();
          return;
        }
        moveEvent.preventDefault();
        currentWidth = Math.min(
          maxWidth,
          Math.max(SESSION_AGENT_LIST_MIN_WIDTH, startWidth + moveEvent.clientX - startX),
        );
        target.style.flexBasis = `${currentWidth}px`;
        target.style.width = `${currentWidth}px`;
      };

      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', finish);
      window.addEventListener('blur', abort);
    },
    [onCommit],
  );

  return (
    <div
      className="gn-session-agent-list-resize"
      onMouseDown={handleMouseDown}
      role="separator"
      aria-orientation="vertical"
      title={t('session_agent.list.resize')}
    />
  );
};
