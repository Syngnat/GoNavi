import React from 'react';
import { Button, Checkbox, Input, Popover, Select, Table, Tooltip } from 'antd';
import type { TableColumnsType } from 'antd';
import { FilterOutlined, LinkOutlined, PushpinOutlined, SearchOutlined } from '@ant-design/icons';
import { t as defaultTranslate, type I18nParams } from '../i18n';
import {
  sortGridColumnValueCounts,
  type DataGridColumnValueCount,
  type DataGridColumnValueCountSortOrder,
} from '../utils/dataGridClientFilter';
import type { FilterValueSelection } from '../utils/sql';

export type DataGridColumnTitleTranslate = (key: string, params?: I18nParams) => string;

export type DataGridColumnFilterDraft = {
  op: string;
  value: string;
  value2?: string;
  valueSelection?: FilterValueSelection;
};

export interface DataGridColumnFilterConfig {
  active: boolean;
  operatorOptions: Array<{ value: string; label: string }>;
  defaultOperator: string;
  initialOperator?: string;
  initialValue?: string;
  initialValue2?: string;
  initialValueSelection?: FilterValueSelection;
  filterLabel: string;
  applyLabel: string;
  clearLabel: string;
  valuePlaceholder: string;
  secondValuePlaceholder: string;
  listValuePlaceholder: string;
  noValuePlaceholder: string;
  isNoValueOp: (op: string) => boolean;
  isBetweenOp: (op: string) => boolean;
  isListOp: (op: string) => boolean;
  onApply: (draft: DataGridColumnFilterDraft) => boolean | void;
  onClear: () => boolean | void;
}

export interface DataGridColumnTitleProps {
  columnName: string;
  columnMeta?: {
    type?: string;
    comment?: string;
  } | null;
  foreignKeyTarget?: {
    refTableName?: string;
    refColumnName?: string;
  } | null;
  showColumnType: boolean;
  showColumnComment: boolean;
  metaFontSize: number;
  columnMetaHintColor: string;
  columnMetaTooltipColor: string;
  darkMode: boolean;
  highlighted?: boolean;
  /** 左侧钉住列：表头显示固定图标 */
  pinnedLeft?: boolean;
  translate?: DataGridColumnTitleTranslate;
  onOpenForeignKey?: () => void;
  currentValueCounts?: DataGridColumnValueCount[];
  loadCurrentValueCounts?: () => DataGridColumnValueCount[] | undefined;
  columnFilter?: DataGridColumnFilterConfig | null;
}

const stopColumnHeaderInteraction = (event: React.SyntheticEvent<HTMLElement>) => {
  event.stopPropagation();
};

const normalizeValueSelection = (selection?: FilterValueSelection): FilterValueSelection => ({
  values: Array.from(new Set((selection?.values || []).map((value) => String(value)))),
  ...(selection?.includeNull ? { includeNull: true } : {}),
  ...(selection?.includeEmpty ? { includeEmpty: true } : {}),
});

