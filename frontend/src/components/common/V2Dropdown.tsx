import React from 'react';
import { Dropdown, type DropdownProps } from 'antd';

// 下拉浮层的进入动画若收不到 animationend，rc-trigger 会一直把菜单留在屏幕外。
// 500ms 晚于默认 0.2s 动画，正常播放不受影响；动画结束事件丢失时按时收场并对齐。
const popupMotion = {
  motionName: 'ant-slide-up',
  motionDeadline: 500,
};

export const V2Dropdown: React.FC<DropdownProps> = (props) => (
  <Dropdown {...props} {...({ popupMotion } as DropdownProps)} />
);
