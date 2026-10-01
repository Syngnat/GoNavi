import React from 'react';
import { AutoComplete, Button, Checkbox, Input, Select } from 'antd';

import { GnCloseIcon, GnPlusIcon } from './icons/gnIcons';
import type { DataGridToolbarFrameProps } from './DataGridToolbarFrame';
import './DataGridFilterPanel.css';

export type DataGridFilterPanelProps = Pick<
  DataGridToolbarFrameProps,
  | 'darkMode'
  | 'dbType'
  | 'panelFrameColor'
  | 'panelRadius'
  | 'panelPaddingX'
  | 'panelPaddingY'
  | 'filterTopPadding'
  | 'filterPanelRef'
  | 'filterConditions'
  | 'sortInfo'
  | 'displayColumnNames'
  | 'quickWhereDraft'
  | 'quickWhereCondition'
  | 'quickWhereSuggestionOptions'
  | 'gridFieldSelectOptions'
  | 'filterLogicOptions'
  | 'filterOpOptions'
  | 'renderGridFieldSelectOption'
  | 'noAutoCapInputProps'
  | 'filterFieldPopupWidth'
  | 'onQuickWhereDraftChange'
  | 'onQuickWhereSuggestionsOpenChange'
  | 'onQuickWhereKeyDown'
  | 'onQuickWhereSelect'
  | 'onQuickWhereCopy'
  | 'onQuickWhereCut'
  | 'onQuickWherePaste'
  | 'onApplyQuickWhere'
  | 'onClearQuickWhere'
  | 'updateFilter'
  | 'removeFilter'
  | 'addFilter'
  | 'isListOp'
  | 'isBetweenOp'
  | 'isNoValueOp'
  | 'enableSortControls'
  | 'onApplySortInfo'
  | 'onApplyFilters'
  | 'onEnableAllFilters'
  | 'onDisableAllFilters'
  | 'onClearFiltersAndSorts'
> & {
  translate: (key: string, params?: Record<string, string | number>) => string;
};

const fieldFilterOption = (input: string, option?: { label?: unknown }) => String(option?.label ?? '')
  .toLowerCase()
  .includes(String(input || '').trim().toLowerCase());

/**
 * The expanded filter area of the data preview: a manual WHERE line, then one
 * aligned row per condition and per sort key, then a single action footer.
 * Every row shares one grid, so columns line up whatever operator is chosen.
 */