const DataGridColumnTitle: React.FC<DataGridColumnTitleProps> = ({
  columnName,
  columnMeta,
  foreignKeyTarget,
  showColumnType,
  showColumnComment,
  metaFontSize,
  columnMetaHintColor,
  columnMetaTooltipColor,
  darkMode,
  highlighted = false,
  pinnedLeft = false,
  translate = defaultTranslate,
  onOpenForeignKey,
  currentValueCounts,
  loadCurrentValueCounts,
  columnFilter,
}) => {
  const normalizedName = String(columnName || '');
  const columnType = String(columnMeta?.type || '').trim();
  const columnComment = String(columnMeta?.comment || '').trim();
  const refTableName = String(foreignKeyTarget?.refTableName || '').trim();
  const refColumnName = String(foreignKeyTarget?.refColumnName || '').trim();
  const shouldShowColumnType = showColumnType && columnType.length > 0;
  const shouldShowColumnComment = showColumnComment && columnComment.length > 0;
  const isSingleLineColumnTitle = !shouldShowColumnType && !shouldShowColumnComment;
  const pinIcon = pinnedLeft ? (
    <PushpinOutlined
      data-grid-column-pinned-icon="true"
      aria-label={translate('data_grid.context_menu.pin_column_left')}
      title={translate('data_grid.context_menu.pin_column_left')}
      style={{
        flex: 'none',
        fontSize: Math.max(11, metaFontSize),
        color: darkMode ? 'rgba(250, 204, 21, 0.92)' : 'rgba(202, 138, 4, 0.95)',
      }}
    />
  ) : null;
  const [filterPopoverOpen, setFilterPopoverOpen] = React.useState(false);
  const initialFilterOperator = columnFilter?.initialOperator || columnFilter?.defaultOperator || '=';
  const [draftFilterOperator, setDraftFilterOperator] = React.useState(initialFilterOperator);
  const [draftFilterValue, setDraftFilterValue] = React.useState(columnFilter?.initialValue || '');
  const [draftFilterValue2, setDraftFilterValue2] = React.useState(columnFilter?.initialValue2 || '');
  const [valueCountSearch, setValueCountSearch] = React.useState('');
  const [valueCountSortOrder, setValueCountSortOrder] = React.useState<DataGridColumnValueCountSortOrder>('descend');
  const [draftValueSelection, setDraftValueSelection] = React.useState<FilterValueSelection>(
    normalizeValueSelection(columnFilter?.initialValueSelection),
  );

  React.useEffect(() => {
    if (!filterPopoverOpen || !columnFilter) return;
    setDraftFilterOperator(columnFilter.initialOperator || columnFilter.defaultOperator || '=');
    setDraftFilterValue(columnFilter.initialValue || '');
    setDraftFilterValue2(columnFilter.initialValue2 || '');
    setValueCountSearch('');
    setDraftValueSelection(normalizeValueSelection(columnFilter.initialValueSelection));
  }, [
    columnFilter?.defaultOperator,
    columnFilter?.initialOperator,
    columnFilter?.initialValue,
    columnFilter?.initialValue2,
    columnFilter?.initialValueSelection,
    filterPopoverOpen,
  ]);

  const hoverLines: string[] = [];
  if (columnType) hoverLines.push(translate('data_grid.column.type_tooltip', { type: columnType }));
  if (columnComment) hoverLines.push(translate('data_grid.column.comment_tooltip', { comment: columnComment }));
  if (refTableName) {
    const refColumnText = refColumnName ? `.${refColumnName}` : '';
    hoverLines.push(translate('data_grid.column.foreign_key_tooltip', { target: `${refTableName}${refColumnText}` }));
  }

  const fieldLabel = refTableName ? (
    <button
      type="button"
      data-grid-fk-jump="true"
      data-column-name={normalizedName}
      data-ref-table-name={refTableName}
      title={translate('data_grid.column.foreign_key_jump_title', { tableName: refTableName })}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onOpenForeignKey?.();
      }}
      onPointerDown={(event) => event.stopPropagation()}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        minWidth: 0,
        maxWidth: '100%',
        padding: 0,
        border: 0,
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        lineHeight: 'inherit',
        cursor: 'pointer',
      }}
    >
      {pinIcon}
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
        {normalizedName}
      </span>
      <LinkOutlined style={{ fontSize: metaFontSize + 1, color: columnMetaHintColor, flex: 'none' }} />
    </button>
  ) : (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, minWidth: 0, maxWidth: '100%' }}>
      {pinIcon}
      <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>
        {normalizedName}
      </span>
    </span>
  );

  const titleNode = (
    <div
      className={isSingleLineColumnTitle ? 'gn-v2-column-title is-single-line' : 'gn-v2-column-title'}
      data-grid-column-highlighted={highlighted ? 'true' : undefined}
      data-column-name={normalizedName}
      data-grid-column-title-single-line={isSingleLineColumnTitle ? 'true' : undefined}
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        justifyContent: 'center',
        minWidth: 0,
        maxWidth: '100%',
        lineHeight: 1.2,
        borderRadius: highlighted ? 8 : undefined,
        background: highlighted ? (darkMode ? 'rgba(250, 173, 20, 0.18)' : 'rgba(250, 173, 20, 0.16)') : undefined,
        boxShadow: highlighted ? `inset 0 0 0 1px ${darkMode ? 'rgba(250, 173, 20, 0.5)' : 'rgba(250, 173, 20, 0.55)'}` : undefined,
        padding: highlighted ? '4px 6px' : undefined,
        transition: 'background 160ms ease, box-shadow 160ms ease',
      }}
    >
      {fieldLabel}
      {shouldShowColumnType && (
        <span
          className="gn-v2-column-title-type"
          style={{
            marginTop: 2,
            fontSize: metaFontSize,
            color: columnMetaHintColor,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            maxWidth: '100%',
          }}
        >
          {columnType}
        </span>
      )}
      {shouldShowColumnComment && (
        <span
          className="gn-v2-column-title-comment"
          style={{
            marginTop: 2,
            fontSize: metaFontSize,
            color: columnMetaHintColor,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            maxWidth: '100%',
          }}
        >
          {columnComment}
        </span>
      )}
    </div>
  );

  const titleWithOptionalTooltip = (() => {
    if (hoverLines.length === 0) {
      return titleNode;
    }

    const tooltipTextColor = darkMode ? columnMetaTooltipColor : 'var(--gn-fg-1, #fff)';

    return (
      <Tooltip
        title={(
          <pre
            className="gn-data-grid-column-meta-tooltip-content"
            style={{
              maxHeight: 260,
              overflow: 'auto',
              margin: 0,
              fontSize: 12,
              whiteSpace: 'pre-wrap',
              color: tooltipTextColor,
            }}
          >
            {hoverLines.join('\n')}
          </pre>
        )}
        rootClassName="gn-data-grid-column-meta-tooltip"
        styles={{ root: { maxWidth: 640 } }}
        {...(!darkMode ? { color: 'rgba(0, 0, 0, 0.82)' } : {})}
      >
        <span style={{ display: 'inline-flex', width: '100%', maxWidth: '100%', minWidth: 0, overflow: 'hidden' }}>
          {titleNode}
        </span>
      </Tooltip>
    );
  })();

  if (!columnFilter) {
    return titleWithOptionalTooltip;
  }

  const noValueOperator = columnFilter.isNoValueOp(draftFilterOperator);
  const betweenOperator = columnFilter.isBetweenOp(draftFilterOperator);
  const listOperator = columnFilter.isListOp(draftFilterOperator);
  const activeColor = darkMode ? '#74d99f' : '#16a34a';
  const mutedColor = columnFilter.active
    ? activeColor
    : (darkMode ? 'rgba(255,255,255,0.52)' : 'rgba(15, 23, 42, 0.46)');
  const filterButtonTitle = `${columnFilter.filterLabel} ${normalizedName}`;
  const getValueCountDisplay = (item: DataGridColumnValueCount) => {
    if (item.kind === 'nullish') return translate('data_grid.filter.value_counts.nullish');
    if (item.kind === 'empty') return translate('data_grid.filter.value_counts.empty');
    return item.display;
  };
  const valueCounts = currentValueCounts
    ?? (filterPopoverOpen ? loadCurrentValueCounts?.() : undefined);
  const normalizedValueCountSearch = valueCountSearch.trim().toLocaleLowerCase();
  const filteredValueCounts = (valueCounts || []).filter((item) => (
    !normalizedValueCountSearch
    || getValueCountDisplay(item).toLocaleLowerCase().includes(normalizedValueCountSearch)
  ));
  const sortedFilteredValueCounts = sortGridColumnValueCounts(filteredValueCounts, valueCountSortOrder);
  const isValueCountSelected = (item: DataGridColumnValueCount) => {
    if (item.kind === 'nullish') return !!draftValueSelection.includeNull;
    if (item.kind === 'empty') return !!draftValueSelection.includeEmpty;
    return draftValueSelection.values.includes(item.display);
  };
  const toggleValueCount = (item: DataGridColumnValueCount) => {
    setDraftValueSelection((current) => {
      if (item.kind === 'nullish') return { ...current, includeNull: !current.includeNull };
      if (item.kind === 'empty') return { ...current, includeEmpty: !current.includeEmpty };
      const values = current.values.includes(item.display)
        ? current.values.filter((value) => value !== item.display)
        : [...current.values, item.display];
      return { ...current, values };
    });
  };
  const selectedValueCount = draftValueSelection.values.length
    + (draftValueSelection.includeNull ? 1 : 0)
    + (draftValueSelection.includeEmpty ? 1 : 0);
  const areAllVisibleValueCountsSelected = filteredValueCounts.length > 0
    && filteredValueCounts.every((item) => isValueCountSelected(item));
  const hasVisibleValueCountSelection = filteredValueCounts.some((item) => isValueCountSelected(item));
  const toggleVisibleValueCounts = () => {
    setDraftValueSelection((current) => {
      const nextValues = new Set(current.values);
      let includeNull = !!current.includeNull;
      let includeEmpty = !!current.includeEmpty;
      filteredValueCounts.forEach((item) => {
        if (item.kind === 'nullish') includeNull = !areAllVisibleValueCountsSelected;
        else if (item.kind === 'empty') includeEmpty = !areAllVisibleValueCountsSelected;
        else if (areAllVisibleValueCountsSelected) nextValues.delete(item.display);
        else nextValues.add(item.display);
      });
      return {
        values: Array.from(nextValues),
        ...(includeNull ? { includeNull: true } : {}),
        ...(includeEmpty ? { includeEmpty: true } : {}),
      };
    });
  };
  const submitColumnFilter = (event?: React.SyntheticEvent<HTMLElement>) => {
    event?.preventDefault();
    event?.stopPropagation();
    const appliesValueSelection = selectedValueCount > 0;
    const applied = columnFilter.onApply({
      op: appliesValueSelection ? 'IN' : draftFilterOperator,
      value: appliesValueSelection ? '' : draftFilterValue,
      value2: appliesValueSelection ? '' : draftFilterValue2,
      valueSelection: appliesValueSelection ? draftValueSelection : undefined,
    });
    if (applied !== false) setFilterPopoverOpen(false);
  };
  const valueCountTableColumns: TableColumnsType<DataGridColumnValueCount> = [
    {
      key: 'select',
      width: 32,
      align: 'center',
      title: (
        <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: '100%' }}>
          <Checkbox
            data-grid-column-value-select-all="true"
            aria-label={translate('data_grid.filter.value_counts.select_all')}
            title={translate('data_grid.filter.value_counts.select_all')}
            checked={areAllVisibleValueCountsSelected}
            indeterminate={hasVisibleValueCountSelection && !areAllVisibleValueCountsSelected}
            disabled={filteredValueCounts.length === 0}
            onChange={toggleVisibleValueCounts}
          />
        </span>
      ),
      render: (_value, item) => (
        <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: '100%' }}>
          <Checkbox
            data-grid-column-value-count-kind={item.kind}
            title={getValueCountDisplay(item)}
            checked={isValueCountSelected(item)}
            onChange={() => toggleValueCount(item)}
          />
        </span>
      ),
    },
    {
      key: 'value',
      dataIndex: 'display',
      title: translate('data_grid.filter.value_counts.value'),
      ellipsis: true,
      render: (_value, item) => (
        <span title={getValueCountDisplay(item)}>
          {getValueCountDisplay(item)}
        </span>
      ),
    },
    {
      key: 'count',
      dataIndex: 'count',
      width: 64,
      align: 'right',
      title: translate('data_grid.filter.value_counts.count'),
      sorter: true,
      sortOrder: valueCountSortOrder,
    },
  ];
  const filterPopoverContent = (
    <div
      data-grid-column-filter-popover="true"
      onClick={stopColumnHeaderInteraction}
      onMouseDown={stopColumnHeaderInteraction}
      onPointerDown={stopColumnHeaderInteraction}
      style={{
        width: 260,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <div
        style={{
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          fontWeight: 600,
          color: darkMode ? 'rgba(255,255,255,0.88)' : 'rgba(15,23,42,0.88)',
        }}
        title={normalizedName}
      >
        {filterButtonTitle}
      </div>
      <Select
        size="small"
        value={draftFilterOperator}
        options={columnFilter.operatorOptions}
        popupMatchSelectWidth={false}
        getPopupContainer={(triggerNode) => triggerNode.parentElement || document.body}
        onChange={(value) => {
          const nextOperator = String(value || columnFilter.defaultOperator || '=');
          setDraftFilterOperator(nextOperator);
          if (columnFilter.isNoValueOp(nextOperator)) {
            setDraftFilterValue('');
            setDraftFilterValue2('');
          } else if (!columnFilter.isBetweenOp(nextOperator)) {
            setDraftFilterValue2('');
          }
        }}
      />
      {noValueOperator ? (
        <Input
          size="small"
          disabled
          value={columnFilter.noValuePlaceholder}
        />
      ) : listOperator ? (
        <Input.TextArea
          value={draftFilterValue}
          placeholder={columnFilter.listValuePlaceholder}
          autoSize={{ minRows: 2, maxRows: 4 }}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          onChange={(event) => setDraftFilterValue(event.target.value)}
        />
      ) : betweenOperator ? (
        <div style={{ display: 'flex', gap: 8 }}>
          <Input
            size="small"
            value={draftFilterValue}
            placeholder={columnFilter.valuePlaceholder}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            onPressEnter={submitColumnFilter}
            onChange={(event) => setDraftFilterValue(event.target.value)}
          />
          <Input
            size="small"
            value={draftFilterValue2}
            placeholder={columnFilter.secondValuePlaceholder}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            onPressEnter={submitColumnFilter}
            onChange={(event) => setDraftFilterValue2(event.target.value)}
          />
        </div>
      ) : (
        <Input
          size="small"
          value={draftFilterValue}
          placeholder={columnFilter.valuePlaceholder}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          onPressEnter={submitColumnFilter}
          onChange={(event) => setDraftFilterValue(event.target.value)}
        />
      )}
      {valueCounts && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minHeight: 0 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: darkMode ? 'rgba(255,255,255,0.72)' : 'rgba(15,23,42,0.68)' }}>
            {translate('data_grid.filter.value_counts.title')}
          </div>
          <Input
            size="small"
            allowClear
            prefix={<SearchOutlined />}
            value={valueCountSearch}
            placeholder={translate('data_grid.filter.value_counts.search_placeholder')}
            onChange={(event) => setValueCountSearch(event.target.value)}
          />
          <div
            className="data-grid-column-value-counts-table"
            data-grid-column-value-counts="true"
            style={{ minHeight: 0 }}
          >
            <Table<DataGridColumnValueCount>
              bordered
              columns={valueCountTableColumns}
              dataSource={sortedFilteredValueCounts}
              locale={{ emptyText: translate('data_grid.filter.value_counts.no_matches') }}
              pagination={false}
              rowHoverable={false}
              rowKey="key"
              scroll={{ x: 240, y: 180 }}
              showSorterTooltip={{ target: 'sorter-icon' }}
              size="small"
              sortDirections={['descend', 'ascend', 'descend']}
              tableLayout="fixed"
              virtual
              onChange={(_pagination, _filters, sorter) => {
                const nextSortOrder = Array.isArray(sorter) ? sorter[0]?.order : sorter.order;
                setValueCountSortOrder(nextSortOrder === 'ascend' ? 'ascend' : 'descend');
              }}
            />
          </div>
        </div>
      )}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <Button
          size="small"
          onClick={() => {
            const cleared = columnFilter.onClear();
            if (cleared !== false) setFilterPopoverOpen(false);
          }}
        >
          {columnFilter.clearLabel}
        </Button>
        <Button
          type="primary"
          size="small"
          onClick={submitColumnFilter}
        >
          {columnFilter.applyLabel}
        </Button>
      </div>
    </div>
  );

  return (
    <span
      className="gn-v2-column-title-shell"
      style={{
        display: 'flex',
        // 顶对齐：有无注释时标题块高度不同，center 会让筛选图标上下错位
        alignItems: 'flex-start',
        gap: 4,
        width: '100%',
        maxWidth: '100%',
        minWidth: 0,
      }}
    >
      <span style={{ display: 'inline-flex', flex: '1 1 auto', maxWidth: '100%', minWidth: 0, overflow: 'hidden' }}>
        {titleWithOptionalTooltip}
      </span>
      <Popover
        trigger="click"
        placement="bottomLeft"
        open={filterPopoverOpen}
        onOpenChange={setFilterPopoverOpen}
        content={filterPopoverContent}
      >
        <button
          type="button"
          data-grid-column-filter-trigger="true"
          data-grid-column-filter-active={columnFilter.active ? 'true' : undefined}
          aria-label={filterButtonTitle}
          title={filterButtonTitle}
          onClick={(event) => {
            event.stopPropagation();
          }}
          onMouseDown={stopColumnHeaderInteraction}
          onPointerDown={stopColumnHeaderInteraction}
          style={{
            width: 22,
            height: 22,
            flex: '0 0 22px',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            // 与列名首行光学对齐（约 1.2 行高与 22px 按钮的中线差）
            marginTop: 0,
            padding: 0,
            border: columnFilter.active ? `1px solid ${activeColor}` : '1px solid transparent',
            borderRadius: 6,
            background: columnFilter.active
              ? (darkMode ? 'rgba(34, 197, 94, 0.14)' : 'rgba(34, 197, 94, 0.12)')
              : 'transparent',
            color: mutedColor,
            cursor: 'pointer',
          }}
        >
          <FilterOutlined style={{ fontSize: 12 }} />
        </button>
      </Popover>
    </span>
  );
};

export default DataGridColumnTitle;
