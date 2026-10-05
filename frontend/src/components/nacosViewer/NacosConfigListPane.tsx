import { Space, Tag, Button, AutoComplete, Checkbox, Popconfirm, Table, Modal } from 'antd';
import {
  ReloadOutlined,
  PlusOutlined,
  DownloadOutlined,
  UploadOutlined,
  DeleteOutlined,
} from '@ant-design/icons';
import { noAutoCapInputProps } from '../../utils/inputAutoCap';
import { nacosConfigSelectionKey } from '../nacosConfigSelection';
import type { NacosViewerStateApi } from './hooks/useNacosViewerState';
import type { NacosViewerBatchActionsApi } from './hooks/useNacosViewerBatchActions';
import type { NacosViewerConfigActionsApi } from './hooks/useNacosViewerConfigActions';

export interface NacosConfigListPaneProps {
  leftPanelRef: NacosViewerStateApi['leftPanelRef'];
  namespaceLabel: NacosViewerBatchActionsApi['namespaceLabel'];
  listenActive: NacosViewerStateApi['listenActive'];
  tr: NacosViewerStateApi['tr'];
  loadList: NacosViewerStateApi['loadList'];
  loadingList: NacosViewerStateApi['loadingList'];
  readOnly: NacosViewerStateApi['readOnly'];
  newForm: NacosViewerStateApi['newForm'];
  setNewModalOpen: NacosViewerStateApi['setNewModalOpen'];
  exporting: NacosViewerStateApi['exporting'];
  handleExport: NacosViewerConfigActionsApi['handleExport'];
  selectedCount: NacosViewerStateApi['selectedCount'];
  importRestricted: NacosViewerStateApi['importRestricted'];
  handlePreviewImport: NacosViewerConfigActionsApi['handlePreviewImport'];
  dataIdAutoOptions: NacosViewerConfigActionsApi['dataIdAutoOptions'];
  fuzzyFilterOption: NacosViewerConfigActionsApi['fuzzyFilterOption'];
  filterDataId: NacosViewerStateApi['filterDataId'];
  setFilterDataId: NacosViewerStateApi['setFilterDataId'];
  pageSize: NacosViewerStateApi['pageSize'];
  dataIdSuggestions: NacosViewerStateApi['dataIdSuggestions'];
  loadFilterSuggestions: NacosViewerStateApi['loadFilterSuggestions'];
  groupAutoOptions: NacosViewerConfigActionsApi['groupAutoOptions'];
  filterGroup: NacosViewerStateApi['filterGroup'];
  setFilterGroup: NacosViewerStateApi['setFilterGroup'];
  groupSuggestions: NacosViewerStateApi['groupSuggestions'];
  workbenchTheme: NacosViewerStateApi['workbenchTheme'];
  allPageSelected: NacosViewerStateApi['allPageSelected'];
  pageSelectionIndeterminate: NacosViewerStateApi['pageSelectionIndeterminate'];
  items: NacosViewerStateApi['items'];
  setSelectedRowKeys: NacosViewerStateApi['setSelectedRowKeys'];
  handleDeleteSelected: NacosViewerBatchActionsApi['handleDeleteSelected'];
  deletingSelected: NacosViewerStateApi['deletingSelected'];
  listBodyRef: NacosViewerStateApi['listBodyRef'];
  pinnedItems: NacosViewerStateApi['pinnedItems'];
  columns: NacosViewerBatchActionsApi['columns'];
  selectedRowKeys: NacosViewerStateApi['selectedRowKeys'];
  pageNo: NacosViewerStateApi['pageNo'];
  totalCount: NacosViewerStateApi['totalCount'];
  draftDirty: NacosViewerStateApi['draftDirty'];
  loadDetail: NacosViewerConfigActionsApi['loadDetail'];
  selectedRowKey: NacosViewerStateApi['selectedRowKey'];
  listScrollY: NacosViewerStateApi['listScrollY'];
}

