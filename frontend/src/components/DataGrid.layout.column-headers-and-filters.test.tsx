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
import { DataGridV2ErView, DataGridV2FieldsView } from './DataGridV2MetadataViews';
import { I18nProvider } from '../i18n/provider';
import { getCurrentLanguage, setCurrentLanguage, type LanguagePreference } from '../i18n';
import { V2CellContextMenuView } from './V2TableContextMenu';
import { cloneShortcutOptions, DEFAULT_SHORTCUT_OPTIONS } from '../utils/shortcuts';

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

const enUsCatalog = JSON.parse(
  readFileSync(new URL('../../../shared/i18n/en-US.json', import.meta.url), 'utf8'),
) as Record<string, string>;

const zhObjectDesignLabel = zhCnCatalog['data_grid.secondary.object_design'];

const zhRowNumberHint = zhCnCatalog['data_grid.row_number.double_click_to_view'];

const enUndoCellChangeLabel = enUsCatalog['data_grid.context_menu.undo_cell_change'];

describe('DataGrid layout', () => {
  it('keeps the V2 column resize hit target visually transparent', () => {
    const css = readV2ThemeCss();

    expect(css).toMatch(
      /\.gn-v2-data-grid \.react-resizable-handle\s*\{[^}]*background-image:\s*none\s*!important;/s,
    );
    expect(css).not.toContain('.react-resizable-handle::after');
    expect(css).not.toContain('.react-resizable-handle:hover::after');
  });

  it('keeps DataGrid rows unchanged on hover', () => {
    const css = buildDataGridCssText({
      darkMode: false,
      densityParams: { dataFontSize: 12 },
      gridId: 'hover-grid',
      rowAddedBg: 'added-bg',
      rowAddedHover: 'added-hover',
      rowModBg: 'modified-bg',
      rowModHover: 'modified-hover',
    });

    expect(css).toContain(
      '.hover-grid.data-grid-root .ant-table-tbody .ant-table-row:hover > .ant-table-cell { background-color: transparent !important; }',
    );
    expect(css).not.toContain(
      '.hover-grid.data-grid-root .ant-table-tbody .ant-table-row:hover > .ant-table-cell { background-color: var(--gn-bg-hover',
    );
    expect(css).not.toContain('rgba(34, 197, 94, 0.18)');
    expect(css).not.toContain('added-hover');
    expect(css).not.toContain('modified-hover');
  });

  it('keeps fixed row controls opaque when their row is hovered or selected', () => {
    const css = buildDataGridCssText({
      darkMode: false,
      densityParams: { dataFontSize: 12 },
      gridId: 'row-number-state-grid',
      bgContent: '#ffffff',
    });

    const transparentHover = css.indexOf(
      '.row-number-state-grid.data-grid-root .ant-table-tbody .ant-table-row:hover > .ant-table-cell',
    );
    expect(transparentHover).toBeGreaterThanOrEqual(0);

    const fixedRowControl = ':is(.data-grid-row-number-cell, .ant-table-selection-column)';
    const fixedRowControlHoverSelectors = [
      `.row-number-state-grid.data-grid-root .ant-table-tbody-virtual-holder .ant-table-row:hover > .ant-table-cell${fixedRowControl}`,
      `.row-number-state-grid.data-grid-root .ant-table-tbody-virtual .ant-table-row:hover > .ant-table-cell${fixedRowControl}`,
      `.row-number-state-grid.data-grid-root .ant-table-tbody-virtual-holder-inner .ant-table-row:hover > .ant-table-cell${fixedRowControl}`,
      `.row-number-state-grid.data-grid-root .ant-table-tbody > tr:hover > td${fixedRowControl}`,
    ];
    fixedRowControlHoverSelectors.forEach((selector) => {
      const ruleStart = css.indexOf(selector);
      expect(ruleStart).toBeGreaterThan(transparentHover);
      const ruleEnd = css.indexOf('}', ruleStart);
      const rule = css.slice(ruleStart, ruleEnd + 1);
      expect(rule).toContain('background: rgb(from var(--gn-bg-panel-2, #ffffff) r g b / 1) !important;');
    });

    const fixedRowControlSelectedSelectors = [
      `.row-number-state-grid.data-grid-root .ant-table-tbody-virtual-holder .ant-table-row:is(.ant-table-row-selected, .ant-table-row-selected:hover) > .ant-table-cell${fixedRowControl}`,
      `.row-number-state-grid.data-grid-root .ant-table-tbody-virtual .ant-table-row:is(.ant-table-row-selected, .ant-table-row-selected:hover) > .ant-table-cell${fixedRowControl}`,
      `.row-number-state-grid.data-grid-root .ant-table-tbody-virtual-holder-inner .ant-table-row:is(.ant-table-row-selected, .ant-table-row-selected:hover) > .ant-table-cell${fixedRowControl}`,
      `.row-number-state-grid.data-grid-root .ant-table-tbody > tr:is(.ant-table-row-selected, .ant-table-row-selected:hover) > td${fixedRowControl}`,
    ];
    fixedRowControlSelectedSelectors.forEach((selector) => {
      const ruleStart = css.indexOf(selector);
      expect(ruleStart).toBeGreaterThan(transparentHover);
      const ruleEnd = css.indexOf('}', ruleStart);
      const rule = css.slice(ruleStart, ruleEnd + 1);
      expect(rule).toContain('background-color: rgb(from var(--gn-bg-panel, #ffffff) r g b / 1) !important;');
      expect(rule).toContain('background-image: linear-gradient(');
      expect(rule).toContain('var(--gn-bg-selected, rgba(34, 197, 94, 0.14))');
    });
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

  it('paints pending edits across the real table cell without mixing selection color', () => {
    const css = buildDataGridCssText({
      darkMode: false,
      densityParams: { dataFontSize: 12 },
      gridId: 'pending-grid',
    });
    const getRuleBlock = (selector: string) => {
      const start = css.indexOf(selector);
      expect(start).toBeGreaterThanOrEqual(0);
      const end = css.indexOf('}', start);
      expect(end).toBeGreaterThan(start);
      return css.slice(start, end + 1);
    };

    const pendingRule = getRuleBlock(
      '.pending-grid.data-grid-root .ant-table-tbody-virtual-holder .ant-table-row > .ant-table-cell[data-cell-modified="true"]',
    );
    expect(pendingRule).toContain('background-color: var(--gn-bg-panel, #ffffff) !important;');
    expect(pendingRule).toContain('background-image: linear-gradient(');
    expect(pendingRule).toContain('var(--gn-warn-soft, #FFF3B0)');
    expect(pendingRule).not.toContain('background-image: none');

    const selectedPendingRule = getRuleBlock(
      '.pending-grid.data-grid-root .ant-table-tbody-virtual-holder .ant-table-row > .ant-table-cell[data-cell-modified="true"][data-cell-selected="true"]',
    );
    expect(selectedPendingRule).toContain('box-shadow: inset 0 0 0 2px var(--gn-accent, #22c55e) !important;');
    expect(selectedPendingRule).toContain('background-color: var(--gn-bg-panel, #ffffff) !important;');
    expect(selectedPendingRule).toContain('background-image: linear-gradient(');
    expect(selectedPendingRule).toContain('var(--gn-warn-soft, #FFF3B0)');

    const editingRule = getRuleBlock(
      '.pending-grid.gn-v2-data-grid .ant-table-tbody-virtual-holder .ant-table-row > .ant-table-cell[data-cell-editing="true"]',
    );
    expect(editingRule).toContain('box-shadow: inset 0 0 0 2px var(--gn-accent, #22c55e) !important;');

    const fixedEditingRule = getRuleBlock(
      '.pending-grid.gn-v2-data-grid .ant-table-tbody-virtual-holder .ant-table-row > .ant-table-cell.ant-table-cell-fix-left-last[data-cell-editing="true"]',
    );
    expect(fixedEditingRule).toContain(
      'box-shadow: inset 0 0 0 2px var(--gn-accent, #22c55e), 4px 0 6px -2px rgba(15, 23, 42, 0.16) !important;',
    );

    const darkCss = buildDataGridCssText({
      darkMode: true,
      densityParams: { dataFontSize: 12 },
      gridId: 'pending-grid-dark',
    });
    expect(darkCss).toContain('var(--gn-warn-soft, rgba(255, 214, 102, 0.16))');
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

  it('renders detached DataGrid chrome with translated labels instead of i18n keys', () => {
    const translate = (key: string, params?: Record<string, unknown>): string => {
      const values: Record<string, string> = {
        'data_grid.page_find.tooltip': 'Find only this page',
        'data_grid.page_find.placeholder': 'Find current page',
        'data_grid.page_find.previous': 'Previous find match',
        'data_grid.page_find.next': 'Next find match',
        'data_grid.page_find.summary': `${params?.occurrences} hits / ${params?.cells} cells`,
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
        viewMode="table"
        translate={translate}
        onViewModeChange={() => {}}
      />,
    );

    const paginationMarkup = renderToStaticMarkup(
      <DataGridPaginationBar

        pagination={{
          current: 1,
          pageSize: 100,
          total: 24,
        }}
        paginationV2SummaryText="24 rows"


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
    expect(paginationMarkup).toContain('First page label');
    expect(paginationMarkup).toContain('Last page label');
    expect(paginationMarkup).toContain('Jump label');
    expect(paginationMarkup).toContain('Jump page aria');
    expect(paginationMarkup).toContain('Go action');
    expect(paginationMarkup).toContain('100 rows per page');
    expect(paginationMarkup).not.toContain('data_grid.pagination');

    const secondaryMarkup = renderToStaticMarkup(
      <DataGridSecondaryActions

        canViewDdl
        canOpenObjectDesigner={false}
        viewMode="table"
        ddlLoading={false}
        resultViewSwitcher={<span>view switcher</span>}
        columnInfoSettingContent={<span>column settings</span>}
        columnQuickFindContent={<span>quick find</span>}
        paginationContent={<span>pagination</span>}
        translate={translate}
        onViewModeChange={() => {}}
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

  it('maps result toolbar button states without leaking them into the statusbar', () => {
    const css = readV2ThemeCss();
    const baseTokensCss = css.slice(
      css.indexOf('body[data-ui-version="v2"] {'),
      css.indexOf('body[data-ui-version="v2"][data-platform="darwin"] {'),
    );
    const toolbarCss = css.slice(
      css.indexOf('body[data-ui-version="v2"] .gn-v2-data-grid .data-grid-toolbar-scroll {'),
      css.indexOf('body[data-ui-version="v2"] .gn-v2-data-grid .data-grid-toolbar-scroll .ant-btn {'),
    );
    const buttonStateCss = css.slice(
      css.indexOf('body[data-ui-version="v2"] .gn-v2-data-grid .data-grid-toolbar-scroll .ant-btn-default:not('),
      css.indexOf('body[data-ui-version="v2"] .gn-v2-data-grid .gn-v2-data-grid-toolbar-action {'),
    );

    for (const kind of ['button', 'primary']) {
      for (const state of ['', '-hover', '-active', '-disabled']) {
        for (const token of ['fg', 'bg', 'border']) {
          const commonProperty = `--gn-toolbar-${kind}${state}-${token}`;
          const scopedProperty = `--gn-result-toolbar-${kind}${state}-${token}`;
          const clientProperty = `--gn-client-result-toolbar-${kind}${state}-${token}`;
          const actionProperty = kind === 'button'
            ? `--gn-toolbar-action${state}-${token}`
            : `--gn-toolbar-action-primary${state}-${token}`;
          expect(baseTokensCss).toContain(`${commonProperty}:`);
          expect(toolbarCss).toContain(
            `${actionProperty}: var(${clientProperty}, var(${scopedProperty}, var(${commonProperty})))`,
          );
        }
      }
    }

    expect(buttonStateCss).toContain('color: var(--gn-toolbar-action-fg) !important;');
    expect(buttonStateCss).toContain('background: var(--gn-toolbar-action-hover-bg) !important;');
    expect(buttonStateCss).toContain('border-color: var(--gn-toolbar-action-active-border) !important;');
    expect(buttonStateCss).toContain('.ant-btn-default:disabled,');
    expect(buttonStateCss).toContain('background: var(--gn-toolbar-action-disabled-bg) !important;');
    expect(buttonStateCss).toContain('background: var(--gn-toolbar-action-primary-bg) !important;');
    expect(buttonStateCss).toContain('background: var(--gn-toolbar-action-primary-hover-bg) !important;');
    expect(buttonStateCss).toContain('background: var(--gn-toolbar-action-primary-active-bg) !important;');
    expect(buttonStateCss).toContain('.ant-btn-primary:not(.gn-v2-commit-button):disabled,');
    expect(buttonStateCss).toContain('color: var(--gn-toolbar-action-primary-disabled-fg) !important;');
    expect(buttonStateCss).not.toContain('.gn-v2-data-grid-statusbar');
  });

  it('lets result-scoped tokens override semantic actions without losing danger, accent or info fallbacks', () => {
    const css = readV2ThemeCss();
    const buttonStateCss = css.slice(
      css.indexOf('body[data-ui-version="v2"] .gn-v2-data-grid .data-grid-toolbar-scroll .ant-btn-default:not('),
      css.indexOf('body[data-ui-version="v2"] .gn-v2-data-grid .gn-v2-data-grid-toolbar-action {'),
    );
    const commitCss = css.slice(
      css.indexOf('body[data-ui-version="v2"] .gn-v2-data-grid .gn-v2-commit-button {'),
      css.indexOf('body[data-ui-version="v2"] .gn-v2-data-grid .gn-v2-commit-button .gn-v2-toolbar-kbd {'),
    );
    const insightCss = css.slice(
      css.indexOf('body[data-ui-version="v2"] .gn-v2-data-grid .gn-v2-ai-insight-button {'),
      css.indexOf('body[data-ui-version="v2"] .gn-v2-data-grid .gn-v2-ai-insight-button .gn-v2-toolbar-kbd {'),
    );

    expect(buttonStateCss).toContain(
      'color: var(--gn-client-result-toolbar-button-fg, var(--gn-result-toolbar-button-fg, var(--gn-danger))) !important;',
    );
    expect(buttonStateCss).toContain(
      'background: var(--gn-client-result-toolbar-button-bg, var(--gn-result-toolbar-button-bg, var(--gn-toolbar-action-bg))) !important;',
    );
    expect(buttonStateCss).toContain(
      'color: var(--gn-client-result-toolbar-button-hover-fg, var(--gn-result-toolbar-button-hover-fg, var(--gn-danger))) !important;',
    );
    expect(buttonStateCss).toContain(
      'background: var(--gn-client-result-toolbar-button-active-bg, var(--gn-result-toolbar-button-active-bg, var(--gn-toolbar-action-active-bg))) !important;',
    );

    expect(commitCss).toContain(
      'background: var(--gn-client-result-toolbar-primary-bg, var(--gn-result-toolbar-primary-bg, var(--gn-accent))) !important;',
    );
    expect(commitCss).toContain(
      'background: var(--gn-client-result-toolbar-primary-hover-bg, var(--gn-result-toolbar-primary-hover-bg, var(--gn-accent-hover, var(--gn-accent-2)))) !important;',
    );
    expect(commitCss).toContain(
      'background: var(--gn-client-result-toolbar-primary-active-bg, var(--gn-result-toolbar-primary-active-bg, var(--gn-accent-active, var(--gn-accent-2)))) !important;',
    );
    expect(commitCss).toContain(
      'background: var(--gn-client-result-toolbar-primary-disabled-bg, var(--gn-result-toolbar-primary-disabled-bg, var(--gn-bg-active))) !important;',
    );

    expect(insightCss).toContain(
      'background: var(--gn-client-result-toolbar-button-bg, var(--gn-result-toolbar-button-bg, var(--gn-info-soft))) !important;',
    );
    expect(insightCss).toContain(
      'color: var(--gn-client-result-toolbar-button-fg, var(--gn-result-toolbar-button-fg, var(--gn-info))) !important;',
    );
    expect(insightCss).toContain(
      'background: var(--gn-client-result-toolbar-button-hover-bg, var(--gn-result-toolbar-button-hover-bg, color-mix(in srgb, var(--gn-info-soft)',
    );
    expect(insightCss).toContain(
      'background: var(--gn-client-result-toolbar-button-active-bg, var(--gn-result-toolbar-button-active-bg, color-mix(in srgb, var(--gn-info-soft)',
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
      expect(markup).toContain('data-col-name="id"');
      expect(markup).toContain('data-col-name="name"');
      expect(markup).toContain(`title="${zhRowNumberHint}"`);
      expect(markup).toContain(
        `<span class="data-grid-row-number" data-grid-row-number="true" title="${zhRowNumberHint}"`,
      );
      expect(markup).toContain('display:flex');
      expect(markup).toContain('width:100%');
      expect(markup).toContain('height:100%');
      expect(markup).toContain('width:36');
      expect(markup).toContain('min-width:36');
      expect(markup).toContain('max-width:36');
      expect(markup).toContain('flex:0 0 36px');
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
});
