import React from 'react';

import { t } from '../../i18n';
import { useOptionalI18n } from '../../i18n/provider';
import {
  TABLE_OVERVIEW_CARD_HEIGHT,
  type OverviewTableSection,
  type TableStatRow,
  type ViewMode,
} from './tableOverviewModel';
import { useTableOverviewRenderers, type UseTableOverviewRenderersInput } from './hooks/useTableOverviewRenderers';
import { useTableOverviewCompactColumnResize } from './hooks/useTableOverviewCompactColumnResize';
import {
  DEFAULT_TABLE_OVERVIEW_COMPACT_COLUMNS,
  type TableOverviewCompactColumnWidths,
} from '../../utils/tableOverviewCompactColumns';

const EMPTY_COLUMN_WIDTHS: TableOverviewCompactColumnWidths = {};

type TableOverviewRowsProps = UseTableOverviewRenderersInput & {
  sections: OverviewTableSection[];
  showSectionTitles: boolean;
  viewMode: ViewMode;
  compactColumnWidths?: TableOverviewCompactColumnWidths;
  onCompactColumnWidthsChange?: (widths: TableOverviewCompactColumnWidths) => void;
};

const TableOverviewRows: React.FC<TableOverviewRowsProps> = ({
  sections,
  showSectionTitles,
  viewMode,
  compactColumnWidths,
  onCompactColumnWidthsChange,
  ...rendererProps
}) => {
  useOptionalI18n();
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const compactColumns = rendererProps.compactColumns ?? DEFAULT_TABLE_OVERVIEW_COMPACT_COLUMNS;
  const resize = useTableOverviewCompactColumnResize({
    scrollRef,
    columns: compactColumns,
    widths: compactColumnWidths ?? EMPTY_COLUMN_WIDTHS,
    onWidthsChange: onCompactColumnWidthsChange,
  });
  const canResizeColumns = Boolean(onCompactColumnWidthsChange);
  const {
    renderOverviewSectionTitle, renderCardTable, renderListTable,
    renderCompactTableHeader, renderCompactTableRow,
  } = useTableOverviewRenderers({
    ...rendererProps,
    compactColumnWidths,
    onCompactColumnResizeStart: canResizeColumns ? resize.handleResizeStart : undefined,
    onCompactColumnResizeKeyDown: canResizeColumns ? resize.handleResizeKeyDown : undefined,
    onCompactColumnAutoFit: canResizeColumns ? resize.handleResizeAutoFit : undefined,
  });
  const previousSections = React.useRef(sections);
  const sectionsUnchanged = sections.length === previousSections.current.length
    && sections.every((section, sectionIndex) => {
      const previous = previousSections.current[sectionIndex];
      return previous
        && section.key === previous.key
        && section.kind === previous.kind
        && section.rows.length === previous.rows.length
        && section.rows.every((row, rowIndex) => row === previous.rows[rowIndex]);
    });
  if (!sectionsUnchanged) previousSections.current = sections;
  const stableSections = previousSections.current;
  const selectedSignature = stableSections
    .map((section) => section.rows
      .map((row) => (rendererProps.isOverviewTableSelected(row.name) ? '1' : '0'))
      .join(''))
    .join('|');
  const compactColumnsSignature = compactColumns.join('\u0000');
  const renderRowRef = React.useRef(renderCompactTableRow);
  const renderSectionTitleRef = React.useRef(renderOverviewSectionTitle);
  renderRowRef.current = renderCompactTableRow;
  renderSectionTitleRef.current = renderOverviewSectionTitle;
  const stableRenderRow = React.useCallback((table: TableStatRow) => renderRowRef.current(table), []);
  const stableRenderSectionTitle = React.useCallback(
    (section: OverviewTableSection) => renderSectionTitleRef.current(section),
    [],
  );
  const compactTableBody = React.useMemo(() => (
    <>
      {stableSections.map((section) => (
        <React.Fragment key={section.key}>
          {showSectionTitles && (
            <div className="gn-table-overview-compact-section">{stableRenderSectionTitle(section)}</div>
          )}
          {section.rows.map(stableRenderRow)}
        </React.Fragment>
      ))}
    </>
  ), [
    compactColumnsSignature,
    rendererProps.connectionName,
    rendererProps.dbName,
    rendererProps.hostSummary,
    rendererProps.metadataDialect,
    rendererProps.schemaName,
    selectedSignature,
    showSectionTitles,
    stableRenderRow,
    stableRenderSectionTitle,
    stableSections,
  ]);

  if (viewMode === 'table') {
    return (
      <div
        ref={scrollRef}
        className="gn-table-overview-compact-scroll"
        role="table"
        tabIndex={0}
        aria-label={t('table_overview.tooltip.table_view')}
        style={resize.gridStyle}
      >
        {renderCompactTableHeader()}
        {compactTableBody}
      </div>
    );
  }
  return (
    <div className="gn-v2-table-overview-sections">
      {sections.map((section) => (
        <section key={section.key} className="gn-v2-table-overview-section">
          {showSectionTitles && renderOverviewSectionTitle(section)}
          {viewMode === 'card' ? (
            <div className="gn-v2-table-card-grid" style={{
              display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
              gridAutoRows: TABLE_OVERVIEW_CARD_HEIGHT, gap: 12,
            }}>
              {section.rows.map(renderCardTable)}
            </div>
          ) : (
            <div className="gn-v2-table-row-list" style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
              {section.rows.map(renderListTable)}
            </div>
          )}
        </section>
      ))}
    </div>
  );
};

export default React.memo(TableOverviewRows);
