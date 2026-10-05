import { Tabs, Button, Table, Empty } from 'antd';
import React from 'react';
import {
  PlusOutlined,
  EditOutlined,
  DeleteOutlined,
  EyeOutlined,
  FileTextOutlined,
} from '@ant-design/icons';
import { t } from '../../i18n';
import { ResizableTitle } from './TableDesignerTableParts';
import TableDesignerSqlPreview from '../TableDesignerSqlPreview';
import type { ForeignKeyDisplayRow } from './tableDesignerTypes';
import Editor from '../MonacoEditor';
import type { TableDesignerStateApi } from './hooks/useTableDesignerState';
import type { TableDesignerTabContentsApi } from './hooks/useTableDesignerTabContents';
import type { TableDesignerDialectSupportApi } from './hooks/useTableDesignerDialectSupport';
import type { TableDesignerIndexEditsApi } from './hooks/useTableDesignerIndexEdits';
import type { TableDesignerSaveActionsApi } from './hooks/useTableDesignerSaveActions';
import type { TableDesignerColumnEditsApi } from './hooks/useTableDesignerColumnEdits';
import type { TableDesignerTriggerListApi } from './hooks/useTableDesignerTriggerList';
import type { TableDesignerProps } from '../TableDesigner';

export interface TableDesignerTabsProps {
  activeKey: TableDesignerStateApi['activeKey'];
  setActiveKey: TableDesignerStateApi['setActiveKey'];
  embedded: Exclude<TableDesignerProps['embedded'], undefined>;
  panelRadius: TableDesignerStateApi['panelRadius'];
  panelFrameColor: TableDesignerStateApi['panelFrameColor'];
  panelBodyBg: TableDesignerStateApi['panelBodyBg'];
  isTDengineNewTable: TableDesignerStateApi['isTDengineNewTable'];
  i18nLanguage: TableDesignerStateApi['i18nLanguage'];
  tdengineCombinedTabContent: TableDesignerTabContentsApi['tdengineCombinedTabContent'];
  columnsTabContent: TableDesignerTabContentsApi['columnsTabContent'];
  isStarRocksNewTable: TableDesignerDialectSupportApi['isStarRocksNewTable'];
  starRocksAdvancedTabContent: TableDesignerTabContentsApi['starRocksAdvancedTabContent'];
  readOnly: TableDesignerStateApi['readOnly'];
  supportsIndexSchemaOps: TableDesignerDialectSupportApi['supportsIndexSchemaOps'];
  openCreateIndexModal: TableDesignerIndexEditsApi['openCreateIndexModal'];
  selectedIndexKeys: TableDesignerStateApi['selectedIndexKeys'];
  openEditIndexModal: TableDesignerIndexEditsApi['openEditIndexModal'];
  handleDeleteIndex: TableDesignerSaveActionsApi['handleDeleteIndex'];
  groupedIndexes: TableDesignerColumnEditsApi['groupedIndexes'];
  groupedIndexFieldCount: TableDesignerColumnEditsApi['groupedIndexFieldCount'];
  isNewTable: TableDesignerStateApi['isNewTable'];
  resizableIndexColumns: TableDesignerTabContentsApi['resizableIndexColumns'];
  indexesLoading: TableDesignerStateApi['indexesLoading'];
  indexTableHeight: TableDesignerIndexEditsApi['indexTableHeight'];
  toggleIndexSelection: TableDesignerTabContentsApi['toggleIndexSelection'];
  selectedIndexCreateSql: TableDesignerIndexEditsApi['selectedIndexCreateSql'];
  selectedIndex: TableDesignerColumnEditsApi['selectedIndex'];
  darkMode: TableDesignerStateApi['darkMode'];
  supportsForeignKeySchemaOps: TableDesignerDialectSupportApi['supportsForeignKeySchemaOps'];
  openCreateForeignKeyModal: TableDesignerSaveActionsApi['openCreateForeignKeyModal'];
  selectedForeignKey: TableDesignerStateApi['selectedForeignKey'];
  openEditForeignKeyModal: TableDesignerSaveActionsApi['openEditForeignKeyModal'];
  handleDeleteForeignKey: TableDesignerSaveActionsApi['handleDeleteForeignKey'];
  groupedForeignKeys: TableDesignerDialectSupportApi['groupedForeignKeys'];
  foreignKeysLoading: TableDesignerStateApi['foreignKeysLoading'];
  tableHeight: TableDesignerStateApi['tableHeight'];
  setSelectedForeignKey: TableDesignerStateApi['setSelectedForeignKey'];
  selectedTrigger: TableDesignerStateApi['selectedTrigger'];
  setIsTriggerModalOpen: TableDesignerStateApi['setIsTriggerModalOpen'];
  handleCreateTrigger: TableDesignerTriggerListApi['handleCreateTrigger'];
  handleEditTrigger: TableDesignerTriggerListApi['handleEditTrigger'];
  handleDeleteTrigger: TableDesignerTriggerListApi['handleDeleteTrigger'];
  triggers: TableDesignerStateApi['triggers'];
  triggersLoading: TableDesignerStateApi['triggersLoading'];
  setSelectedTrigger: TableDesignerStateApi['setSelectedTrigger'];
  ddl: TableDesignerStateApi['ddl'];
}

