import React from 'react';
import { Tooltip } from 'antd';

export interface MetadataHoverRow {
  key: string;
  label: string;
  value: React.ReactNode;
}

type MetadataHoverCardProps = {
  badge: string;
  title: string;
  rows: MetadataHoverRow[];
  dataKind?: string;
};

const stopMetadataHoverPropagation = (event: React.SyntheticEvent<HTMLElement>) => {
  event.stopPropagation();
};

export const MetadataHoverCard = React.memo(({
  badge,
  title,
  rows,
  dataKind,
}: MetadataHoverCardProps) => (
  <div
    className="gn-v2-tab-hover-card"
    data-tab-hover-info="true"
    data-entity-metadata-kind={dataKind}
    onPointerDown={stopMetadataHoverPropagation}
    onPointerMove={stopMetadataHoverPropagation}
    onPointerUp={stopMetadataHoverPropagation}
    onPointerDownCapture={stopMetadataHoverPropagation}
    onPointerUpCapture={stopMetadataHoverPropagation}
    onMouseDown={stopMetadataHoverPropagation}
    onMouseMove={stopMetadataHoverPropagation}
    onMouseUp={stopMetadataHoverPropagation}
    onClick={stopMetadataHoverPropagation}
    onClickCapture={stopMetadataHoverPropagation}
    onTouchStart={stopMetadataHoverPropagation}
    onTouchMove={stopMetadataHoverPropagation}
    onTouchEnd={stopMetadataHoverPropagation}
  >
    <div className="gn-v2-tab-hover-head">
      <span>{badge}</span>
      <strong>{title}</strong>
    </div>
    {rows.length > 0 && (
      <div className="gn-v2-tab-hover-rows">
        {rows.map((row) => (
          <div className="gn-v2-tab-hover-row" key={row.key}>
            <span>{row.label}</span>
            <strong>{row.value}</strong>
          </div>
        ))}
      </div>
    )}
  </div>
));

MetadataHoverCard.displayName = 'MetadataHoverCard';

type MetadataHoverTooltipProps = {
  children: React.ReactElement;
  content: () => React.ReactNode;
  placement?: 'left' | 'right' | 'top' | 'bottom';
  mouseEnterDelay?: number;
  rootClassName?: string;
};

export const MetadataHoverTooltip = ({
  children,
  placement = 'right',
  mouseEnterDelay = 0.8,
  rootClassName = 'gn-v2-tab-hover-tooltip',
  content,
}: MetadataHoverTooltipProps): React.ReactElement => {
  const renderContent = React.useCallback(
    content,
    [content],
  );

  return (
    <Tooltip
      title={renderContent}
      placement={placement}
      mouseEnterDelay={mouseEnterDelay}
      destroyOnHidden
      rootClassName={rootClassName}
    >
      {children}
    </Tooltip>
  );
};
