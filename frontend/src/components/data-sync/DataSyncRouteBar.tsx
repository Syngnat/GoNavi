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
  t: DataSyncWorkbenchTranslate;
  onEditEndpoints?: () => void;
}> = ({ source, target, capability, t, onEditEndpoints }) => {
  const sourceTitle = endpointTitle(source, t('route.pending_source'));
  const targetTitle = endpointTitle(target, t('route.pending_target'));
  const sourceScope = endpointScope(source, t('route.database_fallback'));
  const targetScope = endpointScope(target, t('route.database_fallback'));
  const sourceReady = Boolean(source.connectionId.trim());
  const targetReady = Boolean(target.connectionId.trim());
  const complete = sourceReady && targetReady;
  const accessibleSource = sourceReady
    ? `${t('route.source')} ${sourceTitle}, ${sourceScope}`
    : t('route.missing_source');
  const accessibleTarget = targetReady
    ? `${t('route.target')} ${targetTitle}, ${targetScope}`
    : t('route.missing_target');
  const accessiblePath = `${accessibleSource}; ${accessibleTarget}`;

  return (
    <section
      className="gn-data-sync-route"
      data-data-sync-route="true"
      data-capability={capability.level}
      data-complete={complete ? 'true' : 'false'}
      aria-label={t('route.summary')}
    >
      <span className="gn-data-sync-route__title">{t('route.summary')}</span>
      <button
        type="button"
        className="gn-data-sync-route__path"
        aria-label={`${complete ? t('route.edit') : t('route.choose')}: ${accessiblePath}`}
        title={accessiblePath}
        disabled={!onEditEndpoints}
        onClick={onEditEndpoints}
      >
        {!sourceReady && !targetReady ? (
          <span className="gn-data-sync-route__missing">
            {t('route.missing_both')}
          </span>
        ) : (
          <>
            <span
              className="gn-data-sync-route__endpoint"
              data-endpoint-ready={sourceReady ? 'true' : 'false'}
            >
              {sourceReady ? (
                <>
                  <span className="gn-data-sync-route__role">
                    {t('route.source')}
                  </span>
                  <strong>{sourceTitle}</strong>
                  <small>{sourceScope}</small>
                </>
              ) : (
                <span className="gn-data-sync-route__missing-side">
                  {t('route.missing_source')}
                </span>
              )}
            </span>
            <span className="gn-data-sync-route__arrow" aria-hidden="true">
              →
            </span>
            <span
              className="gn-data-sync-route__endpoint gn-data-sync-route__endpoint--target"
              data-endpoint-ready={targetReady ? 'true' : 'false'}
            >
              {targetReady ? (
                <>
                  <span className="gn-data-sync-route__role">
                    {t('route.target')}
                  </span>
                  <strong>{targetTitle}</strong>
                  <small>{targetScope}</small>
                </>
              ) : (
                <span className="gn-data-sync-route__missing-side">
                  {t('route.missing_target')}
                </span>
              )}
            </span>
          </>
        )}
        {onEditEndpoints ? (
          <span className="gn-data-sync-route__edit">
            <span className="gn-data-sync-route__edit-label">
              {t(complete ? 'route.edit' : 'route.choose')}
            </span>
            <span className="gn-data-sync-route__edit-icon" aria-hidden="true">
              ›
            </span>
          </span>
        ) : null}
      </button>
      {complete ? (
        <span
          className="gn-data-sync-route__capability"
          data-level={capability.level}
          aria-live="polite"
          aria-atomic="true"
        >
          <span className="gn-data-sync-route__capability-full">
            {t(`route.capability.${capability.level}`)}
          </span>
          <span
            className="gn-data-sync-route__capability-short"
            aria-hidden="true"
          >
            {t(`route.capability_short.${capability.level}`)}
          </span>
        </span>
      ) : null}
    </section>
  );
};
