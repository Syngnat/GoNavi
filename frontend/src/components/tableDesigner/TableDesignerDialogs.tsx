import { Space, Checkbox, AutoComplete, Input, Select } from 'antd';
import Modal from '../common/ResizableDraggableModal';
import { t } from '../../i18n';
import {
  resolveColumnDefaultOptions,
  isMySQLCharacterColumnType,
} from '../../utils/columnDefinition';
import { COLLATIONS } from './tableDesignerTypeOptions';
import TableDesignerCopyColumnsModal from '../TableDesignerCopyColumnsModal';
import { noAutoCapInputProps } from '../../utils/inputAutoCap';
import type { IndexKind } from './tableDesignerTypes';
import TableDesignerSqlPreview from '../TableDesignerSqlPreview';
import Editor from '../MonacoEditor';
import type { TableDesignerStateApi } from './hooks/useTableDesignerState';
import type { TableDesignerColumnEditsApi } from './hooks/useTableDesignerColumnEdits';
import type { TableDesignerDialectSupportApi } from './hooks/useTableDesignerDialectSupport';
import type { TableDesignerIndexEditsApi } from './hooks/useTableDesignerIndexEdits';
import type { TableDesignerSaveActionsApi } from './hooks/useTableDesignerSaveActions';
import type { TableDesignerProps } from '../TableDesigner';

