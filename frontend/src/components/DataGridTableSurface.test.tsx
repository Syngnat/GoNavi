import React, { forwardRef } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';

import { DataGridTableSurface } from './DataGridShell';

describe('DataGridTableSurface', () => {
  it('does not rerender the table when only its parent container width changes', () => {
    let tableRenderCount = 0;
    const MockTable = forwardRef<HTMLDivElement, Record<string, unknown>>((_props, ref) => {
      tableRenderCount += 1;
      return <div ref={ref} />;
    });
    const PassThrough = ({ children }: React.PropsWithChildren) => <>{children}</>;
    const CellContextMenuContext = React.createContext<Record<string, unknown>>({});
    const EditableContext = React.createContext<Record<string, unknown>>({});
    const stableProps = {
      CellContextMenuContext,
      DndContext: PassThrough,
      EditableContext,
      Form: PassThrough,
      SortableContext: PassThrough,
      Table: MockTable,
      cellContextMenuValue: {},
      closestCenter: () => null,
      displayColumnNames: ['id'],
      enableVirtual: true,
      form: {},
      handleDragEnd: () => undefined,
      handleTableChange: () => undefined,
      horizontalListSortingStrategy: () => null,
      loading: false,
      rowClassName: () => '',
      rowSelectionConfig: {},
      sensors: [],
      tableColumns: [{ key: 'id' }],
      tableComponents: {},
      tableRef: React.createRef<HTMLDivElement>(),
      tableRenderData: [{ id: 1 }],
      tableScrollConfig: { x: 1200, y: 600 },
      virtualListItemColumnVirtual: true,
      virtualListItemHeight: 28,
      virtualListItemHeightFixed: true,
      virtualListItemNativeScrollbarControlled: true,
      virtualListItemHorizontalOffsetComposited: true,
    };
    const Harness = ({ containerWidth, columnWidth }: { containerWidth: number; columnWidth?: number }) => (
      <section data-container-width={containerWidth}>
        <DataGridTableSurface
          {...stableProps}
          tableColumns={columnWidth === undefined ? stableProps.tableColumns : [{ key: 'id', width: columnWidth }]}
        />
      </section>
    );
    let renderer: ReactTestRenderer | null = null;

    act(() => {
      renderer = create(<Harness containerWidth={1108} />);
    });
    expect(tableRenderCount).toBe(1);

    act(() => {
      renderer?.update(<Harness containerWidth={1280} />);
    });
    expect(tableRenderCount).toBe(1);

    act(() => {
      renderer?.update(<Harness containerWidth={1280} columnWidth={240} />);
    });
    expect(tableRenderCount).toBe(2);

    act(() => renderer?.unmount());
  });
});
