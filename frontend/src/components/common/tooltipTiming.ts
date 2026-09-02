/**
 * Shared hover-hint timing.
 *
 * antd defaults to 0.1s in and 0.1s out. At that speed a hint fires while the
 * pointer is still travelling towards a control, and it disappears the instant
 * the pointer leaves — so sweeping across a row of action buttons flashes a
 * different hint per button. A longer enter delay keeps hints out of the way
 * while aiming; a longer leave delay stops the blink when the pointer crosses
 * the gap between the trigger and the hint.
 *
 * Native `title` attributes cannot be tuned (the OS decides, roughly a second in
 * and instant out), so controls that need a hint use antd Tooltip with these
 * values instead of `title`.
 */
export const HINT_TOOLTIP_ENTER_DELAY = 0.3;
export const HINT_TOOLTIP_LEAVE_DELAY = 0.15;

export const hintTooltipTiming = {
  mouseEnterDelay: HINT_TOOLTIP_ENTER_DELAY,
  mouseLeaveDelay: HINT_TOOLTIP_LEAVE_DELAY,
} as const;

// Provider-settings cards sit in a tight grid. If the bubble keeps pointer
// events, moving onto a neighbour that the bubble covers cannot update the
// hint. Leave delay is 0 and the overlay ignores the pointer, so leaving the
// trigger hides the bubble immediately.
export const HINT_TOOLTIP_OVERLAY_CLASS = 'gonavi-ai-provider-hint-overlay';
export const passThroughHintTooltip = {
  mouseEnterDelay: HINT_TOOLTIP_ENTER_DELAY,
  mouseLeaveDelay: 0,
  overlayClassName: HINT_TOOLTIP_OVERLAY_CLASS,
} as const;