export interface TableDesignerDialogsProps {
  commentEditorColumnName: TableDesignerStateApi['commentEditorColumnName'];
  i18nLanguage: TableDesignerStateApi['i18nLanguage'];
  isCommentModalOpen: TableDesignerStateApi['isCommentModalOpen'];
  closeCommentEditor: TableDesignerStateApi['closeCommentEditor'];
  handleSaveColumnOptions: TableDesignerColumnEditsApi['handleSaveColumnOptions'];
  columnDefaultEnabled: TableDesignerStateApi['columnDefaultEnabled'];
  setColumnDefaultEnabled: TableDesignerStateApi['setColumnDefaultEnabled'];
  getDbType: TableDesignerStateApi['getDbType'];
  commentEditorColumnType: TableDesignerStateApi['commentEditorColumnType'];
  columnDefaultValue: TableDesignerStateApi['columnDefaultValue'];
  setColumnDefaultValue: TableDesignerStateApi['setColumnDefaultValue'];
  columnCharset: TableDesignerStateApi['columnCharset'];
  setColumnCharset: TableDesignerStateApi['setColumnCharset'];
  setColumnCollation: TableDesignerStateApi['setColumnCollation'];
  charsetOptions: TableDesignerStateApi['charsetOptions'];
  columnCollation: TableDesignerStateApi['columnCollation'];
  collationOptions: TableDesignerStateApi['collationOptions'];
  commentEditorValue: TableDesignerStateApi['commentEditorValue'];
  setCommentEditorValue: TableDesignerStateApi['setCommentEditorValue'];
  isCopyColumnsModalOpen: TableDesignerStateApi['isCopyColumnsModalOpen'];
  darkMode: TableDesignerStateApi['darkMode'];
  selectedColumns: TableDesignerColumnEditsApi['selectedColumns'];
  tab: TableDesignerProps['tab'];
  selectedSchema: TableDesignerStateApi['selectedSchema'];
  copyColumnsRpcConfig: TableDesignerDialectSupportApi['copyColumnsRpcConfig'];
  charset: TableDesignerStateApi['charset'];
  collation: TableDesignerStateApi['collation'];
  buildCreateTableSql: TableDesignerDialectSupportApi['buildCreateTableSql'];
  handleCopyColumnsExecute: TableDesignerDialectSupportApi['handleCopyColumnsExecute'];
  setIsCopyColumnsModalOpen: TableDesignerStateApi['setIsCopyColumnsModalOpen'];
  isNewTable: TableDesignerStateApi['isNewTable'];
  isTableCommentModalOpen: TableDesignerStateApi['isTableCommentModalOpen'];
  setIsTableCommentModalOpen: TableDesignerStateApi['setIsTableCommentModalOpen'];
  handleSaveTableComment: TableDesignerIndexEditsApi['handleSaveTableComment'];
  tableCommentSaving: TableDesignerStateApi['tableCommentSaving'];
  tableCommentDraft: TableDesignerStateApi['tableCommentDraft'];
  setTableCommentDraft: TableDesignerStateApi['setTableCommentDraft'];
  tableComment: TableDesignerStateApi['tableComment'];
  indexModalMode: TableDesignerStateApi['indexModalMode'];
  isIndexModalOpen: TableDesignerStateApi['isIndexModalOpen'];
  setIsIndexModalOpen: TableDesignerStateApi['setIsIndexModalOpen'];
  handleSubmitIndex: TableDesignerIndexEditsApi['handleSubmitIndex'];
  indexSaving: TableDesignerStateApi['indexSaving'];
  indexForm: TableDesignerStateApi['indexForm'];
  setIndexForm: TableDesignerStateApi['setIndexForm'];
  localColumnOptions: TableDesignerDialectSupportApi['localColumnOptions'];
  getIndexKindOptions: TableDesignerDialectSupportApi['getIndexKindOptions'];
  getFixedIndexType: TableDesignerDialectSupportApi['getFixedIndexType'];
  getIndexTypeOptions: TableDesignerDialectSupportApi['getIndexTypeOptions'];
  indexCreatePreviewSql: TableDesignerIndexEditsApi['indexCreatePreviewSql'];
  foreignKeyModalMode: TableDesignerStateApi['foreignKeyModalMode'];
  isForeignKeyModalOpen: TableDesignerStateApi['isForeignKeyModalOpen'];
  setIsForeignKeyModalOpen: TableDesignerStateApi['setIsForeignKeyModalOpen'];
  handleSubmitForeignKey: TableDesignerSaveActionsApi['handleSubmitForeignKey'];
  foreignKeySaving: TableDesignerStateApi['foreignKeySaving'];
  foreignKeyForm: TableDesignerStateApi['foreignKeyForm'];
  setForeignKeyForm: TableDesignerStateApi['setForeignKeyForm'];
  isPreviewOpen: TableDesignerStateApi['isPreviewOpen'];
  handleExecuteSave: TableDesignerSaveActionsApi['handleExecuteSave'];
  setIsPreviewOpen: TableDesignerStateApi['setIsPreviewOpen'];
  previewSql: TableDesignerStateApi['previewSql'];
  selectedTrigger: TableDesignerStateApi['selectedTrigger'];
  isTriggerModalOpen: TableDesignerStateApi['isTriggerModalOpen'];
  setIsTriggerModalOpen: TableDesignerStateApi['setIsTriggerModalOpen'];
  panelFrameColor: TableDesignerStateApi['panelFrameColor'];
  panelRadius: TableDesignerStateApi['panelRadius'];
  panelBodyBg: TableDesignerStateApi['panelBodyBg'];
  triggerEditMode: TableDesignerStateApi['triggerEditMode'];
  isTriggerEditModalOpen: TableDesignerStateApi['isTriggerEditModalOpen'];
  setIsTriggerEditModalOpen: TableDesignerStateApi['setIsTriggerEditModalOpen'];
  triggerExecuting: TableDesignerStateApi['triggerExecuting'];
  handleExecuteTriggerSql: TableDesignerColumnEditsApi['handleExecuteTriggerSql'];
  triggerEditSql: TableDesignerStateApi['triggerEditSql'];
  setTriggerEditSql: TableDesignerStateApi['setTriggerEditSql'];
}

