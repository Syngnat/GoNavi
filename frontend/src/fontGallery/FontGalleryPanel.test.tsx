/** @vitest-environment jsdom */
import React, { act } from 'react';
import { Simulate } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FontGalleryPanel } from './FontGalleryPanel';
import { FontGalleryError } from './types';

vi.mock('../i18n/provider', () => ({ useI18n: () => ({ t: (key: string) => key, language: 'zh-CN' }) }));
const preview = vi.fn();
vi.mock('./adapter', () => ({
  getFontGalleryAdapter: () => ({
    status: async () => ({ catalog: { schemaVersion: 1, version: '1', entries: [{
      id: 'go-mono', version: '1', kind: 'mono', family: 'Go Mono', names: { 'zh-CN': 'Go Mono' },
      description: 'desc', useCase: 'sql', font: { path: 'assets/' + 'a'.repeat(64) + '.ttf', sha256: 'a'.repeat(64), sizeBytes: 10, mimeType: 'font/ttf' },
      preview: { path: 'assets/' + 'a'.repeat(64) + '.ttf', sha256: 'a'.repeat(64), sizeBytes: 10, mimeType: 'font/ttf' },
      attribution: 'a', sourceUrl: 'https://example.com/s', rightsStatus: 'approved',
      license: { id: 'bsd', name: 'BSD', url: 'https://example.com/l', notice: 'n', text: 't', nonCommercial: false },
    }] }, installed: [], stale: false }),
    refresh: async () => ({ catalog: { schemaVersion: 1, version: '1', entries: [{
      id: 'go-mono', version: '1', kind: 'mono', family: 'Go Mono', names: { 'zh-CN': 'Go Mono' },
      description: 'desc', useCase: 'sql', font: { path: 'assets/' + 'a'.repeat(64) + '.ttf', sha256: 'a'.repeat(64), sizeBytes: 10, mimeType: 'font/ttf' },
      preview: { path: 'assets/' + 'a'.repeat(64) + '.ttf', sha256: 'a'.repeat(64), sizeBytes: 10, mimeType: 'font/ttf' },
      attribution: 'a', sourceUrl: 'https://example.com/s', rightsStatus: 'approved',
      license: { id: 'bsd', name: 'BSD', url: 'https://example.com/l', notice: 'n', text: 't', nonCommercial: false },
    }] }, installed: [], stale: false }),
    preview,
    download: vi.fn(), remove: vi.fn(), resolve: vi.fn(), cancel: vi.fn(), dispose: vi.fn(),
  }),
}));

describe('FontGalleryPanel preview', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    preview.mockReset();
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });
  const openDropdown = () => {
    act(() => container.querySelector('.ant-select-selector')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
  };
  // 下拉列表为虚拟滚动，先按名称搜索收窄，目标选项才会渲染进 DOM。
  const pickOption = async (text: string) => {
    openDropdown();
    const input = container.querySelector('input')!;
    act(() => { input.value = text; Simulate.change(input); });
    const option = Array.from(document.querySelectorAll<HTMLElement>('.ant-select-item-option'))
      .find(item => item.textContent?.includes(text))!;
    await act(async () => { option.click(); });
  };

  it('renders system-installed recommendations with the installed status in the browse dropdown', async () => {
    await act(async () => {
      root.render(<FontGalleryPanel installedFontFamilies={[{ family: 'JetBrains Mono' }]}
        onEnable={() => undefined} />);
    });
    openDropdown();
    const dropdown = document.querySelector('.ant-select-dropdown')!;
    expect(dropdown.textContent).toContain('JetBrains Mono');
    expect(dropdown.textContent).toContain('app.theme.font_family.gallery.status_system');
    expect(dropdown.textContent).toContain('Fira Code');
    // 目录未加载完成前的静态占位行不发起预览。
    expect(preview).not.toHaveBeenCalled();
  });

  it('keeps the selector-free catalog and reports a failed preview without applying a fallback family', async () => {
    preview.mockRejectedValue(new FontGalleryError('preview_failed'));
    await act(async () => {
      root.render(<FontGalleryPanel installedFontFamilies={[]} onEnable={() => undefined} />);
    });
    expect(container.textContent).toContain('app.theme.font_family.gallery.title');
    await pickOption('Go Mono');
    await act(async () => {});
    expect(container.textContent).toContain('Go Mono');
    // 选中即预览：点击列表行后预览自动发起，无需再点击查看预览。
    expect(container.textContent).toContain('app.theme.font_family.gallery.error.preview_failed');
    expect(Array.from(container.querySelectorAll('button')).some(button => button.textContent === 'app.theme.font_family.gallery.preview')).toBe(false);
    expect(container.querySelector('.gonavi-font-gallery-preview p')?.getAttribute('style') || '').not.toContain('Menlo');
  });
});
