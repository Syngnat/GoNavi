import { describe, expect, it } from 'vitest';
import { pluginStateTag } from './pluginStateTag';

describe('pluginStateTag', () => {
  it('collapses the healthy lifecycle into one enabled or disabled label', () => {
    expect(pluginStateTag('running', true)).toEqual({ key: 'enabled', color: 'success' });
    expect(pluginStateTag('disabled', true)).toEqual({ key: 'enabled', color: 'success' });
    expect(pluginStateTag('disabled', false)).toEqual({ key: 'disabled', color: 'default' });
    expect(pluginStateTag('stopping', false)).toEqual({ key: 'stopping', color: 'processing' });
  });

  it('reports transitional states honestly', () => {
    expect(pluginStateTag('starting', true)).toEqual({ key: 'starting', color: 'processing' });
  });

  it('never hides a fault or a blocked plugin behind the enabled label', () => {
    expect(pluginStateTag('faulted', true)).toEqual({ key: 'faulted', color: 'error' });
    expect(pluginStateTag('blocked', true)).toEqual({ key: 'blocked', color: 'error' });
    expect(pluginStateTag('faulted', false)).toEqual({ key: 'faulted', color: 'error' });
  });
});
