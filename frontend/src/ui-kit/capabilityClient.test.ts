import { describe, expect, it, vi } from 'vitest';
import { createGonaviClient, GonaviCapabilityError } from './capabilityClient';

describe('createGonaviClient', () => {
  it('unwraps the window bridge envelope', async () => {
    const capability = vi.fn().mockResolvedValue({ ok: true, data: { tables: ['users'] } });
    const client = createGonaviClient({ capability });
    await expect(client.call('metadata.tables', { connectionId: 'c' })).resolves.toEqual({ tables: ['users'] });
    expect(capability).toHaveBeenCalledWith('metadata.tables', { connectionId: 'c' });
  });

  it('turns a failed envelope into a typed capability error', async () => {
    const client = createGonaviClient({
      capability: vi.fn().mockResolvedValue({ ok: false, error: { code: 'permission_denied' } }),
    });
    await expect(client.call('metadata.tables')).rejects.toMatchObject({
      name: 'GonaviCapabilityError',
      code: 'permission_denied',
    });
    await expect(client.call('metadata.tables')).rejects.toBeInstanceOf(GonaviCapabilityError);
  });

  it('passes through the page bridge raw result', async () => {
    const call = vi.fn().mockResolvedValue([{ name: 'users' }]);
    const client = createGonaviClient({ call });
    await expect(client.call('metadata.tables')).resolves.toEqual([{ name: 'users' }]);
  });

  it('rejects when no host bridge exists', () => {
    let caught: unknown;
    try {
      createGonaviClient(null);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(GonaviCapabilityError);
    expect((caught as GonaviCapabilityError).code).toBe('bridge_unavailable');
  });
});
