import React from 'react';
import type { TabData } from '../../types';
import { t } from '../../i18n';
import type { TabDisplayModel } from '../../utils/tabDisplay';
import {
  getWorkbenchTabKindTooltipLabel as getTabKindTooltipLabel,
  getWorkbenchTabKindLabel as getTabKindLabel,
} from '../../utils/workbenchTabKindLabels';
import { getTabObjectLabel, stopTabHoverDragPropagation } from './tabManagerCloseHelpers';

export const openTabDisplaySettings = () => {
  if (typeof window === 'undefined') {
    return;
  }
  window.dispatchEvent(new CustomEvent('gonavi:open-tab-display-settings'));
};

export const shouldShowV2ConnectionLabel = (displayTitle: string, connectionLabel?: string): boolean => {
  const normalizedConnectionLabel = String(connectionLabel || '').trim();
  if (!normalizedConnectionLabel) {
    return false;
  }

  const normalizedDisplayTitle = String(displayTitle || '').trim();
  if (!normalizedDisplayTitle) {
    return true;
  }

  const escapedConnectionLabel = normalizedConnectionLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const prefixedConnectionPattern = new RegExp(`^\\[${escapedConnectionLabel}(?:\\s*[|\\]])`, 'i');
  return !prefixedConnectionPattern.test(normalizedDisplayTitle);
};

export const resolveTabHoverTitle = (displayModel: TabDisplayModel | undefined, fallbackTitle: string): string => {
  if (!displayModel) {
    return fallbackTitle;
  }

  const objectPart = [...displayModel.primaryParts, ...displayModel.secondaryParts]
    .find((part) => part.key === 'object');
  if (objectPart?.text) {
    return objectPart.text;
  }

  const primaryText = displayModel.primaryParts
    .filter((part) => part.key !== 'kind')
    .map((part) => part.text)
    .join(' ')
    .trim();
  return primaryText || displayModel.primaryText || fallbackTitle;
};

type TabHoverInfoProps = {
  tab: TabData;
  displayModel?: TabDisplayModel;
  displayTitle: string;
  connectionLabel?: string;
  hostSummary?: string;
};

export const TabHoverInfo: React.FC<TabHoverInfoProps> = ({
  tab,
  displayModel,
  displayTitle,
  connectionLabel,
  hostSummary,
}) => {
  const objectLabel = getTabObjectLabel(tab);
  const hoverTitle = resolveTabHoverTitle(displayModel, displayTitle);
  const schemaPart = displayModel
    ? [...displayModel.primaryParts, ...displayModel.secondaryParts].find((part) => part.key === 'schema')
    : undefined;
  const rows = [
    [t('tab_manager.hover.label.type'), getTabKindTooltipLabel(tab)],
    [t('tab_manager.hover.label.connection'), connectionLabel || t('tab_manager.hover.fallback.unbound_connection')],
    ['Host', hostSummary || t('tab_manager.hover.fallback.host_not_configured')],
    [t('tab_manager.hover.label.database'), tab.dbName || t('tab_manager.hover.fallback.database_not_specified')],
    ['Schema', schemaPart?.value],
    [t('tab_manager.hover.label.object'), objectLabel],
  ].filter(([, value]) => Boolean(value));

  return (
    <div
      className="gn-v2-tab-hover-card"
      data-tab-hover-info="true"
      onPointerDown={stopTabHoverDragPropagation}
      onPointerMove={stopTabHoverDragPropagation}
      onPointerUp={stopTabHoverDragPropagation}
      onPointerDownCapture={stopTabHoverDragPropagation}
      onPointerUpCapture={stopTabHoverDragPropagation}
      onMouseDown={stopTabHoverDragPropagation}
      onMouseMove={stopTabHoverDragPropagation}
      onMouseUp={stopTabHoverDragPropagation}
      onClick={stopTabHoverDragPropagation}
      onClickCapture={stopTabHoverDragPropagation}
      onTouchStart={stopTabHoverDragPropagation}
      onTouchMove={stopTabHoverDragPropagation}
      onTouchEnd={stopTabHoverDragPropagation}
    >
      <div className="gn-v2-tab-hover-head">
        <span>{getTabKindLabel(tab)}</span>
        <strong>{hoverTitle}</strong>
      </div>
      <div className="gn-v2-tab-hover-rows">
        {rows.map(([label, value]) => (
          <div className="gn-v2-tab-hover-row" key={label}>
            <span>{label}</span>
            <strong>{value}</strong>
          </div>
        ))}
      </div>
    </div>
  );
};