export const NacosConfigListPane = ({
  leftPanelRef, namespaceLabel, listenActive, tr, loadList, loadingList, readOnly, newForm,
  setNewModalOpen, exporting, handleExport, selectedCount, importRestricted, handlePreviewImport,
  dataIdAutoOptions, fuzzyFilterOption, filterDataId, setFilterDataId, pageSize, dataIdSuggestions,
  loadFilterSuggestions, groupAutoOptions, filterGroup, setFilterGroup, groupSuggestions,
  workbenchTheme, allPageSelected, pageSelectionIndeterminate, items, setSelectedRowKeys,
  handleDeleteSelected, deletingSelected, listBodyRef, pinnedItems, columns, selectedRowKeys,
  pageNo, totalCount, draftDirty, loadDetail, selectedRowKey, listScrollY,
}: NacosConfigListPaneProps) => (
  <div
    ref={leftPanelRef}
    className={'gn-v2-nacos-list-pane'}
    style={
      { minHeight: 0, overflow: 'hidden' }
    }
  >
    <div
      className={'gn-v2-nacos-pane-header'}
      style={
        { display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'stretch' }
      }
    >
      <Space wrap size={[8, 8]}>
        <Tag color="blue">{namespaceLabel}</Tag>
        {listenActive ? <Tag color="green">{tr('nacos_viewer.status.listening')}</Tag> : null}
        <Button icon={<ReloadOutlined />} onClick={() => void loadList(1)} loading={loadingList}>
          {tr('nacos_viewer.action.refresh')}
        </Button>
        <Button
          icon={<PlusOutlined />}
          disabled={readOnly}
          onClick={() => {
            newForm.setFieldsValue({
              dataId: '',
              group: 'DEFAULT_GROUP',
              type: 'text',
              content: '',
            });
            setNewModalOpen(true);
          }}
        >
          {tr('nacos_viewer.action.new')}
        </Button>
        <Button
          icon={<DownloadOutlined />}
          loading={exporting}
          onClick={() => void handleExport(selectedCount > 0 ? 'selected' : 'all')}
        >
          {tr(
            selectedCount > 0
              ? 'nacos_viewer.action.export_selected'
              : 'nacos_viewer.action.export_all',
          )}
        </Button>
        <Button
          icon={<UploadOutlined />}
          disabled={importRestricted}
          onClick={() => void handlePreviewImport()}
        >
          {tr('nacos_viewer.action.import')}
        </Button>
      </Space>
      <div
        className="gn-nacos-filter-row"
        style={{
          display: 'flex',
          gap: 8,
          width: '100%',
          minWidth: 0,
        }}
      >
        <AutoComplete
          allowClear
          options={dataIdAutoOptions}
          filterOption={fuzzyFilterOption}
          value={filterDataId}
          className="gn-nacos-filter-data-id"
          popupClassName="gn-nacos-filter-dropdown"
          // Match input width so option text can use the full row (no artificial 280px clip).
          popupMatchSelectWidth
          style={{ flex: '1 1 0', minWidth: 0 }}
          placeholder={tr('nacos_viewer.field.data_id')}
          {...noAutoCapInputProps}
          onChange={(value) => {
            const next = String(value ?? '');
            setFilterDataId(next);
            // Clearing should re-query immediately without an extra click.
            if (!next) void loadList(1, pageSize, { dataId: '' });
          }}
          onSelect={(value) => {
            const next = String(value ?? '');
            setFilterDataId(next);
            void loadList(1, pageSize, { dataId: next });
          }}
          onInputKeyDown={(event) => {
            if (event.key === 'Enter') {
              void loadList(1, pageSize, { dataId: filterDataId });
            }
          }}
          onFocus={() => {
            if (dataIdSuggestions.length === 0) void loadFilterSuggestions();
          }}
        />
        <AutoComplete
          allowClear
          options={groupAutoOptions}
          filterOption={fuzzyFilterOption}
          value={filterGroup}
          className="gn-nacos-filter-group"
          popupClassName="gn-nacos-filter-dropdown"
          popupMatchSelectWidth
          style={{ flex: '1 1 0', minWidth: 0 }}
          placeholder={tr('nacos_viewer.field.group')}
          {...noAutoCapInputProps}
          onChange={(value) => {
            const next = String(value ?? '');
            setFilterGroup(next);
            if (!next) void loadList(1, pageSize, { group: '' });
          }}
          onSelect={(value) => {
            const next = String(value ?? '');
            setFilterGroup(next);
            void loadList(1, pageSize, { group: next });
          }}
          onInputKeyDown={(event) => {
            if (event.key === 'Enter') {
              void loadList(1, pageSize, { group: filterGroup });
            }
          }}
          onFocus={() => {
            if (groupSuggestions.length === 0) void loadFilterSuggestions();
          }}
        />
      </div>
      <div
        className="gn-nacos-selection-toolbar"
        style={{ borderTop: `1px solid ${workbenchTheme.divider}` }}
      >
        <div className="gn-nacos-selection-toolbar__summary">
          <Checkbox
            checked={allPageSelected}
            indeterminate={pageSelectionIndeterminate}
            disabled={items.length === 0 || loadingList}
            aria-label={tr('nacos_viewer.selection.select_page')}
            onChange={(event) => {
              setSelectedRowKeys(
                event.target.checked ? items.map(nacosConfigSelectionKey) : [],
              );
            }}
          >
            {tr('nacos_viewer.selection.select_page')}
          </Checkbox>
          <span
            className="gn-nacos-selection-toolbar__count"
            style={{ color: workbenchTheme.textMuted }}
            aria-live="polite"
          >
            {tr('nacos_viewer.selection.count', { count: selectedCount })}
          </span>
        </div>
        <div className="gn-nacos-selection-toolbar__actions">
          <Popconfirm
            disabled={readOnly || selectedCount === 0}
            title={tr('nacos_viewer.message.confirm_delete_selected', {
              count: selectedCount,
            })}
            okText={tr('nacos_viewer.action.delete_selected')}
            cancelText={tr('common.cancel')}
            okButtonProps={{ danger: true }}
            onConfirm={() => void handleDeleteSelected()}
          >
            <Button
              danger
              icon={<DeleteOutlined />}
              disabled={readOnly || selectedCount === 0}
              loading={deletingSelected}
            >
              {tr('nacos_viewer.action.delete_selected')}
            </Button>
          </Popconfirm>
        </div>
      </div>
    </div>
    <div
      ref={listBodyRef}
      className={'gn-v2-nacos-pane-body gn-v2-nacos-list-body'}
      style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', padding: undefined }}
    >
      <Table
        className="gn-nacos-config-table"
        size="small"
        showHeader={false}
        rowKey={nacosConfigSelectionKey}
        loading={loadingList}
        dataSource={pinnedItems}
        columns={columns as any}
        rowSelection={{
          selectedRowKeys: selectedRowKeys,
          onChange: (keys) => setSelectedRowKeys(keys),
          columnWidth: 36,
        }}
        pagination={{
          current: pageNo,
          pageSize,
          total: totalCount,
          size: 'small',
          // Select-only page size (no free-text that can't be applied).
          showSizeChanger: {
            showSearch: false,
            popupMatchSelectWidth: false,
            placement: 'topRight',
          },
          pageSizeOptions: ['20', '50', '100', '200'],
          showLessItems: true,
          showTotal: (total, range) =>
            total > 0
              ? tr('nacos_viewer.pagination.range', {
                  from: range[0],
                  to: range[1],
                  total,
                })
              : tr('nacos_viewer.pagination.empty'),
          onChange: (page, nextSize) => {
            const size = nextSize || pageSize;
            if (size !== pageSize) {
              void loadList(1, size);
              return;
            }
            void loadList(page, size);
          },
          onShowSizeChange: (_current, size) => {
            void loadList(1, size);
          },
        }}
        onRow={(record) => ({
          // Avoid browser text-selection flash when clicking rows.
          onMouseDown: (event) => {
            if (event.detail > 1) event.preventDefault();
          },
          onClick: () => {
            if (typeof window !== 'undefined') {
              window.getSelection()?.removeAllRanges();
            }
            if (draftDirty) {
              Modal.confirm({
                title: tr('nacos_viewer.action.publish'),
                content: tr('nacos_viewer.message.select_config'),
                okText: tr('nacos_viewer.action.refresh'),
                onOk: () => void loadDetail(record),
              });
              return;
            }
            void loadDetail(record);
          },
        })}
        rowClassName={(record) =>
          selectedRowKey === nacosConfigSelectionKey(record)
            ? 'ant-table-row-selected gn-nacos-config-table__row--active'
            : 'gn-nacos-config-table__row'
        }
        style={{ flex: 1, minHeight: 0 }}
        scroll={{ y: listScrollY }}
      />
    </div>
  </div>
);
