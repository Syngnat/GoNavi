import { getQueryHistoryDayOffset } from './queryHistoryModel';

export interface QueryHistoryFormatters {
  /** 列表行内时间（当日分组下只需时分秒） */
  time: Intl.DateTimeFormat;
  /** 预览区完整日期时间 */
  dateTime: Intl.DateTimeFormat;
  day: Intl.DateTimeFormat;
  relativeDay: Intl.RelativeTimeFormat;
  number: Intl.NumberFormat;
}

export const createQueryHistoryFormatters = (language: string): QueryHistoryFormatters => ({
  time: new Intl.DateTimeFormat(language, { timeStyle: 'medium', hour12: false }),
  dateTime: new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'medium', hour12: false }),
  day: new Intl.DateTimeFormat(language, { dateStyle: 'medium' }),
  relativeDay: new Intl.RelativeTimeFormat(language, { numeric: 'auto' }),
  number: new Intl.NumberFormat(language),
});

/** 分组标题：今天/昨天带相对称呼，其余只显示日期，均由 Intl 按界面语言本地化。 */
export const formatQueryHistoryDayLabel = (
  dayStart: number,
  formatters: QueryHistoryFormatters,
  now = Date.now(),
): string => {
  const date = formatters.day.format(new Date(dayStart));
  const offset = getQueryHistoryDayOffset(dayStart, now);
  if (offset !== 0 && offset !== 1) return date;
  return `${formatters.relativeDay.format(-offset, 'day')} · ${date}`;
};
