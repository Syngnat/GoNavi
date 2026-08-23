import type { sync } from '../../wailsjs/go/models';

export type DataSyncCapabilitySupportLevel =
  | 'full'
  | 'partial'
  | 'planned'
  | 'unsupported';

export type DataSyncCapabilitySnapshot = Pick<
  sync.MigrationCapability,
  | 'sourceType'
  | 'targetType'
  | 'planner'
  | 'canExecute'
  | 'supportsAutoCreate'
  | 'supportsAutoAddColumns'
  | 'requiresExistingTarget'
> & {
  supportLevel: DataSyncCapabilitySupportLevel;
};

type Translate = (
  key: string,
  variables?: Record<string, string | number | boolean | null | undefined>,
) => string;

export type DataSyncCapabilityPresentation = {
  alertType: 'info' | 'warning' | 'error';
  message: string;
  blocksExecution: boolean;
  forceExistingTarget: boolean;
};

export const resolveDataSyncCapabilityPresentation = (
  capability: DataSyncCapabilitySnapshot,
  tr: Translate,
): DataSyncCapabilityPresentation => {
  const sourceType = String(capability.sourceType || '').trim() || 'unknown';
  const targetType = String(capability.targetType || '').trim() || 'unknown';
  const variables = { sourceType, targetType };

  if (capability.supportLevel === 'full' && capability.canExecute) {
    return {
      alertType: 'info',
      message: tr('data_sync.capability.full', variables),
      blocksExecution: false,
      forceExistingTarget: !capability.supportsAutoCreate,
    };
  }

  if (capability.supportLevel === 'partial' && capability.canExecute) {
    return {
      alertType: 'warning',
      message: tr('data_sync.capability.partial', variables),
      blocksExecution: false,
      forceExistingTarget: true,
    };
  }

  const supportLevel = capability.supportLevel === 'planned'
    ? 'planned'
    : 'unsupported';
  return {
    alertType: 'error',
    message: tr(`data_sync.capability.${supportLevel}`, variables),
    blocksExecution: true,
    forceExistingTarget: true,
  };
};
