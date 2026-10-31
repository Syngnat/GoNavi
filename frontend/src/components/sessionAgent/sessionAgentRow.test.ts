import { describe, expect, it } from 'vitest';
import {
  SESSION_ASSETS_PREVIEW_MAX_RUNES,
  SESSION_ASSETS_TITLE_MAX_RUNES,
  projectDisplayName,
  shortenSessionPreview,
  shortenSessionTitle,
} from './sessionAgentRow';

describe('shortenSessionTitle', () => {
  it('短标题原样返回', () => {
    expect(shortenSessionTitle('文件具体在哪里')).toBe('文件具体在哪里');
  });

  it('空输入返回空串', () => {
    expect(shortenSessionTitle('')).toBe('');
    expect(shortenSessionTitle('   ')).toBe('');
  });

  it('限长内在第一个句末符号处收尾且不带省略号', () => {
    const title = '我有一台肖尔的服务器，我想作为我的VPN服务器。你有什么想法吗？这台服务器好像一个月会限制流量';
    const shortened = shortenSessionTitle(title);
    expect(shortened).toBe('我有一台肖尔的服务器，我想作为我的VPN服务器。');
    expect(shortened.endsWith('…')).toBe(false);
  });

  it('限长内没有句末符号时硬截并追加省略号', () => {
    const title = '这是一个没有任何句末符号的很长很长很长很长很长很长很长很长很长很长的标题内容';
    const shortened = shortenSessionTitle(title);
    expect(Array.from(shortened).length).toBe(SESSION_ASSETS_TITLE_MAX_RUNES + 1);
    expect(shortened.endsWith('…')).toBe(true);
  });

  it('句末符号过靠前时不在该处收尾', () => {
    // 唯一句末符号位于第 2 个字符，不满足最小成句位置，应硬截。
    const title = '好。' + '这是一个为了凑长度的补充说明'.repeat(4);
    const shortened = shortenSessionTitle(title);
    expect(shortened.endsWith('…')).toBe(true);
    expect(shortened.startsWith('好。')).toBe(true);
  });

  it('折叠连续空白后再判断长度', () => {
    const title = `${'词'.repeat(14)}   ${'词'.repeat(14)}`;
    const shortened = shortenSessionTitle(title);
    expect(shortened).not.toContain('   ');
    expect(Array.from(shortened).length).toBeLessThanOrEqual(SESSION_ASSETS_TITLE_MAX_RUNES + 1);
  });
});

describe('shortenSessionPreview', () => {
  it('短预览原样返回', () => {
    expect(shortenSessionPreview('那么下一步应该做什么呢')).toBe('那么下一步应该做什么呢');
  });

  it('长预览硬截并追加省略号', () => {
    const preview = '所以你对这个项目的判断和评价是什么呢，汇总总结一下，生成一份md文档给我，我发给我们的朋友去看。';
    const shortened = shortenSessionPreview(preview);
    expect(Array.from(shortened).length).toBe(SESSION_ASSETS_PREVIEW_MAX_RUNES + 1);
    expect(shortened.endsWith('…')).toBe(true);
  });

  it('空输入返回空串', () => {
    expect(shortenSessionPreview('')).toBe('');
  });
});

describe('projectDisplayName', () => {
  it('取 Windows 路径末段项目名', () => {
    expect(projectDisplayName('E:\\Project\\CodeUp\\kunghim-ops')).toBe('kunghim-ops');
  });

  it('取 POSIX 路径末段项目名', () => {
    expect(projectDisplayName('/home/user/projects/demo')).toBe('demo');
  });

  it('忽略结尾分隔符', () => {
    expect(projectDisplayName('E:\\Project\\demo\\')).toBe('demo');
    expect(projectDisplayName('/srv/work/app/')).toBe('app');
  });

  it('无分隔符时返回原值', () => {
    expect(projectDisplayName('kunghim-ops')).toBe('kunghim-ops');
  });

  it('空输入返回空串', () => {
    expect(projectDisplayName('')).toBe('');
    expect(projectDisplayName('   ')).toBe('');
  });
});
