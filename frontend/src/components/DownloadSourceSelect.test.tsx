// @vitest-environment jsdom
import React from 'react';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { act, create } from 'react-test-renderer';
import { Select } from 'antd';

import { t } from '../i18n';
import DownloadSourceSelect, {
  DOWNLOAD_SOURCE_META,
  resolveDownloadSourceMeta,
} from './DownloadSourceSelect';

vi.mock('../i18n/provider', () => ({
  useI18n: () => ({ t }),
}));

const LOCALES = ['de-DE', 'en-US', 'ja-JP', 'ru-RU', 'zh-CN', 'zh-TW'];

const textContent = (node: any): string => {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map((item) => textContent(item)).join('');
  return textContent(node.children || []);
};

const renderSelect = (props: Partial<React.ComponentProps<typeof DownloadSourceSelect>> = {}) => {
  const onChange = vi.fn();
  let renderer!: ReturnType<typeof create>;
  act(() => {
    renderer = create(
      <DownloadSourceSelect value="cst" darkMode={false} onChange={onChange} {...props} />,
    );
  });
  return { renderer, onChange, select: renderer.root.findByType(Select as any) };
};

describe('DownloadSourceSelect', () => {
  it('covers cst / bero / github with i18n text in every locale', () => {
    expect(DOWNLOAD_SOURCE_META.map((item) => item.id)).toEqual(['cst', 'bero', 'github']);

    for (const locale of LOCALES) {
      const messages = JSON.parse(readFileSync(
        fileURLToPath(new globalThis.URL(`../../../shared/i18n/${locale}.json`, import.meta.url)),
        'utf8',
      )) as Record<string, string>;
      for (const source of DOWNLOAD_SOURCE_META) {
        for (const key of [source.labelKey, source.descKey, source.guideKey, source.tagKey]) {
          expect(messages[key], `${locale} ${key}`).toBeTruthy();
        }
      }
    }
  });

  it('falls back to the default source for blank or unknown values and ignores case', () => {
    expect(resolveDownloadSourceMeta(undefined).id).toBe('cst');
    expect(resolveDownloadSourceMeta('').id).toBe('cst');
    expect(resolveDownloadSourceMeta('mystery').id).toBe('cst');
    expect(resolveDownloadSourceMeta(' GitHub ').id).toBe('github');
    expect(resolveDownloadSourceMeta('BERO').id).toBe('bero');
  });

  it('shows the current source and forwards the chosen one to onChange', () => {
    const { renderer, onChange, select } = renderSelect({ value: 'github' });

    expect(select.props.value).toBe('github');
    expect(textContent(renderer.toJSON())).toContain(t('app.download_source.option.github'));
    expect(select.props.options.map((item: { value: string }) => item.value)).toEqual([
      'cst',
      'bero',
      'github',
    ]);

    act(() => {
      select.props.onChange('bero');
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('bero');
  });

  it('disables the select while a save is in flight so clicks cannot race', () => {
    expect(renderSelect({ saving: false }).select.props.disabled).toBe(false);
    expect(renderSelect({ saving: true }).select.props.disabled).toBe(true);
  });

  it('renders name, tag and an info icon per option; the icon never selects the option', () => {
    const { select } = renderSelect();

    for (const source of DOWNLOAD_SOURCE_META) {
      let optionRenderer!: ReturnType<typeof create>;
      act(() => {
        optionRenderer = create(select.props.optionRender({ value: source.id }));
      });
      const text = textContent(optionRenderer.toJSON());
      expect(text).toContain(t(source.labelKey));
      expect(text).toContain(t(source.tagKey));

      const info = optionRenderer.root.findByProps({ className: 'gn-download-source-option-info' });
      expect(info.props['aria-label']).toBe(t(source.guideKey));
      // 冒泡到 rc-select 会被当成选中该项，弹层随之关闭，说明就看不成了。
      const stop = vi.fn();
      info.props.onMouseDown({ stopPropagation: stop });
      info.props.onClick({ stopPropagation: stop });
      expect(stop).toHaveBeenCalledTimes(2);
    }
  });
});
