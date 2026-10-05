import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { BRAND_ICON_FALLBACK_SRC } from '../brand/brandIcons';
import BrandIconPicker from './BrandIconPicker';

const resolveLoad = vi.hoisted(() => ({ resolvers: [] as Array<() => void> }));

vi.mock('../../wailsjs/go/app/App', () => ({
  GetBrandIconDataURL: vi.fn(
    (key: string) =>
      new Promise<string>((resolve) => {
        resolveLoad.resolvers.push(() => resolve(`data:image/webp;base64,${key}`));
      }),
  ),
}));

const renderPicker = async (): Promise<ReactTestRenderer> => {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(React.createElement(BrandIconPicker, { value: '02', onChange: () => {} }));
  });
  await act(async () => {});
  return renderer;
};

describe('BrandIconPicker first-run preview loading', () => {
  it('renders pending mascot previews as skeletons instead of the dark fallback', async () => {
    const renderer = await renderPicker();

    // 待加载：bundled #01 与 5 个缎带（GN 兜底与真图同为深色系）共 6 张 img，
    // 10 个吉祥物渲染骨架，绝不出现深色兜底剪影。
    const images = renderer.root.findAll((node) => node.props.src !== undefined);
    expect(images).toHaveLength(6);
    expect(images.filter((node) => node.props.src === BRAND_ICON_FALLBACK_SRC)).toHaveLength(5);
    const skeletonElements = renderer.root.findAll(
      (node) => typeof node.props.className === 'string' && node.props.className.includes('ant-skeleton'),
    );
    expect(skeletonElements.length).toBeGreaterThanOrEqual(10);

    // 资源全部到达后：骨架消失，全部 16 项渲染真实资源。
    await act(async () => {
      resolveLoad.resolvers.forEach((resolve) => resolve());
    });
    await act(async () => {});

    const loadedImages = renderer.root.findAll((node) => node.props.src !== undefined);
    expect(loadedImages).toHaveLength(16);
    expect(loadedImages.filter((node) => node.props.src === BRAND_ICON_FALLBACK_SRC)).toHaveLength(0);
    expect(loadedImages.some((node) => node.props.src === 'data:image/webp;base64,07')).toBe(true);
  });
});
