import { describe, expect, it } from 'vitest';
import {
  fileDisplayName,
  isLocalFileHref,
  isLocalImageHref,
  isLocalImagePath,
  localFileHref,
  localFilePath,
  parseCitationAttributes,
  rewriteCodexFileCitations,
} from './sessionAgentFileLinks';

// 会话正文里的两类本机文件引用：Codex 的 :codex-file-citation 内联
// 标记，和指向本机路径的 Markdown 链接。两者都要变成文件卡片，而不是
// 裸路径或网页链接。

describe('rewriteCodexFileCitations', () => {
  it('rewrites a codex file citation into a local file link', () => {
    const source = ':codex-file-citation{path="E:\\Agent\\Codex\\Project\\2026-08-31\\agent-agent-agent\\outputs\\RAG面试突击知识手册_Java转AI应用开发.docx" purpose="output"}';
    const result = rewriteCodexFileCitations(source);
    expect(result).toContain('RAG面试突击知识手册_Java转AI应用开发.docx');
    expect(result).toContain('file:///E:/Agent/Codex/Project/2026-08-31/agent-agent-agent/outputs/');
    expect(result).not.toContain('codex-file-citation');
  });

  it('keeps a citation without a path out of the content', () => {
    expect(rewriteCodexFileCitations(':codex-file-citation{purpose="output"}')).toBe('');
  });

  it('leaves ordinary content untouched', () => {
    const text = '普通正文，不带引用。';
    expect(rewriteCodexFileCitations(text)).toBe(text);
  });
});

describe('parseCitationAttributes', () => {
  it('reads quoted attributes', () => {
    expect(parseCitationAttributes('path="C:/a/b.md" purpose="output"')).toEqual({
      path: 'C:/a/b.md',
      purpose: 'output',
    });
  });
});

describe('isLocalFileHref', () => {
  it('accepts windows drive paths in markdown links', () => {
    expect(isLocalFileHref('/E:/Agent/Codex/Project/x.md')).toBe(true);
    expect(isLocalFileHref('E:\\Agent\\x.md')).toBe(true);
  });

  it('accepts file urls', () => {
    expect(isLocalFileHref('file:///E:/Agent/x.md')).toBe(true);
  });

  it('rejects web links', () => {
    expect(isLocalFileHref('https://github.com/kunghim/CoBot')).toBe(false);
    expect(isLocalFileHref('#anchor')).toBe(false);
    expect(isLocalFileHref('')).toBe(false);
  });
});

describe('localFilePath', () => {
  it('restores the drive path from a file url', () => {
    expect(localFilePath('file:///E:/Agent/x.md')).toBe('E:\\Agent\\x.md');
  });

  it('keeps a plain path as-is', () => {
    expect(localFilePath('E:\\Agent\\x.md')).toBe('E:\\Agent\\x.md');
  });

  it('drops the leading slash of a markdown windows path', () => {
    // markdown 里的 /E:/path：前导斜杠必须去掉，否则后端会当相对路径拒掉。
    expect(localFilePath('/E:/Project/x.jpg')).toBe('E:/Project/x.jpg');
    expect(localFilePath('/E:/Project/x%20y.jpg')).toBe('E:/Project/x y.jpg');
  });
});

describe('localFileHref', () => {
  it('normalizes a windows path to a file url', () => {
    expect(localFileHref('E:\\Agent\\x.md')).toBe('file:///E:/Agent/x.md');
  });
});

describe('fileDisplayName', () => {
  it('takes the last path segment', () => {
    expect(fileDisplayName('E:\\Agent\\Codex\\outputs\\手册.docx')).toBe('手册.docx');
    expect(fileDisplayName('/E:/Agent/Codex/outputs/手册.docx')).toBe('手册.docx');
  });

  it('returns an empty string for an empty path', () => {
    expect(fileDisplayName('')).toBe('');
  });
});

describe('isLocalImagePath / isLocalImageHref', () => {
  it('accepts the supported image extensions', () => {
    expect(isLocalImagePath('E:/a/b.png')).toBe(true);
    expect(isLocalImagePath('E:/a/b.JPEG')).toBe(true);
    expect(isLocalImagePath('E:/a/b.webp')).toBe(true);
    expect(isLocalImagePath('E:/a/b.svg')).toBe(true);
  });

  it('rejects non-image files', () => {
    expect(isLocalImagePath('E:/a/b.md')).toBe(false);
    expect(isLocalImagePath('E:/a/b.txt')).toBe(false);
    expect(isLocalImagePath('')).toBe(false);
  });

  it('detects a markdown image pointing at a local path', () => {
    // 正文里的 ![alt](/E:/path/x.png)：webview 加载不了本机路径，必须走后端。
    expect(isLocalImageHref('/E:/Project/x.png')).toBe(true);
    expect(isLocalImageHref('file:///E:/Project/x.png')).toBe(true);
    expect(isLocalImageHref('/E:/Project/x.md')).toBe(false);
    expect(isLocalImageHref('https://example.com/x.png')).toBe(false);
  });
});
