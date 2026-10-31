import { describe, expect, it } from 'vitest';
import { PAGE_CALL_TYPE, PAGE_MAX_ARGUMENT_BYTES, PAGE_RESULT_TYPE, pageResult, readPageCallMessage } from './bridgeProtocol';

const TOKEN = 'frame-token-1';
const call = (over: Record<string, unknown> = {}) => ({
  type: PAGE_CALL_TYPE,
  token: TOKEN,
  id: 'r1',
  method: 'app.info',
  arguments: { who: 'Ada' },
  ...over,
});

describe('plugin page bridge protocol', () => {
  it('accepts a page call carrying the frame token and normalizes missing arguments', () => {
    expect(readPageCallMessage(call(), TOKEN)).toEqual({
      kind: 'call',
      message: { id: 'r1', method: 'app.info', argumentsJSON: '{"who":"Ada"}' },
    });
    expect(readPageCallMessage(call({ arguments: undefined }), TOKEN)).toEqual({
      kind: 'call',
      message: { id: 'r1', method: 'app.info', argumentsJSON: '{}' },
    });
    expect(readPageCallMessage(call({ method: 'metadata.tables' }), TOKEN)).toMatchObject({ kind: 'call' });
  });

  it('drops a message from another frame or a stale page without a reply', () => {
    expect(readPageCallMessage(call(), 'other-token')).toBeNull();
    expect(readPageCallMessage(call({ token: undefined }), TOKEN)).toBeNull();
    expect(readPageCallMessage(call({ token: 42 }), TOKEN)).toBeNull();
    expect(readPageCallMessage(call({ token: TOKEN }), '')).toBeNull();
  });

  it('ignores messages that are not page calls or cannot be correlated', () => {
    expect(readPageCallMessage(null, TOKEN)).toBeNull();
    expect(readPageCallMessage('gonavi:page-call', TOKEN)).toBeNull();
    expect(readPageCallMessage({ type: PAGE_RESULT_TYPE, token: TOKEN, id: 'r1' }, TOKEN)).toBeNull();
    expect(readPageCallMessage(call({ id: 'not a valid id' }), TOKEN)).toBeNull();
    expect(readPageCallMessage(call({ id: undefined }), TOKEN)).toBeNull();
  });

  it('answers invalid rather than dropping a correlatable request', () => {
    expect(readPageCallMessage(call({ method: 'Not A Method' }), TOKEN)).toEqual({ kind: 'invalid', id: 'r1' });
    expect(readPageCallMessage(call({ arguments: { text: 'x'.repeat(PAGE_MAX_ARGUMENT_BYTES) } }), TOKEN))
      .toEqual({ kind: 'invalid', id: 'r1' });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(readPageCallMessage(call({ arguments: cyclic }), TOKEN)).toEqual({ kind: 'invalid', id: 'r1' });
  });

  it('builds result envelopes the page runtime can unwrap', () => {
    expect(pageResult('r1', true, { version: 1 })).toEqual({ type: PAGE_RESULT_TYPE, id: 'r1', ok: true, value: { version: 1 } });
    expect(pageResult('r2', false, 'plugin.pages.error.timeout')).toEqual({
      type: PAGE_RESULT_TYPE,
      id: 'r2',
      ok: false,
      error: 'plugin.pages.error.timeout',
    });
    expect(pageResult('r3', false, undefined)).toEqual({ type: PAGE_RESULT_TYPE, id: 'r3', ok: false, error: '' });
  });
});
