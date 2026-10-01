import React from 'react';
import { Button, Popover, Tooltip } from 'antd';
import {
  GnColumnsIcon,
  GnErDiagramIcon,
  GnFieldsIcon,
  GnJumpColumnIcon,
  GnLogIcon,
  GnSqlDocIcon,
  GnTableDesignIcon,
  GnTableIcon,
} from './icons/gnIcons';
import { t as defaultTranslate, type I18nParams } from '../i18n';

type GridViewMode = 'table' | 'json' | 'text' | 'fields' | 'ddl' | 'er' | 'sqlLog';

export type DataGridSecondaryActionsTranslate = (key: string, params?: I18nParams) => string;

export interface DataGridSecondaryActionsProps {
  canViewDdl: boolean;
  canOpenObjectDesigner: boolean;
  viewMode: GridViewMode;
  ddlLoading: boolean;
  resultViewSwitcher: React.ReactNode;
  columnInfoSettingContent: React.ReactNode;
  columnQuickFindContent: React.ReactNode;
  paginationContent: React.ReactNode;
  onViewModeChange: (nextMode: GridViewMode) => void;
  translate?: DataGridSecondaryActionsTranslate;
}

const DataGridSecondaryActions: React.FC<DataGridSecondaryActionsProps> = ({
  canViewDdl,
  canOpenObjectDesigner,
  viewMode,
  ddlLoading,
  resultViewSwitcher,
  columnInfoSettingContent,
  columnQuickFindContent,
  paginationContent,
  onViewModeChange,
  translate = defaultTranslate,
}) => {
  const [columnDisplayOpen, setColumnDisplayOpen] = React.useState(false);

  const fieldsActionLabel = canOpenObjectDesigner
      ? translate('data_grid.secondary.object_design')
      : translate('data_grid.column_settings.field_info');
    const fieldsActionIcon = canOpenObjectDesigner ? <GnTableDesignIcon /> : <GnFieldsIcon />;
    const columnDisplayLabel = translate('data_grid.secondary.column_display');
    const viewTabItems: Array<{ key: GridViewMode; label: string; icon: React.ReactNode; disabled?: boolean }> = [
      { key: 'table', label: translate('data_grid.secondary.data_preview'), icon: <GnTableIcon /> },
      { key: 'fields', label: fieldsActionLabel, icon: fieldsActionIcon },
      { key: 'ddl', label: translate('data_grid.secondary.view_ddl'), icon: <GnSqlDocIcon />, disabled: !canViewDdl },
      { key: 'er', label: translate('data_grid.secondary.er_diagram'), icon: <GnErDiagramIcon /> },
      { key: 'sqlLog', label: translate('log_panel.short_title'), icon: <GnLogIcon /> },
    ];

  return (
      <div data-grid-secondary-actions="true" className="gn-v2-data-grid-statusbar">
        <div className="gn-v2-data-grid-status-main">
          <div className="gn-v2-data-grid-view-tabs">
            {viewTabItems.map((item) => {
              const isActive = viewMode === item.key
                || (item.key === 'table' && (viewMode === 'json' || viewMode === 'text'));

              return (
                <Tooltip key={item.key} title={item.label}>
                  <Button
                    data-grid-ddl-action={item.key === 'ddl' && canViewDdl ? 'true' : undefined}
                    className="gn-v2-data-grid-toolbar-action"
                    aria-label={item.label}
                    aria-pressed={isActive}
                    size="small"
                    type={isActive ? 'primary' : 'text'}
                    icon={item.icon}
                    disabled={item.disabled}
                    loading={item.key === 'ddl' && ddlLoading}
                    onClick={() => {
                      if (item.key === 'table') {
                        onViewModeChange('table');
                        return;
                      }
                      onViewModeChange(item.key);
                    }}
                  />
                </Tooltip>
              );
            })}
          </div>
          <div className="gn-v2-toolbar-divider" />
          {resultViewSwitcher}
          <Popover
            trigger="click"
            placement="topRight"
            content={columnInfoSettingContent}
            open={columnDisplayOpen}
            onOpenChange={setColumnDisplayOpen}
          >
            <Tooltip title={columnDisplayLabel} open={columnDisplayOpen ? false : undefined}>
              <Button
                data-grid-column-display-action="true"
                className="gn-v2-data-grid-toolbar-action"
                aria-label={columnDisplayLabel}
                aria-pressed={columnDisplayOpen}
                size="small"
                type={columnDisplayOpen ? 'primary' : 'text'}
                icon={<GnColumnsIcon />}
              />
            </Tooltip>
          </Popover>
          <Popover trigger="click" placement="topRight" content={<div style={{ padding: 4 }}>{columnQuickFindContent}</div>}>
            <Button
              data-grid-column-quick-find-action="true"
              size="small"
              type="text"
              icon={<GnJumpColumnIcon />}
          >
              {translate('data_grid.secondary.jump_column')}
            </Button>
          </Popover>
        </div>
        <div className="gn-v2-data-grid-status-right">
          {paginationContent}
        </div>
      </div>
  );
};

export default DataGridSecondaryActions;
