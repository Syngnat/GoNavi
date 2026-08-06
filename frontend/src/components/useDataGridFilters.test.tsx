import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { useDataGridFilters, type UseDataGridFiltersResult } from './useDataGridFilters';

const createFilterHookProps = (
  overrides: Partial<Parameters<typeof useDataGridFilters>[0]> = {},
): Parameters<typeof useDataGridFilters>[0] => ({
  appliedFilterConditions: [],
  quickWhereCondition: '',
  showFilter: false,
  displayColumnNames: ['id', 'code', 'title'],
  allTableColumnNames: ['id', 'code', 'title'],
  columnMetaMap: {
    id: { type: 'bigint' },
    code: { type: 'varchar(50)' },
    title: { type: 'varchar(500)' },
  },
  dbType: 'mysql',
  darkMode: false,
  getColumnFilterType: (columnName) => {
    if (columnName === 'id') return 'bigint';
    return 'varchar(255)';
  },
  resolveDefaultGridFilterOperator: (columnType) => (
    String(columnType || '').toLowerCase().includes('char') ? 'CONTAINS' : '='
  ),
  resolveNextGridFilterOperatorForColumnChange: () => 'CONTAINS',
  ...overrides,
});

describe('useDataGridFilters', () => {
  it('syncs column-header filters into the shared toolbar filter state without requiring the filter panel to be open', () => {
    const onApplyFilter = vi.fn();
    const hookProps = createFilterHookProps({
      showFilter: false,
      onApplyFilter,
    });
    let latest: UseDataGridFiltersResult | undefined;
    let renderer: ReactTestRenderer | undefined;

    const Harness = () => {
      latest = useDataGridFilters(hookProps);
      return null;
    };

    act(() => {
      renderer = create(<Harness />);
    });

    expect(latest?.filterConditions).toEqual([]);

    act(() => {
      expect(latest?.applyColumnFilter({
        column: 'code',
        op: 'CONTAINS',
        value: '3551',
      })).toBe(true);
    });

    expect(latest?.filterConditions).toMatchObject([{
      enabled: true,
      logic: 'AND',
      column: 'code',
      op: 'CONTAINS',
      value: '3551',
      value2: '',
    }]);
    expect(onApplyFilter).toHaveBeenCalledWith([
      expect.objectContaining({
        enabled: true,
        logic: 'AND',
        column: 'code',
        op: 'CONTAINS',
        value: '3551',
        value2: '',
      }),
    ]);

    renderer?.unmount();
  });

  it('preserves earlier value selections when a second column filter is applied', () => {
    let latest: UseDataGridFiltersResult | undefined;
    let renderer: ReactTestRenderer | undefined;

    const Harness = () => {
      const [appliedConditions, setAppliedConditions] = React.useState<Parameters<typeof useDataGridFilters>[0]['appliedFilterConditions']>([]);
      latest = useDataGridFilters(createFilterHookProps({
        appliedFilterConditions: appliedConditions,
        onApplyFilter: setAppliedConditions,
      }));
      return null;
    };

    act(() => {
      renderer = create(<Harness />);
    });

    act(() => {
      latest?.applyColumnFilter({
        column: 'code',
        op: 'IN',
        valueSelection: { values: ['A'] },
      });
    });
    act(() => {
      latest?.applyColumnFilter({
        column: 'title',
        op: 'IN',
        valueSelection: { values: ['B'] },
      });
    });

    expect(latest?.filterConditions).toEqual([
      expect.objectContaining({
        column: 'code',
        op: 'IN',
        valueSelection: { values: ['A'] },
      }),
      expect.objectContaining({
        column: 'title',
        op: 'IN',
        valueSelection: { values: ['B'] },
      }),
    ]);

    renderer?.unmount();
  });
});
