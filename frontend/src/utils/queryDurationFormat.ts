const MS_PER_SECOND = 1_000;
const MS_PER_MINUTE = 60 * MS_PER_SECOND;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;

const trimTrailingZeros = (value: string): string => value.replace(/\.?0+$/, '');

/**
 * SQL 执行耗时的唯一展示口径，编辑器状态栏、日志面板、全局搜索共用，
 * 保证同一次执行在各处看到的时间文本完全一致。
 *
 * <1s → `219ms`；<1min → `1.23s`；<1h → `2m 05s`；其余 → `1h 02m 05s`。
 */
export const formatQueryDuration = (durationMs: number): string => {
  const total = Math.max(0, Math.round(Number(durationMs) || 0));
  if (total < MS_PER_SECOND) return `${total}ms`;
  if (total < MS_PER_MINUTE) return `${trimTrailingZeros((total / MS_PER_SECOND).toFixed(2))}s`;

  const pad = (value: number): string => String(value).padStart(2, '0');
  const hours = Math.floor(total / MS_PER_HOUR);
  const minutes = Math.floor((total % MS_PER_HOUR) / MS_PER_MINUTE);
  const seconds = Math.floor((total % MS_PER_MINUTE) / MS_PER_SECOND);
  return hours > 0
    ? `${hours}h ${pad(minutes)}m ${pad(seconds)}s`
    : `${minutes}m ${pad(seconds)}s`;
};
