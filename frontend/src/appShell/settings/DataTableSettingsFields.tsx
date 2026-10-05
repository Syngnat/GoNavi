import { Switch, Segmented, Button } from 'antd';
import type { QueryTableCtrlClickAction } from '../../store';
import {
  DENSITY_OPTIONS,
  sanitizeDataTableDensity,
  sanitizeDataTableFontSize,
  sanitizeSidebarTreeFontSize,
} from '../../utils/dataGridDisplay';
import {
  sanitizeSqlEditorFontSize,
  MIN_SQL_EDITOR_FONT_SIZE,
  MAX_SQL_EDITOR_FONT_SIZE,
} from '../../utils/sqlEditorTypography';
import { ThemeSettingsSlider } from '../ThemeSettingsSlider';
import {
  SQL_EDITOR_FONT_SLIDER_MARKS,
  DATA_TABLE_FONT_SLIDER_MARKS,
} from '../appSettingsConstants';
import type { UseAppThemeSettingsRenderInput } from '../hooks/useAppThemeSettingsRender';

export interface DataTableSettingsFieldsProps {
  renderThemeSettingsRow: UseAppThemeSettingsRenderInput['renderThemeSettingsRow'];
  t: UseAppThemeSettingsRenderInput['t'];
  appearance: UseAppThemeSettingsRenderInput['appearance'];
  setAppearance: UseAppThemeSettingsRenderInput['setAppearance'];
  tableDoubleClickAction: UseAppThemeSettingsRenderInput['tableDoubleClickAction'];
  queryTableCtrlClickAction: UseAppThemeSettingsRenderInput['queryTableCtrlClickAction'];
  sqlEditorFontSizeFollowsGlobal: UseAppThemeSettingsRenderInput['sqlEditorFontSizeFollowsGlobal'];
  effectiveSqlEditorFontSize: UseAppThemeSettingsRenderInput['effectiveSqlEditorFontSize'];
  dataTableFontSizeFollowsGlobal: UseAppThemeSettingsRenderInput['dataTableFontSizeFollowsGlobal'];
  effectiveDataTableFontSize: UseAppThemeSettingsRenderInput['effectiveDataTableFontSize'];
  sidebarTreeFontSizeFollowsGlobal: UseAppThemeSettingsRenderInput['sidebarTreeFontSizeFollowsGlobal'];
  effectiveSidebarTreeFontSize: UseAppThemeSettingsRenderInput['effectiveSidebarTreeFontSize'];
}

