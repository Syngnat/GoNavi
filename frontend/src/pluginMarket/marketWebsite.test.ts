import { describe, expect, it } from 'vitest';
import { marketPluginWebsiteURL } from './marketWebsite';
describe('market website links', () => {
  it('uses the selected source and preserves a deployed prefix', () => {
    expect(marketPluginWebsiteURL('https://plugin.gonavi.org', 'com.gonavi.nginx-inspector')).toBe('https://plugin.gonavi.org/plugins/com.gonavi.nginx-inspector');
    expect(marketPluginWebsiteURL('https://private.test/team/api/v1/', 'test.plugin')).toBe('https://private.test/team/plugins/test.plugin');
  });
  it.each(['javascript:alert(1)', 'https://user:secret@market.test', 'https://market.test?token=secret', 'https://market.test#fragment'])('rejects unsafe source URLs: %s', (source) => {
    expect(marketPluginWebsiteURL(source, 'test.plugin')).toBe('');
  });
  it.each(['../escape', '..', '.', 'test.plugin?token=secret', ''])('rejects unsafe plugin path identifiers: %s', (id) => {
    expect(marketPluginWebsiteURL('https://market.test', id)).toBe('');
  });
});
