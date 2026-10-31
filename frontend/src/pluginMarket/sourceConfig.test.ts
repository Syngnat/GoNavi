import { describe, expect, it } from 'vitest';
import { MAX_MARKET_SOURCES, sourceConfigError } from './sourceConfig';
const row = (baseUrl: string) => ({ baseUrl, enabled: true });
describe('market source URL validation', () => {
  it('accepts the official address and explicit HTTPS or loopback sources', () => {
    expect(sourceConfigError([row('https://plugin.gonavi.org'), row('https://private.example/prefix'), row('http://127.0.0.1:8090')])).toBe('');
  });
  it.each(['', 'javascript:alert(1)', 'http://remote.example', 'http://127.evil.example', 'https://market.test?', 'https://user:secret@example.test', 'https://market.test?q=token', 'https://market.test/#fragment'])('rejects unsafe input: %s', (url) => {
    expect(sourceConfigError([row(url)])).toBe('plugin.market.sources_invalid');
  });
  it('detects equivalent endpoint URLs', () => {
    expect(sourceConfigError([row('https://market.test'), row('https://MARKET.test:443/api/v1/')])).toBe('plugin.market.sources_duplicate');
  });
  it('bounds the source count', () => {
    expect(sourceConfigError(Array.from({ length: MAX_MARKET_SOURCES + 1 }, (_, i) => row('https://market' + i + '.test')))).toBe('plugin.market.sources_too_many');
  });
  it('rejects canonical URLs that exceed the transport limit after encoding', () => {
    expect(sourceConfigError([row('https://private.example/' + String.fromCharCode(0x4e00).repeat(300))])).toBe('plugin.market.sources_invalid');
  });

});