export const TableDesignerDialogs = ({
  commentEditorColumnName, i18nLanguage, isCommentModalOpen, closeCommentEditor,
  handleSaveColumnOptions, columnDefaultEnabled, setColumnDefaultEnabled, getDbType,
  commentEditorColumnType, columnDefaultValue, setColumnDefaultValue, columnCharset,
  setColumnCharset, setColumnCollation, charsetOptions, columnCollation, collationOptions,
  commentEditorValue, setCommentEditorValue, isCopyColumnsModalOpen, darkMode, selectedColumns, tab,
  selectedSchema, copyColumnsRpcConfig, charset, collation, buildCreateTableSql,
  handleCopyColumnsExecute, setIsCopyColumnsModalOpen, isNewTable, isTableCommentModalOpen,
  setIsTableCommentModalOpen, handleSaveTableComment, tableCommentSaving, tableCommentDraft,
  setTableCommentDraft, tableComment, indexModalMode, isIndexModalOpen, setIsIndexModalOpen,
  handleSubmitIndex, indexSaving, indexForm, setIndexForm, localColumnOptions, getIndexKindOptions,
  getFixedIndexType, getIndexTypeOptions, indexCreatePreviewSql, foreignKeyModalMode,
  isForeignKeyModalOpen, setIsForeignKeyModalOpen, handleSubmitForeignKey, foreignKeySaving,
  foreignKeyForm, setForeignKeyForm, isPreviewOpen, handleExecuteSave, setIsPreviewOpen, previewSql,
  selectedTrigger, isTriggerModalOpen, setIsTriggerModalOpen, panelFrameColor, panelRadius,
  panelBodyBg, triggerEditMode, isTriggerEditModalOpen, setIsTriggerEditModalOpen, triggerExecuting,
  handleExecuteTriggerSql, triggerEditSql, setTriggerEditSql,
}: TableDesignerDialogsProps) => (
  <>
    <Modal
        title={commentEditorColumnName
            ? t('table_designer.modal.column_options_title_named', { name: commentEditorColumnName }, i18nLanguage)
            : t('table_designer.modal.column_options_title', undefined, i18nLanguage)}
        open={isCommentModalOpen}
        onCancel={closeCommentEditor}
        onOk={handleSaveColumnOptions}
        okText={t('table_designer.action.apply', undefined, i18nLanguage)}
        cancelText={t('table_designer.action.cancel', undefined, i18nLanguage)}
        width={640}
        destroyOnHidden
    >
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
            <Space direction="vertical" size={8} style={{ width: '100%' }}>
                <Checkbox
                    checked={columnDefaultEnabled}
                    onChange={(event) => setColumnDefaultEnabled(event.target.checked)}
                >
                    {t('table_designer.column.enable_default', undefined, i18nLanguage)}
                </Checkbox>
                <AutoComplete
                    options={resolveColumnDefaultOptions(getDbType(), commentEditorColumnType)}
                    value={columnDefaultValue}
                    onChange={setColumnDefaultValue}
                    disabled={!columnDefaultEnabled}
                    style={{ width: '100%' }}
                    placeholder={t('table_designer.placeholder.column_default', undefined, i18nLanguage)}
                />
            </Space>
            {getDbType() === 'mysql' && isMySQLCharacterColumnType(commentEditorColumnType) && (
                <Space wrap size={12} style={{ width: '100%' }}>
                    <AutoComplete
                        allowClear
                        value={columnCharset}
                        onChange={(value) => {
                            setColumnCharset(value || undefined);
                            const options = value ? (COLLATIONS as any)[value] : undefined;
                            setColumnCollation(options?.[0]?.value);
                        }}
                        options={charsetOptions}
                        placeholder={t('table_designer.column.charset', undefined, i18nLanguage)}
                        style={{ width: 180 }}
                    />
                    <AutoComplete
                        allowClear
                        value={columnCollation}
                        onChange={(value) => setColumnCollation(value || undefined)}
                        options={columnCharset ? (collationOptions as any)[columnCharset] || [] : []}
                        placeholder={t('table_designer.column.collation', undefined, i18nLanguage)}
                        style={{ width: 260 }}
                    />
                </Space>
            )}
            <Input.TextArea
                value={commentEditorValue}
                onChange={(e) => setCommentEditorValue(e.target.value)}
                autoSize={{ minRows: 5, maxRows: 12 }}
                placeholder={t('table_designer.placeholder.column_comment', undefined, i18nLanguage)}
                maxLength={2000}
            />
        </Space>
    </Modal>

    <TableDesignerCopyColumnsModal
        open={isCopyColumnsModalOpen}
        language={i18nLanguage}
        darkMode={darkMode}
        selectedCount={selectedColumns.length}
        selectedColumns={selectedColumns}
        defaultNewTableName={`${(tab.tableName || 'new_table').trim()}_copy`}
        currentTableName={tab.tableName || ''}
        dbName={tab.dbName || ''}
        dbType={getDbType()}
        selectedSchema={selectedSchema}
        rpcConfig={copyColumnsRpcConfig}
        charset={charset}
        collation={collation}
        charsetOptions={charsetOptions}
        collationOptions={collationOptions}
        showCharsetFields
        buildCreateTableSql={(tableName, nextCharset, nextCollation) => (
            buildCreateTableSql(tableName, selectedColumns, nextCharset, nextCollation)
        )}
        onExecute={handleCopyColumnsExecute}
        onClose={() => setIsCopyColumnsModalOpen(false)}
    />

    <Modal
        title={isNewTable
            ? t('table_designer.modal.table_comment_create_title', undefined, i18nLanguage)
            : t('table_designer.modal.table_comment_title', undefined, i18nLanguage)}
        open={isTableCommentModalOpen}
        onCancel={() => setIsTableCommentModalOpen(false)}
        onOk={handleSaveTableComment}
        okText={isNewTable
            ? t('table_designer.action.apply', undefined, i18nLanguage)
            : t('table_designer.action.save', undefined, i18nLanguage)}
        cancelText={t('table_designer.action.cancel', undefined, i18nLanguage)}
        confirmLoading={!isNewTable && tableCommentSaving}
        width={640}
    >
        <Input.TextArea
            value={tableCommentDraft}
            onChange={(e) => setTableCommentDraft(e.target.value)}
            autoSize={{ minRows: 5, maxRows: 12 }}
            placeholder={t('table_designer.placeholder.table_comment', undefined, i18nLanguage)}
            maxLength={2048}
        />
        <div style={{ marginTop: 8, color: '#888', fontSize: 12 }}>
            {isNewTable
                ? t('table_designer.notice.new_table_comment_hint', undefined, i18nLanguage)
                : t('table_designer.table_comment.current', {
                    comment: tableComment || t('table_designer.fallback.empty', undefined, i18nLanguage),
                }, i18nLanguage)}
        </div>
    </Modal>

    <Modal
        title={indexModalMode === 'create'
            ? t('table_designer.modal.index_create_title', undefined, i18nLanguage)
            : t('table_designer.modal.index_edit_title', undefined, i18nLanguage)}
        open={isIndexModalOpen}
        onCancel={() => setIsIndexModalOpen(false)}
        onOk={handleSubmitIndex}
        okText={indexModalMode === 'create' ? t('table_designer.action.create', undefined, i18nLanguage) : t('table_designer.action.save', undefined, i18nLanguage)}
        cancelText={t('table_designer.action.cancel', undefined, i18nLanguage)}
        confirmLoading={indexSaving}
        width={620}
    >
        <Space direction="vertical" size={10} style={{ width: '100%' }}>
            <Input
                {...noAutoCapInputProps}
                placeholder={indexForm.kind === 'PRIMARY'
                    ? t('table_designer.placeholder.primary_index_name', undefined, i18nLanguage)
                    : t('table_designer.placeholder.index_name', undefined, i18nLanguage)}
                value={indexForm.name}
                onChange={(e) => setIndexForm(prev => ({ ...prev, name: e.target.value }))}
                maxLength={128}
                disabled={indexForm.kind === 'PRIMARY'}
            />
            <Select
                mode="multiple"
                allowClear
                placeholder={t('table_designer.placeholder.index_columns', undefined, i18nLanguage)}
                value={indexForm.columnNames}
                onChange={(vals) => setIndexForm(prev => ({ ...prev, columnNames: vals }))}
                options={localColumnOptions}
                style={{ width: '100%' }}
            />
            <Space wrap>
                <Select
                    value={indexForm.kind}
                    options={getIndexKindOptions()}
                    onChange={(val: IndexKind) => {
                        const fixedType = getFixedIndexType(val);
                        if (fixedType) {
                            // 固定类型（PRIMARY/FULLTEXT/SPATIAL）直接设置对应的索引方法
                            setIndexForm(prev => ({
                                ...prev,
                                kind: val,
                                name: val === 'PRIMARY' ? 'PRIMARY' : (prev.name === 'PRIMARY' ? '' : prev.name),
                                indexType: fixedType,
                            }));
                        } else {
                            const nextTypeOptions = getIndexTypeOptions(val);
                            const currentType = indexForm.indexType || 'DEFAULT';
                            const isCurrentTypeValid = nextTypeOptions.some(opt => opt.value === currentType);
                            setIndexForm(prev => ({
                                ...prev,
                                kind: val,
                                name: val === 'PRIMARY' ? 'PRIMARY' : (prev.name === 'PRIMARY' ? '' : prev.name),
                                indexType: isCurrentTypeValid ? currentType : 'DEFAULT',
                            }));
                        }
                    }}
                    style={{ width: 220 }}
                />
                <Select
                    value={indexForm.indexType}
                    onChange={(val) => setIndexForm(prev => ({ ...prev, indexType: val }))}
                    options={getIndexTypeOptions(indexForm.kind)}
                    style={{ width: 160 }}
                    disabled={indexForm.kind === 'PRIMARY' || indexForm.kind === 'FULLTEXT' || indexForm.kind === 'SPATIAL'}
                />
            </Space>
            <div style={{ color: '#888', fontSize: 12 }}>
                {t(isNewTable
                    ? 'table_designer.notice.new_table_index_hint'
                    : 'table_designer.notice.index_restore_hint', undefined, i18nLanguage)}
            </div>
            <div style={{ width: '100%' }}>
                <div style={{ color: '#666', fontSize: 12, marginBottom: 6 }}>{t('table_designer.label.create_statement_plain', undefined, i18nLanguage)}</div>
                <TableDesignerSqlPreview sql={indexCreatePreviewSql} darkMode={darkMode} height="180px" />
            </div>
        </Space>
    </Modal>

    <Modal
        title={foreignKeyModalMode === 'create'
            ? t('table_designer.modal.foreign_key_create_title', undefined, i18nLanguage)
            : t('table_designer.modal.foreign_key_edit_title', undefined, i18nLanguage)}
        open={isForeignKeyModalOpen}
        onCancel={() => setIsForeignKeyModalOpen(false)}
        onOk={handleSubmitForeignKey}
        okText={foreignKeyModalMode === 'create' ? t('table_designer.action.create', undefined, i18nLanguage) : t('table_designer.action.save', undefined, i18nLanguage)}
        cancelText={t('table_designer.action.cancel', undefined, i18nLanguage)}
        confirmLoading={foreignKeySaving}
        width={700}
    >
        <Space direction="vertical" size={10} style={{ width: '100%' }}>
            <Input
                {...noAutoCapInputProps}
                placeholder={t('table_designer.placeholder.foreign_key_name', undefined, i18nLanguage)}
                value={foreignKeyForm.constraintName}
                onChange={(e) => setForeignKeyForm(prev => ({ ...prev, constraintName: e.target.value }))}
                maxLength={128}
            />
            <Select
                mode="multiple"
                allowClear
                placeholder={t('table_designer.placeholder.local_columns', undefined, i18nLanguage)}
                value={foreignKeyForm.columnNames}
                onChange={(vals) => setForeignKeyForm(prev => ({ ...prev, columnNames: vals }))}
                options={localColumnOptions}
                style={{ width: '100%' }}
            />
            <Input
                {...noAutoCapInputProps}
                placeholder={t('table_designer.placeholder.ref_table', undefined, i18nLanguage)}
                value={foreignKeyForm.refTableName}
                onChange={(e) => setForeignKeyForm(prev => ({ ...prev, refTableName: e.target.value }))}
                maxLength={256}
            />
            <Select
                mode="tags"
                tokenSeparators={[',', ' ']}
                placeholder={t('table_designer.placeholder.ref_columns', undefined, i18nLanguage)}
                value={foreignKeyForm.refColumnNames}
                onChange={(vals) => setForeignKeyForm(prev => ({ ...prev, refColumnNames: vals }))}
                style={{ width: '100%' }}
            />
            <div style={{ color: '#888', fontSize: 12 }}>
                {t(isNewTable
                    ? 'table_designer.notice.new_table_foreign_key_hint'
                    : 'table_designer.notice.foreign_key_replace_hint', undefined, i18nLanguage)}
            </div>
        </Space>
    </Modal>

    <Modal
        title={t('table_designer.modal.confirm_sql_title', undefined, i18nLanguage)}
        open={isPreviewOpen}
        onOk={handleExecuteSave}
        onCancel={() => setIsPreviewOpen(false)}
        width={700}
        okText={t('table_designer.action.execute', undefined, i18nLanguage)}
        cancelText={t('table_designer.action.cancel', undefined, i18nLanguage)}
    >
        <TableDesignerSqlPreview sql={previewSql} darkMode={darkMode} />
        <p style={{ marginTop: 10, color: '#faad14' }}>{t('table_designer.notice.sql_irreversible', undefined, i18nLanguage)}</p>
    </Modal>

    <Modal
        title={selectedTrigger
            ? t('table_designer.modal.trigger_detail_title_named', { name: selectedTrigger.name }, i18nLanguage)
            : t('table_designer.modal.trigger_detail_title', undefined, i18nLanguage)}
        open={isTriggerModalOpen}
        onCancel={() => setIsTriggerModalOpen(false)}
        footer={null}
        width={700}
    >
        {selectedTrigger && (
            <div>
                <div style={{ marginBottom: 12, display: 'flex', gap: 24 }}>
                    <span><strong>{t('table_designer.trigger.field.timing', undefined, i18nLanguage)}:</strong> {selectedTrigger.timing}</span>
                    <span><strong>{t('table_designer.trigger.field.event', undefined, i18nLanguage)}:</strong> {selectedTrigger.event}</span>
                </div>
                <div style={{ border: `1px solid ${panelFrameColor}`, borderRadius: panelRadius, background: panelBodyBg }}>
                    <Editor
                        height="350px"
                        language="sql"
                        theme={darkMode ? 'transparent-dark' : 'transparent-light'}
                        value={selectedTrigger.statement}
                        options={{
                            readOnly: true,
                            minimap: { enabled: false },
                            fontSize: 14,
                            lineNumbers: 'on',
                            scrollBeyondLastLine: false,
                            wordWrap: 'on',
                            automaticLayout: true,
                        }}
                    />
                </div>
            </div>
        )}
    </Modal>

    <Modal
        title={triggerEditMode === 'create'
            ? t('table_designer.modal.trigger_create_title', undefined, i18nLanguage)
            : t('table_designer.modal.trigger_edit_title', undefined, i18nLanguage)}
        open={isTriggerEditModalOpen}
        onCancel={() => setIsTriggerEditModalOpen(false)}
        width={800}
        okText={triggerEditMode === 'create' ? t('table_designer.action.create', undefined, i18nLanguage) : t('table_designer.action.save', undefined, i18nLanguage)}
        cancelText={t('table_designer.action.cancel', undefined, i18nLanguage)}
        confirmLoading={triggerExecuting}
        onOk={handleExecuteTriggerSql}
    >
        <div style={{ marginBottom: 8, color: '#888', fontSize: 12 }}>
            {isNewTable
                ? t('table_designer.notice.new_table_trigger_hint', undefined, i18nLanguage)
                : (triggerEditMode === 'edit' && selectedTrigger
                    ? t('table_designer.notice.trigger_replace_hint', undefined, i18nLanguage)
                    : null)}
        </div>
        <div style={{ border: `1px solid ${panelFrameColor}`, borderRadius: panelRadius, background: panelBodyBg }}>
            <Editor
                height="350px"
                language="sql"
                theme={darkMode ? 'vs-dark' : 'light'}
                value={triggerEditSql}
                onChange={(val) => setTriggerEditSql(val || '')}
                options={{
                    minimap: { enabled: false },
                    fontSize: 14,
                    lineNumbers: 'on',
                    scrollBeyondLastLine: false,
                    wordWrap: 'on',
                    automaticLayout: true,
                }}
            />
        </div>
        {!isNewTable && (
            <p style={{ marginTop: 10, color: '#faad14' }}>{t('table_designer.notice.sql_statement_irreversible', undefined, i18nLanguage)}</p>
        )}
    </Modal>
  </>
);
