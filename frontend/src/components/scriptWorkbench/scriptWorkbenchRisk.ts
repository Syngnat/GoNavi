import type { SavedConnection } from '../../types';
import { confirmProductionRisk } from '../../utils/productionRiskConfirm';
import type { ScriptDraft } from './scriptWorkbenchTypes';
import type { ScriptWorkbenchTranslate } from './useScriptWorkbenchCopy';

export const confirmScriptWriteRisks = async ({
  draft,
  connections,
  t,
}: {
  draft: ScriptDraft;
  connections: SavedConnection[];
  t: ScriptWorkbenchTranslate;
}): Promise<boolean> => {
  if (!draft.allowWrite) return true;
  const byId = new Map(connections.map((connection) => [connection.id, connection]));
  const confirmed = new Set<string>();
  for (const binding of draft.connections) {
    const connection = binding.connectionId ? byId.get(binding.connectionId) : undefined;
    if (!connection) continue;
    if (confirmed.has(connection.id)) continue;
    confirmed.add(connection.id);
    const approved = await confirmProductionRisk({
      connection,
      action: t('script_workbench.production_risk.action'),
      target: [binding.alias, binding.database].filter(Boolean).join(' / '),
      translate: t,
    });
    if (!approved) return false;
  }
  return true;
};
