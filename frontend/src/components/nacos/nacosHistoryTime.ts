import dayjs from 'dayjs';

export const formatNacosHistoryTime = (value?: string): string => {
  if (!value?.trim()) return '-';
  const parsed = dayjs(value);
  return parsed.isValid() ? parsed.format('YYYY-MM-DD HH:mm:ss') : value;
};
