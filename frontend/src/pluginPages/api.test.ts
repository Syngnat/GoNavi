import { beforeEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({ PluginPageCall: vi.fn() }));
vi.mock('../../wailsjs/go/app/App', () => host);

import { PluginAPIError } from '../plugins/apiResult';
import { pageCall } from './api';

beforeEach(() => vi.resetAllMocks());

const failure = (code: string, message = '') => ({ success: false, message, data: { code } });

describe('plugin page transport', () => {
  it('sends identity, page and the bounded arguments with every call', async () => {
    host.PluginPageCall.mockResolvedValue({ success: true, data: { hostVersion: '1.0.0' } });
    expect(await pageCall('test.pages', 'overview', 'app.info', '{}')).toEqual({ hostVersion: '1.0.0' });
    expect(host.PluginPageCall).toHaveBeenCalledWith('test.pages', 'overview', 'app.info', '{}');
  });

  it('maps every backend page code to its own catalog key', async () => {
    for (const code of [
      'page_invalid_identity',
      'page_not_running',
      'page_not_declared',
      'page_permission_denied',
      'page_unknown_method',
      'page_invalid_arguments',
      'page_result_too_large',
      'page_unsupported',
      'page_internal',
    ]) {
      host.PluginPageCall.mockResolvedValue(failure(code));
      await expect(pageCall('test.pages', 'overview', 'app.info', '{}'))
        .rejects.toThrow('plugin.backend.error.' + code);
    }
    host.PluginPageCall.mockResolvedValue(failure('management_denied'));
    await expect(pageCall('test.pages', 'overview', 'app.info', '{}'))
      .rejects.toThrow('plugin.backend.error.management_denied');
  });

  it('accepts the bare contract spelling of the same codes', async () => {
    for (const code of ['not_running', 'not_declared', 'permission_denied', 'unknown_method']) {
      host.PluginPageCall.mockResolvedValue(failure(code));
      await expect(pageCall('test.pages', 'overview', 'app.info', '{}'))
        .rejects.toThrow('plugin.backend.error.page_' + code);
    }
  });

  it('never invents a message for an unknown code and keeps the host detail', async () => {
    host.PluginPageCall.mockResolvedValue(failure('future_code', 'Host says no'));
    try {
      await pageCall('test.pages', 'overview', 'app.info', '{}');
      throw new Error('expected rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(PluginAPIError);
      expect((error as PluginAPIError).key).toBe('plugin.backend.error.operation_failed');
      expect((error as PluginAPIError).detail).toBe('Host says no');
    }
  });

  it('rejects a malformed or oversized result instead of passing it to the page',async () => {
    host.PluginPageCall.mockResolvedValue({ success: true, data: { note: 'x'.repeat(300 * 1024) } });
    await expect(pageCall('test.pages', 'overview', 'app.info', '{}'))
      .rejects.toThrow('plugin.backend.error.page_result_too_large');
    host.PluginPageCall.mockResolvedValue({ success: 'yes' });
    await expect(pageCall('test.pages', 'overview', 'app.info', '{}'))
      .rejects.toThrow('plugin.backend.error.page_internal');
    host.PluginPageCall.mockRejectedValue(new Error('bridge gone'));
    await expect(pageCall('test.pages', 'overview', 'app.info', '{}'))
      .rejects.toThrow('plugin.backend.error.page_internal');
  });
});
