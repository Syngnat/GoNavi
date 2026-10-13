import React from 'react';

/**
 * 日志面板拖拽时跟随鼠标的 ghost 指示线。平时 display:none，由
 * useAppLogPanelResize 在拖拽时切换可见性。从 App.tsx 抽出。
 */

export interface AppLogPanelResizeGhostProps {
  ghostRef: React.Ref<HTMLDivElement>;
  left: number;
  guideColor: string;
}

export const AppLogPanelResizeGhost = ({ ghostRef, left, guideColor }: AppLogPanelResizeGhostProps) => (
  <div
    ref={ghostRef}
    style={{
      position: 'fixed',
      left, // 从渲染中的侧栏右缘开始
      right: 0,
      height: '4px',
      background: guideColor,
      zIndex: 9999,
      pointerEvents: 'none',
      display: 'none',
      cursor: 'row-resize',
    } as React.CSSProperties}
  />
);

export default AppLogPanelResizeGhost;
