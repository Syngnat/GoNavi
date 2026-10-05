import { Button, Input, Segmented, Form } from 'antd';
import Modal from '../common/ResizableDraggableModal';
import { t as translate } from '../../i18n';
import type { QueryEditorAiApplyMode } from './QueryEditorAiAssist';
import SqlSnippetPickerModal from './SqlSnippetPickerModal';
import DuckDBAttachPickerModal from './DuckDBAttachPickerModal';
import type { QueryEditorConnectionContextApi } from './hooks/useQueryEditorConnectionContext';
import type { QueryEditorCoreStateApi } from './hooks/useQueryEditorCoreState';
import type { QueryEditorAiAssistActionsApi } from './hooks/useQueryEditorAiAssistActions';
import type { QueryEditorShortcutsAndSnippetsApi } from './hooks/useQueryEditorShortcutsAndSnippets';
import type { QueryEditorDraftSyncApi } from './hooks/useQueryEditorDraftSync';
import type { QueryEditorResultTabsApi } from './hooks/useQueryEditorResultTabs';

export interface QueryEditorDialogsProps {
  isElasticsearchMode: QueryEditorConnectionContextApi['isElasticsearchMode'];
  isTextToSqlModalOpen: QueryEditorCoreStateApi['isTextToSqlModalOpen'];
  textToSqlGenerating: QueryEditorCoreStateApi['textToSqlGenerating'];
  setIsTextToSqlModalOpen: QueryEditorCoreStateApi['setIsTextToSqlModalOpen'];
  handleGenerateTextToSql: QueryEditorAiAssistActionsApi['handleGenerateTextToSql'];
  darkMode: QueryEditorConnectionContextApi['darkMode'];
  textToSqlInstruction: QueryEditorCoreStateApi['textToSqlInstruction'];
  setTextToSqlInstruction: QueryEditorCoreStateApi['setTextToSqlInstruction'];
  textToSqlApplyMode: QueryEditorCoreStateApi['textToSqlApplyMode'];
  setTextToSqlApplyMode: QueryEditorCoreStateApi['setTextToSqlApplyMode'];
  isSqlSnippetPickerOpen: QueryEditorCoreStateApi['isSqlSnippetPickerOpen'];
  sqlSnippetPickerKeyword: QueryEditorCoreStateApi['sqlSnippetPickerKeyword'];
  setSqlSnippetPickerKeyword: QueryEditorCoreStateApi['setSqlSnippetPickerKeyword'];
  filteredSqlSnippets: QueryEditorShortcutsAndSnippetsApi['filteredSqlSnippets'];
  sqlSnippetPickerEmptyLabel: QueryEditorShortcutsAndSnippetsApi['sqlSnippetPickerEmptyLabel'];
  handleInsertSqlSnippet: QueryEditorDraftSyncApi['handleInsertSqlSnippet'];
  handleOpenSnippetSettingsFromPicker: QueryEditorShortcutsAndSnippetsApi['handleOpenSnippetSettingsFromPicker'];
  handleCloseSqlSnippetPicker: QueryEditorShortcutsAndSnippetsApi['handleCloseSqlSnippetPicker'];
  isDuckDBAttachPickerOpen: QueryEditorCoreStateApi['isDuckDBAttachPickerOpen'];
  connections: QueryEditorConnectionContextApi['connections'];
  currentConnectionConfig: QueryEditorConnectionContextApi['currentConnectionConfig'];
  currentDb: QueryEditorCoreStateApi['currentDb'];
  setIsDuckDBAttachPickerOpen: QueryEditorCoreStateApi['setIsDuckDBAttachPickerOpen'];
  handleInsertDuckDBAttachStatement: QueryEditorDraftSyncApi['handleInsertDuckDBAttachStatement'];
  saveModalMode: QueryEditorCoreStateApi['saveModalMode'];
  isSaveModalOpen: QueryEditorCoreStateApi['isSaveModalOpen'];
  handleSave: QueryEditorResultTabsApi['handleSave'];
  setIsSaveModalOpen: QueryEditorCoreStateApi['setIsSaveModalOpen'];
  saveQueryNameInputRef: QueryEditorCoreStateApi['saveQueryNameInputRef'];
  saveForm: QueryEditorCoreStateApi['saveForm'];
}

