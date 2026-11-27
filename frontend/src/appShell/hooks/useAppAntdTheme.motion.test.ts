import { describe, expect, it } from 'vitest';

import { resolveAntdMotionTokens } from '../antdMotionTokens';

describe('antd motion tokens', () => {
  it('keeps the motion lifecycle enabled when animations should be reduced', () => {
    expect(resolveAntdMotionTokens(false)).toEqual({ motion: true });
    expect(resolveAntdMotionTokens(true)).toEqual({
      motion: true,
      motionDurationFast: '0.001ms',
      motionDurationMid: '0.001ms',
      motionDurationSlow: '0.001ms',
    });
  });
});
