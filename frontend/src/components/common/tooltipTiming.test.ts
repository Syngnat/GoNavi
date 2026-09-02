import { describe, expect, it } from 'vitest';
import {
  HINT_TOOLTIP_ENTER_DELAY, HINT_TOOLTIP_LEAVE_DELAY, HINT_TOOLTIP_OVERLAY_CLASS,
  hintTooltipTiming, passThroughHintTooltip,
} from './tooltipTiming';

/** antd Tooltip ships 0.1s in and 0.1s out; both felt twitchy on dense button rows. */
const ANTD_DEFAULT_DELAY = 0.1;

describe('hover hint timing', () => {
  it('holds a hint back long enough that pointing at a control does not fire it', () => {
    expect(HINT_TOOLTIP_ENTER_DELAY).toBeGreaterThan(ANTD_DEFAULT_DELAY);
    expect(HINT_TOOLTIP_ENTER_DELAY).toBeGreaterThanOrEqual(0.3);
    expect(HINT_TOOLTIP_ENTER_DELAY).toBeLessThanOrEqual(0.35);
  });

  it('keeps a hint on screen briefly after the pointer leaves so it stops blinking', () => {
    expect(HINT_TOOLTIP_LEAVE_DELAY).toBeGreaterThan(ANTD_DEFAULT_DELAY);
    expect(HINT_TOOLTIP_LEAVE_DELAY).toBeLessThan(HINT_TOOLTIP_ENTER_DELAY);
  });

  it('exposes the pair as spreadable Tooltip props', () => {
    expect(hintTooltipTiming).toEqual({
      mouseEnterDelay: HINT_TOOLTIP_ENTER_DELAY,
      mouseLeaveDelay: HINT_TOOLTIP_LEAVE_DELAY,
    });
  });

  it('lets provider-settings hints close as soon as the pointer leaves the trigger', () => {
    expect(passThroughHintTooltip).toEqual({
      mouseEnterDelay: HINT_TOOLTIP_ENTER_DELAY,
      mouseLeaveDelay: 0,
      overlayClassName: HINT_TOOLTIP_OVERLAY_CLASS,
    });
  });
});
