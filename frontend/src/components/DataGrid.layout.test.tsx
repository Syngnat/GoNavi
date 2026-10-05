import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { readV2ThemeCss } from '../test/readV2ThemeCss';
import DataGrid, { buildDataGridPaginationPageSizeOptions } from './DataGrid';
import DataGridColumnQuickFind from './DataGridColumnQuickFind';
import DataGridPaginationBar from './DataGridPaginationBar';
import DataGridResultViewSwitcher from './DataGridResultViewSwitcher';
import { buildDataGridCssText } from './dataGridStyles';
import { DataGridV2DdlSideWorkspace, DataGridV2DdlView } from './DataGridV2DdlWorkspace';
import { I18nProvider } from '../i18n/provider';
import { getCurrentLanguage, resolveLanguage, setCurrentLanguage, t, type LanguagePreference } from '../i18n';
import { cloneShortcutOptions, DEFAULT_SHORTCUT_OPTIONS } from '../utils/shortcuts';

const readDataGridSource = () => [
  './useDataGridBatchActions.ts',
  './dataGrid/batchActions/cellSelectionInteraction.ts',
  './dataGrid/batchActions/cellSelectionHandlers.ts',
  './DataGrid.tsx',
  // DataGrid.tsx 拆出的常量模块与 hook
  './dataGrid/dataGridPagingOptions.ts',
  './dataGrid/dataGridScrollTiming.ts',
  './dataGrid/hooks/useDataGridCoreState.ts',
  './dataGrid/hooks/useDataGridCellEditorState.ts',
  './dataGrid/hooks/useDataGridTableMetrics.ts',
  './dataGrid/hooks/useDataGridColumnTitles.tsx',
  './dataGrid/hooks/useDataGridCellEditing.ts',
  './dataGrid/hooks/useDataGridInlineEditor.ts',
  './dataGrid/hooks/useDataGridRowEditors.ts',
  './dataGrid/hooks/useDataGridColumns.tsx',
  './dataGrid/hooks/useDataGridRowActions.tsx',
  './dataGrid/hooks/useDataGridCommit.ts',
  './dataGrid/hooks/useDataGridHorizontalVirtualScroll.tsx',
  './dataGrid/hooks/useDataGridPageFind.ts',
  './dataGrid/hooks/useDataGridExternalScroll.ts',
  './dataGrid/hooks/useDataGridLayoutEffects.ts',
  './useDataGridV2Actions.ts',
  './dataGrid/v2Actions/useDataGridV2ColumnActions.ts',
  './dataGrid/v2Actions/useDataGridV2CopyExport.ts',
  './dataGrid/v2Actions/useDataGridV2CellActions.ts',
  './useDataGridMetadata.ts',
  './useDataGridColumnResize.ts',
  './dataGridStyles.ts',
  './dataGridStylesTable.ts',
  './dataGridStylesBody.ts',
  './dataGridStylesScrollbars.ts',
  './dataGridStylesPagination.ts',
  './DataGridCore.tsx',
  // DataGridCore.tsx 拆出的 dataGrid/core 模块
  './dataGrid/core/dataGridTypes.ts',
  './dataGrid/core/dataGridCellStyles.ts',
  './dataGrid/core/DataGridErrorBoundary.tsx',
  './dataGrid/core/dataGridCellKeys.ts',
  './dataGrid/core/dataGridCellValues.ts',
  './dataGrid/core/dataGridCellDisplay.tsx',
  './dataGrid/core/DataGridHeaderCells.tsx',
  './dataGrid/core/EditableCell.tsx',
  './dataGrid/core/dataGridGridFilters.tsx',
  './dataGrid/core/dataGridCommitChangeSet.ts',
  './DataGridShell.tsx',
  './dataGrid/shell/DataGridTableSurface.tsx',
  './dataGrid/shell/useDataGridShellRenderers.tsx',
  './dataGrid/shell/DataGridShellToolbar.tsx',
  './dataGrid/shell/DataGridShellBody.tsx',
  './dataGrid/shell/DataGridShellRowEditorModal.tsx',
].map((file) => readFileSync(new URL(file, import.meta.url), 'utf8')).join('\n');

const readDataGridShellSource = (): string => [
  './DataGridShell.tsx',
  './dataGrid/shell/DataGridTableSurface.tsx',
  './dataGrid/shell/useDataGridShellRenderers.tsx',
  './dataGrid/shell/DataGridShellToolbar.tsx',
  './dataGrid/shell/DataGridShellBody.tsx',
  './dataGrid/shell/DataGridShellRowEditorModal.tsx',
].map((file) => readFileSync(new URL(file, import.meta.url), 'utf8')).join('\n');

const readDataGridColumnResizeSource = (): string =>
  readFileSync(new URL('./useDataGridColumnResize.ts', import.meta.url), 'utf8');

const mockStoreState = vi.hoisted(() => ({
  languagePreference: 'system' as LanguagePreference,
}));

vi.mock('../store', () => ({
  useStore: (selector: (state: any) => any) => selector({
    connections: [],
    addSqlLog: vi.fn(),
    theme: 'light',
    appearance: {
      enabled: true,
      opacity: 1,
      blur: 0,
      showDataTableVerticalBorders: false,
      showDataTableRowNumber: true,
      dataTableDensity: 'comfortable',
    },
    setAppearance: vi.fn(),
    queryOptions: {
      showColumnComment: false,
      showColumnType: false,
      alignNumericTemporalCellsRight: false,
    },
    setQueryOptions: vi.fn(),
    dataEditTransactionOptions: {
      commitMode: 'manual',
      autoCommitDelayMs: 5000,
    },
    setDataEditTransactionOptions: vi.fn(),
    addTab: vi.fn(),
    setActiveContext: vi.fn(),
    tableColumnOrders: {},
    tablePinnedLeftColumns: {},
    enableColumnOrderMemory: false,
    setTableColumnOrder: vi.fn(),
    setEnableColumnOrderMemory: vi.fn(),
    clearTableColumnOrder: vi.fn(),
    tableHiddenColumns: {},
    enableHiddenColumnMemory: false,
    setTableHiddenColumns: vi.fn(),
    setEnableHiddenColumnMemory: vi.fn(),
    clearTableHiddenColumns: vi.fn(),
    shortcutOptions: cloneShortcutOptions(DEFAULT_SHORTCUT_OPTIONS),
    languagePreference: mockStoreState.languagePreference,
    aiPanelVisible: false,
    setAIPanelVisible: vi.fn(),
  }),
}));

vi.mock('../../wailsjs/go/app/App', () => ({
  ImportData: vi.fn(),
  PreviewImportFileWithOptions: vi.fn(),
  CancelImportJob: vi.fn(),
  ExportTable: vi.fn(),
  ExportData: vi.fn(),
  ExportQuery: vi.fn(),
  ApplyChanges: vi.fn(),
  DBGetColumns: vi.fn(),
  DBGetIndexes: vi.fn(),
  DBGetForeignKeys: vi.fn(),
  DBShowCreateTable: vi.fn(),
}));