export const DataTableSettingsFields = ({
  renderThemeSettingsRow, t, appearance, setAppearance, tableDoubleClickAction,
  queryTableCtrlClickAction, sqlEditorFontSizeFollowsGlobal, effectiveSqlEditorFontSize,
  dataTableFontSizeFollowsGlobal, effectiveDataTableFontSize, sidebarTreeFontSizeFollowsGlobal,
  effectiveSidebarTreeFontSize,
}: DataTableSettingsFieldsProps) => (
  <>
      {renderThemeSettingsRow({
          label: t('app.theme.data_table.vertical_borders'),
          hint: t('app.theme.data_table.vertical_borders_hint'),
          control: (
              <Switch
                  checked={appearance.showDataTableVerticalBorders === true}
                  onChange={(checked) => setAppearance({ showDataTableVerticalBorders: checked })}
              />
          ),
      })}
      {renderThemeSettingsRow({
          label: t('app.theme.data_table.row_number'),
          hint: t('app.theme.data_table.row_number_hint'),
          control: (
              <Switch
                  checked={appearance.showDataTableRowNumber !== false}
                  onChange={(checked) => setAppearance({ showDataTableRowNumber: checked })}
              />
          ),
      })}
      {renderThemeSettingsRow({
          label: t('app.theme.data_table.table_double_click_action'),
          hint: t('app.theme.data_table.table_double_click_action_hint'),
          stacked: true,
          control: (
              <Segmented
                  className="gonavi-settings-segmented-choice"
                  block
                  options={[
                      { label: t('app.theme.data_table.table_double_click_action.open_data'), value: 'open-data' },
                      { label: t('app.theme.data_table.table_double_click_action.open_design'), value: 'open-design' },
                  ]}
                  value={tableDoubleClickAction}
                  onChange={(value) => setAppearance({ tableDoubleClickAction: value as 'open-data' | 'open-design' })}
              />
          ),
      })}
      {renderThemeSettingsRow({
          label: t('app.theme.data_table.query_ctrl_click_action'),
          hint: t('app.theme.data_table.query_ctrl_click_action_hint'),
          stacked: true,
          control: (
              <Segmented
                  className="gonavi-settings-segmented-choice"
                  block
                  options={[
                      { label: t('app.theme.data_table.query_ctrl_click_action.open_design'), value: 'open-design' },
                      { label: t('app.theme.data_table.query_ctrl_click_action.locate'), value: 'locate' },
                  ]}
                  value={queryTableCtrlClickAction}
                  onChange={(value) => setAppearance({ queryTableCtrlClickAction: value as QueryTableCtrlClickAction })}
              />
          ),
      })}
      {renderThemeSettingsRow({
          label: t('app.theme.data_table.density'),
          hint: t('app.theme.data_table.density_hint'),
          stacked: true,
          control: (
              <Segmented
                  className="gonavi-settings-segmented-choice"
                  block
                  options={DENSITY_OPTIONS.map((option) => ({
                      ...option,
                      label: t(`app.theme.data_table.density.${option.value}`),
                  }))}
                  value={appearance.dataTableDensity}
                  onChange={(value) => setAppearance({ dataTableDensity: sanitizeDataTableDensity(value) })}
              />
          ),
      })}
      {renderThemeSettingsRow({
          label: (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span>{t('app.theme.data_table.sql_editor_font_size')}</span>
                  <Button
                      size="small"
                      type={sqlEditorFontSizeFollowsGlobal ? 'primary' : 'default'}
                      onClick={() => setAppearance({
                          sqlEditorFontSizeFollowGlobal: !sqlEditorFontSizeFollowsGlobal,
                          sqlEditorFontSize: sqlEditorFontSizeFollowsGlobal
                              ? sanitizeSqlEditorFontSize(appearance.sqlEditorFontSize)
                              : null,
                      })}
                  >
                      {t('app.theme.data_table.follow_global')}
                  </Button>
              </span>
          ),
          stacked: true,
          control: (
              <ThemeSettingsSlider
                  min={MIN_SQL_EDITOR_FONT_SIZE}
                  max={MAX_SQL_EDITOR_FONT_SIZE}
                  step={1}
                  marks={SQL_EDITOR_FONT_SLIDER_MARKS}
                  disabled={sqlEditorFontSizeFollowsGlobal}
                  value={effectiveSqlEditorFontSize}
                  unit="px"
                  onChange={(value) => setAppearance({
                      sqlEditorFontSize: sanitizeSqlEditorFontSize(value),
                      sqlEditorFontSizeFollowGlobal: false,
                  })}
              />
          ),
      })}
      {renderThemeSettingsRow({
          label: (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span>{t('app.theme.data_table.font_size')}</span>
                  <Button
                      size="small"
                      type={dataTableFontSizeFollowsGlobal ? 'primary' : 'default'}
                      onClick={() => setAppearance({
                          dataTableFontSizeFollowGlobal: !dataTableFontSizeFollowsGlobal,
                          dataTableFontSize: dataTableFontSizeFollowsGlobal
                              ? sanitizeDataTableFontSize(appearance.dataTableFontSize)
                              : null,
                      })}
                  >
                      {t('app.theme.data_table.follow_global')}
                  </Button>
              </span>
          ),
          stacked: true,
          control: (
              <ThemeSettingsSlider
                  min={10}
                  max={18}
                  step={1}
                  marks={DATA_TABLE_FONT_SLIDER_MARKS}
                  disabled={dataTableFontSizeFollowsGlobal}
                  value={effectiveDataTableFontSize}
                  unit="px"
                  onChange={(value) => setAppearance({
                      dataTableFontSize: sanitizeDataTableFontSize(value),
                      dataTableFontSizeFollowGlobal: false,
                  })}
              />
          ),
      })}
      {renderThemeSettingsRow({
          label: (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span>{t('app.theme.data_table.sidebar_tree_font_size')}</span>
                  <Button
                      size="small"
                      type={sidebarTreeFontSizeFollowsGlobal ? 'primary' : 'default'}
                      onClick={() => setAppearance({
                          sidebarTreeFontSizeFollowGlobal: !sidebarTreeFontSizeFollowsGlobal,
                          sidebarTreeFontSize: sidebarTreeFontSizeFollowsGlobal
                              ? sanitizeSidebarTreeFontSize(appearance.sidebarTreeFontSize)
                              : null,
                      })}
                  >
                      {t('app.theme.data_table.follow_global')}
                  </Button>
              </span>
          ),
          stacked: true,
          control: (
              <ThemeSettingsSlider
                  min={10}
                  max={18}
                  step={1}
                  marks={DATA_TABLE_FONT_SLIDER_MARKS}
                  disabled={sidebarTreeFontSizeFollowsGlobal}
                  value={effectiveSidebarTreeFontSize}
                  unit="px"
                  onChange={(value) => setAppearance({
                      sidebarTreeFontSize: sanitizeSidebarTreeFontSize(value),
                      sidebarTreeFontSizeFollowGlobal: false,
                  })}
              />
          ),
      })}
  </>
);
