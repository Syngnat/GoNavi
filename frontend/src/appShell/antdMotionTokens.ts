/**
 * antd 浮层依赖 motion 生命周期完成首帧对齐。WebKitGTK 在 `motion:false`
 * 下不会触发 rc-trigger 的 onAlign，Dropdown/Popover 会一直停在初始的
 * -10000vw/-10000vh。低配与减少动画只能缩短时长，不能关闭 motion。
 */
export const resolveAntdMotionTokens = (reduceMotion: boolean) => ({
  motion: true,
  ...(reduceMotion ? {
    motionDurationFast: '0.001ms',
    motionDurationMid: '0.001ms',
    motionDurationSlow: '0.001ms',
  } : {}),
});
