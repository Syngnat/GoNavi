import { describe, expect, it } from 'vitest';
import { pickConnectionTestLogKeyword } from './useConnectionTestLog';

describe('pickConnectionTestLogKeyword', () => {
  // 回归：错误消息末尾的「（详细日志：C:\Users\x\.GoNavi\Logs\gonavi.log）」含冒号
  // 与字母，曾被当成关键词，结果是拿文件路径去过滤日志，一条都匹配不到。
  it('ignores the trailing log-path hint', () => {
    const reason = '测试失败: 连接建立后验证失败: 第1次连接验证失败: EOF (详细日志: C:\\Users\\bryea\\.GoNavi\\Logs\\gonavi.log)';
    expect(pickConnectionTestLogKeyword(reason)).toBe('EOF');
  });

  it('ignores a bare posix path segment', () => {
    expect(pickConnectionTestLogKeyword('连接失败: dial error: /var/log/gonavi.log'))
      .toBe('dial error');
  });

  it('picks the most specific trailing error text', () => {
    expect(pickConnectionTestLogKeyword('测试失败: 连接建立后验证失败: connection refused'))
      .toBe('connection refused');
  });

  it('returns an empty keyword when nothing searchable remains', () => {
    expect(pickConnectionTestLogKeyword('测试失败')).toBe('');
    expect(pickConnectionTestLogKeyword('测试失败: 详见 C:\\a\\b.log')).toBe('');
  });
});
