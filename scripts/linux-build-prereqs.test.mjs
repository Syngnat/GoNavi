// Run with: node scripts/linux-build-prereqs.test.mjs
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildInstallHint,
  detectPackageManager,
  planWebKit,
  webKitApiForTags,
  withWebKitApi,
} from './linux-build-prereqs.mjs';

describe('webKitApiForTags', () => {
  it('maps the webkit2_41 tag to WebKitGTK 4.1 and anything else to 4.0', () => {
    assert.equal(webKitApiForTags('webkit2_41'), '4.1');
    assert.equal(webKitApiForTags('foo, webkit2_41'), '4.1');
    assert.equal(webKitApiForTags(''), '4.0');
    assert.equal(webKitApiForTags('foo bar'), '4.0');
  });
});

describe('withWebKitApi', () => {
  it('toggles only the WebKitGTK tag and keeps unrelated tags', () => {
    assert.equal(withWebKitApi('webkit2_41', '4.0'), '');
    assert.equal(withWebKitApi('', '4.1'), 'webkit2_41');
    assert.equal(withWebKitApi('foo,webkit2_41', '4.0'), 'foo');
    assert.equal(withWebKitApi('foo bar', '4.1'), 'foo,bar,webkit2_41');
  });
});

describe('planWebKit', () => {
  it('keeps the configured API when it is installed', () => {
    assert.deepEqual(planWebKit('4.1', { '4.1': true, '4.0': true }), { action: 'ok' });
  });

  it('switches to the only installed API', () => {
    assert.deepEqual(planWebKit('4.1', { '4.1': false, '4.0': true }), { action: 'switch', api: '4.0' });
    assert.deepEqual(planWebKit('4.0', { '4.1': true, '4.0': false }), { action: 'switch', api: '4.1' });
  });

  it('asks for an install when neither API is present', () => {
    assert.deepEqual(planWebKit('4.1', { '4.1': false, '4.0': false }), { action: 'install' });
  });
});

describe('detectPackageManager', () => {
  it('prefers dnf over its yum compatibility shim', () => {
    const manager = detectPackageManager((bin) => bin === 'dnf' || bin === 'yum');
    assert.equal(manager.bin, 'dnf');
  });

  it('returns null when no known package manager exists', () => {
    assert.equal(detectPackageManager(() => false), null);
  });
});

describe('buildInstallHint', () => {
  it('lists the exact packages for the detected manager with a WebKitGTK fallback', () => {
    const apt = detectPackageManager((bin) => bin === 'apt-get');
    const hint = buildInstallHint(apt, ['compiler', 'webkit'], '4.1');
    assert.match(hint, /sudo apt-get install -y build-essential libwebkit2gtk-4\.1-dev/);
    assert.match(hint, /改装 libwebkit2gtk-4\.0-dev/);
  });

  it('falls back to a generic hint without a known package manager', () => {
    const hint = buildInstallHint(null, ['gtk'], '4.1');
    assert.match(hint, /GTK3 开发包/);
  });
});
