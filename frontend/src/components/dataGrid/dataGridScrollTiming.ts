import { useEffect, useLayoutEffect } from 'react';

// Native scroll events can outlive a pointer gesture on macOS. Wait for a brief
// idle window before the virtual table performs its final visual correction.
export const EXTERNAL_HORIZONTAL_SCROLL_IDLE_SETTLE_MS = 80;
export const useDataGridLayoutEffect = import.meta.env.MODE === 'test' || typeof document === 'undefined' ? useEffect : useLayoutEffect;
// How far the horizontal offset may drift before the mounted column window is
// recomputed. This must stay below the window's own trailing overscan (960px in
// the rc-table patch): once the drift passes it, the mounted cells stop short of
// the right edge and the user sees a blank strip that grows until the commit
// lands. Committing remounts every visible column in every rendered row, so the
// threshold cannot be tiny either — 480px keeps the strip at zero while cutting
// the remount rate to roughly once per 38 frames of a fast drag.
export const VIRTUAL_HORIZONTAL_RANGE_COMMIT_THRESHOLD_PX = 480;
