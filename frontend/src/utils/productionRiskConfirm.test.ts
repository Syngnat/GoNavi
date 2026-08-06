import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../components/common/countdownDangerConfirm', () => ({
  showCountdownDangerConfirm: vi.fn(),
}));

import { showCountdownDangerConfirm } from '../components/common/countdownDangerConfirm';
import type { SavedConnection } from '../types';
import {
  confirmProductionRisk,
  requiresProductionRiskConfirmation,
} from './productionRiskConfirm';

const createConnection = (
  environmentType: SavedConnection['environmentType'],
  protection?: SavedConnection['config']['protection'],
): SavedConnection => ({
  id: 'connection-1',
  name: 'Orders',
  environmentType,
  config: {
    id: 'connection-1',
    type: 'postgres',
    host: 'prod.example.com',
    port: 5432,
    user: 'app',
    protection,
  },
});

describe('productionRiskConfirm', () => {
  beforeEach(() => {
    vi.mocked(showCountdownDangerConfirm).mockReset();
  });

  it('requires confirmation only for unprotected production connections', () => {
    expect(requiresProductionRiskConfirmation(
      createConnection('production'),
    )).toBe(true);
    expect(requiresProductionRiskConfirmation(
      createConnection('development'),
    )).toBe(false);
    expect(requiresProductionRiskConfirmation(
      createConnection('production', { restrictDataEdit: true }),
    )).toBe(false);
  });

  it('resolves true immediately when the production fallback is unnecessary', async () => {
    await expect(confirmProductionRisk({
      connection: createConnection('local'),
      action: 'update data',
    })).resolves.toBe(true);
    expect(showCountdownDangerConfirm).not.toHaveBeenCalled();
  });

  it('waits for explicit acknowledgement and resolves false on cancellation', async () => {
    const translate = (key: string, params?: Record<string, unknown>) => (
      params ? `${key}:${JSON.stringify(params)}` : key
    );
    const confirmation = confirmProductionRisk({
      connection: createConnection('production'),
      action: 'update data',
      target: 'orders',
      translate,
    });

    await vi.waitFor(() => {
      expect(showCountdownDangerConfirm).toHaveBeenCalledTimes(1);
    });
    const options = vi.mocked(showCountdownDangerConfirm).mock.calls[0]?.[0];
    expect(options?.confirmText).toBe('connection.production_risk.acknowledge');
    expect(String(options?.content)).toContain('Orders / prod.example.com / orders');
    options?.onCancel?.();

    await expect(confirmation).resolves.toBe(false);
  });
});
