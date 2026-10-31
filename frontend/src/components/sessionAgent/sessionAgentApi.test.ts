import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * 会话管理的 API seam 回归。
 *
 * 后端失败时 QueryResult.success 为 false、message 已 i18n 化。旧实现
 * unwrap 失败返回 null/空数组，调用方的 catch 永远不触发——用户只看到
 * 「空列表」，分不清是没有会话、智能体没添加还是扫描失败。这里锁定
 * 「失败必须抛错，且带上后端 message」。
 */
const { bindings } = vi.hoisted(() => ({
  bindings: {
    SessionAgentList: vi.fn(),
    SessionAgentDetail: vi.fn(),
    SessionAgentReadPage: vi.fn(),
    SessionAgentBlockContent: vi.fn(),
    SessionAgentExportMarkdown: vi.fn(),
    SessionAgentCopyResume: vi.fn(),
    SessionAgentDelete: vi.fn(),
    SessionAgentRevealPath: vi.fn(),
    SessionAgentImageDataURL: vi.fn(),
    SessionAgentImageInlineDataURL: vi.fn(),
    SessionAgentTimeGroups: vi.fn(),
  },
}));

vi.mock('../../../wailsjs/go/app/App', () => bindings);

import { wailsSessionAgentApi } from './sessionAgentApi';

describe('session agent API seam', () => {
  beforeEach(() => {
    Object.values(bindings).forEach((mock) => mock.mockReset());
  });

  it('rejects with the backend message when the list call fails', async () => {
    bindings.SessionAgentList.mockResolvedValue({ success: false, message: '加载会话列表失败：磁盘读取错误' });
    await expect(wailsSessionAgentApi.list('', '')).rejects.toThrow('加载会话列表失败：磁盘读取错误');
  });

  it('rejects when the binding returns no result at all', async () => {
    bindings.SessionAgentList.mockResolvedValue(null);
    await expect(wailsSessionAgentApi.list('', '')).rejects.toThrow();
  });

  it('resolves with the items on success', async () => {
    bindings.SessionAgentList.mockResolvedValue({ success: true, data: { items: [{ sessionId: 's1' }], total: 1 } });
    await expect(wailsSessionAgentApi.list('', '')).resolves.toEqual([{ sessionId: 's1' }]);
  });

  it('rejects with the backend message when the detail call fails', async () => {
    bindings.SessionAgentDetail.mockResolvedValue({ success: false, message: '读取会话详情失败：文件已更新' });
    await expect(wailsSessionAgentApi.detail('codex', '/tmp/x.jsonl')).rejects.toThrow('读取会话详情失败：文件已更新');
  });

  it('returns the inline image data url', async () => {
    bindings.SessionAgentImageInlineDataURL.mockResolvedValue({ success: true, data: { dataUrl: 'data:image/png;base64,AAAA' } });
    await expect(
      wailsSessionAgentApi.imageInlineDataUrl('claude', '/tmp/x.jsonl', { kind: 'jsonl', offset: 0, len: 4, pointer: '/source/data' }, 'image/png'),
    ).resolves.toBe('data:image/png;base64,AAAA');
  });
});
