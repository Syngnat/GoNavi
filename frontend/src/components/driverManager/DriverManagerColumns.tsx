import { Button, Tooltip, Input, Select, Empty } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { t } from '../../i18n';
import DownloadSourceSelect from '../DownloadSourceSelect';
import { Text, type DriverListSortKey } from './driverManagerModel';
import type { DriverManagerStatusLoadingApi } from './useDriverManagerStatusLoading';
import type { DriverManagerStateApi } from './useDriverManagerState';
import type { DriverManagerNetworkSummaryApi } from './driverManagerNetworkSummary';
import type { DriverManagerRowsApi } from './useDriverManagerRows';
import type { DriverManagerDetailViewApi } from './useDriverManagerDetailView';
import type { DriverManagerModalProps } from '../DriverManagerModal';

export interface DriverManagerColumnsProps {
  embedded: Exclude<DriverManagerModalProps['embedded'], undefined>;
  refreshStatus: DriverManagerStatusLoadingApi['refreshStatus'];
  loading: DriverManagerStateApi['loading'];
  networkTooltipTitle: DriverManagerNetworkSummaryApi['networkTooltipTitle'];
  networkDotTone: DriverManagerNetworkSummaryApi['networkDotTone'];
  checkNetworkStatus: DriverManagerStatusLoadingApi['checkNetworkStatus'];
  networkChecking: DriverManagerStateApi['networkChecking'];
  onChangeDownloadSource: DriverManagerModalProps['onChangeDownloadSource'];
  downloadSource: DriverManagerModalProps['downloadSource'];
  darkMode: DriverManagerStateApi['darkMode'];
  downloadSourceMeta: DriverManagerNetworkSummaryApi['downloadSourceMeta'];
  driverManagerTheme: DriverManagerStateApi['driverManagerTheme'];
  downloadSourceSwitching: Exclude<DriverManagerModalProps['downloadSourceSwitching'], undefined>;
  statusSummary: DriverManagerRowsApi['statusSummary'];
  driverFilter: DriverManagerStateApi['driverFilter'];
  setDriverFilter: DriverManagerStateApi['setDriverFilter'];
  searchKeyword: DriverManagerStateApi['searchKeyword'];
  setSearchKeyword: DriverManagerStateApi['setSearchKeyword'];
  driverSortKey: DriverManagerStateApi['driverSortKey'];
  setDriverSortKey: DriverManagerStateApi['setDriverSortKey'];
  initialStatusLoading: DriverManagerRowsApi['initialStatusLoading'];
  visibleRows: DriverManagerRowsApi['visibleRows'];
  renderDriverListItem: DriverManagerDetailViewApi['renderDriverListItem'];
  selectedRow: DriverManagerRowsApi['selectedRow'];
  renderDriverDetail: DriverManagerDetailViewApi['renderDriverDetail'];
  normalizedSearchKeyword: DriverManagerRowsApi['normalizedSearchKeyword'];
  renderDriverLogSection: DriverManagerDetailViewApi['renderDriverLogSection'];
}

