import React, { useState } from 'react';
import { type MenuProps, Tooltip, Dropdown } from 'antd';
import { CloseOutlined } from '@ant-design/icons';
import type { TabData } from '../../types';
import { t } from '../../i18n';
import type { TabDisplayModel, TabDisplayPart } from '../../utils/tabDisplay';
import { renderV2ActionMenuPopup } from '../common/V2ActionMenuPopup';
import { QueryEditorTabRunningIndicator } from '../queryEditor/QueryEditorTabRunningIndicator';
import { TabHoverInfo } from './TabHoverInfo';

export const resolveTabHoverOpen = (isHoverInfoOpen: boolean, isTabMenuOpen: boolean) =>
  isHoverInfoOpen && !isTabMenuOpen;

type SortableTabLabelProps = {
  tab: TabData;
  displayModel: TabDisplayModel;
  displayTitle: string;
  menuItems: MenuProps['items'];
  connectionLabel?: string;
  hostSummary?: string;
  environmentColor?: string;
  environmentLabel?: string;
  environmentType?: string;
  onClose?: () => void;
};

export const isMiddleMouseButton = (button: number): boolean => button === 1;

const renderV2TabDisplayPart = (part: TabDisplayPart) => {
  if (part.key === 'kind') {
    return (
      <span className="gn-v2-tab-kind" key={part.key}>
        {part.text}
      </span>
    );
  }
  return (
    <span className={`gn-v2-tab-label-part gn-v2-tab-label-part-${part.key}`} key={part.key}>
      {part.text}
    </span>
  );
};

const renderV2TabSecondaryParts = (parts: TabDisplayPart[]) => parts.map((part, index) => (
  <React.Fragment key={part.key}>
    {index > 0 ? <span className="gn-v2-tab-label-separator" aria-hidden="true">·</span> : null}
    {renderV2TabDisplayPart(part)}
  </React.Fragment>
));

export const SortableTabLabel: React.FC<SortableTabLabelProps> = ({
  tab,
  displayModel,
  displayTitle,
  menuItems,
  connectionLabel,
  hostSummary,
  environmentColor,
  environmentLabel,
  environmentType,
  onClose,
}) => {
  const [isHoverInfoOpen, setIsHoverInfoOpen] = useState(false);
  const [isTabMenuOpen, setIsTabMenuOpen] = useState(false);

  const handleTabLabelContextMenu = (event: React.MouseEvent<HTMLElement>) => {
    event.preventDefault();
    setIsHoverInfoOpen(false);
    setIsTabMenuOpen(true);
  };

  const handleTabLabelMouseDown = (event: React.MouseEvent<HTMLElement>) => {
    if (!onClose || !isMiddleMouseButton(event.button)) return;
    event.preventDefault();
    event.stopPropagation();
  };

  const handleTabLabelAuxClick = (event: React.MouseEvent<HTMLElement>) => {
    if (!onClose || !isMiddleMouseButton(event.button)) return;
    event.preventDefault();
    event.stopPropagation();
    onClose();
  };

  const handleTabMenuOpenChange = (open: boolean) => {
    setIsTabMenuOpen(open);
    setIsHoverInfoOpen(false);
  };

  const handleHoverInfoOpenChange = (open: boolean) => {
    setIsHoverInfoOpen(open && !isTabMenuOpen);
  };

  const tabDisplayPartCount = displayModel.primaryParts.length + displayModel.secondaryParts.length;
  const showSecondaryLine = displayModel.layout === 'double' && Boolean(displayModel.secondaryText);
  const labelNode = (
    <span
      className={`tab-dnd-label gn-v2-tab-label${showSecondaryLine ? ' gn-v2-tab-label-double' : ''}${tabDisplayPartCount >= 4 ? ' gn-v2-tab-label-rich' : ''}${environmentColor ? ' gn-tab-label-has-environment' : ''}`}
      data-connection-environment={environmentType}
      onContextMenu={handleTabLabelContextMenu}
      onMouseDown={handleTabLabelMouseDown}
      onAuxClick={handleTabLabelAuxClick}
      title={undefined}
    >
      {environmentColor ? (
        <span
          className="gn-tab-environment-accent"
          style={{
            '--gn-tab-environment-color': environmentColor,
          } as React.CSSProperties}
          title={environmentLabel}
          aria-label={environmentLabel}
        />
      ) : null}
      {tab.type === 'query' ? <QueryEditorTabRunningIndicator tabId={tab.id} /> : null}
      <span className="gn-v2-tab-label-content">
          <span className="gn-v2-tab-label-main tab-title-text">
            {displayModel.primaryParts.length > 0
              ? displayModel.primaryParts.map(renderV2TabDisplayPart)
              : displayModel.primaryText}
          </span>
          {showSecondaryLine ? (
            <span
              className="gn-v2-tab-label-secondary"
              title={displayModel.secondaryText}
              aria-label={displayModel.secondaryText}
            >
              {renderV2TabSecondaryParts(displayModel.secondaryParts)}
            </span>
          ) : null}
      </span>
      {onClose ? (
        <button
          type="button"
          className="gn-v2-tab-close"
          aria-label={t('tab_manager.close_aria', { title: displayTitle })}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          }}
        >
          <CloseOutlined />
        </button>
      ) : null}
    </span>
  );

  const wrappedLabel = <Tooltip
      title={(
        <TabHoverInfo
          tab={tab}
          displayModel={displayModel}
          displayTitle={displayTitle}
          connectionLabel={connectionLabel}
          hostSummary={hostSummary}
        />
      )}
      placement="bottomLeft"
      mouseEnterDelay={1.2}
      open={resolveTabHoverOpen(isHoverInfoOpen, isTabMenuOpen)}
      onOpenChange={handleHoverInfoOpenChange}
      destroyOnHidden
      rootClassName="gn-v2-tab-hover-tooltip"
    >
      {labelNode}
    </Tooltip>;

  return (
    <Dropdown
      menu={{ items: menuItems }}
      trigger={['contextMenu']}
      onOpenChange={handleTabMenuOpenChange}
      rootClassName={'gn-v2-tab-context-menu-popup'}
      popupRender={(menu) => renderV2ActionMenuPopup(menu, true, {
        title: displayTitle,
        showHeader: false,
      })}
    >
      {wrappedLabel}
    </Dropdown>
  );
};
