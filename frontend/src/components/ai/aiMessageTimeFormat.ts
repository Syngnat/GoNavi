const pad = (value: number): string => String(value).padStart(2, '0');

/**
 * Message send time: `HH:mm:ss` for today, `MM-DD HH:mm:ss` earlier this year,
 * `YYYY-MM-DD HH:mm:ss` otherwise. Returns an empty string for a missing time.
 */
export const formatMessageTime = (timestamp: number, now: number = Date.now()): string => {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '';
  const date = new Date(timestamp);
  const reference = new Date(now);
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  if (date.getFullYear() !== reference.getFullYear()) {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${time}`;
  }
  if (date.getMonth() !== reference.getMonth() || date.getDate() !== reference.getDate()) {
    return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${time}`;
  }
  return time;
};

type DurationUnit = 'hour' | 'minute' | 'second';

const UNIT_FALLBACK: Record<DurationUnit, string> = { hour: 'h', minute: 'm', second: 's' };

const formatUnit = (value: number, unit: DurationUnit, language: string, fractionDigits = 0): string => {
  try {
    return new Intl.NumberFormat(language, {
      style: 'unit',
      unit,
      unitDisplay: 'narrow',
      maximumFractionDigits: fractionDigits,
    }).format(value);
  } catch {
    return `${Number(value.toFixed(fractionDigits))}${UNIT_FALLBACK[unit]}`;
  }
};

/**
 * AI processing time in the reader's language: `6.2s`, `41s`, `2m 5s`, `1h 3m`.
 * Returns an empty string when the duration is unknown or not positive.
 */
export const formatProcessingDuration = (durationMs: number, language = 'en-US'): string => {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return '';
  const totalSeconds = durationMs / 1000;
  if (totalSeconds < 60) {
    return formatUnit(totalSeconds, 'second', language, totalSeconds < 10 ? 1 : 0);
  }
  const rounded = Math.round(totalSeconds);
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const seconds = rounded % 60;
  if (hours > 0) {
    return [formatUnit(hours, 'hour', language), minutes > 0 ? formatUnit(minutes, 'minute', language) : '']
      .filter(Boolean).join(' ');
  }
  return [formatUnit(minutes, 'minute', language), seconds > 0 ? formatUnit(seconds, 'second', language) : '']
    .filter(Boolean).join(' ');
};
