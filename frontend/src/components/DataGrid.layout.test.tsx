import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { readV2ThemeCss } from '../test/readV2ThemeCss';

import DataGrid, {
  buildGridFieldSelectOptions,
  formatCellDisplayText,
  resolveContextMenuFieldName,
  resolveDefaultGridFilterOperator,
  resolveNextGridFilterOperatorForColumnChange,
} from './DataGrid';
import DataGridPageFind from './DataGridPageFind';
import DataGridPaginationBar from './DataGridPaginationBar';
import DataGridPreviewPanel from './DataGridPreviewPanel';
import { DataGridJsonView, DataGridTextView } from './DataGridRecordViews';
import DataGridResultViewSwitcher from './DataGridResultViewSwitcher';
import DataGridSecondaryActions from './DataGridSecondaryActions';
import { buildDataGridCssText } from './dataGridStyles';
import { DataGridV2DdlSideWorkspace, DataGridV2DdlView } from './DataGridV2DdlWorkspace';
import { DataGridV2ErView, DataGridV2FieldsView } from './DataGridV2MetadataViews';
import { I18nProvider } from '../i18n/provider';
import { getCurrentLanguage, setCurrentLanguage, type LanguagePreference } from '../i18n';
import { V2CellContextMenuView } from './V2TableContextMenu';
import { cloneShortcutOptions, DEFAULT_SHORTCUT_OPTIONS } from '../utils/shortcuts';

const readDataGridSource = () => [
  './useDataGridBatchActions.ts',
  './DataGrid.tsx',
  './useDataGridV2Actions.ts',
  './useDataGridMetadata.ts',
  './useDataGridColumnResize.ts',
  './dataGridStyles.ts',
  './DataGridCore.tsx',
  './DataGridShell.tsx',
].map((file) => readFileSync(new URL(file, import.meta.url), 'utf8')).join('\n');
const readDataGridSecondaryActionsSource = (): string =>
  readFileSync(new URL('./DataGridSecondaryActions.tsx', import.meta.url), 'utf8');
const readDataGridShellSource = (): string =>
  readFileSync(new URL('./DataGridShell.tsx', import.meta.url), 'utf8');

