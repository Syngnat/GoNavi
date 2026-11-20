import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SavedConnection } from '../../types';
import type { ScriptDraft } from './scriptWorkbenchTypes';
import { confirmScriptWriteRisks } from './scriptWorkbenchRisk';

const mocks = vi.hoisted(() => ({
  confirmProductionRisk: vi.fn(async (_options: unknown) => true),
}));
vi.mock('../../utils/productionRiskConfirm', () => ({
  confirmProductionRisk: mocks.confirmProductionRisk,
}));

const connection = {
  id: 'conn-1',
  name: 'prod',
  environmentType: 'production',
  config: {
    type: 'mysql',
    host: 'db.internal',
    port: 3306,
    user: 'reader',
    database: 'orders',
    useSSH: false,
    ssh: { host: '', port: 22, user: '' },
  },
} as SavedConnection;

const draft: ScriptDraft = {
  draftInstanceId: 'draft:test-risk',
  name: 'script',
  description: '',
  source: 'gonavi.db.query("prod", { sql: "SELECT 1" });',
  visibility: 'private',
  revision: 0,
  allowWrite: true,
  batchSize: 500,
  inListLimit: 1_000,
  connections: [
    { alias: 'prod', connectionId: 'conn-1', database: 'orders' },
    { alias: 'archive', connectionId: 'conn-1', database: 'archive' },
  ],
  inputs: [],
};

describe('script workbench write risks', () => {
  beforeEach(() => mocks.confirmProductionRisk.mockClear());

  it('asks for production confirmation once per physical connection', async () => {
    await expect(confirmScriptWriteRisks({
      draft,
      connections: [connection],
      t: ((key: string) => key) as never,
    })).resolves.toBe(true);
    expect(mocks.confirmProductionRisk).toHaveBeenCalledTimes(1);
  });
});