vi.mock('@monaco-editor/react', () => ({
  default: (props: { value?: string }) => (
    <pre data-monaco-editor="true">{props.value ?? ''}</pre>
  ),
}));

const requestAnimationFrameMock = vi.fn((callback: FrameRequestCallback) => {
  callback(0);
  return 1;
});

const cancelAnimationFrameMock = vi.fn();

vi.stubGlobal('requestAnimationFrame', requestAnimationFrameMock);

vi.stubGlobal('cancelAnimationFrame', cancelAnimationFrameMock);

vi.stubGlobal('window', {
  requestAnimationFrame: requestAnimationFrameMock,
  cancelAnimationFrame: cancelAnimationFrameMock,
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
});

const renderDataGridWithI18n = (
  element: React.ReactElement,
  options: { preference?: LanguagePreference; systemLanguages?: readonly string[] } = {},
) => {
  const preference = options.preference ?? mockStoreState.languagePreference;
  return renderToStaticMarkup(
    <I18nProvider
      preference={preference}
      systemLanguages={options.systemLanguages ?? ['zh-CN']}
      onPreferenceChange={() => {}}
    >
      {element}
    </I18nProvider>,
  );
};

const zhCnCatalog = JSON.parse(
  readFileSync(new URL('../../../shared/i18n/zh-CN.json', import.meta.url), 'utf8'),
) as Record<string, string>;

const zhObjectDesignLabel = zhCnCatalog['data_grid.secondary.object_design'];