export const QueryEditorDialogs = ({
  isElasticsearchMode, isTextToSqlModalOpen, textToSqlGenerating, setIsTextToSqlModalOpen,
  handleGenerateTextToSql, darkMode, textToSqlInstruction, setTextToSqlInstruction,
  textToSqlApplyMode, setTextToSqlApplyMode, isSqlSnippetPickerOpen, sqlSnippetPickerKeyword,
  setSqlSnippetPickerKeyword, filteredSqlSnippets, sqlSnippetPickerEmptyLabel,
  handleInsertSqlSnippet, handleOpenSnippetSettingsFromPicker, handleCloseSqlSnippetPicker,
  isDuckDBAttachPickerOpen, connections, currentConnectionConfig, currentDb,
  setIsDuckDBAttachPickerOpen, handleInsertDuckDBAttachStatement, saveModalMode, isSaveModalOpen,
  handleSave, setIsSaveModalOpen, saveQueryNameInputRef, saveForm,
}: QueryEditorDialogsProps) => (
  <>
    <Modal
      title={translate(isElasticsearchMode
        ? 'query_editor.elasticsearch.ai_title'
        : 'query_editor.text_to_sql.title')}
      open={isTextToSqlModalOpen}
      centered
      mask={false}
      maskClosable={!textToSqlGenerating}
      width={640}
      draggable
      resizable
      minResizableWidth={480}
      minResizableHeight={320}
      onCancel={() => {
        if (!textToSqlGenerating) {
          setIsTextToSqlModalOpen(false);
        }
      }}
      footer={[
        <Button key="cancel" disabled={textToSqlGenerating} onClick={() => setIsTextToSqlModalOpen(false)}>
          {translate('common.cancel')}
        </Button>,
        <Button key="generate" type="primary" loading={textToSqlGenerating} onClick={handleGenerateTextToSql}>
          {translate(isElasticsearchMode
            ? 'query_editor.elasticsearch.action.ai_generate'
            : 'query_editor.text_to_sql.generate')}
        </Button>,
      ]}
      styles={{
        content: {
          borderRadius: 16,
          border: darkMode ? '1px solid rgba(255,255,255,0.12)' : '1px solid rgba(15,23,42,0.12)',
          background: darkMode ? 'rgba(18,18,20,0.98)' : 'rgba(255,255,255,0.98)',
          boxShadow: darkMode ? '0 24px 60px rgba(0,0,0,0.45)' : '0 24px 60px rgba(15,23,42,0.16)',
          backdropFilter: 'blur(12px)',
        },
        header: {
          background: 'transparent',
          borderBottom: 'none',
          paddingBottom: 8,
        },
        body: {
          paddingTop: 8,
          paddingBottom: 16,
        },
      }}
    >
      <div
        data-query-editor-text-to-sql-modal="true"
        style={{ display: 'flex', flexDirection: 'column', gap: 14 }}
      >
        <div style={{ fontSize: 12, lineHeight: 1.6, color: darkMode ? 'rgba(255,255,255,0.65)' : 'rgba(16,24,40,0.6)' }}>
          {translate(isElasticsearchMode
            ? 'query_editor.elasticsearch.ai_read_only_hint'
            : 'query_editor.text_to_sql.description')}
        </div>
        <Input.TextArea
          autoFocus
          value={textToSqlInstruction}
          onChange={(event) => setTextToSqlInstruction(event.target.value)}
          placeholder={translate(isElasticsearchMode
            ? 'query_editor.elasticsearch.ai_placeholder'
            : 'query_editor.text_to_sql.placeholder')}
          autoSize={{ minRows: 5, maxRows: 10 }}
          disabled={textToSqlGenerating}
        />
        <Segmented
          value={textToSqlApplyMode}
          onChange={(value) => setTextToSqlApplyMode(value as QueryEditorAiApplyMode)}
          disabled={textToSqlGenerating}
          options={[
            { label: translate('query_editor.text_to_sql.mode.insert'), value: 'insert' },
            { label: translate('query_editor.text_to_sql.mode.replace_selection'), value: 'replaceSelection' },
            { label: translate('query_editor.text_to_sql.mode.replace_all'), value: 'replaceAll' },
          ]}
        />
      </div>
    </Modal>

    <SqlSnippetPickerModal
      open={isSqlSnippetPickerOpen}
      darkMode={darkMode}
      keyword={sqlSnippetPickerKeyword}
      onKeywordChange={setSqlSnippetPickerKeyword}
      filteredSnippets={filteredSqlSnippets}
      emptyLabel={sqlSnippetPickerEmptyLabel}
      onInsertSnippet={handleInsertSqlSnippet}
      onManageSnippets={handleOpenSnippetSettingsFromPicker}
      onClose={handleCloseSqlSnippetPicker}
    />
    <DuckDBAttachPickerModal
      open={isDuckDBAttachPickerOpen}
      connections={connections}
      darkMode={darkMode}
      hostConnectionConfig={currentConnectionConfig}
      hostDbName={currentDb}
      onClose={() => setIsDuckDBAttachPickerOpen(false)}
      onInsert={handleInsertDuckDBAttachStatement}
    />
    <Modal
      title={translate(
        saveModalMode === 'rename'
          ? 'query_editor.save_modal.rename_title'
          : saveModalMode === 'saveAs'
            ? 'query_editor.save_modal.save_as_title'
            : 'query_editor.save_modal.title',
      )}
      open={isSaveModalOpen}
      onOk={handleSave}
      onCancel={() => setIsSaveModalOpen(false)}
      okText={translate(
        saveModalMode === 'rename'
          ? 'query_editor.save_modal.rename_ok'
          : saveModalMode === 'saveAs'
            ? 'query_editor.action.save_as'
            : 'common.save',
      )}
      cancelText={translate('common.cancel')}
      afterOpenChange={(open) => {
        if (open) {
          saveQueryNameInputRef.current?.focus({ cursor: 'all' });
        }
      }}
    >
        <Form form={saveForm} layout="vertical">
            <Form.Item name="name" label={translate('query_editor.save_modal.name_label')} rules={[{ required: true, message: translate('query_editor.save_modal.name_required') }]}>
                <Input ref={saveQueryNameInputRef} placeholder={translate('query_editor.save_modal.name_placeholder')} />
            </Form.Item>
        </Form>
    </Modal>
  </>
);
