const compactTokenFormatter = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  compactDisplay: 'short',
  maximumFractionDigits: 1,
});

export const formatTokenCount = (value: number): string => {
  if (!Number.isFinite(value) || value < 0) return '0';
  return compactTokenFormatter.format(value);
};
