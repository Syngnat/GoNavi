import React from 'react';

import { t } from '../../i18n';
import { useOptionalI18n } from '../../i18n/provider';
import { TABLE_OVERVIEW_CARD_HEIGHT, type OverviewTableSection, type ViewMode } from './tableOverviewModel';
import { useTableOverviewRenderers, type UseTableOverviewRenderersInput } from './hooks/useTableOverviewRenderers';

type TableOverviewRowsProps = UseTableOverviewRenderersInput & {
  sections: OverviewTableSection[];
  showSectionTitles: boolean;
  viewMode: ViewMode;
};

const TableOverviewRows: React.FC<TableOverviewRowsProps> = ({ sections, showSectionTitles, viewMode, ...rendererProps }) => {
  useOptionalI18n();
  const {
    renderOverviewSectionTitle, renderCardTable, renderListTable,
    renderCompactTableHeader, renderCompactTableRow,
  } = useTableOverviewRenderers(rendererProps);

  if (viewMode === 'table') {
    return (
      <div className="gn-table-overview-compact-scroll" role="table" aria-label={t('table_overview.tooltip.table_view')}>
        {renderCompactTableHeader()}
        {sections.map((section) => (
          <React.Fragment key={section.key}>
            {showSectionTitles && (
              <div className="gn-table-overview-compact-section">{renderOverviewSectionTitle(section)}</div>
            )}
            {section.rows.map(renderCompactTableRow)}
          </React.Fragment>
        ))}
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
