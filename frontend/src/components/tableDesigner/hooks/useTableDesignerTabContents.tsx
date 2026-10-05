import { useMemo, useEffect } from 'react';
import { MenuOutlined, DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import {
    Tooltip,
    Tag,
    Checkbox,
    Space,
    Radio,
    Select,
    Input,
    AutoComplete,
    Button,
    Spin,
    Dropdown,
    Table,
} from 'antd';
import { DndContext, closestCenter } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { t } from '../../../i18n';
import { toggleIndexSelection as getNextIndexSelection } from '../../tableDesignerIndexUtils';
import { noAutoCapInputProps } from '../../../utils/inputAutoCap';
import type { EditableColumn } from '../tableDesignerTypes';
import { ResizableTitle, SortableRow } from '../TableDesignerTableParts';
import type { TableDesignerStateApi } from './useTableDesignerState';
import type { TableDesignerSaveActionsApi } from './useTableDesignerSaveActions';
import type { TableDesignerColumnEditsApi } from './useTableDesignerColumnEdits';
import type { TableDesignerDataLoadApi } from './useTableDesignerDataLoad';
import type { TableDesignerDialectSupportApi } from './useTableDesignerDialectSupport';

export interface UseTableDesignerTabContentsInput {
    readOnly: TableDesignerStateApi['readOnly'];
    resizableColumns: TableDesignerSaveActionsApi['resizableColumns'];
    columnSelectCol: TableDesignerSaveActionsApi['columnSelectCol'];
    setIndexColumns: TableDesignerStateApi['setIndexColumns'];
    i18nLanguage: TableDesignerStateApi['i18nLanguage'];
    groupedIndexes: TableDesignerColumnEditsApi['groupedIndexes'];
    selectedIndexKeys: TableDesignerStateApi['selectedIndexKeys'];
    setSelectedIndexKeys: TableDesignerStateApi['setSelectedIndexKeys'];
    indexColumns: TableDesignerStateApi['indexColumns'];
    handleIndexResizeStart: TableDesignerDataLoadApi['handleIndexResizeStart'];
    starRocksTableKind: TableDesignerStateApi['starRocksTableKind'];
    setStarRocksTableKind: TableDesignerStateApi['setStarRocksTableKind'];
    starRocksKeyModel: TableDesignerStateApi['starRocksKeyModel'];
    setStarRocksKeyModel: TableDesignerStateApi['setStarRocksKeyModel'];
    starRocksKeyColumns: TableDesignerStateApi['starRocksKeyColumns'];
    setStarRocksKeyColumns: TableDesignerStateApi['setStarRocksKeyColumns'];
    localColumnOptions: TableDesignerDialectSupportApi['localColumnOptions'];
    starRocksPartitionClause: TableDesignerStateApi['starRocksPartitionClause'];
    setStarRocksPartitionClause: TableDesignerStateApi['setStarRocksPartitionClause'];
    starRocksDistributionType: TableDesignerStateApi['starRocksDistributionType'];
    setStarRocksDistributionType: TableDesignerStateApi['setStarRocksDistributionType'];
    starRocksDistributionColumns: TableDesignerStateApi['starRocksDistributionColumns'];
    setStarRocksDistributionColumns: TableDesignerStateApi['setStarRocksDistributionColumns'];
    starRocksBucketMode: TableDesignerStateApi['starRocksBucketMode'];
    setStarRocksBucketMode: TableDesignerStateApi['setStarRocksBucketMode'];
    starRocksBucketCount: TableDesignerStateApi['starRocksBucketCount'];
    setStarRocksBucketCount: TableDesignerStateApi['setStarRocksBucketCount'];
    starRocksProperties: TableDesignerStateApi['starRocksProperties'];
    setStarRocksProperties: TableDesignerStateApi['setStarRocksProperties'];
    starRocksRollups: TableDesignerStateApi['starRocksRollups'];
    setStarRocksRollups: TableDesignerStateApi['setStarRocksRollups'];
    starRocksExternalEngine: TableDesignerStateApi['starRocksExternalEngine'];
    setStarRocksExternalEngine: TableDesignerStateApi['setStarRocksExternalEngine'];
    starRocksExternalProperties: TableDesignerStateApi['starRocksExternalProperties'];
    setStarRocksExternalProperties: TableDesignerStateApi['setStarRocksExternalProperties'];
    tdengineTableKind: TableDesignerStateApi['tdengineTableKind'];
    setTdengineTableKind: TableDesignerStateApi['setTdengineTableKind'];
    tdengineTagDefinitions: TableDesignerStateApi['tdengineTagDefinitions'];
    setTdengineTagDefinitions: TableDesignerStateApi['setTdengineTagDefinitions'];
    tdengineTagTypeOptions: TableDesignerDialectSupportApi['tdengineTagTypeOptions'];
    tdengineStableName: TableDesignerStateApi['tdengineStableName'];
    setTdengineStableName: TableDesignerStateApi['setTdengineStableName'];
    tdengineStableOptions: TableDesignerStateApi['tdengineStableOptions'];
    tdengineStableOptionsLoading: TableDesignerStateApi['tdengineStableOptionsLoading'];
    tdengineChildTagDefsLoading: TableDesignerStateApi['tdengineChildTagDefsLoading'];
    tdengineChildTagDefs: TableDesignerStateApi['tdengineChildTagDefs'];
    tdengineChildTagValues: TableDesignerStateApi['tdengineChildTagValues'];
    setTdengineChildTagValues: TableDesignerStateApi['setTdengineChildTagValues'];
    tdengineTagValues: TableDesignerStateApi['tdengineTagValues'];
    setTdengineTagValues: TableDesignerStateApi['setTdengineTagValues'];
    columnClipboard: TableDesignerColumnEditsApi['columnClipboard'];
    containerRef: TableDesignerStateApi['containerRef'];
    panelBodyBg: TableDesignerStateApi['panelBodyBg'];
    focusRowBg: TableDesignerStateApi['focusRowBg'];
    columns: TableDesignerStateApi['columns'];
    focusColumnKey: TableDesignerStateApi['focusColumnKey'];
    columnsLoading: TableDesignerStateApi['columnsLoading'];
    tableHeight: TableDesignerStateApi['tableHeight'];
    handleColumnRowContextMenu: TableDesignerColumnEditsApi['handleColumnRowContextMenu'];
    sensors: TableDesignerStateApi['sensors'];
    onDragEnd: TableDesignerSaveActionsApi['onDragEnd'];
    isTDengineChildNewTable: TableDesignerDialectSupportApi['isTDengineChildNewTable'];
    panelToolbarBorder: TableDesignerStateApi['panelToolbarBorder'];
    darkMode: TableDesignerStateApi['darkMode'];
    designerColumnSummary: TableDesignerStateApi['designerColumnSummary'];
}

export const useTableDesignerTabContents = ({
    readOnly, resizableColumns, columnSelectCol, setIndexColumns, i18nLanguage, groupedIndexes,
    selectedIndexKeys, setSelectedIndexKeys, indexColumns, handleIndexResizeStart,
    starRocksTableKind, setStarRocksTableKind, starRocksKeyModel, setStarRocksKeyModel,
    starRocksKeyColumns, setStarRocksKeyColumns, localColumnOptions, starRocksPartitionClause,
    setStarRocksPartitionClause, starRocksDistributionType, setStarRocksDistributionType,
    starRocksDistributionColumns, setStarRocksDistributionColumns, starRocksBucketMode,
    setStarRocksBucketMode, starRocksBucketCount, setStarRocksBucketCount, starRocksProperties,
    setStarRocksProperties, starRocksRollups, setStarRocksRollups, starRocksExternalEngine,
    setStarRocksExternalEngine, starRocksExternalProperties, setStarRocksExternalProperties,
    tdengineTableKind, setTdengineTableKind, tdengineTagDefinitions, setTdengineTagDefinitions,
    tdengineTagTypeOptions, tdengineStableName, setTdengineStableName, tdengineStableOptions,
    tdengineStableOptionsLoading, tdengineChildTagDefsLoading, tdengineChildTagDefs,
    tdengineChildTagValues, setTdengineChildTagValues, tdengineTagValues, setTdengineTagValues,
    columnClipboard, containerRef, panelBodyBg, focusRowBg, columns, focusColumnKey, columnsLoading,
    tableHeight, handleColumnRowContextMenu, sensors, onDragEnd, isTDengineChildNewTable,
    panelToolbarBorder, darkMode, designerColumnSummary,
}: UseTableDesignerTabContentsInput) => {
    // sort 拖拽列（不参与 resize）
    const sortColumn = useMemo(() => ({
        key: 'sort',
        width: 40,
        render: () => <MenuOutlined style={{ cursor: 'grab', color: '#999' }} />,
    }), []);

    const columnsWithSelect = useMemo(() =>
        readOnly
            ? resizableColumns
            : [columnSelectCol, sortColumn, ...resizableColumns],
        [readOnly, columnSelectCol, sortColumn, resizableColumns]
    );

    // --- Index Columns Init ---
    useEffect(() => {
        setIndexColumns([
            {
                title: t('table_designer.index.column.name', undefined, i18nLanguage),
                dataIndex: 'name',
                key: 'name',
                width: 240,
                render: (text: string) => (
                    <Tooltip title={text}>
                        <span style={{ display: 'inline-block', maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {text}
                        </span>
                    </Tooltip>
                ),
            },
            {
                title: t('table_designer.index.column.fields', undefined, i18nLanguage),
                dataIndex: 'columnNames',
                key: 'columnNames',
                width: 320,
                render: (columnNames: string[]) => {
                    if (!columnNames || columnNames.length === 0) {
                        return '-';
                    }
                    return (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                            {columnNames.map((columnName: string, idx: number) => (
                                <Tag key={`${columnName}-${idx}`}>
                                    {columnName}
                                </Tag>
                            ))}
                        </div>
                    );
                }
            },
            {
                title: t('table_designer.index.column.type', undefined, i18nLanguage),
                dataIndex: 'indexType',
                key: 'indexType',
                width: 140,
                render: (text: string) => text || '-',
            },
            {
                title: t('table_designer.index.column.uniqueness', undefined, i18nLanguage),
                dataIndex: 'nonUnique',
                key: 'nonUnique',
                width: 110,
                render: (v: number) => (
                    <Tag color={v === 0 ? 'gold' : 'default'}>
                        {v === 0 ? t('table_designer.index.uniqueness.unique', undefined, i18nLanguage) : t('table_designer.index.uniqueness.normal', undefined, i18nLanguage)}
                    </Tag>
                ),
            },
        ]);
    }, [i18nLanguage]);

    // Checkbox 选择列（不参与 resize，支持全选）
    const allIndexKeys = groupedIndexes.map(idx => idx.key);
    const isAllSelected = allIndexKeys.length > 0 && selectedIndexKeys.length === allIndexKeys.length;
    const isIndeterminate = selectedIndexKeys.length > 0 && selectedIndexKeys.length < allIndexKeys.length;
    const toggleIndexSelection = (key: string, checked?: boolean) => {
        setSelectedIndexKeys(prev => getNextIndexSelection(prev, key, checked));
    };

    const selectColumn = {
        title: () => (
            <Checkbox
                checked={isAllSelected}
                indeterminate={isIndeterminate}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => {
                    setSelectedIndexKeys(e.target.checked ? allIndexKeys : []);
                }}
                style={{ margin: 0 }}
            />
        ),
        dataIndex: '_select',
        key: '_select',
        width: 48,
        className: 'table-designer-select-column',
        onHeaderCell: () => ({ className: 'table-designer-select-column' }),
        onCell: () => ({ className: 'table-designer-select-column' }),
        render: (_: any, record: any) => (
            <span
                onClick={(e) => {
                    e.stopPropagation();
                    toggleIndexSelection(record.key);
                }}
                style={{ display: 'inline-flex' }}
            >
                <Checkbox
                    checked={selectedIndexKeys.includes(record.key)}
                    onChange={() => undefined}
                    style={{ margin: 0, pointerEvents: 'none' }}
                />
            </span>
        ),
    };

    const resizableIndexColumns = [
        selectColumn,
        ...indexColumns.map((col, index) => ({
          ...col,
          onHeaderCell: (column: any) => ({
            width: column.width,
            onResizeStart: handleIndexResizeStart(index),
          }),
        })),
    ];

    const starRocksAdvancedTabContent = (
        <div style={{ height: '100%', overflow: 'auto', padding: 12 }}>
            <Space direction="vertical" size={14} style={{ width: '100%', maxWidth: 960 }}>
                <Radio.Group
                    value={starRocksTableKind}
                    onChange={(e) => setStarRocksTableKind(e.target.value)}
                    optionType="button"
                    buttonStyle="solid"
                    options={[
                        { label: t('table_designer.starrocks.table_kind.olap', undefined, i18nLanguage), value: 'olap' },
                        { label: t('table_designer.starrocks.table_kind.external', undefined, i18nLanguage), value: 'external' },
                    ]}
                />

                {starRocksTableKind === 'olap' ? (
                    <>
                        <Space wrap>
                            <Select
                                value={starRocksKeyModel}
                                onChange={setStarRocksKeyModel}
                                options={[
                                    { label: t('table_designer.starrocks.key_model.duplicate', undefined, i18nLanguage), value: 'DUPLICATE' },
                                    { label: t('table_designer.column.primary_key', undefined, i18nLanguage), value: 'PRIMARY' },
                                    { label: t('table_designer.starrocks.key_model.unique', undefined, i18nLanguage), value: 'UNIQUE' },
                                    { label: t('table_designer.starrocks.key_model.aggregate', undefined, i18nLanguage), value: 'AGGREGATE' },
                                ]}
                                style={{ width: 180 }}
                            />
                            <Select
                                mode="multiple"
                                allowClear
                                placeholder={t('table_designer.starrocks.placeholder.key_columns', undefined, i18nLanguage)}
                                value={starRocksKeyColumns}
                                onChange={setStarRocksKeyColumns}
                                options={localColumnOptions}
                                style={{ minWidth: 280 }}
                            />
                        </Space>

                        <Input.TextArea
                            value={starRocksPartitionClause}
                            onChange={(e) => setStarRocksPartitionClause(e.target.value)}
                            autoSize={{ minRows: 3, maxRows: 8 }}
                            placeholder={t('table_designer.starrocks.placeholder.partition_clause', undefined, i18nLanguage)}
                        />

                        <Space wrap>
                            <Select
                                value={starRocksDistributionType}
                                onChange={setStarRocksDistributionType}
                                options={[
                                    { label: t('table_designer.starrocks.distribution.hash', undefined, i18nLanguage), value: 'HASH' },
                                    { label: t('table_designer.starrocks.distribution.random', undefined, i18nLanguage), value: 'RANDOM' },
                                    { label: t('table_designer.starrocks.distribution.none', undefined, i18nLanguage), value: 'NONE' },
                                ]}
                                style={{ width: 180 }}
                            />
                            <Select
                                mode="multiple"
                                allowClear
                                disabled={starRocksDistributionType !== 'HASH'}
                                placeholder={t('table_designer.starrocks.placeholder.distribution_columns', undefined, i18nLanguage)}
                                value={starRocksDistributionColumns}
                                onChange={setStarRocksDistributionColumns}
                                options={localColumnOptions}
                                style={{ minWidth: 260 }}
                            />
                            <Select
                                value={starRocksBucketMode}
                                onChange={setStarRocksBucketMode}
                                options={[
                                    { label: t('table_designer.starrocks.bucket_mode.auto', undefined, i18nLanguage), value: 'AUTO' },
                                    { label: t('table_designer.starrocks.bucket_mode.number', undefined, i18nLanguage), value: 'NUMBER' },
                                ]}
                                style={{ width: 160 }}
                            />
                            <Input
                                {...noAutoCapInputProps}
                                disabled={starRocksBucketMode !== 'NUMBER'}
                                value={starRocksBucketCount}
                                onChange={(e) => setStarRocksBucketCount(e.target.value.replace(/[^\d]/g, ''))}
                                placeholder={t('table_designer.starrocks.placeholder.bucket_count', undefined, i18nLanguage)}
                                style={{ width: 120 }}
                            />
                        </Space>

                        <Input.TextArea
                            value={starRocksProperties}
                            onChange={(e) => setStarRocksProperties(e.target.value)}
                            autoSize={{ minRows: 3, maxRows: 8 }}
                            placeholder={'"replication_num" = "1"\n"storage_medium" = "SSD"'}
                        />

                        <Input.TextArea
                            value={starRocksRollups}
                            onChange={(e) => setStarRocksRollups(e.target.value)}
                            autoSize={{ minRows: 3, maxRows: 8 }}
                            placeholder={'rollup_name: column1, column2\nrollup_daily: dt, user_id'}
                        />
                    </>
                ) : (
                    <>
                        <Space wrap>
                            <Select
                                value={starRocksExternalEngine}
                                onChange={setStarRocksExternalEngine}
                                options={[
                                    { label: 'Hive', value: 'hive' },
                                    { label: 'MySQL', value: 'mysql' },
                                    { label: 'Iceberg', value: 'iceberg' },
                                    { label: 'Hudi', value: 'hudi' },
                                    { label: 'JDBC', value: 'jdbc' },
                                ]}
                                style={{ width: 180 }}
                            />
                        </Space>
                        <Input.TextArea
                            value={starRocksExternalProperties}
                            onChange={(e) => setStarRocksExternalProperties(e.target.value)}
                            autoSize={{ minRows: 6, maxRows: 14 }}
                            placeholder={'"resource" = "hive0"\n"database" = "raw_db"\n"table" = "raw_table"'}
                        />
                    </>
                )}
            </Space>
        </div>
    );

    const tdengineAdvancedFormContent = (
            <Space direction="vertical" size={14} style={{ width: '100%', maxWidth: 960 }}>
                <Radio.Group
                    value={tdengineTableKind}
                    onChange={(event) => setTdengineTableKind(event.target.value)}
                    optionType="button"
                    buttonStyle="solid"
                    options={[
                        { label: t('table_designer.tdengine.table_kind.normal', undefined, i18nLanguage), value: 'normal' },
                        { label: t('table_designer.tdengine.table_kind.stable', undefined, i18nLanguage), value: 'stable' },
                        { label: t('table_designer.tdengine.table_kind.child', undefined, i18nLanguage), value: 'child' },
                    ]}
                />

                {tdengineTableKind === 'stable' && (
                    <Space direction="vertical" size={8} style={{ width: '100%' }}>
                        <Space size={8} style={{ width: '100%' }}>
                            <span style={{ width: 180, color: '#888', fontSize: 12 }}>{t('table_designer.tdengine.tag.name', undefined, i18nLanguage)}</span>
                            <span style={{ width: 220, color: '#888', fontSize: 12 }}>{t('table_designer.tdengine.tag.type', undefined, i18nLanguage)}</span>
                        </Space>
                        {tdengineTagDefinitions.map((tag) => (
                            <Space key={tag._key} align="start" wrap>
                                <Input
                                    {...noAutoCapInputProps}
                                    value={tag.name}
                                    onChange={(event) => setTdengineTagDefinitions(previous => previous.map(item => item._key === tag._key ? { ...item, name: event.target.value } : item))}
                                    placeholder={t('table_designer.tdengine.placeholder.tag_name', undefined, i18nLanguage)}
                                    style={{ width: 180 }}
                                />
                                <AutoComplete
                                    value={tag.type}
                                    onChange={(value) => setTdengineTagDefinitions(previous => previous.map(item => item._key === tag._key ? { ...item, type: value } : item))}
                                    options={tdengineTagTypeOptions}
                                    placeholder={t('table_designer.tdengine.placeholder.tag_type', undefined, i18nLanguage)}
                                    style={{ width: 220 }}
                                />
                                <Tooltip title={t('table_designer.tdengine.action.remove_tag', undefined, i18nLanguage)}>
                                    <Button
                                        type="text"
                                        danger
                                        icon={<DeleteOutlined />}
                                        onClick={() => setTdengineTagDefinitions(previous => previous.filter(item => item._key !== tag._key))}
                                    />
                                </Tooltip>
                            </Space>
                        ))}
                        <Button
                            size="small"
                            icon={<PlusOutlined />}
                            onClick={() => setTdengineTagDefinitions(previous => [
                                ...previous,
                                { _key: `tag-${Date.now()}-${previous.length}`, name: '', type: 'BINARY(64)' },
                            ])}
                        >
                            {t('table_designer.tdengine.action.add_tag', undefined, i18nLanguage)}
                        </Button>
                    </Space>
                )}

                {tdengineTableKind === 'child' && (
                    <Space direction="vertical" size={10} style={{ width: '100%' }}>
                        <AutoComplete
                            {...noAutoCapInputProps}
                            allowClear
                            value={tdengineStableName}
                            onChange={(value) => setTdengineStableName(value)}
                            placeholder={t('table_designer.tdengine.placeholder.stable_name', undefined, i18nLanguage)}
                            options={tdengineStableOptions}
                            style={{ width: '100%' }}
                            filterOption={(inputValue, option) =>
                                (option?.value ?? '').toLowerCase().includes(inputValue.toLowerCase())
                            }
                            notFoundContent={tdengineStableOptionsLoading ? t('table_designer.tdengine.message.loading_tag_defs', undefined, i18nLanguage) : t('table_designer.tdengine.message.no_stable_found', undefined, i18nLanguage)}
                        />
                        {tdengineChildTagDefsLoading || tdengineChildTagDefs.length > 0 ? (
                            <Spin spinning={tdengineChildTagDefsLoading}>
                                {tdengineChildTagDefs.length > 0 ? (
                                    <Space direction="vertical" size={8} style={{ width: '100%' }}>
                                        <Space size={8} style={{ width: '100%' }}>
                                            <span style={{ width: 160, color: '#888', fontSize: 12 }}>{t('table_designer.tdengine.tag.name', undefined, i18nLanguage)}</span>
                                            <span style={{ width: 160, color: '#888', fontSize: 12 }}>{t('table_designer.tdengine.tag.type', undefined, i18nLanguage)}</span>
                                            <span style={{ color: '#888', fontSize: 12 }}>{t('table_designer.tdengine.tag.value', undefined, i18nLanguage)}</span>
                                        </Space>
                                        {tdengineChildTagDefs.map((tag) => (
                                            <Space key={tag._key} align="start" wrap>
                                                <span style={{ width: 160, lineHeight: '32px', fontSize: 13, fontWeight: 500 }}>{tag.name}</span>
                                                <span style={{ width: 160, lineHeight: '32px', fontSize: 12, color: '#888' }}>{tag.type}</span>
                                                <Input
                                                    {...noAutoCapInputProps}
                                                    value={tdengineChildTagValues[tag.name] ?? ''}
                                                    onChange={(event) => setTdengineChildTagValues(prev => ({ ...prev, [tag.name]: event.target.value }))}
                                                    placeholder={t('table_designer.tdengine.placeholder.tag_value_input', undefined, i18nLanguage)}
                                                    style={{ width: 280 }}
                                                />
                                            </Space>
                                        ))}
                                    </Space>
                                ) : (
                                    <div style={{ padding: '16px 0', textAlign: 'center', color: '#888' }}>
                                        {t('table_designer.tdengine.message.loading_tag_defs', undefined, i18nLanguage)}
                                    </div>
                                )}
                            </Spin>
                        ) : (
                            <Input.TextArea
                                {...noAutoCapInputProps}
                                value={tdengineTagValues}
                                onChange={(event) => setTdengineTagValues(event.target.value)}
                                autoSize={{ minRows: 3, maxRows: 8 }}
                                placeholder={t('table_designer.tdengine.placeholder.tag_values', undefined, i18nLanguage)}
                            />
                        )}
                    </Space>
                )}
            </Space>
    );

    const columnsTabContent = (
        <Dropdown menu={{ items: columnClipboard.contextMenuItems }} trigger={['contextMenu']}>
        <div
            ref={containerRef}
            className="table-designer-wrapper gn-v2-designer-table-shell"
            onCopy={columnClipboard.handleCopyEvent}
            onPaste={columnClipboard.handlePasteEvent}
            onKeyDown={columnClipboard.handleKeyDown}
            style={{
                height: '100%',
                overflow: 'hidden',
                position: 'relative',
                background: panelBodyBg
            }}
        >
          <style>{`
              .table-designer-wrapper .table-designer-focus-row > .ant-table-cell {
                  background: ${focusRowBg} !important;
              }
              .table-designer-wrapper .table-designer-drag-handle {
                  display: inline-flex;
                  align-items: center;
                  cursor: grab;
                  color: #999;
              }
          `}</style>
          {readOnly ? (
          <Table
              dataSource={columns}
              columns={columnsWithSelect}
              rowKey="_key"
              rowClassName={(record: EditableColumn) => record._key === focusColumnKey ? 'table-designer-focus-row' : ''}
              size="small"
              pagination={false}
              loading={columnsLoading}
              scroll={{ y: tableHeight }}
              bordered={false}
              components={{
                header: {
                  cell: ResizableTitle,
                },
              }}
              onRow={(record: EditableColumn) => ({
                  onContextMenu: () => handleColumnRowContextMenu(record),
              })}
          />
    ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={columns.map(c => c._key)} strategy={verticalListSortingStrategy}>
              <Table
                  dataSource={columns}
                  columns={columnsWithSelect}
                  rowKey="_key"
                  rowClassName={(record: EditableColumn) => record._key === focusColumnKey ? 'table-designer-focus-row' : ''}
                  size="small"
                  pagination={false}
                  loading={columnsLoading}
                  scroll={{ y: tableHeight }}
                  bordered={false}
                  components={{
                      body: { row: SortableRow },
                      header: { cell: ResizableTitle }
                  }}
                  onRow={(record: EditableColumn) => ({
                      onContextMenu: () => handleColumnRowContextMenu(record),
                  })}
              />
          </SortableContext>
        </DndContext>
    )}
    </div>
        </Dropdown>
    );

    const tdengineCombinedTabContent = (
        <div
            className="gn-v2-tdengine-combined"
            style={{
                display: 'flex',
                flexDirection: 'column',
                height: '100%',
                minHeight: 0,
                overflow: 'hidden',
                background: panelBodyBg,
            }}
        >
            <div
                className="gn-v2-tdengine-options"
                style={{
                    flex: isTDengineChildNewTable ? '1 1 auto' : '0 0 auto',
                    minHeight: 0,
                    maxHeight: isTDengineChildNewTable ? undefined : 'min(42%, 320px)',
                    overflow: 'auto',
                    padding: '10px 12px',
                    borderBottom: isTDengineChildNewTable ? undefined : `1px solid ${panelToolbarBorder}`,
                }}
            >
                {tdengineAdvancedFormContent}
            </div>
            {!isTDengineChildNewTable && (
                <div
                    className="gn-v2-tdengine-columns-section"
                    style={{
                        display: 'flex',
                        flexDirection: 'column',
                        flex: '1 1 auto',
                        minHeight: 0,
                        overflow: 'hidden',
                    }}
                >
                    <div
                        className="gn-v2-tdengine-columns-heading"
                        style={{
                            display: 'flex',
                            alignItems: 'baseline',
                            justifyContent: 'space-between',
                            gap: 8,
                            flex: '0 0 auto',
                            padding: '8px 12px 6px',
                        }}
                    >
                        <strong>{t('table_designer.tab.columns', undefined, i18nLanguage)}</strong>
                        <span style={{ color: darkMode ? 'rgba(255,255,255,0.52)' : 'rgba(0,0,0,0.45)', fontSize: 12 }}>
                            {designerColumnSummary}
                        </span>
                    </div>
                    <div style={{ flex: '1 1 auto', minHeight: 0, overflow: 'hidden' }}>
                        {columnsTabContent}
                    </div>
                </div>
            )}
        </div>
    );
    return {
        toggleIndexSelection, resizableIndexColumns, starRocksAdvancedTabContent, columnsTabContent,
        tdengineCombinedTabContent,
    };
};

export type TableDesignerTabContentsApi = ReturnType<typeof useTableDesignerTabContents>;
