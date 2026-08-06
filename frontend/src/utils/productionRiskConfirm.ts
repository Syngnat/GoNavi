import type { SavedConnection } from '../types';
import { t as defaultTranslate, type I18nParams } from '../i18n';
import { hasAnyConnectionProtection } from './connectionReadOnly';
import { normalizeConnectionEnvironmentType } from './connectionEnvironment';

type Translate = (key: string, params?: I18nParams) => string;

export type ProductionRiskConfirmOptions = {
  connection: SavedConnection | null | undefined;
  action: string;
  target?: string;
  translate?: Translate;
};

export const requiresProductionRiskConfirmation = (
  connection: SavedConnection | null | undefined,
): boolean => (
  normalizeConnectionEnvironmentType(connection?.environmentType) === 'production'
  && !hasAnyConnectionProtection(connection?.config)
);

export const confirmProductionRisk = async ({
  connection,
  action,
  target = '',
  translate = defaultTranslate,
}: ProductionRiskConfirmOptions): Promise<boolean> => {
  if (!requiresProductionRiskConfirmation(connection)) {
    return true;
  }

  const { showCountdownDangerConfirm } = await import(
    '../components/common/countdownDangerConfirm'
  );

  const connectionName = String(connection?.name || '').trim();
  const host = String(connection?.config?.host || '').trim();
  const connectionTarget = [connectionName, host].filter(Boolean).join(' / ');
  const fullTarget = [connectionTarget, String(target || '').trim()]
    .filter(Boolean)
    .join(' / ');

  return new Promise((resolve) => {
    let settled = false;
    const settle = (approved: boolean) => {
      if (settled) return;
      settled = true;
      resolve(approved);
    };

    showCountdownDangerConfirm({
      title: translate('connection.production_risk.title'),
      icon: undefined,
      content: translate('connection.production_risk.message', {
        action,
        target: fullTarget || translate('connection.production_risk.unknown_target'),
      }),
      confirmText: translate('connection.production_risk.acknowledge'),
      onOk: () => settle(true),
      onCancel: () => settle(false),
      afterClose: () => settle(false),
    });
  });
};

/**
 * Production confirmation for non-SQL tools (Redis, Nacos, sync, messaging).
 * The caller supplies the translated action so the warning remains specific.
 */
export const confirmProductionMutation = (
  connection: SavedConnection | null | undefined,
  action: string,
  target = '',
  translate?: Translate,
): Promise<boolean> => confirmProductionRisk({
  connection,
  action,
  target,
  translate,
});
