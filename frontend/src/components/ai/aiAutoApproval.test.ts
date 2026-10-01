import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  parseAutoApprovalSettings,
  readAutoApprovalSettings,
  rememberApprovalScope,
} from './aiAutoApproval';

const stubService = (service: Record<string, unknown>) => {
  vi.stubGlobal('window', { go: { aiservice: { Service: service } } });
};

describe('AI auto approval client', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('parses the Go settings shape defensively', () => {
    expect(parseAutoApprovalSettings({ global: true, sessionIds: [' s1 ', '', 7] })).toEqual({
      global: true,
      sessionIds: ['s1', '7'],
    });
    expect(parseAutoApprovalSettings(null)).toEqual({ global: false, sessionIds: [] });
    expect(parseAutoApprovalSettings({ global: 'true' })).toEqual({ global: false, sessionIds: [] });
  });

  it('reports an unreachable service as null instead of throwing', async () => {
    vi.stubGlobal('window', {});
    await expect(readAutoApprovalSettings()).resolves.toBeNull();
  });

  it('stores nothing when a call is approved once', async () => {
    const AISetSessionAutoApproval = vi.fn();
    const AISetGlobalAutoApproval = vi.fn();
    stubService({ AISetSessionAutoApproval, AISetGlobalAutoApproval });

    await rememberApprovalScope('once', 'session-1');

    expect(AISetSessionAutoApproval).not.toHaveBeenCalled();
    expect(AISetGlobalAutoApproval).not.toHaveBeenCalled();
  });

  it('remembers a session or global choice through the Go service', async () => {
    const AISetSessionAutoApproval = vi.fn().mockResolvedValue({ global: false, sessionIds: ['session-1'] });
    const AISetGlobalAutoApproval = vi.fn().mockResolvedValue({ global: true, sessionIds: [] });
    stubService({ AISetSessionAutoApproval, AISetGlobalAutoApproval });

    await rememberApprovalScope('session', 'session-1');
    await rememberApprovalScope('global', 'session-1');

    expect(AISetSessionAutoApproval).toHaveBeenCalledWith('session-1', true);
    expect(AISetGlobalAutoApproval).toHaveBeenCalledWith(true);
  });

  it('fails loudly when a choice cannot be stored', async () => {
    stubService({});
    await expect(rememberApprovalScope('global', 'session-1')).rejects.toThrow('AISetGlobalAutoApproval');
  });
});
