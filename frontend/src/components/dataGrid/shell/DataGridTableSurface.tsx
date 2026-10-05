import React from 'react';
import { GONAVI_ROW_KEY } from '../../DataGridCore';

type DataGridTableSurfaceProps = {
  CellContextMenuContext: React.Context<any>;
  DndContext: React.ElementType;
  EditableContext: React.Context<any>;
  Form: React.ElementType;
  SortableContext: React.ElementType;
  Table: React.ElementType;
  cellContextMenuValue: any;
  closestCenter: any;
  displayColumnNames: React.Key[];
  enableVirtual: boolean;
  form: any;
  handleDragEnd: (...args: any[]) => any;
  handleTableChange: (...args: any[]) => any;
  horizontalListSortingStrategy: any;
  loading: boolean;
  rowClassName: (...args: any[]) => string;
  rowSelectionConfig: any;
  sensors: any;
  tableColumns: any[];
  tableComponents: any;
  tableRef: React.Ref<any>;
  tableRenderData: any[];
  tableScrollConfig: any;
  virtualListItemColumnVirtual: boolean;
  virtualListItemHeight?: number;
  virtualListItemHeightFixed: boolean;
  virtualListItemNativeScrollbarControlled: boolean;
  virtualListItemHorizontalOffsetComposited: boolean;
};

const TABLE_SORTER_TOOLTIP = { target: 'sorter-icon' } as const;

const DataGridTableSurfaceComponent: React.FC<DataGridTableSurfaceProps> = ({
  CellContextMenuContext,
  DndContext,
  EditableContext,
  Form,
  SortableContext,
  Table,
  cellContextMenuValue,
  closestCenter,
  displayColumnNames,
  enableVirtual,
  form,
  handleDragEnd,
  handleTableChange,
  horizontalListSortingStrategy,
  loading,
  rowClassName,
  rowSelectionConfig,
  sensors,
  tableColumns,
  tableComponents,
  tableRef,
  tableRenderData,
  tableScrollConfig,
  virtualListItemColumnVirtual,
  virtualListItemHeight,
  virtualListItemHeightFixed,
  virtualListItemNativeScrollbarControlled,
  virtualListItemHorizontalOffsetComposited,
}) => (
  <Form component={false} form={form}>
    <CellContextMenuContext.Provider value={cellContextMenuValue}>
      <EditableContext.Provider value={form}>
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={displayColumnNames} strategy={horizontalListSortingStrategy}>
            <Table
              ref={tableRef}
              components={tableComponents}
              dataSource={tableRenderData}
              columns={tableColumns}
              {...(enableVirtual && typeof virtualListItemHeight === 'number'
                ? {
                    listItemHeight: virtualListItemHeight,
                    listItemHeightFixed: virtualListItemHeightFixed,
                    listItemNativeScrollbarControlled: virtualListItemNativeScrollbarControlled,
                    listItemHorizontalOffsetComposited: virtualListItemHorizontalOffsetComposited,
                    listItemColumnVirtual: virtualListItemColumnVirtual,
                  }
                : {})}
              showSorterTooltip={TABLE_SORTER_TOOLTIP}
              size="small"
              tableLayout="fixed"
              scroll={tableScrollConfig}
              sticky={false}
              virtual={enableVirtual}
              loading={loading}
              rowKey={GONAVI_ROW_KEY}
              pagination={false}
              onChange={handleTableChange}
              rowHoverable={false}
              bordered
              rowSelection={rowSelectionConfig}
              rowClassName={rowClassName}
            />
          </SortableContext>
        </DndContext>
      </EditableContext.Provider>
    </CellContextMenuContext.Provider>
  </Form>
);

export const DataGridTableSurface = React.memo(DataGridTableSurfaceComponent);
DataGridTableSurface.displayName = 'DataGridTableSurface';
