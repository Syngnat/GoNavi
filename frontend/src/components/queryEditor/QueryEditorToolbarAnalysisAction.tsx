import React from 'react';
import { Button, Dropdown, Tooltip, type MenuProps } from 'antd';
import { renderV2ActionMenuPopup } from '../common/V2ActionMenuPopup';
import { GnChevronDownIcon, GnHistoryIcon } from '../icons/gnIcons';
import './QueryEditorToolbarAnalysisAction.css';

export type QueryEditorToolbarAnalysisActionProps = {
  items: MenuProps['items'];
  open: boolean;
  label: string;
  tooltip: string;
  onOpenChange: (open: boolean) => void;
};

/**
 * 「历史与诊断」入口：带文字标签的工具栏按钮，把执行历史 / SQL 诊断 / 慢 SQL 历史
 * 从图标化的「更多」菜单里提出来，避免用户不点开「更多」就不知道有这些能力。
 */
export const QueryEditorToolbarAnalysisAction: React.FC<QueryEditorToolbarAnalysisActionProps> = ({
  items,
  open,
  label,
  tooltip,
  onOpenChange,
}) => (
  <Tooltip title={tooltip} open={open ? false : undefined}>
    <span className="gn-v2-query-toolbar-analysis-trigger">
      <Dropdown
        menu={{ items }}
        placement="bottomRight"
        trigger={['click']}
        rootClassName="gn-v2-titlebar-quick-dropdown gn-v2-action-menu-popup-host"
        popupRender={(menu) => renderV2ActionMenuPopup(menu, true, { title: tooltip, showHeader: false })}
        open={open}
        onOpenChange={onOpenChange}
      >
        <Button
          className="gn-v2-query-toolbar-analysis-action"
          aria-label={label}
          aria-haspopup="menu"
          aria-expanded={open}
        >
          <GnHistoryIcon aria-hidden="true" />
          <span className="gn-v2-query-toolbar-analysis-label">{label}</span>
          <GnChevronDownIcon aria-hidden="true" className="gn-v2-query-toolbar-analysis-caret" />
        </Button>
      </Dropdown>
    </span>
  </Tooltip>
);
