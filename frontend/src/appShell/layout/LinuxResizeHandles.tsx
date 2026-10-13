import React from 'react';

/**
 * Linux Mint 下 frameless 窗口仅局部可缩放：补四边四角命中层。
 * 从 App.tsx 抽出，App 只保留一行接线。
 */

export interface LinuxResizeHandlesProps {
  visible: boolean;
  styleBase: React.CSSProperties;
}

const EDGE_HANDLES: Array<Partial<React.CSSProperties>> = [
  { top: 0, left: 14, right: 14, height: 6, cursor: 'ns-resize' },
  { bottom: 0, left: 14, right: 14, height: 6, cursor: 'ns-resize' },
  { top: 14, bottom: 14, left: 0, width: 6, cursor: 'ew-resize' },
  { top: 14, bottom: 14, right: 0, width: 6, cursor: 'ew-resize' },
];

const CORNER_HANDLES: Array<Partial<React.CSSProperties>> = [
  { top: 0, left: 0, width: 14, height: 14, cursor: 'nwse-resize' },
  { top: 0, right: 0, width: 14, height: 14, cursor: 'nesw-resize' },
  { bottom: 0, left: 0, width: 14, height: 14, cursor: 'nesw-resize' },
  { bottom: 0, right: 0, width: 14, height: 14, cursor: 'nwse-resize' },
];

export const LinuxResizeHandles = ({ visible, styleBase }: LinuxResizeHandlesProps) => {
  if (!visible) return null;
  return (
    <>
      {EDGE_HANDLES.map((handle, index) => (
        <div key={`edge-${index}`} style={{ ...styleBase, ...handle } as React.CSSProperties} />
      ))}
      {CORNER_HANDLES.map((handle, index) => (
        <div key={`corner-${index}`} style={{ ...styleBase, ...handle } as React.CSSProperties} />
      ))}
    </>
  );
};

export default LinuxResizeHandles;
