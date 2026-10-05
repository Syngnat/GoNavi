import { Select, Input, Button } from 'antd';
import {
  SaveOutlined,
  ReloadOutlined,
  EditOutlined,
  PlusOutlined,
  CopyOutlined,
  SnippetsOutlined,
  TableOutlined,
} from '@ant-design/icons';
import { t } from '../../i18n';
import { noAutoCapInputProps } from '../../utils/inputAutoCap';
import { resolveTableDesignerSchema } from '../tableDesignerSchemaContext';
import { COLLATIONS } from './tableDesignerTypeOptions';
import type { TableDesignerStateApi } from './hooks/useTableDesignerState';
import type { TableDesignerTriggerListApi } from './hooks/useTableDesignerTriggerList';
import type { TableDesignerSaveActionsApi } from './hooks/useTableDesignerSaveActions';
import type { TableDesignerDialectSupportApi } from './hooks/useTableDesignerDialectSupport';
import type { TableDesignerIndexEditsApi } from './hooks/useTableDesignerIndexEdits';
import type { TableDesignerColumnEditsApi } from './hooks/useTableDesignerColumnEdits';
import type { TableDesignerProps } from '../TableDesigner';

export interface TableDesignerToolbarProps {
  panelToolbarBorder: TableDesignerStateApi['panelToolbarBorder'];
  embedded: Exclude<TableDesignerProps['embedded'], undefined>;
  panelRadius: TableDesignerStateApi['panelRadius'];
  panelFrameColor: TableDesignerStateApi['panelFrameColor'];
  panelToolbarBg: TableDesignerStateApi['panelToolbarBg'];
  supportsTableDesignerSchemaSelection: TableDesignerTriggerListApi['supportsTableDesignerSchemaSelection'];
  i18nLanguage: TableDesignerStateApi['i18nLanguage'];
  designerSchemaTitle: TableDesignerStateApi['designerSchemaTitle'];
  schemaLoading: TableDesignerStateApi['schemaLoading'];
  schemaReady: TableDesignerStateApi['schemaReady'];
  schemaOptions: TableDesignerStateApi['schemaOptions'];
  handleSchemaChange: TableDesignerTriggerListApi['handleSchemaChange'];
  isNewTable: TableDesignerStateApi['isNewTable'];
  newTableName: TableDesignerStateApi['newTableName'];
  setNewTableName: TableDesignerStateApi['setNewTableName'];
  selectedSchema: TableDesignerStateApi['selectedSchema'];
  getDbType: TableDesignerStateApi['getDbType'];
  latestSelectedSchemaRef: TableDesignerStateApi['latestSelectedSchemaRef'];
  setSelectedSchema: TableDesignerStateApi['setSelectedSchema'];
  setTableDesignerSchema: TableDesignerStateApi['setTableDesignerSchema'];
  tab: TableDesignerProps['tab'];
  isTDengineNewTable: TableDesignerStateApi['isTDengineNewTable'];
  charset: TableDesignerStateApi['charset'];
  setCharset: TableDesignerStateApi['setCharset'];
  setCollation: TableDesignerStateApi['setCollation'];
  charsetOptions: TableDesignerStateApi['charsetOptions'];
  collation: TableDesignerStateApi['collation'];
  collationOptions: TableDesignerStateApi['collationOptions'];
  readOnly: TableDesignerStateApi['readOnly'];
  generateDDL: TableDesignerSaveActionsApi['generateDDL'];
  metadataLoading: TableDesignerStateApi['metadataLoading'];
  handleRefreshDesigner: TableDesignerSaveActionsApi['handleRefreshDesigner'];
  supportsTableCommentOps: TableDesignerDialectSupportApi['supportsTableCommentOps'];
  openTableCommentModal: TableDesignerIndexEditsApi['openTableCommentModal'];
  isTDengineChildNewTable: TableDesignerDialectSupportApi['isTDengineChildNewTable'];
  handleAddColumn: TableDesignerColumnEditsApi['handleAddColumn'];
  handleAddColumnAfterSelected: TableDesignerColumnEditsApi['handleAddColumnAfterSelected'];
  selectedColumnRowKeys: TableDesignerStateApi['selectedColumnRowKeys'];
  columnClipboard: TableDesignerColumnEditsApi['columnClipboard'];
  selectedColumns: TableDesignerColumnEditsApi['selectedColumns'];
  openCopySelectedColumnsModal: TableDesignerColumnEditsApi['openCopySelectedColumnsModal'];
}