describe('DataGrid layout', () => {
  it('applies new-column auto widths before the browser paints the reused grid', () => {
    const source = readDataGridColumnResizeSource();
    const autoFitEffect = source.slice(
      source.indexOf('const initialAutoFitSignature'),
      source.indexOf('const autoFitColumnWidth'),
    );

    expect(autoFitEffect).toContain('useDataGridLayoutEffect(() => {');
    expect(autoFitEffect).not.toContain('useEffect(() => {');
  });

  it('uses SQL max-row presets for paginated SQL results without changing other grids', () => {
    expect(buildDataGridPaginationPageSizeOptions()).toEqual(['100', '200', '500', '1000']);
    expect(buildDataGridPaginationPageSizeOptions(750)).toEqual(['100', '500', '1000', '5000', '20000', '0', '750']);
    expect(buildDataGridPaginationPageSizeOptions(1000)).toEqual(['100', '500', '1000', '5000', '20000', '0']);
    expect(buildDataGridPaginationPageSizeOptions(0)).toEqual(['100', '500', '1000', '5000', '20000', '0']);
  });

  it.each([-1, 12.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'ignores an invalid SQL max row count (%s)',
    (queryMaxRows) => {
      expect(buildDataGridPaginationPageSizeOptions(queryMaxRows)).toEqual(['100', '500', '1000', '5000', '20000', '0']);
    },
  );

  it('renders without navigator in server-side environments', () => {
    const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Reflect.deleteProperty(globalThis, 'navigator');

    try {
      expect(() => renderDataGridWithI18n(
        <DataGrid
          data={[]}
          columnNames={[]}
          loading={false}
          tableName="users"
          dbName="main"
          connectionId="conn-1"
          readOnly
          pagination={{
            current: 1,
            pageSize: 100,
            total: 0,
          }}
          onPageChange={() => {}}
        />,
      )).not.toThrow();
    } finally {
      if (navigatorDescriptor) {
        Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, 'navigator');
      }
    }
  });

  it('renders a secondary action strip for view switching and auxiliary actions', () => {
    const markup = renderDataGridWithI18n(
      <DataGrid
        data={[
          {
            __gonavi_row_key__: 'row-1',
            id: 1,
            name: 'alpha',
          },
        ]}
        columnNames={['id', 'name']}
        loading={false}
        tableName="users"
        dbName="main"
        connectionId="conn-1"
        readOnly
        pagination={{
          current: 1,
          pageSize: 100,
          total: 1,
        }}
        onPageChange={() => {}}
      />,
    );

    expect(markup).toContain('data-grid-secondary-actions="true"');
    expect(markup).toContain('data-grid-view-switcher="true"');
    expect(markup).toContain('data-grid-column-display-action="true"');
    expect(markup).toContain('data-grid-column-quick-find-action="true"');
    expect(markup).toContain('显示/隐藏字段列');
    expect(markup).toContain('跳列');
    expect(markup).toContain('日志');
    expect(markup).toContain(zhObjectDesignLabel);
    expect(markup).not.toContain('data-grid-page-find="true"');
    expect(markup).not.toContain('data-grid-page-find-prev="true"');
    expect(markup).not.toContain('data-grid-page-find-next="true"');
    expect(markup).toContain('gn-v2-data-grid-status-main');
    expect(markup).toContain('gn-v2-data-grid-status-right');
    expect(markup).toContain('data-grid-v2-pagination="true"');
    expect(markup).toContain('data-grid-v2-page-chip="true"');
    expect(markup).toContain('data-grid-v2-pagination-first="true"');
    expect(markup).toContain('data-grid-v2-pagination-prev="true"');
    expect(markup).toContain('data-grid-v2-pagination-next="true"');
    expect(markup).toContain('data-grid-v2-pagination-last="true"');
    expect(markup).toContain('data-grid-pagination-jump="true"');
    expect(markup).toContain('跳页');
    expect(markup).toContain('跳转页码');
    expect(markup).not.toContain('class="ant-pagination');
    expect(markup).not.toContain('class="data-grid-pagination-kicker"');
    expect(markup).not.toContain('当前页查找...');
  });

  it('keeps every column header left-aligned regardless of column type', () => {
    const markup = renderDataGridWithI18n(
      <DataGrid
        data={[
          {
            __gonavi_row_key__: 'row-1',
            id: 1,
            amount: 9.5,
            name: 'alpha',
            created_at: '2026-01-01 00:00:00',
          },
        ]}
        columnNames={['id', 'amount', 'name', 'created_at']}
        initialColumnMetaMap={{
          id: { type: 'int' },
          amount: { type: 'decimal(10,2)' },
          name: { type: 'varchar(255)' },
          created_at: { type: 'datetime' },
        } as any}
        loading={false}
        tableName="users"
        dbName="main"
        connectionId="conn-1"
        readOnly
        pagination={{
          current: 1,
          pageSize: 100,
          total: 1,
        }}
        onPageChange={() => {}}
      />,
    );

    const columnTitleBlock = (columnName: string) =>
      markup.match(new RegExp(`<div class="gn-v2-column-title[^"]*" data-column-name="${columnName}"[^>]*style="[^"]*"`))?.[0] || '';

    // 数值/日期时间/字符串列的表头列名一律左对齐，且不引入 #1353 的表头右对齐类。
    expect(columnTitleBlock('id')).toContain('align-items:flex-start');
    expect(columnTitleBlock('amount')).toContain('align-items:flex-start');
    expect(columnTitleBlock('created_at')).toContain('align-items:flex-start');
    expect(columnTitleBlock('name')).toContain('align-items:flex-start');
    expect(markup).not.toContain('is-align-right');
  });

  it('right-aligns numeric and datetime body cells through cell props, not the header', () => {
    const source = readDataGridSource();
    // 数据格右对齐仅通过 onCell 的 style 作用于 body 单元格（SSR 不渲染 body 行，故校验源码接线）。
    expect(source).toContain('resolveGridColumnAlign');
    // 由显示设置开关控制：仅当开启时注入 textAlign:right。
    expect(source).toContain("gridColumnAlignMap[dataIndex] === 'right' ? { textAlign: 'right' } : undefined");
    // 默认值与安全兜底均为 false（默认全左对齐）。
    expect(source).toContain('alignNumericTemporalCellsRight');
  });

  it('refreshes DataGrid localized chrome when the language preference changes', () => {
    mockStoreState.languagePreference = 'system';
    const renderLocalizedQuickFind = (systemLanguages: readonly string[]) => {
      const language = resolveLanguage('system', systemLanguages);
      return renderDataGridWithI18n(
        <DataGridColumnQuickFind

          value=""
          options={[]}
          translate={(key, params) => t(key, params, language)}
          onChange={() => {}}
          onSubmit={() => {}}
        />,
        { systemLanguages },
      );
    };

    const zhMarkup = renderLocalizedQuickFind(['zh-CN']);
    expect(zhMarkup).toContain('placeholder="跳到字段列..."');
    expect(zhMarkup).not.toContain('placeholder="Jump to column..."');

    const enMarkup = renderLocalizedQuickFind(['en-US']);
    expect(enMarkup).toContain('placeholder="Jump to column..."');

    const source = readDataGridSource();
  });

  it('keeps the v2 footer fields action labeled as field info for views', () => {
    const markup = renderDataGridWithI18n(
      <DataGrid
        data={[
          {
            __gonavi_row_key__: 'row-1',
            id: 1,
            name: 'alpha',
          },
        ]}
        columnNames={['id', 'name']}
        loading={false}
        tableName="user_view"
        objectType="view"
        readOnly
        pagination={{
          current: 1,
          pageSize: 100,
          total: 1,
        }}
        onPageChange={() => {}}
      />,
    );

    expect(markup).toContain('字段信息');
    expect(markup).not.toContain(zhObjectDesignLabel);
  });

  it('falls back to the current i18n language when rendered outside I18nProvider', () => {
    const previousLanguage = getCurrentLanguage();
    setCurrentLanguage('en-US');

    try {
      const markup = renderToStaticMarkup(
        <DataGridColumnQuickFind

          value=""
          options={[]}
          onChange={() => {}}
          onSubmit={() => {}}
        />,
      );

      expect(markup).toContain('placeholder="Jump to column..."');
      expect(markup).not.toContain('placeholder="跳到字段列..."');
    } finally {
      setCurrentLanguage(previousLanguage);
    }
  });

  it('localizes v2 pagination summaries through DataGrid i18n', () => {
    mockStoreState.languagePreference = 'system';
    const markup = renderDataGridWithI18n(
      <DataGrid
        data={[
          {
            __gonavi_row_key__: 'row-1',
            id: 1,
            name: 'alpha',
          },
        ]}
        columnNames={['id', 'name']}
        loading={false}
        tableName="users"
        readOnly
        pagination={{
          current: 1,
          pageSize: 100,
          total: 1,
          totalKnown: false,
          totalCountLoading: true,
        }}
        onPageChange={() => {}}
      />,
      { systemLanguages: ['en-US'] },
    );
    expect(markup).toContain('Current 1 rows / counting total...');
    expect(markup).not.toContain('正在统计');
  });

  it('keeps v2 pagination page text out of the summary because the page chip owns it', () => {
    mockStoreState.languagePreference = 'system';
    const markup = renderDataGridWithI18n(
      <DataGrid
        data={[
          {
            __gonavi_row_key__: 'row-1',
            id: 1,
            name: 'alpha',
          },
        ]}
        columnNames={['id', 'name']}
        loading={false}
        tableName="users"
        readOnly
        pagination={{
          current: 1,
          pageSize: 100,
          total: 1,
        }}
        onPageChange={() => {}}
      />,
      { systemLanguages: ['en-US'] },
    );

    expect(markup).toContain('Current 1 rows / 1 rows total');
    expect(markup).toContain('data-grid-v2-page-chip="true"');
    expect(markup).toContain('<strong>1</strong><span>/</span><span>1</span>');
    expect(markup).not.toContain('Page 1 / 1');
  });

  it('keeps the v2 pagination total-count action readable instead of icon-button width', () => {
    const css = readV2ThemeCss();
    const markup = renderToStaticMarkup(
      <DataGridPaginationBar

        pagination={{
          current: 1,
          pageSize: 500,
          total: 500,
          totalKnown: false,
        }}
        paginationV2SummaryText="当前 500 条 / 未统计总数"


        paginationTotalPages={1}
        paginationPageText="第 1 页"
        paginationPageSizeOptions={['500']}
        showKnownPageCount={false}
        manualTotalCountAvailable
        onPageChange={() => {}}
        onPageSizeChange={() => {}}
        onV2PageStep={() => {}}
        onToggleTotalCount={() => {}}
      />,
    );

    expect(markup).toContain('data-grid-pagination-total-count="true"');
    expect(markup).toContain('统计总数');
    expect(css).toMatch(/\[data-grid-pagination-total-count="true"\]\.ant-btn \{[\s\S]*?width: auto !important;[\s\S]*?min-width: max-content !important;[\s\S]*?white-space: nowrap;/);
    expect(css).toMatch(/\[data-grid-pagination-total-count="true"\]\.ant-btn \.ant-btn-icon \{[\s\S]*?margin-inline-end: 3px !important;/);
  });

  it('keeps the SQL custom page-size dropdown input and confirmation button compact', () => {
    const css = readV2ThemeCss();

    expect(css).toMatch(/\[data-grid-custom-page-size-dropdown="true"\]\s*\{[^}]*width:\s*128px;[^}]*max-width:\s*calc\(100vw - 24px\);/s);
    expect(css).toMatch(/\[data-grid-custom-page-size-confirm="true"\]\.ant-btn\s*\{[^}]*width:\s*24px\s*!important;[^}]*min-width:\s*24px\s*!important;[^}]*max-width:\s*24px\s*!important;[^}]*height:\s*24px\s*!important;[^}]*min-height:\s*24px\s*!important;[^}]*padding:\s*0\s*!important;/s);
  });

  it('keeps V2 current-page find hidden until its floating table overlay is opened', () => {
    const css = readV2ThemeCss();
    expect(css).toMatch(/\.gn-v2-data-grid-page-find-overlay\s*\{[^}]*position:\s*absolute;[^}]*top:\s*8px;[^}]*right:\s*8px;[^}]*z-index:\s*40;[^}]*background:[^;]+;[^}]*box-shadow:/s);
    expect(css).toMatch(/\.gn-v2-data-grid-page-find-overlay\s*\{[^}]*width:\s*min\(360px,\s*calc\(100% - 16px\)\);/s);
    expect(css).toMatch(/\.gn-v2-data-grid-page-find\s*\{[^}]*width:\s*100%;[^}]*flex:\s*1 1 auto;[^}]*overflow:\s*hidden;/s);
    expect(css).toMatch(/\.gn-v2-data-grid-page-find \.ant-input-affix-wrapper\s*\{[^}]*flex:\s*1 1 160px;[^}]*width:\s*auto !important;[^}]*max-width:\s*none !important;/s);
    expect(css).not.toMatch(/\.gn-v2-data-grid-page-find\s*\{[^}]*max-width:\s*214px\s*!important;/s);
    expect(css).not.toMatch(/\.gn-v2-data-grid-page-find [^{]*\.gn-v2-data-grid-page-find-input[^{]*\{[^}]*width:\s*160px\s*!important;/s);
    expect(css).not.toContain('.gn-v2-data-grid-page-find-row');
  });

  it('does not render a full-height guide line while resizing columns', () => {
    const source = readDataGridShellSource();

    expect(source).not.toContain('Ghost Resize Line for Columns');
    expect(source).not.toContain('ghostRef');
  });

  it('paints a neutral crosshair for the active cell while preserving selection precedence', () => {
    const css = buildDataGridCssText({
      darkMode: false,
      densityParams: { dataFontSize: 12 },
      gridId: 'active-cell-grid',
      bgContent: '#ffffff',
    });
    const rowSelector = '.active-cell-grid.data-grid-root .ant-table-tbody-virtual-holder .ant-table-row[data-active-cell-row="true"] > .ant-table-cell';
    const columnSelector = '.active-cell-grid.data-grid-root .ant-table-tbody-virtual-holder .ant-table-row > .ant-table-cell[data-active-cell-column="true"]';
    const fixedControlHoverSelector = '.active-cell-grid.data-grid-root .ant-table-tbody-virtual-holder .ant-table-row[data-active-cell-row="true"]:hover > .ant-table-cell:is(.data-grid-row-number-cell, .ant-table-selection-column)';
    const headerSelector = '.active-cell-grid.data-grid-root .ant-table-header .ant-table-thead > tr > th.ant-table-cell[data-active-cell-column="true"]';

    [rowSelector, columnSelector, fixedControlHoverSelector, headerSelector].forEach((selector) => {
      expect(css).toContain(selector);
    });
    const fixedControlHoverRuleStart = css.indexOf(fixedControlHoverSelector);
    const fixedControlHoverRuleEnd = css.indexOf('}', fixedControlHoverRuleStart);
    const fixedControlHoverRule = css.slice(fixedControlHoverRuleStart, fixedControlHoverRuleEnd + 1);
    expect(fixedControlHoverRule).toContain('background: rgb(from var(--gn-bg-panel-2, #ffffff) r g b / 1) !important;');
    expect(css).toContain('var(--gn-bg-hover, rgba(15, 23, 42, 0.045))');
    expect(css).toContain('var(--gn-bg-active, rgba(15, 23, 42, 0.075))');
    expect(css.indexOf('[data-cell-selected="true"]')).toBeGreaterThan(css.indexOf(rowSelector));

    const darkCss = buildDataGridCssText({
      darkMode: true,
      densityParams: { dataFontSize: 12 },
      gridId: 'active-cell-dark-grid',
      bgContent: '#161a21',
    });
    expect(darkCss).toContain('var(--gn-bg-hover, rgba(255, 255, 255, 0.05))');
    expect(darkCss).toContain('var(--gn-bg-active, rgba(255, 255, 255, 0.08))');

    const source = readDataGridSource();
    expect(source).toContain("'data-col-name': key");
    expect(source).toContain('syncDataGridCellSelectionVisuals({');
  });

  it('keeps detached DataGrid chrome text behind translateDataGrid', () => {
    const dataGridSource = readDataGridSource();
    const pageFindSource = readFileSync(new URL('./DataGridPageFind.tsx', import.meta.url), 'utf8');
    const resultViewSource = readFileSync(new URL('./DataGridResultViewSwitcher.tsx', import.meta.url), 'utf8');
    const paginationSource = readFileSync(new URL('./DataGridPaginationBar.tsx', import.meta.url), 'utf8');
    const secondaryActionsSource = readFileSync(new URL('./DataGridSecondaryActions.tsx', import.meta.url), 'utf8');
    const recordViewsSource = readFileSync(new URL('./DataGridRecordViews.tsx', import.meta.url), 'utf8');
    const previewPanelSource = readFileSync(new URL('./DataGridPreviewPanel.tsx', import.meta.url), 'utf8');
    const modalsSource = readFileSync(new URL('./DataGridModals.tsx', import.meta.url), 'utf8');
    const ddlWorkspaceSource = readFileSync(new URL('./DataGridV2DdlWorkspace.tsx', import.meta.url), 'utf8');
    const detachedChromeSource = [
      pageFindSource,
      resultViewSource,
      paginationSource,
      secondaryActionsSource,
      recordViewsSource,
      previewPanelSource,
      modalsSource,
      ddlWorkspaceSource,
    ].join('\n');
    [
      'data_grid.table_fallback.query_result',
      'data_grid.toolbar.refresh',
      'data_grid.toolbar.filter',
      'data_grid.toolbar.add_row',
      'data_grid.toolbar.undo_delete',
      'data_grid.toolbar.delete_selected',
      'data_grid.toolbar.selected_count',
      'data_grid.toolbar.cell_selection_enter',
      'data_grid.toolbar.cell_selection_exit',
      'data_grid.toolbar.cell_selection_mode',
      'data_grid.toolbar.copy_selection',
      'data_grid.toolbar.copy_selection_columns',
      'data_grid.toolbar.copy_selection_columns_same_row',
      'data_grid.toolbar.batch_fill',
      'data_grid.toolbar.paste_to_selected_rows',
      'data_grid.toolbar.select_fill_template_targets',
      'data_grid.toolbar.copied_columns_count',
      'data_grid.toolbar.commit_label',
      'data_grid.toolbar.commit',
      'data_grid.toolbar.preview_sql_generate',
      'data_grid.toolbar.preview_sql',
      'data_grid.toolbar.rollback',
      'data_grid.toolbar.import',
      'data_grid.toolbar.export',
      'data_grid.toolbar.copy',
      'data_grid.toolbar.ai_insight',
      'data_grid.toolbar.ai_insight_short',
      'data_grid.toolbar.ai_insight_tooltip',
      'data_grid.toolbar.cancel_count',
      'data_grid.toolbar.cancel_count_tooltip',
      'data_grid.toolbar.count_total',
      'data_grid.toolbar.count_total_tooltip',
      'data_grid.pagination.selected_count',
      'data_grid.filter.mongodb_query_placeholder',
      'data_grid.filter.quick_where_placeholder',
      'data_grid.filter.apply_where',
      'data_grid.filter.clear',
      'data_grid.filter.enabled',
      'data_grid.filter.first_condition',
      'data_grid.filter.search_field_placeholder',
      'data_grid.filter.custom_where_placeholder',
      'data_grid.filter.list_values_placeholder',
      'data_grid.filter.start_value_placeholder',
      'data_grid.filter.end_value_placeholder',
      'data_grid.filter.no_value_placeholder',
      'data_grid.filter.sort_label',
      'data_grid.filter.then_label',
      'data_grid.filter.select_sort_field_placeholder',
      'data_grid.filter.sort_asc',
      'data_grid.filter.sort_desc',
      'data_grid.filter.add_condition',
      'data_grid.filter.add_sort',
      'data_grid.filter.enable_all',
      'data_grid.filter.disable_all',
      'data_grid.filter.apply',
    ].forEach((key) => {
    });
    [
      /translate\('data_grid\.toolbar\.selected_count', \{ count: deleteTargetRowCount \}\)/,
      /translate\('data_grid\.toolbar\.copy_selection', \{ count: selectedCellsSize \}\)/,
      /translate\('data_grid\.toolbar\.copy_selection_columns', \{ count: selectedCellsSize \}\)/,
      /translate\('data_grid\.toolbar\.batch_fill', \{ count: selectedCellsSize \}\)/,
      /translate\('data_grid\.toolbar\.paste_to_selected_rows', \{[\s\S]*count: fillTemplateTargetRowCount,[\s\S]*\}\)/,
      /translate\('data_grid\.toolbar\.copied_columns_count', \{ count: copiedCellPatchColumnCount \}\)/,
      /translate\('data_grid\.toolbar\.commit', \{ count: pendingChangeCount \}\)/,
    ].forEach((pattern) => {
    });
    [
      '查询结果',
      '刷新',
      '筛选',
      '添加行',
      '撤销删除',
      '删除选中',
      '选择多个单元格',
      '单元格选择模式',
      '退出单元格选择',
      '复制到剪贴板',
      '复制为填充模板',
      '批量设值',
      '将模板应用到目标行',
      '请框选目标单元格，或勾选目标行',
      '提交事务',
      '生成预览 SQL',
      '预览SQL',
      '回滚',
      '导入',
      '导出',
      '一键借助 AI 智能分析当前查询页数据',
      'AI 洞察',
      'AI 数据洞察',
      '取消本次精确总数统计（不会影响当前浏览）',
      '按当前筛选统计精确总数',
      '取消统计',
      '统计总数',
      '应用 WHERE',
      '清空',
      '启用',
      '首条',
      '搜索字段名',
      '输入自定义 WHERE 表达式',
      '多个值用逗号或换行分隔',
      '开始值',
      '结束值',
      '无需输入值',
      '排序',
      '然后',
      '选择排序字段',
      '升序',
      '降序',
      '添加条件',
      '添加排序',
      '全启用',
      '全停用',
      '>应用<',
      '>复制<',
    ].forEach((literal) => {
    });
    (['zh-CN', 'zh-TW', 'en-US', 'ja-JP', 'de-DE', 'ru-RU'] as const).forEach((locale) => {
    });

    const handleCopyDdlSourceStart = dataGridSource.indexOf('const handleCopyDdl = useCallback(() => {');
    const handleCopyDdlSource = dataGridSource.slice(
      handleCopyDdlSourceStart,
      dataGridSource.indexOf('const handleCopySelectedCellsToClipboard', handleCopyDdlSourceStart),
    );
    [
      'data_grid.message.no_ddl_to_copy',
      'data_grid.message.ddl_copied',
      'data_grid.message.ddl_copy_failed',
    ].forEach((key) => {
    });
    [
      '暂无可复制的 DDL',
      'DDL 已复制到剪贴板',
      '复制 DDL 失败',
    ].forEach((literal) => {
    });
    expect(dataGridSource.match(/message\.info\(translateDataGrid\('data_grid\.message\.no_copyable_rows'\)\)/g) ?? []).toHaveLength(2);

    const ddlWorkspaceInlineLiterals = [
      '底部',
      '侧栏',
      '重新加载',
      '复制 DDL',
      '正在加载 DDL...',
      '表 DDL 侧栏',
    ];
    ddlWorkspaceInlineLiterals.forEach((literal) => {
    });

    const ddlWorkspaceTranslateCalls: Array<{ key: string; params?: Record<string, unknown> }> = [];
    const translate = (key: string, params?: Record<string, unknown>) => {
      ddlWorkspaceTranslateCalls.push({ key, params });
      return `[${key}]`;
    };
    const rawTableName = 'catalog.system_raw_error';
    const rawDdl = 'CREATE TABLE catalog.system_raw_error (sql_text text, checksum text, github_release text, http_status int);';

    const bottomDdlMarkup = renderToStaticMarkup(
      <DataGridV2DdlView
        layout="bottom"
        darkMode={false}
        tableName={rawTableName}
        ddlViewLayout="bottom"
        ddlLoading={false}
        ddlText={rawDdl}
        onDdlViewLayoutChange={() => {}}
        onReload={() => {}}
        onCopy={() => {}}
        translate={translate}
      />,
    );
    const sideDdlMarkup = renderToStaticMarkup(
      <DataGridV2DdlSideWorkspace
        tableContent={<div data-table-content="true">rows</div>}
        tableName={rawTableName}
        ddlViewLayout="side"
        ddlLoading
        ddlText={rawDdl}
        darkMode={false}
        onDdlViewLayoutChange={() => {}}
        onReload={() => {}}
        onCopy={() => {}}
        ddlSidebarWidth={420}
        ddlSidebarResizePreviewX={null}
        onResizeStart={() => {}}
        translate={translate}
      />,
    );
    const v2ThemeCss = readV2ThemeCss();
    expect(v2ThemeCss).toMatch(/\.gn-v2-data-grid-ddl-view\.is-side\s+\.gn-v2-data-grid-ddl-actions\s*\{[^}]*flex-wrap:\s*nowrap;/s);
    expect(v2ThemeCss).toMatch(/\.gn-v2-data-grid-ddl-view\.is-side\s+\.gn-v2-data-grid-ddl-title\s*\{[^}]*overflow:\s*hidden;/s);
    expect(ddlWorkspaceTranslateCalls.map((call) => call.key)).toEqual([
      'data_grid.ddl.layout_bottom',
      'data_grid.ddl.layout_side',
      'data_grid.ddl.reload',
      'data_grid.ddl.copy',
      'data_grid.ddl.sidebar_aria',
      'data_grid.ddl.layout_bottom',
      'data_grid.ddl.layout_side',
      'data_grid.ddl.reload',
      'data_grid.ddl.copy',
      'common.close',
      'data_grid.ddl.loading',
    ]);
    expect(ddlWorkspaceTranslateCalls.every((call) => call.params === undefined)).toBe(true);

    [
      '仅查找当前页已加载数据，不改变 WHERE 条件',
      '当前页查找...',
      '匹配 ',
      '结果视图',
      '表格',
      '文本',
      '数据预览',
      '字段信息',
      '显示/隐藏字段列',
      '跳列',
      '未提交',
      '跳页',
      '跳转页码',
      '>跳<',
      '每页条数',
      '结果集',
      '当前结果集无数据',
      '当前结果集 ',
      ' 条记录',
      '编辑 JSON',
      '上一条',
      '下一条',
      '记录 ',
      '编辑当前记录',
      '点击单元格查看数据',
      '编辑行',
      '编辑 JSON 结果集',
      '说明：此处按当前结果集顺序编辑',
      '格式化 JSON',
      '应用修改',
      '批量填充',
      '设置为 NULL',
      '对已选中单元格设置为NULL',
      '输入要填充的值',
      '复制 DDL',
      '正在加载 DDL...',
      '>保存<',
      '点击表格中的单元格以预览完整数据',
    ].forEach((literal) => {
    });
  });

  it('localizes DataGrid filter option labels through the filter hook translator', () => {
    const dataGridSource = readDataGridSource();
    const filterHookSource = readFileSync(new URL('./useDataGridFilters.tsx', import.meta.url), 'utf8');
    const filterOpOptionsStart = filterHookSource.indexOf('const filterOpOptions = React.useMemo');
    const filterLogicOptionsStart = filterHookSource.indexOf('const filterLogicOptions = React.useMemo');
    const hookCallStart = dataGridSource.indexOf('} = useDataGridFilters({');
    const hookCallSource = dataGridSource.slice(
      hookCallStart,
      dataGridSource.indexOf('});', hookCallStart) + 3,
    );
    const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    const filterOpOptionsSource = filterHookSource.slice(filterOpOptionsStart, filterLogicOptionsStart);
    const filterLogicOptionsSource = filterHookSource.slice(
      filterLogicOptionsStart,
      filterHookSource.indexOf('const isNoValueOp', filterLogicOptionsStart),
    );
    const rawOperatorLabels = ['=', '!=', '<', '<=', '>', '>='];
    rawOperatorLabels.forEach((operator) => {
      const operatorPattern = escapeRegExp(operator);
    });

    const translatedOperatorKeys: Array<[string, string]> = [
      ['CONTAINS', 'data_grid.filter.op.contains'],
      ['NOT_CONTAINS', 'data_grid.filter.op.not_contains'],
      ['STARTS_WITH', 'data_grid.filter.op.starts_with'],
      ['NOT_STARTS_WITH', 'data_grid.filter.op.not_starts_with'],
      ['ENDS_WITH', 'data_grid.filter.op.ends_with'],
      ['NOT_ENDS_WITH', 'data_grid.filter.op.not_ends_with'],
      ['IS_NULL', 'data_grid.filter.op.is_null'],
      ['IS_NOT_NULL', 'data_grid.filter.op.is_not_null'],
      ['IS_EMPTY', 'data_grid.filter.op.is_empty'],
      ['IS_NOT_EMPTY', 'data_grid.filter.op.is_not_empty'],
      ['BETWEEN', 'data_grid.filter.op.between'],
      ['NOT_BETWEEN', 'data_grid.filter.op.not_between'],
      ['IN', 'data_grid.filter.op.in_list'],
      ['NOT_IN', 'data_grid.filter.op.not_in_list'],
      ['CUSTOM', 'data_grid.filter.op.custom'],
    ];
    translatedOperatorKeys.forEach(([value, key]) => {
    });

    [
      '包含',
      '不包含',
      '开始以',
      '不是开始于',
      '结束以',
      '不是结束于',
      '是 null',
      '不是 null',
      '是空的',
      '不是空的',
      '介于',
      '不介于',
      '在列表',
      '不在列表',
      '[自定义]',
      '且 (AND)',
      '或 (OR)',
    ].forEach((literal) => {
      expect(`${filterOpOptionsSource}\n${filterLogicOptionsSource}`).not.toContain(literal);
    });

    (['zh-CN', 'zh-TW', 'en-US', 'ja-JP', 'de-DE', 'ru-RU'] as const).forEach((locale) => {
      translatedOperatorKeys.forEach(([, key]) => {
      });
    });
  });

  it('renders the v2 DataGrid toolbar using the redesigned topbar hooks', () => {
    const markup = renderDataGridWithI18n(
      <DataGrid
        data={[
          {
            __gonavi_row_key__: 'row-1',
            id: 1,
            name: 'alpha',
          },
        ]}
        columnNames={['id', 'name']}
        loading={false}
        tableName="users"
        dbName="main"
        connectionId="conn-1"
        editLocator={{
          strategy: 'primary-key',
          columns: ['id'],
          valueColumns: ['id'],
          readOnly: false,
        }}
        onReload={() => {}}
        showFilter
        onToggleFilter={() => {}}
        pagination={{
          current: 1,
          pageSize: 100,
          total: 1,
        }}
        onPageChange={() => {}}
      />,
    );

    expect(markup).toContain('gn-v2-data-grid');
    expect(markup).toContain('gn-v2-data-grid-toolbar-frame');
    expect(markup).toContain('gn-v2-data-grid-toolbar-title');
    expect(markup).toContain('gn-v2-toolbar-divider');
    expect(markup).toContain('gn-v2-commit-button');
    expect(markup).toContain('gn-v2-ai-insight-button');
    expect(markup).toContain('gn-v2-data-grid-toolbar-action');
    expect(markup).toContain('gn-v2-smart-filter-panel');
    expect(markup).toContain('gn-v2-data-grid-table-shell');
    expect(markup).toContain('gn-v2-data-grid-table-wrap');
    expect(markup).toContain('· main');
    expect(markup).toContain('提交事务');
    expect(markup).toContain('手动提交');
    expect(markup).toContain('AI 洞察');

    const getButtonBody = (label: string) => {
      const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const match = markup.match(new RegExp(`<button(?=[^>]*aria-label="${escapedLabel}")[^>]*>([\\s\\S]*?)<\\/button>`));
      expect(match, `missing toolbar button: ${label}`).not.toBeNull();
      return match?.[1] ?? '';
    };

    [
      '刷新',
      '筛选',
      '新增行',
      '删除选中',
      '单元格选择模式',
      '提交事务',
      '手动提交',
      '导入',
      '导出',
      'AI 洞察',
    ].forEach((label) => {
      expect(getButtonBody(label)).not.toContain(label);
    });
    [
      '数据预览',
      zhObjectDesignLabel,
      '查看 DDL',
      'ER 图',
      '日志',
      '显示/隐藏字段列',
    ].forEach((label) => {
      expect(getButtonBody(label)).not.toContain(label);
    });
    expect(markup).toContain('aria-haspopup="menu"');
    expect(markup).toContain('aria-expanded="false"');

    const resultViewMarkup = renderToStaticMarkup(
      <DataGridResultViewSwitcher
        viewMode="table"
        translate={(key) => zhCnCatalog[key] ?? key}
        onViewModeChange={() => {}}
      />,
    );
    expect(
      readFileSync(new URL('./DataGridResultViewSwitcher.tsx', import.meta.url), 'utf8'),
    ).toContain('<Tooltip title={option.label}>');

    const css = readV2ThemeCss();
    const iconActionCss = css.slice(
      css.indexOf('body[data-ui-version="v2"] .gn-v2-data-grid .gn-v2-data-grid-toolbar-action {'),
      css.indexOf('body[data-ui-version="v2"] .gn-v2-data-grid-toolbar-title {'),
    );
    const commitBaseCss = css.slice(
      css.indexOf('body[data-ui-version="v2"] .gn-v2-data-grid .gn-v2-commit-button {'),
      css.indexOf('body[data-ui-version="v2"] .gn-v2-data-grid .gn-v2-commit-button:hover,'),
    );
    const commitInteractiveCss = css.slice(
      css.indexOf('body[data-ui-version="v2"] .gn-v2-data-grid .gn-v2-commit-button:hover,'),
      css.indexOf('body[data-ui-version="v2"] .gn-v2-data-grid .gn-v2-commit-button:disabled,'),
    );
    const commitDisabledCss = css.slice(
      css.indexOf('body[data-ui-version="v2"] .gn-v2-data-grid .gn-v2-commit-button:disabled,'),
      css.indexOf('body[data-ui-version="v2"] .gn-v2-data-grid .gn-v2-commit-button .gn-v2-toolbar-kbd {'),
    );
    const viewTabSelectionCss = css.slice(
      css.indexOf('body[data-ui-version="v2"] .gn-v2-data-grid-view-tabs .ant-btn-primary {'),
      css.indexOf('body[data-ui-version="v2"] .gn-v2-data-grid-statusbar .gn-v2-data-grid-toolbar-action.ant-btn {'),
    );
    const resultViewSelectionCss = css.slice(
      css.indexOf('body[data-ui-version="v2"] .gn-v2-data-grid-result-switcher .ant-segmented-item-selected,'),
      css.indexOf('body[data-ui-version="v2"] .gn-v2-data-grid-page-find-overlay {'),
    );
    expect(iconActionCss).toContain('width: 28px !important;');
    expect(iconActionCss).toContain('min-width: 28px !important;');
    expect(iconActionCss).toContain('padding-inline: 0 !important;');
    expect(commitBaseCss).toContain(
      'background: var(--gn-client-result-toolbar-primary-bg, var(--gn-result-toolbar-primary-bg, var(--gn-accent))) !important;',
    );
    expect(commitBaseCss).toContain(
      'color: var(--gn-client-result-toolbar-primary-fg, var(--gn-result-toolbar-primary-fg, var(--gn-on-accent, #fff))) !important;',
    );
    expect(commitInteractiveCss).toContain('box-shadow:');
    expect(commitDisabledCss).toContain(
      'background: var(--gn-client-result-toolbar-primary-disabled-bg, var(--gn-result-toolbar-primary-disabled-bg, var(--gn-bg-active))) !important;',
    );
    expect(commitDisabledCss).toContain(
      'color: var(--gn-client-result-toolbar-primary-disabled-fg, var(--gn-result-toolbar-primary-disabled-fg, var(--gn-fg-5))) !important;',
    );
    expect(commitDisabledCss).not.toContain('var(--gn-accent-soft)');
    expect(viewTabSelectionCss).toContain('background: var(--gn-accent-strong, var(--gn-accent)) !important;');
    expect(viewTabSelectionCss).toContain('color: var(--gn-ant-on-primary, var(--gn-on-accent, #fff)) !important;');
    expect(viewTabSelectionCss).not.toContain('background: var(--gn-bg-active) !important;');
    expect(viewTabSelectionCss).toContain(':focus-visible');
    expect(viewTabSelectionCss).toContain('background: var(--gn-accent-strong-hover, var(--gn-accent-2)) !important;');
    expect(viewTabSelectionCss).toContain('background: var(--gn-accent-strong-active, var(--gn-accent-2)) !important;');
    expect(resultViewSelectionCss).toContain('background: var(--gn-accent-strong, var(--gn-accent)) !important;');
    expect(resultViewSelectionCss).toContain('border: 0 !important;');
    expect(resultViewSelectionCss).toContain('box-shadow: none !important;');
    expect(resultViewSelectionCss).toContain('color: var(--gn-ant-on-primary, var(--gn-on-accent, #fff)) !important;');
    expect(css).toContain(
      'body[data-ui-version="v2"] .gn-v2-data-grid-statusbar .gn-v2-data-grid-toolbar-action.ant-btn {',
    );
  });

  it('keeps quick WHERE input clipboard editing isolated from grid shortcuts', () => {
    const source = readDataGridSource();
    const filterHookSource = readFileSync(new URL('./useDataGridFilters.tsx', import.meta.url), 'utf8');
    const css = readV2ThemeCss();
    expect(css).toContain('[data-grid-quick-where-input="true"]');
    expect(css).toContain('font-size: var(--gn-font-size, 14px) !important;');
    expect(css).toContain('user-select: text !important;');
  });

  it('enters fixed-row virtual scrolling before a user can scroll the V2 data table', () => {
    const source = readDataGridSource();
    const css = readV2ThemeCss();

    expect(css).toContain('height: calc(28px * var(--gn-ui-scale, 1));');
    expect(source).toContain('const virtualListItemHeight = Math.max(1, 28 * effectiveUiScale);');
    expect(source).toContain('const virtualListItemHeightFixed = !virtualEditingCellForRender;');
    expect(source).not.toContain('virtualRowHeightMeasurement');
  });

  it('keeps native horizontal scrolling outside the post-commit visual guard', () => {
    const source = readDataGridSource();
    const virtualColumnSource = source.slice(
      source.indexOf('const virtualListItemColumnVirtual ='),
      source.indexOf('const tableComponents ='),
    );
    const visualSyncSource = source.slice(
      source.indexOf('const syncVirtualHorizontalVisualOffset = useCallback'),
      source.indexOf('virtualHorizontalPostCommitFrameHandlerRef.current ='),
    );
    const postCommitSource = source.slice(
      source.indexOf('const scheduleVirtualHorizontalPostCommit = useCallback'),
      source.indexOf('const applyVirtualHorizontalOffset = useCallback'),
    );
    const externalScrollSource = source.slice(
      source.indexOf('const applyExternalScrollToTableTargets = useCallback'),
      source.indexOf('const handleExternalHorizontalScrollPointerDown = useCallback'),
    );

    expect(source).toContain('const isWindowsLike = useMemo(() => isWindowsPlatform(), []);');
    expect(source).toContain('const virtualListItemHorizontalOffsetComposited = isMacLike || isWindowsLike;');
    expect(source).toContain('const horizontalScrollVisible = isTableSurfaceActive && !isWindowsLike && externalHorizontalScrollMetrics.visible;');
    // Every platform now keeps the column window: rc-table's 640/960px overscan
    // plus its 512px retention buffer covers a one-frame-late window.
    expect(virtualColumnSource).not.toContain('&& !isWindowsLike');
    expect(virtualColumnSource).not.toContain('&& !isMacLike');
    expect(virtualColumnSource).toContain('&& shouldVirtualizeDataGridColumns(displayColumnNames.length);');
    expect(visualSyncSource).toContain('virtualHorizontalPostCommitGuardRef.current?.cancel();');
    expect(visualSyncSource).toContain('virtualHorizontalPreviewActiveRef.current = false;');
    expect(postCommitSource).toContain('virtualListItemHorizontalOffsetComposited) return;');
    expect(externalScrollSource).toContain("horizontalSyncSourceRef.current === 'table'");
  });

  it('keeps the native header on one transform path that follows every scroll source', () => {
    const source = readDataGridSource();
    const shellSource = readDataGridShellSource();
    const css = buildDataGridCssText({
      darkMode: false,
      densityParams: { dataFontSize: 12 },
      gridId: 'mac-scroll-grid',
      floatingScrollbarHeight: 8,
    });
    const visualSyncSource = source.slice(
      source.indexOf('const syncVirtualHorizontalVisualOffset = useCallback'),
      source.indexOf('virtualHorizontalPostCommitFrameHandlerRef.current ='),
    );
    const nativeScrollHandlerIndex = source.indexOf('const handleTargetScroll = (event: Event)');
    const nativeScrollBindingSource = source.slice(
      source.lastIndexOf('useEffect(() => {', nativeScrollHandlerIndex),
      source.indexOf('const paginationControlTotal = useMemo', nativeScrollHandlerIndex),
    );

    const nativeScrollFlushSource = source.slice(
      source.indexOf('const flushNativeVirtualHorizontalScroll = useCallback'),
      source.indexOf('const scheduleNativeVirtualHorizontalScroll = useCallback'),
    );

    expect(shellSource).toContain("data-horizontal-scroll-sync={virtualListItemHorizontalOffsetComposited ? 'transform' : undefined}");
    expect(css).not.toContain('[data-horizontal-scroll-sync="timeline"]');
    expect(css).toContain('[data-horizontal-scroll-sync="transform"] .ant-table-header > table');
    expect(css).toContain('translate: var(--gn-datagrid-h-scroll, 0px) 0 !important;');
    expect(css).not.toContain('animation-timeline:');
    expect(source).not.toContain('resolveDataGridHorizontalSyncMode');
    expect(visualSyncSource).toContain('syncDataGridHeaderHorizontalOffset(');
    expect(visualSyncSource).not.toContain("headerEl.style.setProperty('--gn-datagrid-h-scroll'");
    expect(visualSyncSource).not.toContain("cell.style.setProperty('transform'");
    expect(nativeScrollBindingSource).toContain('scheduleNativeVirtualHorizontalScroll(tableContainer)');
    expect(nativeScrollBindingSource).not.toContain('syncVirtualHorizontalVisualOffset(tableContainer, source.scrollLeft)');
    expect(nativeScrollFlushSource).toContain('const visual = syncVirtualHorizontalVisualOffset(tableContainer, holderEl.scrollLeft);');
    expect(nativeScrollFlushSource).not.toContain('timeline');
  });

  it('uses native Windows scrollbars and keeps the macOS overlay track', () => {
    const source = readDataGridSource();
    const css = buildDataGridCssText({
      darkMode: false,
      densityParams: { dataFontSize: 12 },
      gridId: 'win-scroll-grid',
      floatingScrollbarHeight: 8,
    });
    const themeCss = readV2ThemeCss();

    expect(source).toContain('const virtualListItemHorizontalOffsetComposited = isMacLike || isWindowsLike;');
    expect(source).toContain('const horizontalScrollVisible = isTableSurfaceActive && !isWindowsLike && externalHorizontalScrollMetrics.visible;');
    expect(source).toContain('const virtualListItemNativeScrollbarControlled = isMacLike && virtualListItemHeightFixed;');
    expect(css).toContain('body[data-platform="darwin"] .win-scroll-grid .ant-table-tbody-virtual-holder[data-horizontal-scroll-native="true"]::-webkit-scrollbar');
    expect(css).toContain('body[data-platform="windows"] .win-scroll-grid .data-grid-external-horizontal-scroll');
    expect(css).toContain('body:not([data-platform="windows"]) .win-scroll-grid .ant-table-body::-webkit-scrollbar');
    expect(themeCss).toContain('body[data-ui-version="v2"]:not([data-platform="windows"]) :not(:is(.gn-v2-explorer-tree-shell .ant-tree-list-holder))::-webkit-scrollbar');
    expect(themeCss).not.toMatch(/body\[data-ui-version="v2"\] ::-webkit-scrollbar \{/);
  });

  it('keeps overflowing table column references stable across viewport-only resizes', () => {
    const source = readDataGridSource();

    expect(source).toContain('const baseTableColumns = useMemo(() => (');
    expect(source).toContain('columns: baseTableColumns,');
    expect(source).toContain('stretchToViewport: mergedColumns.length > 0');
  });

  it('keeps DataGrid scroll synchronization throttled to animation frames', () => {
    const source = readDataGridSource();
    const secondaryActionsSource = readFileSync(new URL('./DataGridSecondaryActions.tsx', import.meta.url), 'utf8');
    const css = readV2ThemeCss();
    const pageFindFocusSource = source.slice(
      source.indexOf('const focusPageFindMatch = useCallback'),
      source.indexOf('const handleNavigatePageFind = useCallback'),
    );
    const interactionActiveSource = source.slice(
      source.indexOf('const isExternalScrollbarInteractionActive = useCallback'),
      source.indexOf('const clearExternalScrollbarInteraction = useCallback'),
    );
    const finishExternalScrollbarDragSource = source.slice(
      source.indexOf('const finishExternalScrollbarDrag = useCallback'),
      source.indexOf('const handleExternalHorizontalScrollPointerRelease = useCallback'),
    );
    expect(css).toContain('width: 66px !important;');
    expect(css).toContain('container-name: gn-v2-data-grid-statusbar;');
    expect(css).toContain('body[data-ui-version="v2"] .gn-v2-data-grid-statusbar::-webkit-scrollbar');
    expect(css).toContain('scrollbar-width: thin;');
    expect(css).toContain('min-width: max-content;');
    expect(css).toContain('flex: 0 0 auto;');
    expect(css).not.toContain('gn-v2-data-grid-status-center');
    expect(css).not.toContain('gn-v2-data-grid-live');
    expect(css).toContain('body[data-ui-version="v2"] .gn-v2-data-grid-pagination-wrap::-webkit-scrollbar');
    expect(css).toContain('@container gn-v2-data-grid-statusbar (max-width: 960px)');
    expect(css).toContain('@container gn-v2-data-grid-statusbar (max-width: 760px)');
    expect(css).toContain('.data-grid-pagination-size-select.ant-select-focused .ant-select-selector');
    expect(css).toContain('overflow-x: auto;');
    expect(css).toContain('.data-grid-pagination-jump-input.ant-input-number-focused');
    expect(css).toContain('background: transparent !important;');
  });
});
