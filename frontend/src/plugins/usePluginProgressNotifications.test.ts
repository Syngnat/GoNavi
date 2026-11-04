import { describe, expect, it } from 'vitest';
import { decodePluginProgressEvent, pluginProgressKey } from './usePluginProgressNotifications';

describe('plugin progress events', () => {
  it('decodes a bounded progress event', () => {
    const event = decodePluginProgressEvent({ pluginId: 'p', id: 'upload', action: 'update', title: '上传', detail: '2/10', percent: 20 });
    expect(event).toEqual({ pluginId: 'p', id: 'upload', action: 'update', title: '上传', detail: '2/10', percent: 20 });
    expect(pluginProgressKey(event!)).toBe('plugin-progress:p:upload');
  });

  it('clamps percent and drops malformed payloads', () => {
    expect(decodePluginProgressEvent({ pluginId: 'p', id: 'a', action: 'open', percent: 140 })?.percent).toBe(100);
    expect(decodePluginProgressEvent({ pluginId: 'p', id: 'a', action: 'open', percent: -5 })?.percent).toBe(0);
    expect(decodePluginProgressEvent(null)).toBeNull();
    expect(decodePluginProgressEvent({ pluginId: '', id: 'a', action: 'open' })).toBeNull();
    expect(decodePluginProgressEvent({ pluginId: 'p', id: 'a', action: 'remove' })).toBeNull();
  });
});