export const DriverManagerColumns = ({
  embedded,
  refreshStatus,
  loading,
  networkTooltipTitle,
  networkDotTone,
  checkNetworkStatus,
  networkChecking,
  onChangeDownloadSource,
  downloadSource,
  darkMode,
  downloadSourceMeta,
  driverManagerTheme,
  downloadSourceSwitching,
  statusSummary,
  driverFilter,
  setDriverFilter,
  searchKeyword,
  setSearchKeyword,
  driverSortKey,
  setDriverSortKey,
  initialStatusLoading,
  visibleRows,
  renderDriverListItem,
  selectedRow,
  renderDriverDetail,
  normalizedSearchKeyword,
  renderDriverLogSection,
}: DriverManagerColumnsProps) => (
  <div className="driver-manager-columns">
    <aside className="driver-manager-list-pane">
      {embedded ? (
        <div className="driver-manager-list-search-row is-embedded">
          <div className="driver-manager-list-search-row-left">
            <Button
              size="middle"
              icon={<ReloadOutlined />}
              onClick={() => refreshStatus(true)}
              loading={loading}
            >
              {t('driver.modal.footer.refresh')}
            </Button>
            <Tooltip title={networkTooltipTitle} placement="bottomRight">
              <Button
                size="middle"
                className="driver-manager-network-check-btn"
                icon={<span className={`driver-manager-net-dot driver-manager-net-dot-${networkDotTone}`} aria-hidden="true" />}
                onClick={() => checkNetworkStatus(true)}
                loading={networkChecking}
              >
                {t('driver.modal.footer.networkCheck')}
              </Button>
            </Tooltip>
          </div>
          {onChangeDownloadSource ? (
            <div
              className="driver-manager-mirror-chip is-compact"
              data-download-source={downloadSource}
            >
              <div className="driver-manager-mirror-chip-copy">
                <span
                  aria-hidden="true"
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: 999,
                    background: darkMode ? downloadSourceMeta.darkDot : downloadSourceMeta.lightDot,
                    flexShrink: 0,
                  }}
                />
                <span className="driver-manager-mirror-chip-label" style={{ color: driverManagerTheme.mutedText, fontSize: 13 }}>
                  {t('driver_manager.mirror_source.label')}
                </span>
              </div>
              <DownloadSourceSelect
                value={downloadSource}
                darkMode={darkMode}
                saving={downloadSourceSwitching}
                onChange={onChangeDownloadSource}
                size="small"
                borderless
                style={{ minWidth: 132 }}
              />
            </div>
          ) : null}
        </div>
      ) : null}
      <div className="driver-manager-filterbar">
        {([
          { key: 'all', label: t('driver.modal.stats.total'), count: statusSummary.total },
          { key: 'needsUpdate', label: t('driver.modal.stats.needsUpdate'), count: statusSummary.needsUpdate, tone: 'needsUpdate' },
          { key: 'enabled', label: t('driver.modal.stats.enabled'), count: statusSummary.enabled },
          { key: 'notEnabled', label: t('driver.modal.stats.notEnabled'), count: statusSummary.notEnabled },
        ]).map((chip) => (
          <button
            key={chip.key}
            type="button"
            data-tone={chip.tone}
            className={`driver-manager-filter-chip${driverFilter === chip.key ? ' is-active' : ''}`}
            onClick={() => setDriverFilter(chip.key as typeof driverFilter)}
          >
            <span>{chip.label}</span>
            <span className="driver-manager-filter-chip-count">{chip.count}</span>
          </button>
        ))}
      </div>
      <div className="driver-manager-list-head">
        {loading ? (
          <Text type="secondary" className="driver-manager-list-head-loading">
            {t('driver.modal.status.refreshing')}
          </Text>
        ) : null}
        <Input.Search
          allowClear
          size="small"
          placeholder={t('driver.modal.toolbar.searchPlaceholder')}
          value={searchKeyword}
          onChange={(event) => setSearchKeyword(event.target.value)}
          className="driver-manager-list-search is-in-head"
        />
        <div className="driver-manager-list-head-right">
          <Select
            size="small"
            className="driver-manager-list-head-sort"
            value={driverSortKey}
            popupMatchSelectWidth={false}
            variant="borderless"
            aria-label={t('driver.modal.list.sortLabel')}
            options={[
              { value: 'name', label: t('driver.modal.list.sortByName') },
              { value: 'status', label: t('driver.modal.list.sortByStatus') },
              { value: 'size', label: t('driver.modal.list.sortBySize') },
              { value: 'version', label: t('driver.modal.list.sortByVersion') },
            ]}
            onChange={(value) => setDriverSortKey(value as DriverListSortKey)}
          />
        </div>
      </div>
      <div className="driver-manager-list" aria-busy={initialStatusLoading}>
        {initialStatusLoading ? null : visibleRows.map(renderDriverListItem)}
      </div>
    </aside>
    <section className="driver-manager-detail" aria-live="polite">
      {selectedRow ? (
        renderDriverDetail(selectedRow)
      ) : initialStatusLoading ? null : (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={normalizedSearchKeyword
            ? t('driver.modal.empty.noMatch', { keyword: String(searchKeyword || '').trim() })
            : t('driver.modal.empty.noData')}
        />
      )}
      {selectedRow ? renderDriverLogSection(selectedRow) : null}
    </section>
  </div>
);
