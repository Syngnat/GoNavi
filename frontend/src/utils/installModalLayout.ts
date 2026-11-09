import type { CSSProperties } from 'react';

/**
 * 安装类弹窗内容区的最大高度。
 * antd Modal 默认 top: 100px，底部另有 24px 留白；再预留 16px，确保外层
 * .ant-modal-wrap 不需要滚动，长内容只在弹窗正文内部滚动。
 */
export const installModalContentMaxHeight = 'calc(100vh - 140px)';

type InstallModalStyles = {
  content: CSSProperties;
  header: CSSProperties;
  body: CSSProperties;
  footer: CSSProperties;
};

/**
 * 安装类弹窗统一为“外层封顶 + 正文内部滚动”。
 * 只给 body 设 maxHeight 时，正文触顶后会让 .ant-modal-wrap 多出一条整页滚动条；
 * 描述较短的插件不会触顶，于是表现为右侧滚动条时有时无。
 */
export const installModalStyles: InstallModalStyles = {
  content: {
    display: 'flex',
    flexDirection: 'column',
    maxHeight: installModalContentMaxHeight,
  },
  header: { flexShrink: 0 },
  body: { minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' },
  footer: { flexShrink: 0 },
};