const DataGridFilterPanel: React.FC<DataGridFilterPanelProps> = ({
  darkMode,
  dbType,
  panelFrameColor,
  panelRadius,
  panelPaddingX,
  panelPaddingY,
  filterTopPadding,
  filterPanelRef,
  filterConditions,
  sortInfo,
  displayColumnNames,
  quickWhereDraft,
  quickWhereCondition,
  quickWhereSuggestionOptions,
  gridFieldSelectOptions,
  filterLogicOptions,
  filterOpOptions,
  renderGridFieldSelectOption,
  noAutoCapInputProps,
  filterFieldPopupWidth,
  onQuickWhereDraftChange,
  onQuickWhereSuggestionsOpenChange,
  onQuickWhereKeyDown,
  onQuickWhereSelect,
  onQuickWhereCopy,
  onQuickWhereCut,
  onQuickWherePaste,
  onApplyQuickWhere,
  onClearQuickWhere,
  updateFilter,
  removeFilter,
  addFilter,
  isListOp,
  isBetweenOp,
  isNoValueOp,
  enableSortControls,
  onApplySortInfo,
  onApplyFilters,
  onEnableAllFilters,
  onDisableAllFilters,
  onClearFiltersAndSorts,
  translate,
}) => {
  const quickWherePlaceholder = dbType === 'mongodb'
    ? translate('data_grid.filter.mongodb_query_placeholder')
    : translate('data_grid.filter.quick_where_placeholder');
  const hasRows = filterConditions.length > 0 || (enableSortControls && sortInfo.length > 0);
  const hasSortRows = enableSortControls && sortInfo.length > 0;

  const renderValueControls = (cond: DataGridFilterPanelProps['filterConditions'][number]) => {
    if (cond.op === 'CUSTOM' || isListOp(cond.op)) {
      return (
        <Input.TextArea
          {...noAutoCapInputProps}
          autoSize={{ minRows: 1, maxRows: 4 }}
          value={cond.value}
          onChange={(event) => updateFilter(cond.id, 'value', event.target.value)}
          placeholder={cond.op === 'CUSTOM'
            ? translate('data_grid.filter.custom_where_placeholder')
            : translate('data_grid.filter.list_values_placeholder')}
        />
      );
    }
    if (isBetweenOp(cond.op)) {
      return (
        <div className="gn-dgf-between">
          <Input
            {...noAutoCapInputProps}
            value={cond.value}
            onChange={(event) => updateFilter(cond.id, 'value', event.target.value)}
            placeholder={translate('data_grid.filter.start_value_placeholder')}
          />
          <Input
            {...noAutoCapInputProps}
            value={cond.value2 || ''}
            onChange={(event) => updateFilter(cond.id, 'value2', event.target.value)}
            placeholder={translate('data_grid.filter.end_value_placeholder')}
          />
        </div>
      );
    }
    if (isNoValueOp(cond.op)) {
      return <Input {...noAutoCapInputProps} value="" disabled placeholder={translate('data_grid.filter.no_value_placeholder')} />;
    }
    return (
      <Input
        {...noAutoCapInputProps}
        value={cond.value}
        onChange={(event) => updateFilter(cond.id, 'value', event.target.value)}
      />
    );
  };

  return (
    <div
      ref={filterPanelRef}
      className="gn-v2-smart-filter-panel gn-dgf"
      style={{
        padding: `${filterTopPadding}px ${panelPaddingX}px ${panelPaddingY}px ${panelPaddingX}px`,
        background: 'transparent',
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div
        data-grid-quick-where="true"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '10px 12px',
          marginBottom: 10,
          borderRadius: Math.max(10, panelRadius - 2),
          border: `1px solid ${panelFrameColor}`,
          background: darkMode ? 'rgba(255,255,255,0.035)' : 'rgba(255,255,255,0.72)',
          boxSizing: 'border-box',
          minWidth: 0,
        }}
      >
        <span
          data-grid-quick-where-label="true"
          style={{
            flex: '0 0 auto',
            minWidth: 0,
            color: 'var(--gn-fg-3)',
            fontSize: 12,
            fontWeight: 600,
            lineHeight: '28px',
            whiteSpace: 'nowrap',
          }}
        >
          {translate('data_grid.filter.manual_query_condition')}
        </span>
        <AutoComplete
          className="gn-v2-smart-filter-manual-input"
          value={quickWhereDraft}
          options={quickWhereSuggestionOptions}
          onChange={onQuickWhereDraftChange}
          onOpenChange={onQuickWhereSuggestionsOpenChange}
          onInputKeyDown={onQuickWhereKeyDown}
          onSelect={onQuickWhereSelect}
          style={{ flex: '1 1 320px', minWidth: 220 }}
          popupMatchSelectWidth={420}
        >
          <Input
            {...noAutoCapInputProps}
            allowClear
            data-grid-quick-where-input="true"
            onCopy={onQuickWhereCopy}
            onCut={onQuickWhereCut}
            onPaste={onQuickWherePaste}
            placeholder={quickWherePlaceholder}
          />
        </AutoComplete>
        <Button size="small" type="primary" autoInsertSpace={false} onClick={onApplyQuickWhere}>
          {translate('data_grid.filter.apply_where')}
        </Button>
        <Button size="small" autoInsertSpace={false} onClick={onClearQuickWhere} disabled={!quickWhereDraft && !quickWhereCondition}>
          {translate('data_grid.filter.clear')}
        </Button>
      </div>

      {hasRows && (
        <div className="gn-dgf-rows">
          {filterConditions.map((cond, condIndex) => (
            <div key={cond.id} className="gn-dgf-row" data-enabled={cond.enabled === false ? 'false' : 'true'}>
              <Checkbox
                className="gn-dgf-check"
                title={translate('data_grid.filter.enabled')}
                aria-label={translate('data_grid.filter.enabled')}
                checked={cond.enabled !== false}
                onChange={(event) => updateFilter(cond.id, 'enabled', event.target.checked)}
              />
              <Select
                className="gn-dgf-logic"
                value={condIndex === 0 ? '__FIRST__' : (cond.logic === 'OR' ? 'OR' : 'AND')}
                onChange={(value) => updateFilter(cond.id, 'logic', value)}
                options={condIndex === 0 ? [{ value: '__FIRST__', label: translate('data_grid.filter.first_condition') }] : filterLogicOptions}
                disabled={condIndex === 0}
              />
              <Select
                className="gn-dgf-field"
                value={cond.column}
                onChange={(value) => updateFilter(cond.id, 'column', value)}
                options={gridFieldSelectOptions}
                showSearch
                optionFilterProp="label"
                optionRender={renderGridFieldSelectOption}
                popupMatchSelectWidth={filterFieldPopupWidth}
                filterOption={fieldFilterOption}
                placeholder={translate('data_grid.filter.search_field_placeholder')}
                disabled={cond.op === 'CUSTOM'}
              />
              <Select
                className="gn-dgf-op"
                value={cond.op}
                onChange={(value) => updateFilter(cond.id, 'op', value)}
                options={filterOpOptions}
              />
              <div className="gn-dgf-value">{renderValueControls(cond)}</div>
              <Button
                className="gn-dgf-remove"
                type="text"
                icon={<GnCloseIcon />}
                aria-label={translate('data_grid.filter.remove_condition')}
                onClick={() => removeFilter(cond.id)}
              />
            </div>
          ))}
          {hasSortRows && (
            <div className="gn-dgf-sort-group" data-has-conditions={filterConditions.length > 0 ? 'true' : 'false'}>
              {sortInfo.map((item, index) => (
                <div key={`${item.columnKey || 'sort'}-${index}`} className="gn-dgf-row" data-enabled={item.enabled === false ? 'false' : 'true'}>
                  <Checkbox
                    className="gn-dgf-check"
                    title={translate('data_grid.filter.enabled')}
                    aria-label={translate('data_grid.filter.enabled')}
                    checked={item.enabled !== false}
                    onChange={(event) => {
                      const next = [...sortInfo];
                      next[index] = { ...next[index], enabled: event.target.checked };
                      onApplySortInfo(next);
                    }}
                  />
                  <span className="gn-dgf-sort-label">
                    {index === 0 ? translate('data_grid.filter.sort_label') : translate('data_grid.filter.then_label')}
                  </span>
                  <Select
                    className="gn-dgf-field"
                    value={item.columnKey || undefined}
                    onChange={(value) => {
                      const next = [...sortInfo];
                      if (!value) {
                        next.splice(index, 1);
                      } else {
                        next[index] = { ...next[index], columnKey: value };
                      }
                      onApplySortInfo(next.filter((entry) => entry.columnKey));
                    }}
                    options={displayColumnNames
                      .filter((columnName) => columnName === item.columnKey || !sortInfo.some((entry) => entry.columnKey === columnName))
                      .map((columnName) => ({ value: columnName, label: columnName, title: columnName }))}
                    showSearch
                    optionFilterProp="label"
                    optionRender={renderGridFieldSelectOption}
                    popupMatchSelectWidth={filterFieldPopupWidth}
                    filterOption={fieldFilterOption}
                    placeholder={translate('data_grid.filter.select_sort_field_placeholder')}
                    allowClear
                    onClear={() => onApplySortInfo(sortInfo.filter((_, itemIndex) => itemIndex !== index))}
                  />
                  <Select
                    className="gn-dgf-op"
                    value={item.order || 'ascend'}
                    onChange={(value) => {
                      const next = [...sortInfo];
                      next[index] = { ...next[index], order: value };
                      onApplySortInfo(next);
                    }}
                    options={[
                      { value: 'ascend', label: `${translate('data_grid.filter.sort_asc')} ↑` },
                      { value: 'descend', label: `${translate('data_grid.filter.sort_desc')} ↓` },
                    ]}
                    disabled={!item.columnKey}
                  />
                  <span className="gn-dgf-value" />
                  <Button
                    className="gn-dgf-remove"
                    type="text"
                    icon={<GnCloseIcon />}
                    aria-label={translate('data_grid.filter.remove_condition')}
                    onClick={() => onApplySortInfo(sortInfo.filter((_, itemIndex) => itemIndex !== index))}
                  />
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="gn-dgf-footer" data-has-rows={hasRows ? 'true' : 'false'}>
        <div className="gn-dgf-footer-group">
          <Button className="gn-dgf-add" size="small" icon={<GnPlusIcon />} autoInsertSpace={false} onClick={addFilter}>
            {translate('data_grid.filter.add_condition')}
          </Button>
          {enableSortControls && (
            <Button
              className="gn-dgf-add"
              size="small"
              icon={<GnPlusIcon />}
              autoInsertSpace={false}
              onClick={() => {
                const nextColumn = displayColumnNames.find((columnName) => !sortInfo.some((item) => item.columnKey === columnName)) || displayColumnNames[0] || '';
                onApplySortInfo([...sortInfo, { columnKey: nextColumn, order: 'ascend', enabled: true }]);
              }}
              disabled={sortInfo.length >= displayColumnNames.length}
            >
              {translate('data_grid.filter.add_sort')}
            </Button>
          )}
        </div>
        <div className="gn-dgf-footer-group gn-dgf-footer-end">
          <Button size="small" autoInsertSpace={false} onClick={onEnableAllFilters}>{translate('data_grid.filter.enable_all')}</Button>
          <Button size="small" autoInsertSpace={false} onClick={onDisableAllFilters}>{translate('data_grid.filter.disable_all')}</Button>
          <Button size="small" autoInsertSpace={false} onClick={onClearFiltersAndSorts}>{translate('data_grid.filter.clear_all')}</Button>
          <Button type="primary" size="small" autoInsertSpace={false} onClick={onApplyFilters}>{translate('data_grid.filter.apply')}</Button>
        </div>
      </div>
    </div>
  );
};

export default DataGridFilterPanel;
