type ImportTransferMetricInput = {
  startedAt: number;
  now: number;
  bytesRead: number;
  totalBytes: number;
};

export const calculateImportTransferMetrics = ({
  startedAt,
  now,
  bytesRead,
  totalBytes,
}: ImportTransferMetricInput): { bytesPerSecond: number; etaSeconds: number } => {
  const safeStartedAt = Number.isFinite(startedAt) && startedAt > 0 ? startedAt : 0;
  const safeNow = Number.isFinite(now) ? now : 0;
  const safeBytesRead = Number.isFinite(bytesRead) && bytesRead > 0 ? Math.trunc(bytesRead) : 0;
  const safeTotalBytes = Number.isFinite(totalBytes) && totalBytes > 0 ? Math.trunc(totalBytes) : 0;
  const elapsedSeconds = safeStartedAt > 0 ? Math.max(0, (safeNow - safeStartedAt) / 1000) : 0;
  const bytesPerSecond = elapsedSeconds > 0 ? Math.round(safeBytesRead / elapsedSeconds) : 0;
  const etaSeconds = bytesPerSecond > 0 && safeTotalBytes > safeBytesRead
    ? Math.round((safeTotalBytes - safeBytesRead) / bytesPerSecond)
    : 0;
  return { bytesPerSecond, etaSeconds };
};

export const formatImportBytes = (value: number): string => {
  const bytes = Number.isFinite(value) && value > 0 ? value : 0;
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${Math.trunc(bytes)} B`;
};

const formatImportDurationUnit = (
  value: number,
  unit: 'hour' | 'minute' | 'second',
  locale: string,
): string => {
  try {
    return new Intl.NumberFormat(locale, {
      style: 'unit',
      unit,
      unitDisplay: 'narrow',
    }).format(value);
  } catch {
    const suffix = unit === 'hour' ? 'h' : unit === 'minute' ? 'm' : 's';
    return `${value}${suffix}`;
  }
};

export const formatImportDuration = (value: number, locale?: string): string => {
  const seconds = Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
  const formatUnit = (unitValue: number, unit: 'hour' | 'minute' | 'second'): string => (
    locale ? formatImportDurationUnit(unitValue, unit, locale) : `${unitValue}${unit[0]}`
  );
  if (seconds >= 3600) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return `${formatUnit(hours, 'hour')} ${formatUnit(minutes, 'minute')}`;
  }
  if (seconds >= 60) {
    return `${formatUnit(Math.floor(seconds / 60), 'minute')} ${formatUnit(seconds % 60, 'second')}`;
  }
  return formatUnit(seconds, 'second');
};