export const TableDesignerToolbar = ({
  panelToolbarBorder, embedded, panelRadius, panelFrameColor, panelToolbarBg,
  supportsTableDesignerSchemaSelection, i18nLanguage, designerSchemaTitle, schemaLoading,
  schemaReady, schemaOptions, handleSchemaChange, isNewTable, newTableName, setNewTableName,
  selectedSchema, getDbType, latestSelectedSchemaRef, setSelectedSchema, setTableDesignerSchema,
  tab, isTDengineNewTable, charset, setCharset, setCollation, charsetOptions, collation,
  collationOptions, readOnly, generateDDL, metadataLoading, handleRefreshDesigner,
  supportsTableCommentOps, openTableCommentModal, isTDengineChildNewTable, handleAddColumn,
  handleAddColumnAfterSelected, selectedColumnRowKeys, columnClipboard, selectedColumns,
  openCopySelectedColumnsModal,
}: TableDesignerToolbarProps) => (
  <div
      className={'gn-v2-designer-toolbar'}
      style={{
          padding: '10px 12px 8px 12px',
          borderBottom: `1px solid ${panelToolbarBorder}`,
          borderTopLeftRadius: embedded ? 0 : panelRadius,
          borderTopRightRadius: embedded ? 0 : panelRadius,
          borderLeft: `1px solid ${panelFrameColor}`,
          borderRight: `1px solid ${panelFrameColor}`,
          borderTop: embedded ? 'none' : `1px solid ${panelFrameColor}`,
          background: panelToolbarBg,
          display: 'flex',
          gap: '8px',
          alignItems: 'center'
      }}
  >
      {supportsTableDesignerSchemaSelection && (
          <Select
              aria-label={t('data_sync.field.schema', undefined, i18nLanguage)}
              value={designerSchemaTitle || undefined}
              placeholder={t('data_sync.field.schema', undefined, i18nLanguage)}
              loading={schemaLoading}
              disabled={!schemaReady}
              showSearch
              optionFilterProp="label"
              options={designerSchemaTitle && !schemaOptions.some(option => option.value === designerSchemaTitle)
                  ? [{ label: designerSchemaTitle, value: designerSchemaTitle }, ...schemaOptions]
                  : schemaOptions}
              onChange={handleSchemaChange}
              style={{ minWidth: 150 }}
              popupMatchSelectWidth={false}
          />
      )}
      {isNewTable && (
          <>
              <Input
                  {...noAutoCapInputProps}
                  placeholder={t('table_designer.placeholder.table_name', undefined, i18nLanguage)}
                  value={newTableName}
                  onChange={e => {
                      const nextTableName = e.target.value;
                      setNewTableName(nextTableName);
                      const explicitSchema = resolveTableDesignerSchema(nextTableName, selectedSchema, getDbType());
                      if (explicitSchema && explicitSchema !== selectedSchema) {
                          latestSelectedSchemaRef.current = explicitSchema;
                          setSelectedSchema(explicitSchema);
                          setTableDesignerSchema?.(tab.connectionId, explicitSchema);
                      }
                  }}
                  style={{ width: 150 }}
              />
              {!isTDengineNewTable && (
                  <>
                      <Select
                          value={charset}
                          onChange={v => {
                              setCharset(v);
                              // Set default collation
                              const cols = (COLLATIONS as any)[v];
                              if (cols && cols.length > 0) setCollation(cols[0].value);
                          }}
                          options={charsetOptions}
                          style={{ width: 120 }}
                      />
                      <Select
                          value={collation}
                          onChange={setCollation}
                          options={(collationOptions as any)[charset] || []}
                          style={{ width: 150 }}
                      />
                  </>
              )}
          </>
      )}
      {!readOnly && <Button size="small" icon={<SaveOutlined />} type="primary" disabled={supportsTableDesignerSchemaSelection && !schemaReady} onClick={generateDDL}>{t('table_designer.action.save', undefined, i18nLanguage)}</Button>}
      {!isNewTable && <Button size="small" icon={<ReloadOutlined />} loading={metadataLoading} onClick={handleRefreshDesigner}>{t('table_designer.action.refresh', undefined, i18nLanguage)}</Button>}
      {!readOnly && supportsTableCommentOps() && (
          <Button size="small" icon={<EditOutlined />} onClick={openTableCommentModal}>{t('table_designer.action.table_comment', undefined, i18nLanguage)}</Button>
      )}
      {!readOnly && !isTDengineChildNewTable && <Button size="small" icon={<PlusOutlined />} onClick={() => handleAddColumn()}>{t('table_designer.action.add_column', undefined, i18nLanguage)}</Button>}
      {!readOnly && !isTDengineChildNewTable && (
          <Button
              size="small"
              icon={<PlusOutlined />}
              onClick={handleAddColumnAfterSelected}
              disabled={selectedColumnRowKeys.length === 0}
          >
              {t('table_designer.action.add_after_selected', undefined, i18nLanguage)}
          </Button>
      )}
      {!isTDengineChildNewTable && (
          <Button
              size="small"
              icon={<CopyOutlined />}
              onClick={() => { void columnClipboard.copySelected(); }}
              disabled={selectedColumns.length === 0}
          >
              {t('table_designer.action.copy_columns', undefined, i18nLanguage)}
          </Button>
      )}
      {!readOnly && !isTDengineChildNewTable && (
          <Button
              size="small"
              icon={<SnippetsOutlined />}
              onClick={() => { void columnClipboard.pasteFromClipboard(); }}
          >
              {t('table_designer.action.paste_columns', undefined, i18nLanguage)}
          </Button>
      )}
      {!readOnly && !isTDengineChildNewTable && (
          <Button
              size="small"
              icon={<TableOutlined />}
              onClick={openCopySelectedColumnsModal}
              disabled={selectedColumns.length === 0}
          >
              {t('table_designer.action.copy_columns_to_table', undefined, i18nLanguage)}
          </Button>
      )}
      <div style={{ flex: 1 }} />
  </div>
);
