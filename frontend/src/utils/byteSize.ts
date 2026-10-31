// 统一的字节量展示：1024 进制、按量级选精度，避免把 38136129 这类原始字节直接抛给用户。
const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

/** 把字节数转成人类可读文本；非法输入回退占位符，不当成 0。 */
export const formatBytes = (value?: number): string => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return '--';
  }
  let next = value;
  let unitIndex = 0;
  while (next >= 1024 && unitIndex < BYTE_UNITS.length - 1) {
    next /= 1024;
    unitIndex += 1;
  }
  const precision = next >= 100 || unitIndex === 0 ? 0 : next >= 10 ? 1 : 2;
  return `${next.toFixed(precision)} ${BYTE_UNITS[unitIndex]}`;
};
