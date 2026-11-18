import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { PluginInspection } from '../plugins/types';

vi.mock('../i18n/provider', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
import { MarketPackageSummary } from './MarketPackageSummary';

const inspection: PluginInspection = {
  manifest: { schemaVersion: 1, apiVersion: 1, id: 'com.gonavi.tool', name: 'Tool', version: '1.2.3', permissions: [] },
  digest: 'a'.repeat(64),
  sourcePath: '/staged/tool.zip',
  sizeBytes: 15875274,
};

describe('market package summary', () => {
  it('shows the inspected package identity and digest once', () => {
    const html = renderToStaticMarkup(<MarketPackageSummary inspection={inspection} official />);
    expect(html).toContain('Tool');
    expect(html).toContain('1.2.3');
    expect(html).toContain('plugin.market.official');
    expect(html).toContain('plugin.market.install_package_checked');
    expect(html).toContain('a'.repeat(64));
  });
});
