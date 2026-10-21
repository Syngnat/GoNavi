import { describe, expect, it, vi } from 'vitest';

// 模型文件导出 antd 的 Text，这里只测时间格式化，避免把整套 antd 拉进单测。
vi.mock('antd', () => ({ Typography: { Text: 'span' } }));

import { formatMessageTimestamp, rowTimestamp } from './messageQueueWorkbenchModel';

describe('message queue row timestamp', () => {
  it('renders date together with time instead of time only', () => {
    const date = new Date(2026, 9, 21, 11, 47, 16);
    expect(formatMessageTimestamp(date)).toBe('2026-10-21 11:47:16');
    // 毫秒与秒级时间戳都要落到同一展示，避免 1970 年附近的错位。
    expect(rowTimestamp({ received_at: date.getTime() })).toBe('2026-10-21 11:47:16');
    expect(rowTimestamp({ timestamp: Math.floor(date.getTime() / 1000) })).toBe('2026-10-21 11:47:16');
  });

  it('keeps the raw value when it cannot be parsed and stays empty without a timestamp', () => {
    expect(rowTimestamp({ timestamp: 'not-a-date' })).toBe('not-a-date');
    expect(rowTimestamp({})).toBe('');
  });
});
