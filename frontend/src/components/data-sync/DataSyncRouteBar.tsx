import React from 'react';

import type {
  DataSyncEndpointRef,
  DataSyncRouteCapability,
} from './model';
import type { DataSyncWorkbenchTranslate } from './text';

const endpointTitle = (
  endpoint: DataSyncEndpointRef,
  fallback: string,
): string => endpoint.connectionName || endpoint.connectionId || fallback;

const endpointScope = (
  endpoint: DataSyncEndpointRef,
  fallback: string,
): string =>
  [endpoint.database, endpoint.schema].filter(Boolean).join(' / ') || fallback;

export const DataSyncRouteBar: React.FC<{
  source: DataSyncEndpointRef;
  target: DataSyncEndpointRef;
  capability: DataSyncRouteCapability;
  active: boolean;
  t: DataSyncWorkbenchTranslate;
}> = ({ source, target, capability, active, t }) => (
  <div
    className="gn-data-sync-route"
    data-data-sync-route="true"
    data-capability={capability.level}
    data-active={active ? 'true' : 'false'}
  >
    <div className="gn-data-sync-route__endpoint">
      <small>{t('route.source')}</small>
      <strong>{endpointTitle(source, t('route.pending_source'))}</strong>
      <span>{endpointScope(source, t('route.database_fallback'))}</span>
    </div>
    <div className="gn-data-sync-route__track" aria-label={t(`route.capability.${capability.level}`)}>
      <span className="gn-data-sync-route__line" aria-hidden="true">
        <span className="gn-data-sync-route__traveller" />
      </span>
      <span
        className="gn-data-sync-route__capability"
        data-level={capability.level}
      >
        {t(`route.capability.${capability.level}`)}
      </span>
    </div>
    <div className="gn-data-sync-route__endpoint gn-data-sync-route__endpoint--target">
      <small>{t('route.target')}</small>
      <strong>{endpointTitle(target, t('route.pending_target'))}</strong>
      <span>{endpointScope(target, t('route.database_fallback'))}</span>
    </div>
  </div>
);
