import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatNacosHistoryTime } from './nacosHistoryTime';

describe('Nacos history time display', () => {
  afterEach(() => vi.unstubAllEnvs());
  it('formats offset and UTC timestamps as local wall-clock time without milliseconds', () => {
    vi.stubEnv('TZ', 'Asia/Shanghai');
    expect(formatNacosHistoryTime('2026-09-29T20:02:33.844+08:00')).toBe('2026-09-29 20:02:33');
    expect(formatNacosHistoryTime('2026-09-29T12:02:33.844Z')).toBe('2026-09-29 20:02:33');
    expect(formatNacosHistoryTime('2026-09-29 20:02:33')).toBe('2026-09-29 20:02:33');
  });
  it('keeps missing and invalid times understandable', () => {
    expect(formatNacosHistoryTime()).toBe('-');
    expect(formatNacosHistoryTime('invalid-time')).toBe('invalid-time');
  });
});