export const TableDesignerTabs = ({
  activeKey, setActiveKey, embedded, panelRadius, panelFrameColor, panelBodyBg, isTDengineNewTable,
  i18nLanguage, tdengineCombinedTabContent, columnsTabContent, isStarRocksNewTable,
  starRocksAdvancedTabContent, readOnly, supportsIndexSchemaOps, openCreateIndexModal,
  selectedIndexKeys, openEditIndexModal, handleDeleteIndex, groupedIndexes, groupedIndexFieldCount,
  isNewTable, resizableIndexColumns, indexesLoading, indexTableHeight, toggleIndexSelection,
  selectedIndexCreateSql, selectedIndex, darkMode, supportsForeignKeySchemaOps,
  openCreateForeignKeyModal, selectedForeignKey, openEditForeignKeyModal, handleDeleteForeignKey,
  groupedForeignKeys, foreignKeysLoading, tableHeight, setSelectedForeignKey, selectedTrigger,
  setIsTriggerModalOpen, handleCreateTrigger, handleEditTrigger, handleDeleteTrigger, triggers,
  triggersLoading, setSelectedTrigger, ddl,
}: TableDesignerTabsProps) => (
  <Tabs
      className={'gn-v2-designer-tabs'}
      activeKey={activeKey}
      onChange={(key) => React.startTransition(() => setActiveKey(key))}
      style={{
          flex: 1,
          minHeight: 0,
          padding: embedded ? 0 : '0 10px 10px 10px',
          borderBottomLeftRadius: embedded ? 0 : panelRadius,
          borderBottomRightRadius: embedded ? 0 : panelRadius,
          borderLeft: `1px solid ${panelFrameColor}`,
          borderRight: `1px solid ${panelFrameColor}`,
          borderBottom: `1px solid ${panelFrameColor}`,
          background: panelBodyBg
      }}
      items={[
          ...(isTDengineNewTable ? [
              {
                  key: 'tdengine',
                  label: t('table_designer.tab.tdengine', undefined, i18nLanguage),
                  children: tdengineCombinedTabContent,
              },
          ] : [
              {
                  key: 'columns',
                  label: t('table_designer.tab.columns', undefined, i18nLanguage),
                  children: columnsTabContent
              },
          ]),
          ...(isStarRocksNewTable ? [
              {
                  key: 'starrocks',
                  label: 'StarRocks',
                  children: starRocksAdvancedTabContent,
              },
          ] : []),
          ...(!isTDengineNewTable ? [
              {
                  key: 'indexes',
                  label: t('table_designer.tab.indexes', undefined, i18nLanguage),
                  children: (
                      <div className="index-table-wrap gn-v2-designer-tab-content gn-v2-designer-index-table" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                          {!readOnly && (
                              <div className={'gn-v2-designer-actionbar'} style={{ display: 'flex', gap: 8 }}>
                                  <Button size="small" icon={<PlusOutlined />} disabled={!supportsIndexSchemaOps()} onClick={openCreateIndexModal}>{t('table_designer.action.add', undefined, i18nLanguage)}</Button>
                                  <Button size="small" icon={<EditOutlined />} disabled={!supportsIndexSchemaOps() || selectedIndexKeys.length !== 1} onClick={openEditIndexModal}>{t('table_designer.action.edit', undefined, i18nLanguage)}</Button>
                                  <Button size="small" icon={<DeleteOutlined />} danger disabled={!supportsIndexSchemaOps() || selectedIndexKeys.length === 0} onClick={handleDeleteIndex}>{t('table_designer.action.delete', undefined, i18nLanguage)}</Button>
                                  {!supportsIndexSchemaOps() && (
                                      <span style={{ marginLeft: 'auto', color: '#faad14', fontSize: 12, alignSelf: 'center' }}>
                                          {t('table_designer.notice.index_readonly', undefined, i18nLanguage)}
                                      </span>
                                  )}
                                  {supportsIndexSchemaOps() && selectedIndexKeys.length > 0 && (
                                      <span style={{ marginLeft: 'auto', color: '#888', fontSize: 12, alignSelf: 'center' }}>
                                          {t('table_designer.selection.indexes_selected', { count: selectedIndexKeys.length }, i18nLanguage)}
                                      </span>
                                  )}
                              </div>
                          )}
                          <div className={'gn-v2-designer-section-note'} style={{ color: '#888', fontSize: 12 }}>
                              {t('table_designer.summary.indexes', { count: groupedIndexes.length, fields: groupedIndexFieldCount }, i18nLanguage)}
                              {isNewTable ? ` ${t('table_designer.notice.new_table_index_hint', undefined, i18nLanguage)}` : ''}
                          </div>
                          <Table
                              dataSource={groupedIndexes}
                              columns={resizableIndexColumns}
                              rowKey="key"
                              size="small"
                              pagination={false}
                              loading={indexesLoading}
                              scroll={{ x: 960, y: indexTableHeight }}
                              components={{
                                  header: { cell: ResizableTitle },
                              }}
                              onRow={(record) => ({
                                  onClick: () => {
                                      toggleIndexSelection(record.key);
                                  },
                                  style: { cursor: 'pointer' }
                              })}
                          />
                          {selectedIndexCreateSql && selectedIndex && (
                              <div style={{ width: '100%' }}>
                                  <div style={{ color: '#666', fontSize: 12, marginBottom: 6 }}>
                                      {t('table_designer.label.create_statement', { name: selectedIndex.name }, i18nLanguage)}
                                  </div>
                                  <TableDesignerSqlPreview sql={selectedIndexCreateSql} darkMode={darkMode} height="160px" />
                              </div>
                          )}
                      </div>
                  )
              },
              {
                  key: 'foreignKeys',
                  label: t('table_designer.tab.foreign_keys', undefined, i18nLanguage),
                  children: (
                      <div className={'gn-v2-designer-tab-content'} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                          {!readOnly && (
                              <div className={'gn-v2-designer-actionbar'} style={{ display: 'flex', gap: 8 }}>
                                  <Button size="small" icon={<PlusOutlined />} disabled={!supportsForeignKeySchemaOps()} onClick={openCreateForeignKeyModal}>{t('table_designer.action.add', undefined, i18nLanguage)}</Button>
                                  <Button size="small" icon={<EditOutlined />} disabled={!supportsForeignKeySchemaOps() || !selectedForeignKey} onClick={openEditForeignKeyModal}>{t('table_designer.action.edit', undefined, i18nLanguage)}</Button>
                                  <Button size="small" icon={<DeleteOutlined />} danger disabled={!supportsForeignKeySchemaOps() || !selectedForeignKey} onClick={handleDeleteForeignKey}>{t('table_designer.action.delete', undefined, i18nLanguage)}</Button>
                                  {!supportsForeignKeySchemaOps() && (
                                      <span style={{ marginLeft: 'auto', color: '#faad14', fontSize: 12, alignSelf: 'center' }}>
                                          {t('table_designer.notice.foreign_key_readonly', undefined, i18nLanguage)}
                                      </span>
                                  )}
                                  {supportsForeignKeySchemaOps() && selectedForeignKey && (
                                      <span style={{ marginLeft: 'auto', color: '#888', fontSize: 12, alignSelf: 'center' }}>
                                          {t('table_designer.selection.foreign_key_selected', { name: selectedForeignKey.constraintName }, i18nLanguage)}
                                      </span>
                                  )}
                              </div>
                          )}
                          {isNewTable && (
                              <div className={'gn-v2-designer-section-note'} style={{ color: '#888', fontSize: 12 }}>
                                  {t('table_designer.notice.new_table_foreign_key_hint', undefined, i18nLanguage)}
                              </div>
                          )}
                          <Table
                              dataSource={groupedForeignKeys}
                              columns={[
                                  { title: t('table_designer.foreign_key.column.constraint_name', undefined, i18nLanguage), dataIndex: 'constraintName', key: 'constraintName', width: 220 },
                                  {
                                      title: t('table_designer.foreign_key.column.fields', undefined, i18nLanguage),
                                      dataIndex: 'columnNames',
                                      key: 'columnNames',
                                      render: (vals: string[]) => vals?.length ? vals.join(', ') : '-',
                                  },
                                  { title: t('table_designer.foreign_key.column.ref_table', undefined, i18nLanguage), dataIndex: 'refTableName', key: 'refTableName', width: 220 },
                                  {
                                      title: t('table_designer.foreign_key.column.ref_fields', undefined, i18nLanguage),
                                      dataIndex: 'refColumnNames',
                                      key: 'refColumnNames',
                                      render: (vals: string[]) => vals?.length ? vals.join(', ') : '-',
                                  },
                              ]}
                              rowKey="key"
                              size="small"
                              pagination={false}
                              loading={foreignKeysLoading}
                              scroll={{ x: 980, y: tableHeight }}
                              rowSelection={{
                                  type: 'radio',
                                  selectedRowKeys: selectedForeignKey ? [selectedForeignKey.key] : [],
                                  onChange: (_, selectedRows) => setSelectedForeignKey((selectedRows[0] as ForeignKeyDisplayRow) || null),
                              }}
                              onRow={(record) => ({
                                  onClick: () => {
                                      if (selectedForeignKey?.key === record.key) {
                                          setSelectedForeignKey(null);
                                      } else {
                                          setSelectedForeignKey(record);
                                      }
                                  },
                                  style: { cursor: 'pointer' }
                              })}
                          />
                      </div>
                  )
              },
              {
                  key: 'triggers',
                  label: t('table_designer.tab.triggers', undefined, i18nLanguage),
                  children: (
                      <div className={'gn-v2-designer-tab-content'}>
                          <div className={'gn-v2-designer-actionbar'} style={{ marginBottom: 8, display: 'flex', gap: 8 }}>
                              <Button
                                  size="small"
                                  icon={<EyeOutlined />}
                                  disabled={!selectedTrigger}
                                  onClick={() => setIsTriggerModalOpen(true)}
                              >
                                  {t('table_designer.action.view_statement', undefined, i18nLanguage)}
                              </Button>
                              {!readOnly && (
                                  <>
                                      <Button size="small" icon={<PlusOutlined />} onClick={handleCreateTrigger}>{t('table_designer.action.add', undefined, i18nLanguage)}</Button>
                                      <Button size="small" icon={<EditOutlined />} disabled={!selectedTrigger} onClick={handleEditTrigger}>{t('table_designer.action.edit', undefined, i18nLanguage)}</Button>
                                      <Button size="small" icon={<DeleteOutlined />} danger disabled={!selectedTrigger} onClick={handleDeleteTrigger}>{t('table_designer.action.delete', undefined, i18nLanguage)}</Button>
                                  </>
                              )}
                              <span style={{ marginLeft: 'auto', color: '#888', fontSize: 12, alignSelf: 'center' }}>
                                  {selectedTrigger
                                      ? t('table_designer.selection.trigger_selected', { name: selectedTrigger.name }, i18nLanguage)
                                      : t('table_designer.selection.trigger_prompt', undefined, i18nLanguage)}
                              </span>
                          </div>
                          {isNewTable && (
                              <div className={'gn-v2-designer-section-note'} style={{ color: '#888', fontSize: 12, marginBottom: 8 }}>
                                  {t('table_designer.notice.new_table_trigger_hint', undefined, i18nLanguage)}
                              </div>
                          )}
                          <Table
                              dataSource={triggers}
                              columns={[
                                  { title: t('table_designer.trigger.column.name', undefined, i18nLanguage), dataIndex: 'name', key: 'name' },
                                  { title: t('table_designer.trigger.column.timing', undefined, i18nLanguage), dataIndex: 'timing', key: 'timing', width: 100 },
                                  { title: t('table_designer.trigger.column.event', undefined, i18nLanguage), dataIndex: 'event', key: 'event', width: 100 },
                              ]}
                              rowKey="name"
                              size="small"
                              pagination={false}
                              loading={triggersLoading}
                              scroll={{ y: tableHeight }}
                              locale={{ emptyText: <Empty description={t('table_designer.empty.triggers', undefined, i18nLanguage)} image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
                              rowSelection={{
                                  type: 'radio',
                                  selectedRowKeys: selectedTrigger ? [selectedTrigger.name] : [],
                                  onChange: (_, selectedRows) => setSelectedTrigger(selectedRows[0] || null),
                                  onSelect: (record, selected) => {
                                      // 点击单选按钮时，如果已选中则取消
                                      if (selectedTrigger?.name === record.name) {
                                          setSelectedTrigger(null);
                                      } else {
                                          setSelectedTrigger(record);
                                      }
                                  },
                              }}
                              onRow={(record) => ({
                                  onClick: () => {
                                      // 点击已选中的行时取消选择
                                      if (selectedTrigger?.name === record.name) {
                                          setSelectedTrigger(null);
                                      } else {
                                          setSelectedTrigger(record);
                                      }
                                  },
                                  style: { cursor: 'pointer' }
                              })}
                          />
                      </div>
                  )
              }
          ] : []),
          ...(!isNewTable ? [{
                  key: 'ddl',
                  label: 'DDL',
                  icon: <FileTextOutlined />,
                  children: (
                  <div className={'gn-v2-designer-ddl-shell'} style={{ height: '100%', minHeight: 320, border: `1px solid ${panelFrameColor}`, borderRadius: panelRadius, background: panelBodyBg }}>
                      <Editor
                          height="100%"
                          language="sql"
                          theme={darkMode ? 'transparent-dark' : 'transparent-light'}
                          value={ddl}
                          options={{
                              readOnly: true,
                              minimap: { enabled: false },
                              fontSize: 14,
                              lineNumbers: 'on',
                              scrollBeyondLastLine: true,
                              wordWrap: 'on',
                              automaticLayout: true,
                              padding: { top: 8, bottom: 24 },
                          }}
                      />
                  </div>
              )
          }] : [])
      ]}
  />
);