const mockStoreState = vi.hoisted(() => ({
  languagePreference: 'system' as LanguagePreference,
  uiVersion: 'v2',
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
      uiVersion: mockStoreState.uiVersion,
    },
    setAppearance: vi.fn(),
    queryOptions: {
      showColumnComment: false,
      showColumnType: false,
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
const enUsCatalog = JSON.parse(
  readFileSync(new URL('../../../shared/i18n/en-US.json', import.meta.url), 'utf8'),
) as Record<string, string>;
const zhObjectDesignLabel = zhCnCatalog['data_grid.secondary.object_design'];
const enUndoCellChangeLabel = enUsCatalog['data_grid.context_menu.undo_cell_change'];

describe('DataGrid layout', () => {
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
    expect(markup).toContain('字段显示');
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

  it('refreshes DataGrid localized chrome when the language preference changes', () => {
    mockStoreState.languagePreference = 'system';
    const previousUiVersion = mockStoreState.uiVersion;
    mockStoreState.uiVersion = 'legacy';
    const renderLocalizedGrid = (systemLanguages: readonly string[]) => renderDataGridWithI18n(
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
      { systemLanguages },
    );

    try {
      const zhMarkup = renderLocalizedGrid(['zh-CN']);
      expect(zhMarkup).toContain('placeholder="跳到字段列..."');
      expect(zhMarkup).not.toContain('placeholder="Jump to column..."');

      const enMarkup = renderLocalizedGrid(['en-US']);
      expect(enMarkup).toContain('placeholder="Jump to column..."');
    } finally {
      mockStoreState.uiVersion = previousUiVersion;
    }

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
    const previousUiVersion = mockStoreState.uiVersion;
    const previousLanguage = getCurrentLanguage();
    mockStoreState.uiVersion = 'legacy';
    setCurrentLanguage('en-US');

    try {
      const markup = renderToStaticMarkup(
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
        />,
      );

      expect(markup).toContain('placeholder="Jump to column..."');
      expect(markup).not.toContain('placeholder="跳到字段列..."');
    } finally {
      setCurrentLanguage(previousLanguage);
      mockStoreState.uiVersion = previousUiVersion;
    }
  });

  it('localizes legacy and v2 pagination summaries through DataGrid i18n', () => {
    mockStoreState.languagePreference = 'system';
    const previousUiVersion = mockStoreState.uiVersion;
    const renderLocalizedGrid = (uiVersion: 'legacy' | 'v2', pagination: React.ComponentProps<typeof DataGrid>['pagination']) => {
      mockStoreState.uiVersion = uiVersion;
      return renderDataGridWithI18n(
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
          pagination={pagination}
          onPageChange={() => {}}
        />,
        { systemLanguages: ['en-US'] },
      );
    };

    try {
      const legacyMarkup = renderLocalizedGrid('legacy', {
        current: 1,
        pageSize: 100,
        total: 1,
      });
      expect(legacyMarkup).toContain('Current 1 rows / 1 rows total');
      expect(legacyMarkup).not.toContain('当前 1 条');

      const v2Markup = renderLocalizedGrid('v2', {
        current: 1,
        pageSize: 100,
        total: 1,
        totalKnown: false,
        totalCountLoading: true,
      });
      expect(v2Markup).toContain('Current 1 rows / counting total...');
      expect(v2Markup).not.toContain('正在统计');
    } finally {
      mockStoreState.uiVersion = previousUiVersion;
    }
  });

  it('keeps v2 pagination page text out of the summary because the page chip owns it', () => {
    mockStoreState.languagePreference = 'system';
    const previousUiVersion = mockStoreState.uiVersion;
    mockStoreState.uiVersion = 'v2';

    try {
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
    } finally {
      mockStoreState.uiVersion = previousUiVersion;
    }
  });

  it('keeps the v2 pagination total-count action readable instead of icon-button width', () => {
    const css = readV2ThemeCss();
    const markup = renderToStaticMarkup(
      <DataGridPaginationBar
        isV2Ui
        pagination={{
          current: 1,
          pageSize: 500,
          total: 500,
          totalKnown: false,
        }}
        paginationV2SummaryText="当前 500 条 / 未统计总数"
        paginationSummaryText="当前 500 条 / 未统计总数"
        paginationControlTotal={500}
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

  it('keeps V2 current-page find hidden until its floating table overlay is opened', () => {
    const source = readDataGridShellSource();
    const secondaryActionsSource = readDataGridSecondaryActionsSource();
    const css = readV2ThemeCss();
    const v2BranchStart = secondaryActionsSource.indexOf('if (isV2Ui)');
    const legacyBranchStart = secondaryActionsSource.lastIndexOf('  return (');
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

  it('keeps the V2 column resize hit target visually transparent', () => {
    const css = readV2ThemeCss();

    expect(css).toMatch(
      /\.gn-v2-data-grid \.react-resizable-handle\s*\{[^}]*background-image:\s*none\s*!important;/s,
    );
    expect(css).not.toContain('.react-resizable-handle::after');
    expect(css).not.toContain('.react-resizable-handle:hover::after');
  });

  it('uses the table cell as the only V2 inline edit frame', () => {
    const css = readV2ThemeCss();
    const inlineEditorCss = css.slice(
      css.indexOf('body[data-ui-version="v2"] .gn-v2-data-grid .data-grid-virtual-inline-editing .ant-input,'),
      css.indexOf('body[data-ui-version="v2"] .gn-v2-data-grid-statusbar'),
    );

    expect(inlineEditorCss).toContain('border: 0 !important;');
    expect(inlineEditorCss).toContain('border-radius: 0 !important;');
    expect(inlineEditorCss).toContain('background: transparent !important;');
    expect(inlineEditorCss).toContain('box-shadow: none !important;');
  });

  it('avoids duplicating legacy pagination page text beside the pager', () => {
    const markup = renderToStaticMarkup(
      <DataGridPaginationBar
        isV2Ui={false}
        pagination={{
          current: 1,
          pageSize: 100,
          total: 24,
        }}
        paginationV2SummaryText="24 行"
        paginationSummaryText="当前 24 条 / 共 24 条"
        paginationControlTotal={24}
        paginationTotalPages={1}
        paginationPageText="第 1 / 1 页"
        paginationPageSizeOptions={['100', '200']}
        showKnownPageCount
        onPageChange={() => {}}
        onPageSizeChange={() => {}}
        onV2PageStep={() => {}}
      />,
    );

    expect(markup).toContain('class="ant-pagination');
    expect(markup).not.toContain('第 1 / 1 页');
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
      'data_grid.toolbar.cell_editor',
      'data_grid.toolbar.copy_selection',
      'data_grid.toolbar.copy_selection_columns',
      'data_grid.toolbar.batch_fill',
      'data_grid.toolbar.paste_to_selected_rows',
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
      /translate\('data_grid\.toolbar\.paste_to_selected_rows', \{ count: selectedRowKeysLength \}\)/,
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
      '单元格编辑器',
      '复制选区',
      '复制选区列值',
      '批量填充',
      '粘贴到选中行',
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
    expect(dataGridSource.match(/message\.info\(translateDataGrid\('data_grid\.message\.no_copyable_rows'\)\)/g) ?? []).toHaveLength(3);

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
        tableName={rawTableName}
        ddlViewLayout="bottom"
        ddlLoading={false}
        ddlText={rawDdl}
        darkMode={false}
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
      '字段显示',
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
      '输入要填充的值',
      '复制 DDL',
      '正在加载 DDL...',
      '>保存<',
      '点击表格中的单元格以预览完整数据',
    ].forEach((literal) => {
    });
  });

  it('localizes V2 metadata fields and ER view chrome while preserving raw metadata values', () => {
    const translate = (key: string, params?: Record<string, unknown>) => {
      const labels: Record<string, string> = {
        'data_grid.table_fallback.query_result': 'Query fallback',
        'data_grid.metadata_view.fields_badge': 'Meta fields',
        'data_grid.metadata_view.er_table_badge': 'Entity table',
        'data_grid.metadata_view.er_field_badge': 'Entity field',
        'data_grid.metadata_view.field_count': `${params?.count} localized fields`,
        'data_grid.metadata_view.column_name': 'Localized name',
        'data_grid.metadata_view.column_type': 'Localized type',
        'data_grid.metadata_view.default_value': 'Localized default',
        'data_grid.metadata_view.comment': 'Localized comment',
      };
      return labels[key] ?? `missing:${key}`;
    };

    const fieldsMarkup = renderToStaticMarkup(
      <DataGridV2FieldsView
        translate={translate}
        tableName="raw_users"
        displayOutputColumnNames={['raw_id', 'raw_name']}
        pkColumns={['raw_id']}
        columnMetaMap={{
          raw_id: { type: 'bigint', comment: 'raw primary key' },
          raw_name: { type: 'varchar(64)', comment: 'raw display name' },
        }}
        columnMetaMapByLowerName={{}}
      />,
    );

    expect(fieldsMarkup).toContain('Meta fields');
    expect(fieldsMarkup).toContain('2 localized fields');
    expect(fieldsMarkup).toContain('Localized name');
    expect(fieldsMarkup).toContain('Localized type');
    expect(fieldsMarkup).toContain('Localized default');
    expect(fieldsMarkup).toContain('Localized comment');
    expect(fieldsMarkup).toContain('raw_users');
    expect(fieldsMarkup).toContain('raw_id');
    expect(fieldsMarkup).toContain('varchar(64)');
    expect(fieldsMarkup).toContain('raw display name');
    expect(fieldsMarkup).toContain('PK');
    expect(fieldsMarkup).not.toContain('FIELDS');
    expect(fieldsMarkup).not.toContain('名称');
    expect(fieldsMarkup).not.toContain('默认值');

    const erMarkup = renderToStaticMarkup(
      <DataGridV2ErView
        translate={translate}
        displayOutputColumnNames={['raw_name']}
        columnMetaMap={{ raw_name: { type: 'varchar(64)', comment: 'raw display name' } }}
        columnMetaMapByLowerName={{}}
      />,
    );

    expect(erMarkup).toContain('Entity table');
    expect(erMarkup).toContain('Entity field');
    expect(erMarkup).toContain('Query fallback');
    expect(erMarkup).toContain('1 localized fields');
    expect(erMarkup).toContain('raw_name');
    expect(erMarkup).toContain('varchar(64)');
    expect(erMarkup).not.toContain('TABLE');
    expect(erMarkup).not.toContain('FIELD');
    expect(erMarkup).not.toContain('1 fields');
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

  it('renders detached DataGrid chrome with translated labels instead of i18n keys', () => {
    const translate = (key: string, params?: Record<string, unknown>): string => {
      const values: Record<string, string> = {
        'data_grid.page_find.tooltip': 'Find only this page',
        'data_grid.page_find.placeholder': 'Find current page',
        'data_grid.page_find.previous': 'Previous find match',
        'data_grid.page_find.next': 'Next find match',
        'data_grid.page_find.summary': `${params?.occurrences} hits / ${params?.cells} cells`,
        'data_grid.pagination.result_set': 'Result set label',
        'data_grid.pagination.page_size_aria': 'Rows per page label',
        'data_grid.pagination.page_size_option': `${params?.count} rows per page`,
        'data_grid.pagination.first_page': 'First page label',
        'data_grid.pagination.last_page': 'Last page label',
        'data_grid.pagination.jump_label': 'Jump label',
        'data_grid.pagination.jump_aria': 'Jump page aria',
        'data_grid.pagination.jump_action': 'Go action',
        'data_grid.view.result_view': 'Result view label',
        'data_grid.view.table': 'Table label',
        'data_grid.view.text': 'Text label',
        'data_grid.secondary.data_preview': 'Data preview label',
        'data_grid.column_settings.field_info': 'Field info label',
        'data_grid.secondary.view_ddl': 'View DDL label',
        'data_grid.secondary.er_diagram': 'ER diagram label',
        'data_grid.secondary.column_display': 'Column display label',
        'data_grid.secondary.jump_column': 'Jump column label',
        'data_grid.record_view.empty': 'No rows label',
        'data_grid.record_view.json_record_count': `${params?.count} JSON rows label`,
        'data_grid.record_view.edit_json': 'Edit JSON label',
        'data_grid.record_view.back_to_table': 'Back to table label',
        'data_grid.record_view.field': 'Field label',
        'data_grid.record_view.value': 'Value label',
        'data_grid.record_view.comment': 'Comment label',
        'data_grid.record_view.type': 'Type label',
        'data_grid.record_view.copy_value': 'Copy value label',
        'data_grid.record_view.previous': 'Previous label',
        'data_grid.record_view.next': 'Next label',
        'data_grid.record_view.record_position': `Record label ${params?.current} of ${params?.total}`,
        'data_grid.record_view.edit_current': 'Edit current label',
        'data_grid.record_view.field_or_comment_search_placeholder': 'Search field or comment label',
        'data_grid.column_quick_find.placeholder': 'Search field label',
        'data_grid.column.type_tooltip': `TYPE ${params?.type}`,
        'data_grid.column.comment_tooltip': `COMMENT ${params?.comment}`,
        'data_grid.preview_panel.no_cell_title': 'Select cell title',
        'data_grid.preview_panel.no_cell_description': 'Select cell description',
        'data_grid.json_editor.format': 'Format JSON label',
        'common.close': 'Close find',
        'common.save': 'Save label',
      };
      return values[key] ?? key;
    };

    const pageFindMarkup = renderToStaticMarkup(
      <DataGridPageFind
        isV2Ui
        darkMode={false}
        pageFindText="al"
        normalizedPageFindText="al"
        hasMatches
        activePageFindPosition={1}
        matchCount={3}
        occurrenceCount={4}
        matchedCellCount={2}
        translate={translate}
        onPageFindTextChange={() => {}}
        onCancel={() => {}}
        onNavigatePrevious={() => {}}
        onNavigateNext={() => {}}
      />,
    );
    expect(pageFindMarkup).toContain('placeholder="Find current page"');
    expect(pageFindMarkup).toContain('1 / 3');
    expect(pageFindMarkup).toContain('4 hits / 2 cells');
    expect(pageFindMarkup).toContain('aria-label="Previous find match"');
    expect(pageFindMarkup).toContain('aria-label="Next find match"');
    expect(pageFindMarkup).toContain('aria-label="Close find"');
    expect(pageFindMarkup).not.toContain('data_grid.page_find');

    const resultViewMarkup = renderToStaticMarkup(
      <DataGridResultViewSwitcher
        isV2Ui={false}
        darkMode={false}
        viewMode="table"
        translate={translate}
        onViewModeChange={() => {}}
      />,
    );

    const paginationMarkup = renderToStaticMarkup(
      <DataGridPaginationBar
        isV2Ui={false}
        pagination={{
          current: 1,
          pageSize: 100,
          total: 24,
        }}
        paginationV2SummaryText="24 rows"
        paginationSummaryText="24 rows"
        paginationControlTotal={24}
        paginationTotalPages={2}
        paginationPageText="Page 1"
        paginationPageSizeOptions={['100', '200']}
        showKnownPageCount
        translate={translate}
        onPageChange={() => {}}
        onPageSizeChange={() => {}}
        onV2PageStep={() => {}}
      />,
    );
    expect(paginationMarkup).toContain('Result set label');
    expect(paginationMarkup).toContain('First page label');
    expect(paginationMarkup).toContain('Last page label');
    expect(paginationMarkup).toContain('Jump label');
    expect(paginationMarkup).toContain('Jump page aria');
    expect(paginationMarkup).toContain('Go action');
    expect(paginationMarkup).toContain('100 rows per page');
    expect(paginationMarkup).not.toContain('data_grid.pagination');

    const secondaryMarkup = renderToStaticMarkup(
      <DataGridSecondaryActions
        isV2Ui
        canViewDdl
        canOpenObjectDesigner={false}
        viewMode="table"
        ddlLoading={false}
        showColumnComment={false}
        showColumnType={false}
        resultViewSwitcher={<span>view switcher</span>}
        columnInfoSettingContent={<span>column settings</span>}
        columnQuickFindContent={<span>quick find</span>}
        pageFindContent={<span>page find</span>}
        paginationContent={<span>pagination</span>}
        translate={translate}
        onViewModeChange={() => {}}
        dataPanelOpen={false}
        isTableSurfaceActive
        onToggleDataPanel={() => {}}
        onOpenTableDdl={() => {}}
      />,
    );
    expect(secondaryMarkup).toContain('Data preview label');
    expect(secondaryMarkup).toContain('Field info label');
    expect(secondaryMarkup).toContain('View DDL label');
    expect(secondaryMarkup).toContain('ER diagram label');
    expect(secondaryMarkup).toContain('Column display label');
    expect(secondaryMarkup).toContain('Jump column label');
    expect(secondaryMarkup).not.toContain('page find');
    expect(secondaryMarkup).not.toContain('gn-v2-data-grid-status-center');
    expect(secondaryMarkup).not.toContain('data_grid.secondary');

    const jsonRecordMarkup = renderToStaticMarkup(
      <DataGridJsonView
        darkMode={false}
        rowCount={5}
        canModifyData
        jsonViewText="[]"
        translate={translate}
        onOpenJsonEditor={() => {}}
        onReturnToTable={() => {}}
      />,
    );
    expect(jsonRecordMarkup).toContain('5 JSON rows label');
    expect(jsonRecordMarkup).toContain('Edit JSON label');
    expect(jsonRecordMarkup).toContain('Back to table label');
    expect(jsonRecordMarkup).toContain('Search field label');
    expect(jsonRecordMarkup).toContain('data-grid-record-field-search="true"');
    expect(jsonRecordMarkup).toContain('data-grid-record-field-search--navigation');
    expect(jsonRecordMarkup).toContain('data-grid-record-field-search-navigation');
    expect(jsonRecordMarkup).not.toContain('data_grid.record_view');

    const textRecordMarkup = renderToStaticMarkup(
      <DataGridTextView
        darkMode={false}
        rowCount={2}
        textRecordIndex={0}
        canModifyData
        currentTextRow={{ raw_sql: 'GitHub release HTTP 500 checksum abc123' }}
        displayOutputColumnNames={['raw_sql']}
        columnMetaMap={{ raw_sql: { type: 'varchar(128)', comment: 'SQL text payload' } }}
        columnMetaMapByLowerName={{}}
        showColumnType
        showColumnComment
        translate={translate}
        onPrev={() => {}}
        onNext={() => {}}
        onEditCurrent={() => {}}
        onReturnToTable={() => {}}
        formatTextViewValue={(value) => String(value)}
      />,
    );
    expect(textRecordMarkup).toContain('Previous label');
    expect(textRecordMarkup).toContain('Next label');
    expect(textRecordMarkup).toContain('Record label 1 of 2');
    expect(textRecordMarkup).toContain('Edit current label');
    expect(textRecordMarkup).toContain('Back to table label');
    expect(textRecordMarkup).toContain('Search field or comment label');
    expect(textRecordMarkup).toContain('data-grid-record-field-search="true"');
    expect(textRecordMarkup).toContain('Field label');
    expect(textRecordMarkup).toContain('Value label');
    expect(textRecordMarkup).toContain('Comment label');
    expect(textRecordMarkup).toContain('Type label');
    expect(textRecordMarkup).toContain('data-grid-text-view-header="field"');
    expect(textRecordMarkup).toContain('data-grid-text-view-header="value"');
    expect(textRecordMarkup.indexOf('data-grid-text-view-header="field"'))
      .toBeLessThan(textRecordMarkup.indexOf('data-grid-text-view-header="type"'));
    expect(textRecordMarkup.indexOf('data-grid-text-view-header="type"'))
      .toBeLessThan(textRecordMarkup.indexOf('data-grid-text-view-header="comment"'));
    expect(textRecordMarkup.indexOf('data-grid-text-view-header="comment"'))
      .toBeLessThan(textRecordMarkup.indexOf('data-grid-text-view-header="value"'));
    expect(textRecordMarkup).toContain('data-grid-text-value-copy="true"');
    expect(textRecordMarkup).toContain('aria-label="Copy value label"');
    expect(textRecordMarkup).toContain('grid-template-columns:180px 140px 240px minmax(260px, 1fr)');
    expect(textRecordMarkup).toContain('text-overflow:ellipsis');
    expect(textRecordMarkup).toContain('raw_sql');
    expect(textRecordMarkup).toContain('varchar(128)');
    expect(textRecordMarkup).toContain('SQL text payload');
    expect(textRecordMarkup).toContain('GitHub release HTTP 500 checksum abc123');
    expect(textRecordMarkup).not.toContain('data_grid.record_view');

    const recordSearchCss = buildDataGridCssText({
      darkMode: false,
      densityParams: { dataFontSize: 12 },
      gridId: 'record-grid',
    });
    expect(recordSearchCss).toContain('.record-grid .data-grid-record-field-search-navigation.ant-btn');
    expect(recordSearchCss).toContain('.record-grid .data-grid-record-field-search .ant-input-affix-wrapper-focused');
    expect(recordSearchCss).toContain('.record-grid .data-grid-record-field-search-autocomplete.ant-select-focused .ant-select-selector');
    expect(recordSearchCss).toContain('.record-grid .data-grid-record-field-search .ant-input::placeholder');
    expect(recordSearchCss).toContain('font-size: 12px !important;');
    expect(recordSearchCss).toContain('height: 24px !important;');
    expect(recordSearchCss).toContain('box-shadow: none !important;');

    const hiddenTextRecordMarkup = renderToStaticMarkup(
      <DataGridTextView
        darkMode={false}
        rowCount={1}
        textRecordIndex={0}
        canModifyData={false}
        currentTextRow={{ raw_sql: 'select 1' }}
        displayOutputColumnNames={['raw_sql']}
        columnMetaMap={{ raw_sql: { type: 'varchar(128)', comment: 'SQL text payload' } }}
        columnMetaMapByLowerName={{}}
        showColumnType={false}
        showColumnComment={false}
        translate={translate}
        onPrev={() => {}}
        onNext={() => {}}
        onEditCurrent={() => {}}
        onReturnToTable={() => {}}
        formatTextViewValue={(value) => String(value)}
      />,
    );
    expect(hiddenTextRecordMarkup).not.toContain('TYPE varchar(128)');
    expect(hiddenTextRecordMarkup).not.toContain('COMMENT SQL text payload');

    const previewWithCellMarkup = renderToStaticMarkup(
      <DataGridPreviewPanel
        visible
        isTableSurfaceActive
        darkMode={false}
        focusedCellInfo={{ dataIndex: 'raw_sql' }}
        dataPanelIsJson
        focusedCellWritable
        dataPanelValue='{"raw":true}'
        columnMetaMap={{ raw_sql: { type: 'varchar(64)' } }}
        columnMetaMapByLowerName={{}}
        translate={translate}
        onFormatJson={() => {}}
        onSave={() => {}}
        onValueChange={() => {}}
        onDirtyChange={() => {}}
        isDirtyComparedToOriginal={() => false}
      />,
    );
    expect(previewWithCellMarkup).toContain('raw_sql');
    expect(previewWithCellMarkup).toContain('varchar(64)');
    expect(previewWithCellMarkup).toContain('Format JSON label');
    expect(previewWithCellMarkup).toContain('Save label');
    expect(previewWithCellMarkup).not.toContain('data_grid.preview_panel');

    const emptyPreviewMarkup = renderToStaticMarkup(
      <DataGridPreviewPanel
        visible
        isTableSurfaceActive
        darkMode={false}
        focusedCellInfo={null}
        dataPanelIsJson={false}
        focusedCellWritable={false}
        dataPanelValue=""
        columnMetaMap={{}}
        columnMetaMapByLowerName={{}}
        translate={translate}
        onFormatJson={() => {}}
        onSave={() => {}}
        onValueChange={() => {}}
        onDirtyChange={() => {}}
        isDirtyComparedToOriginal={() => false}
      />,
    );
    expect(emptyPreviewMarkup).toContain('Select cell title');
    expect(emptyPreviewMarkup).toContain('Select cell description');
    expect(emptyPreviewMarkup).not.toContain('data_grid.preview_panel');
  });

  it('keeps unknown-total pagination sequential while still allowing direct page jumps', () => {
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
          current: 3,
          pageSize: 100,
          total: 400,
          totalKnown: false,
        }}
        onPageChange={() => {}}
      />,
    );

    expect(markup).toContain('第 3 页');
    expect(markup).not.toContain('<strong>3</strong><span>/</span><span>4</span>');
    expect(markup).toContain('data-grid-pagination-jump="true"');
    expect(markup).toContain('跳页');
  });

  it('keeps legacy unknown-total pagination sequential while still allowing direct page jumps', () => {
    const previousUiVersion = mockStoreState.uiVersion;
    mockStoreState.uiVersion = 'legacy';

    try {
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
            current: 3,
            pageSize: 100,
            total: 400,
            totalKnown: false,
          }}
          onPageChange={() => {}}
        />,
      );

      expect(markup).toContain('第 3 页');
      expect(markup).toContain('data-grid-pagination-sequential="true"');
      expect(markup).not.toContain('class="ant-pagination');
      expect(markup).toContain('data-grid-pagination-jump="true"');
      expect(markup).toContain('跳页');
    } finally {
      mockStoreState.uiVersion = previousUiVersion;
    }
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
      '单元格编辑',
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
      '字段显示',
    ].forEach((label) => {
      expect(getButtonBody(label)).not.toContain(label);
    });
    expect(markup).toContain('aria-haspopup="menu"');
    expect(markup).toContain('aria-expanded="false"');

    const resultViewMarkup = renderToStaticMarkup(
      <DataGridResultViewSwitcher
        isV2Ui
        darkMode={false}
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
      css.indexOf('body[data-ui-version="v2"] .gn-v2-data-grid .gn-v2-commit-button:disabled {'),
    );
    const commitDisabledCss = css.slice(
      css.indexOf('body[data-ui-version="v2"] .gn-v2-data-grid .gn-v2-commit-button:disabled {'),
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
    expect(commitBaseCss).toContain('background: var(--gn-accent) !important;');
    expect(commitBaseCss).toContain('color: var(--gn-on-accent, #fff) !important;');
    expect(commitInteractiveCss).toContain('box-shadow:');
    expect(commitDisabledCss).toContain('background: var(--gn-bg-active) !important;');
    expect(commitDisabledCss).toContain('color: var(--gn-fg-5) !important;');
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

  it('renders a non-data row number column when enabled', () => {
    const previousLanguage = getCurrentLanguage();
    setCurrentLanguage('zh-CN');

    try {
      const markup = renderToStaticMarkup(
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
          tableName="events"
          dbName="main"
          connectionId="conn-1"
          readOnly
          showRowNumberColumn
          pagination={{
            current: 2,
            pageSize: 50,
            total: 51,
          }}
          onPageChange={() => {}}
        />,
      );

      expect(markup).toContain('aria-label="行号"');
      expect(markup).toContain('<span aria-label="行号">#</span>');
      expect(markup).not.toContain('>行号<');
      expect(markup).toContain('data-grid-row-number-title="true"');
      expect(markup).toContain('data-grid-column-title-single-line="true"');
      expect(markup).toContain('justify-content:center');
      expect(markup).toContain('align-items:center');
      expect(markup).toContain('min-height:var(--gonavi-header-min-height, 40px)');
      expect(markup).toContain('text-align:center');
      expect(markup).toContain('padding:0');
      expect(markup).toContain('vertical-align:middle');
      expect(markup).toContain('data-grid-row-number="true"');
      expect(markup).toContain('data-grid-row-number-action="true"');
      expect(markup).toContain('display:flex');
      expect(markup).toContain('width:100%');
      expect(markup).toContain('height:100%');
      expect(markup).toContain('width:36');
      // ant Table fixed 列会渲染 fix 相关 class
      expect(markup.includes('ant-table-cell-fix') || markup.includes('fixed')).toBe(true);
      expect(markup).toContain('51');
    } finally {
      setCurrentLanguage(previousLanguage);
    }
  });

  it('follows appearance.showDataTableRowNumber when prop is omitted', () => {
    const previousLanguage = getCurrentLanguage();
    setCurrentLanguage('zh-CN');

    try {
      const withDefault = renderToStaticMarkup(
        <DataGrid
          data={[{ __gonavi_row_key__: 'row-1', id: 1 }]}
          columnNames={['id']}
          loading={false}
          tableName="events"
          dbName="main"
          connectionId="conn-1"
          readOnly
        />,
      );
      expect(withDefault).toContain('data-grid-row-number="true"');

      const hidden = renderToStaticMarkup(
        <DataGrid
          data={[{ __gonavi_row_key__: 'row-1', id: 1 }]}
          columnNames={['id']}
          loading={false}
          tableName="events"
          dbName="main"
          connectionId="conn-1"
          readOnly
          showRowNumberColumn={false}
        />,
      );
      expect(hidden).not.toContain('data-grid-row-number="true"');
    } finally {
      setCurrentLanguage(previousLanguage);
    }
  });

  it('renders a cell-level undo action in the v2 context menu for modified cells', () => {
    const markup = renderToStaticMarkup(
      <V2CellContextMenuView
        fieldName="status"
        tableName="orders"
        rowLabel="row 1"
        canModifyData
        canUndoCellChange
      />,
    );

    expect(markup).toContain(enUndoCellChangeLabel);
  });

  it('preserves fractional seconds when rendering datetime values', () => {
    expect(formatCellDisplayText('2026-05-10T09:12:33.456+08:00')).toBe('2026-05-10 09:12:33.456');
  });

  it('collapses OceanBase Oracle DATE midnight values to date-only text', () => {
    const oceanBaseOracleConfig = {
      type: 'oceanbase',
      oceanBaseProtocol: 'oracle',
    } as any;

    expect(formatCellDisplayText('2026-06-16T00:00:00Z', 'DATE', oceanBaseOracleConfig)).toBe('2026-06-16');
    expect(formatCellDisplayText('2026-06-16 00:00:00', 'DATE', oceanBaseOracleConfig)).toBe('2026-06-16');
    expect(formatCellDisplayText('2026-06-16T13:14:15Z', 'DATE', oceanBaseOracleConfig)).toBe('2026-06-16 13:14:15');
    expect(formatCellDisplayText('2026-06-16T00:00:00Z', 'DATE', { type: 'oracle' } as any)).toBe('2026-06-16 00:00:00');
  });

  it('renders bit column hex values as decimal flags', () => {
    expect(formatCellDisplayText('0x00', 'bit(1)')).toBe('0');
    expect(formatCellDisplayText('0x01', 'bit(1)')).toBe('1');
    expect(formatCellDisplayText('0x02', 'bit varying(8)')).toBe('2');
    expect(formatCellDisplayText('0x01', 'bytea')).toBe('0x01');
  });

  it('resolves the field name copied from the cell context menu', () => {
    expect(resolveContextMenuFieldName('created_at', '创建时间')).toBe('created_at');
    expect(resolveContextMenuFieldName('', 'fallback_name')).toBe('fallback_name');
  });

  it('uses contains as the default filter operator for string-like columns', () => {
    expect(resolveDefaultGridFilterOperator('varchar(255)')).toBe('CONTAINS');
    expect(resolveDefaultGridFilterOperator('character varying(64)')).toBe('CONTAINS');
    expect(resolveDefaultGridFilterOperator('nvarchar(max)')).toBe('CONTAINS');
    expect(resolveDefaultGridFilterOperator('Nullable(LowCardinality(String))')).toBe('CONTAINS');
    expect(resolveDefaultGridFilterOperator('text')).toBe('CONTAINS');

    expect(resolveDefaultGridFilterOperator('int')).toBe('=');
    expect(resolveDefaultGridFilterOperator('decimal(10,2)')).toBe('=');
    expect(resolveDefaultGridFilterOperator('datetime')).toBe('=');
  });

  it('updates only untouched default filter operators when the column changes', () => {
    expect(resolveNextGridFilterOperatorForColumnChange({
      currentOperator: '=',
      previousColumnType: 'int',
      nextColumnType: 'varchar(64)',
    })).toBe('CONTAINS');

    expect(resolveNextGridFilterOperatorForColumnChange({
      currentOperator: 'CONTAINS',
      previousColumnType: 'varchar(64)',
      nextColumnType: 'bigint',
    })).toBe('=');

    expect(resolveNextGridFilterOperatorForColumnChange({
      currentOperator: 'STARTS_WITH',
      previousColumnType: 'varchar(64)',
      nextColumnType: 'bigint',
    })).toBe('STARTS_WITH');
  });

  it('keeps full field names in filter field select options', () => {
    const [option] = buildGridFieldSelectOptions(['mes_manufacture_order_really_long_column_name']);

    expect(option).toEqual({
      value: 'mes_manufacture_order_really_long_column_name',
      label: 'mes_manufacture_order_really_long_column_name',
      title: 'mes_manufacture_order_really_long_column_name',
    });
  });

  it('renders a DDL action whenever a physical table context is available', () => {
    const tableMarkup = renderDataGridWithI18n(
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
      />,
    );

    expect(tableMarkup).toContain('data-grid-ddl-action="true"');
    expect(tableMarkup).toContain('查看 DDL');
    expect(tableMarkup).toContain(zhObjectDesignLabel);
    expect(tableMarkup).not.toContain('data-grid-locate-sidebar-action="true"');

    const schemaTableMarkup = renderDataGridWithI18n(
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
        tableName="public.users"
        dbName=""
        connectionId="conn-1"
      />,
    );

    expect(schemaTableMarkup).toContain('data-grid-ddl-action="true"');
    expect(schemaTableMarkup).toContain('查看 DDL');
    expect(schemaTableMarkup).toContain(zhObjectDesignLabel);
    expect(schemaTableMarkup).not.toContain('data-grid-page-find="true"');

    const queryMarkup = renderDataGridWithI18n(
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
        ddlDbName="main"
        ddlTableName="users"
        connectionId="conn-1"
        exportScope="queryResult"
      />,
    );

    expect(queryMarkup).toContain('data-grid-ddl-action="true"');
    expect(queryMarkup).toContain('查看 DDL');
    expect(queryMarkup).toContain('字段信息');
    expect(queryMarkup).not.toContain(zhObjectDesignLabel);

    const ambiguousQueryMarkup = renderDataGridWithI18n(
      <DataGrid
        data={[{ __gonavi_row_key__: 'row-1', id: 1 }]}
        columnNames={['id']}
        loading={false}
        tableName="users"
        dbName="main"
        connectionId="conn-1"
        exportScope="queryResult"
      />,
    );

    expect(ambiguousQueryMarkup).not.toContain('data-grid-ddl-action="true"');

    const derivedQueryMarkup = renderDataGridWithI18n(
      <DataGrid
        data={[{ __gonavi_row_key__: 'row-1', total: 2 }]}
        columnNames={['total']}
        loading={false}
        dbName="main"
        connectionId="conn-1"
        exportScope="queryResult"
      />,
    );

    expect(derivedQueryMarkup).not.toContain('data-grid-ddl-action="true"');
  });

  it('keeps row copy and paste as context menu actions instead of toolbar buttons', () => {
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
        pkColumns={['id']}
      />,
    );

    expect(markup).not.toContain('data-grid-copy-row-action="true"');
    expect(markup).not.toContain('data-grid-paste-row-action="true"');
  });

  it('renders a clickable copy action for aggregate query results', () => {
    const markup = renderDataGridWithI18n(
      <DataGrid
        data={[
          {
            __gonavi_row_key__: 'row-1',
            'COUNT(*)': 12,
          },
        ]}
        columnNames={['COUNT(*)']}
        loading={false}
        exportScope="queryResult"
      />,
    );

    expect(markup).toContain('data-grid-query-copy-action="true"');
    expect(markup).not.toMatch(/data-grid-query-copy-action="true"[^>]*disabled/);
    expect(markup).toContain('复制');
    expect(markup).toContain('aria-haspopup="menu"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup.match(/data-grid-query-copy-action="true"/g)?.length).toBe(1);
  });

  it('renders a manual query condition editor when table filters are visible', () => {
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
        showFilter
        quickWhereCondition="name like 'a%'"
        onApplyQuickWhereCondition={() => {}}
      />,
    );

    expect(markup).toContain('data-grid-quick-where="true"');
    expect(markup).toContain('data-grid-quick-where-input="true"');
    expect(markup).toContain('data-grid-quick-where-label="true"');
    expect(markup).toContain('手动查询条件');
    const manualConditionLabel = markup.match(/<span data-grid-quick-where-label="true"([^>]*)>/)?.[1] ?? '';
    expect(manualConditionLabel).not.toContain('border');
    expect(manualConditionLabel).not.toContain('background');
    const englishMarkup = renderDataGridWithI18n(
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
        showFilter
        quickWhereCondition="name like 'a%'"
        onApplyQuickWhereCondition={() => {}}
      />,
      { preference: 'en-US' },
    );

    expect(englishMarkup).toContain('Manual query condition');
    expect(englishMarkup).toContain('Enter a query condition');
    expect(englishMarkup).not.toContain('Enter the condition after WHERE');
    expect(englishMarkup).not.toContain('输入查询条件');
  });

  it('keeps quick WHERE input clipboard editing isolated from grid shortcuts', () => {
    const source = readDataGridSource();
    const filterHookSource = readFileSync(new URL('./useDataGridFilters.tsx', import.meta.url), 'utf8');
    const css = readV2ThemeCss();
    expect(css).toContain('[data-grid-quick-where-input="true"]');
    expect(css).toContain('font-size: var(--gn-font-size, 14px) !important;');
    expect(css).toContain('user-select: text !important;');
  });

  it('keeps V2 filter controls on the query workbench theme surface', () => {
    const css = readV2ThemeCss();
    const toolbarCss = css.slice(
      css.indexOf('body[data-ui-version="v2"] .gn-v2-data-grid-toolbar-frame'),
      css.indexOf('body[data-ui-version="v2"] .gn-v2-data-grid-toolbar-title'),
    );
    const filterCss = css.slice(
      css.indexOf('body[data-ui-version="v2"] .gn-v2-smart-filter-panel'),
      css.indexOf('body[data-ui-version="v2"] .gn-v2-data-grid-table-shell'),
    ).replace(/\r\n/g, '\n');
    const tableSurfaceCss = css.slice(
      css.indexOf('body[data-ui-version="v2"] .gn-v2-data-grid-table-shell'),
      css.indexOf('body[data-ui-version="v2"] .gn-v2-data-grid .ant-table-thead'),
    );

    expect(toolbarCss).toContain('background: var(--gn-query-workbench-bg, var(--gn-bg-panel-2)) !important;');
    expect(filterCss).toContain('background: var(--gn-query-workbench-bg, var(--gn-bg-panel-2)) !important;');
    expect(filterCss).toContain('padding-inline: 0 !important;');
    expect(filterCss).toContain('.gn-v2-smart-filter-manual-input');
    expect(filterCss).toContain('max-width: 680px !important;');
    expect(filterCss).toContain('.gn-v2-smart-filter-panel .ant-select-selector');
    expect(filterCss).toContain('.gn-v2-smart-filter-panel .ant-input-affix-wrapper');
    expect(filterCss).not.toContain('background: var(--gn-bg-input)');
    expect(filterCss).toContain('[data-grid-quick-where="true"] {\n  min-height: 38px;\n  padding-inline: 0 !important;\n  margin-bottom: 8px !important;\n  border: 0 !important;\n  border-radius: 0 !important;');
    expect(tableSurfaceCss).toContain('background: var(--gn-query-workbench-bg, var(--gn-bg-panel-2)) !important;');
    expect(tableSurfaceCss).toContain('.gn-v2-data-grid .ant-table-container');
    expect(tableSurfaceCss).toContain('.gn-v2-data-grid .ant-table-tbody-virtual-holder');
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
