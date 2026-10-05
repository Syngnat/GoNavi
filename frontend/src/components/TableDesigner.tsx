import React from 'react';
import { TableOutlined, FolderOpenOutlined } from '@ant-design/icons';
import { TabData } from '../types';
import { t } from '../i18n';
import type {
  EditableColumn,
  SchemaExecutionOptions,
  SchemaExecutionResult,
} from './tableDesigner/tableDesignerTypes';
import { useTableDesignerState } from './tableDesigner/hooks/useTableDesignerState';
import { useTableDesignerDataLoad } from './tableDesigner/hooks/useTableDesignerDataLoad';
import { useTableDesignerTriggerList } from './tableDesigner/hooks/useTableDesignerTriggerList';
import { useTableDesignerColumnEdits } from './tableDesigner/hooks/useTableDesignerColumnEdits';
import {
    useTableDesignerDialectSupport,
} from './tableDesigner/hooks/useTableDesignerDialectSupport';
import { useTableDesignerIndexEdits } from './tableDesigner/hooks/useTableDesignerIndexEdits';
import { useTableDesignerSaveActions } from './tableDesigner/hooks/useTableDesignerSaveActions';
import { useTableDesignerTabContents } from './tableDesigner/hooks/useTableDesignerTabContents';
import { useLateBoundCallback } from '../hooks/useLateBoundCallback';
import { TABLE_DESIGNER_SHELL_CSS } from './tableDesigner/tableDesignerShellStyles';
import { TableDesignerToolbar } from './tableDesigner/TableDesignerToolbar';
import { TableDesignerTabs } from './tableDesigner/TableDesignerTabs';
import { TableDesignerDialogs } from './tableDesigner/TableDesignerDialogs';

export interface TableDesignerProps { tab: TabData; embedded?: boolean }

const TableDesigner: React.FC<TableDesignerProps> = ({ tab, embedded = false }) => {
  const {
      isNewTable, columns, setColumns, originalColumns, setOriginalColumns, indexes, setIndexes,
      fks, setFks, triggers, setTriggers, ddl, setDdl, newTableName, setNewTableName, schemaOptions,
      setSchemaOptions, selectedSchema, setSelectedSchema, schemaSelectionOverride,
      setSchemaSelectionOverride, schemaReady, setSchemaReady, schemaLoading, setSchemaLoading,
      charset, setCharset, collation, setCollation, starRocksTableKind, setStarRocksTableKind,
      starRocksKeyModel, setStarRocksKeyModel, starRocksKeyColumns, setStarRocksKeyColumns,
      starRocksPartitionClause, setStarRocksPartitionClause, starRocksDistributionType,
      setStarRocksDistributionType, starRocksDistributionColumns, setStarRocksDistributionColumns,
      starRocksBucketMode, setStarRocksBucketMode, starRocksBucketCount, setStarRocksBucketCount,
      starRocksProperties, setStarRocksProperties, starRocksRollups, setStarRocksRollups,
      starRocksExternalEngine, setStarRocksExternalEngine, starRocksExternalProperties,
      setStarRocksExternalProperties, tdengineTableKind, setTdengineTableKind, tdengineStableName,
      setTdengineStableName, tdengineTagDefinitions, setTdengineTagDefinitions, tdengineTagValues,
      setTdengineTagValues, tdengineStableOptions, setTdengineStableOptions,
      tdengineStableOptionsLoading, setTdengineStableOptionsLoading, tdengineChildTagDefs,
      setTdengineChildTagDefs, tdengineChildTagValues, setTdengineChildTagValues,
      tdengineChildTagDefsLoading, setTdengineChildTagDefsLoading, columnsLoading,
      setColumnsLoading, indexesLoading, setIndexesLoading, foreignKeysLoading,
      setForeignKeysLoading, triggersLoading, setTriggersLoading, setDdlLoading, previewSql,
      setPreviewSql, isPreviewOpen, setIsPreviewOpen, activeKey, setActiveKey,
      selectedColumnRowKeys, setSelectedColumnRowKeys, isCopyColumnsModalOpen,
      setIsCopyColumnsModalOpen, tableComment, setTableComment, tableCommentDraft,
      setTableCommentDraft, isTableCommentModalOpen, setIsTableCommentModalOpen, tableCommentSaving,
      setTableCommentSaving, selectedIndexKeys, setSelectedIndexKeys, isIndexModalOpen,
      setIsIndexModalOpen, indexModalMode, setIndexModalMode, indexSaving, setIndexSaving,
      indexForm, setIndexForm, selectedForeignKey, setSelectedForeignKey, isForeignKeyModalOpen,
      setIsForeignKeyModalOpen, foreignKeyModalMode, setForeignKeyModalMode, foreignKeySaving,
      setForeignKeySaving, foreignKeyForm, setForeignKeyForm, selectedTrigger, setSelectedTrigger,
      isTriggerModalOpen, setIsTriggerModalOpen, isTriggerEditModalOpen, setIsTriggerEditModalOpen,
      triggerEditMode, setTriggerEditMode, triggerEditSql, setTriggerEditSql, triggerExecuting,
      setTriggerExecuting, isCommentModalOpen, commentEditorColumnKey, commentEditorColumnName,
      commentEditorColumnType, commentEditorValue, setCommentEditorValue, columnDefaultEnabled,
      setColumnDefaultEnabled, columnDefaultValue, setColumnDefaultValue, columnCharset,
      setColumnCharset, columnCollation, setColumnCollation, connections, addTab, setActiveContext,
      tableDesignerSchemaByConnection, setTableDesignerSchema, i18nLanguage, darkMode,
      dataTableVerticalBorderRule, resizeGuideColor, readOnly, isPgLikeDialect, isOracleLikeDialect,
      isSqlServerDialect, isMysqlLikeDialect, isNonRelationalDialect, lacksAlterForeignKeySupport,
      quoteIdentifierPartByDialect, quoteIdentifierPathByDialect, getDbType, isTDengineNewTable,
      resolveTableInfo, resolvePreviewTableInfo, hasUnsavedDraftChanges, designerTableTitle,
      designerDbTitle, designerSchemaTitle, designerColumnSummary, metadataLoading, charsetOptions,
      collationOptions, panelRadius, panelFrameColor, panelToolbarBorder, panelToolbarBg,
      panelBodyBg, focusRowBg, containerRef, tableHeight, shellRef, pendingFocusColumnKeyRef,
      metadataLoadSeqRef, schemaLoadSeqRef, latestSelectedSchemaRef, schemaContextKeyRef,
      focusColumnKey, openCommentEditor, closeCommentEditor, tableColumns, setTableColumns,
      indexColumns, setIndexColumns, resizeDragRef, resizeRafRef, latestResizeXRef, ghostRef,
      resizeBodyStyleRef, resizeListenerRef, sensors,
  } = useTableDesignerState({ tab });

  const handleColumnChangeLate = useLateBoundCallback<(key: string, field: keyof EditableColumn, value: any) => void>();
  const handleDeleteColumnLate = useLateBoundCallback<(key: string) => void>();
  const { handleResizeStart, handleIndexResizeStart, fetchData, normalizeDbType } = useTableDesignerDataLoad({
      tab, getDbType, i18nLanguage, readOnly, handleColumnChange: handleColumnChangeLate.call,
      isTDengineNewTable, openCommentEditor, handleDeleteColumn: handleDeleteColumnLate.call,
      setTableColumns, connections, resizeRafRef, resizeDragRef, ghostRef, latestResizeXRef,
      resizeListenerRef, resizeBodyStyleRef, shellRef, tableColumns, indexColumns, setIndexColumns,
      setColumnsLoading, setIndexesLoading, setForeignKeysLoading, setTriggersLoading,
      setDdlLoading, metadataLoadSeqRef, isNewTable, resolveTableInfo, setColumns,
      setOriginalColumns, setSelectedColumnRowKeys, setIndexes, setFks, setTriggers, setDdl,
      setTableComment, isTableCommentModalOpen, setTableCommentDraft, selectedSchema,
  });

  const executeSchemaStatementsLate = useLateBoundCallback<(sqlText: string, options?: SchemaExecutionOptions) => Promise<SchemaExecutionResult>>();
  const {
      supportsTableDesignerSchemaSelection, handleSchemaChange, buildDropTriggerSql,
      handleCreateTrigger, handleEditTrigger, handleDeleteTrigger,
  } = useTableDesignerTriggerList({
      normalizeDbType, getDbType, tab, schemaLoadSeqRef, schemaContextKeyRef,
      latestSelectedSchemaRef, setSchemaOptions, setSelectedSchema, setSchemaSelectionOverride,
      setSchemaReady, setSchemaLoading, connections, tableDesignerSchemaByConnection,
      setTableDesignerSchema, selectedSchema, isNewTable, setColumns, setOriginalColumns,
      setIndexes, setFks, setTriggers, setDdl, setSelectedColumnRowKeys, hasUnsavedDraftChanges,
      i18nLanguage, resolvePreviewTableInfo, resolveTableInfo, setTriggerEditMode,
      setTriggerEditSql, setIsTriggerEditModalOpen, selectedTrigger, setActiveContext, addTab,
      setSelectedTrigger, executeSchemaStatements: executeSchemaStatementsLate.call, fetchData,
  });

  const {
      handleExecuteTriggerSql, handleColumnChange, handleSaveColumnOptions, handleAddColumn,
      handleAddColumnAfterSelected, handleDeleteColumn, selectedColumns,
      openCopySelectedColumnsModal, columnClipboard, handleColumnRowContextMenu, groupedIndexes,
      selectedIndex, groupedIndexFieldCount,
  } = useTableDesignerColumnEdits({
      tab, getDbType, triggerEditSql, i18nLanguage, isNewTable, triggers, setTriggers,
      triggerEditMode, selectedTrigger, setSelectedTrigger, setIsTriggerEditModalOpen, connections,
      setTriggerExecuting, resolveTableInfo, buildDropTriggerSql,
      executeSchemaStatements: executeSchemaStatementsLate.call, fetchData, setColumns,
      commentEditorColumnKey, closeCommentEditor, commentEditorColumnType, columnDefaultEnabled,
      columnDefaultValue, commentEditorValue, columnCharset, columnCollation, columns,
      setSelectedColumnRowKeys, pendingFocusColumnKeyRef, selectedColumnRowKeys,
      setIsCopyColumnsModalOpen, readOnly, activeKey, indexes, selectedIndexKeys,
  });
  handleColumnChangeLate.bind(handleColumnChange);
  handleDeleteColumnLate.bind(handleDeleteColumn);

  const {
      groupedForeignKeys, localColumnOptions, isStarRocksNewTable, isTDengineChildNewTable,
      tdengineTagTypeOptions, supportsIndexSchemaOps, supportsForeignKeySchemaOps,
      supportsTableCommentOps, getIndexKindOptions, getIndexTypeOptions, getFixedIndexType,
      buildCreateTableSql, handleCopyColumnsExecute, copyColumnsRpcConfig,
  } = useTableDesignerDialectSupport({
      fks, i18nLanguage, columns, isNewTable, getDbType, isTDengineNewTable, tdengineTableKind, tab,
      setActiveKey, setTdengineStableOptions, setTdengineStableOptionsLoading, connections,
      tdengineStableName, setTdengineChildTagDefs, setTdengineChildTagValues,
      setTdengineChildTagDefsLoading, starRocksTableKind, starRocksKeyModel, starRocksKeyColumns,
      starRocksPartitionClause, starRocksDistributionType, starRocksDistributionColumns,
      starRocksBucketMode, starRocksBucketCount, starRocksProperties, starRocksRollups,
      starRocksExternalEngine, starRocksExternalProperties, tdengineTagValues, tdengineChildTagDefs,
      tdengineChildTagValues, tdengineTagDefinitions, selectedIndexKeys, setSelectedIndexKeys,
      groupedIndexes, selectedForeignKey, setSelectedForeignKey, isNonRelationalDialect,
      lacksAlterForeignKeySupport, isMysqlLikeDialect, isPgLikeDialect, isSqlServerDialect,
      selectedSchema, supportsTableDesignerSchemaSelection, designerSchemaTitle,
      executeSchemaStatements: executeSchemaStatementsLate.call,
  });

  const {
      executeSchemaStatements, executeSchemaSql, openTableCommentModal, handleSaveTableComment,
      openCreateIndexModal, openEditIndexModal, indexCreatePreviewSql, selectedIndexCreateSql,
      indexTableHeight, buildIndexDropSql, handleSubmitIndex,
  } = useTableDesignerIndexEdits({
      tab, connections, i18nLanguage, resolveTableInfo, supportsTableDesignerSchemaSelection,
      designerSchemaTitle, getIndexKindOptions, fetchData, setTableCommentDraft, tableComment,
      setIsTableCommentModalOpen, supportsTableCommentOps, isNewTable, setTableComment,
      tableCommentDraft, setTableCommentSaving, setIndexModalMode, setIndexForm,
      setIsIndexModalOpen, selectedIndex, resolvePreviewTableInfo, isIndexModalOpen, indexForm,
      newTableName, schemaSelectionOverride, selectedSchema, selectedIndexKeys, tableHeight,
      isMysqlLikeDialect, quoteIdentifierPartByDialect, isSqlServerDialect, isPgLikeDialect,
      isOracleLikeDialect, quoteIdentifierPathByDialect, isNonRelationalDialect, setIndexes,
      setColumns, indexModalMode, supportsIndexSchemaOps, groupedIndexes, setIndexSaving,
  });
  executeSchemaStatementsLate.bind(executeSchemaStatements);

  const {
      handleDeleteIndex, openCreateForeignKeyModal, openEditForeignKeyModal, handleSubmitForeignKey,
      handleDeleteForeignKey, onDragEnd, generateDDL, handleRefreshDesigner, handleExecuteSave,
      resizableColumns, columnSelectCol,
  } = useTableDesignerSaveActions({
      selectedIndexKeys, setSelectedIndexKeys, i18nLanguage, supportsIndexSchemaOps, groupedIndexes,
      isNewTable, setIndexes, setColumns, buildIndexDropSql, executeSchemaSql,
      setForeignKeyModalMode, setForeignKeyForm, setIsForeignKeyModalOpen, selectedForeignKey,
      resolvePreviewTableInfo, supportsForeignKeySchemaOps, tab, foreignKeyForm, groupedForeignKeys,
      foreignKeyModalMode, setFks, setForeignKeySaving, setSelectedForeignKey, newTableName,
      isTDengineChildNewTable, tdengineStableName, tdengineChildTagDefs, tdengineChildTagValues,
      tdengineTagValues, columns, isTDengineNewTable, tdengineTableKind, tdengineTagDefinitions,
      buildCreateTableSql, charset, collation, tableComment, getIndexKindOptions, triggers,
      setPreviewSql, setIsPreviewOpen, resolveTableInfo, originalColumns, hasUnsavedDraftChanges,
      fetchData, executeSchemaStatements, previewSql, selectedSchema, getDbType,
      supportsTableDesignerSchemaSelection, designerSchemaTitle, tableColumns, handleResizeStart,
      selectedColumnRowKeys, setSelectedColumnRowKeys,
  });

  const {
      toggleIndexSelection, resizableIndexColumns, starRocksAdvancedTabContent, columnsTabContent,
      tdengineCombinedTabContent,
  } = useTableDesignerTabContents({
      readOnly, resizableColumns, columnSelectCol, setIndexColumns, i18nLanguage, groupedIndexes,
      selectedIndexKeys, setSelectedIndexKeys, indexColumns, handleIndexResizeStart,
      starRocksTableKind, setStarRocksTableKind, starRocksKeyModel, setStarRocksKeyModel,
      starRocksKeyColumns, setStarRocksKeyColumns, localColumnOptions, starRocksPartitionClause,
      setStarRocksPartitionClause, starRocksDistributionType, setStarRocksDistributionType,
      starRocksDistributionColumns, setStarRocksDistributionColumns, starRocksBucketMode,
      setStarRocksBucketMode, starRocksBucketCount, setStarRocksBucketCount, starRocksProperties,
      setStarRocksProperties, starRocksRollups, setStarRocksRollups, starRocksExternalEngine,
      setStarRocksExternalEngine, starRocksExternalProperties, setStarRocksExternalProperties,
      tdengineTableKind, setTdengineTableKind, tdengineTagDefinitions, setTdengineTagDefinitions,
      tdengineTagTypeOptions, tdengineStableName, setTdengineStableName, tdengineStableOptions,
      tdengineStableOptionsLoading, tdengineChildTagDefsLoading, tdengineChildTagDefs,
      tdengineChildTagValues, setTdengineChildTagValues, tdengineTagValues, setTdengineTagValues,
      columnClipboard, containerRef, panelBodyBg, focusRowBg, columns, focusColumnKey,
      columnsLoading, tableHeight, handleColumnRowContextMenu, sensors, onDragEnd,
      isTDengineChildNewTable, panelToolbarBorder, darkMode, designerColumnSummary,
  });

  return (
    <div
        ref={shellRef}
        className={`table-designer-shell gn-v2-table-designer${embedded ? ' is-embedded' : ''}`}
        onKeyDown={columnClipboard.handleKeyDown}
        style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, padding: embedded ? 0 : '6px 0', position: 'relative', ['--gn-data-table-vertical-border' as string]: dataTableVerticalBorderRule }}
    >
        <style>{TABLE_DESIGNER_SHELL_CSS}</style>
        <div
          ref={ghostRef}
          style={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            left: 0,
            width: '2px',
            background: resizeGuideColor,
            zIndex: 9999,
            display: 'none',
            pointerEvents: 'none',
            willChange: 'transform',
          }}
        />
        <div className="gn-v2-designer-header">
                <div className="gn-v2-designer-title">
                    <span>{t('table_designer.title.schema_designer', undefined, i18nLanguage)}</span>
                    <strong>{designerTableTitle}</strong>
                </div>
                <div className="gn-v2-designer-meta">
                    <span><TableOutlined /> {designerDbTitle}</span>
                    {supportsTableDesignerSchemaSelection && designerSchemaTitle && <span><FolderOpenOutlined /> {designerSchemaTitle}</span>}
                    <span>{designerColumnSummary}</span>
                    {readOnly && <span>{t('table_designer.status.read_only', undefined, i18nLanguage)}</span>}
                </div>
        </div>
        <TableDesignerToolbar
          panelToolbarBorder={panelToolbarBorder} embedded={embedded} panelRadius={panelRadius}
          panelFrameColor={panelFrameColor} panelToolbarBg={panelToolbarBg}
          supportsTableDesignerSchemaSelection={supportsTableDesignerSchemaSelection}
          i18nLanguage={i18nLanguage} designerSchemaTitle={designerSchemaTitle}
          schemaLoading={schemaLoading} schemaReady={schemaReady} schemaOptions={schemaOptions}
          handleSchemaChange={handleSchemaChange} isNewTable={isNewTable}
          newTableName={newTableName} setNewTableName={setNewTableName}
          selectedSchema={selectedSchema} getDbType={getDbType}
          latestSelectedSchemaRef={latestSelectedSchemaRef} setSelectedSchema={setSelectedSchema}
          setTableDesignerSchema={setTableDesignerSchema} tab={tab}
          isTDengineNewTable={isTDengineNewTable} charset={charset} setCharset={setCharset}
          setCollation={setCollation} charsetOptions={charsetOptions} collation={collation}
          collationOptions={collationOptions} readOnly={readOnly} generateDDL={generateDDL}
          metadataLoading={metadataLoading} handleRefreshDesigner={handleRefreshDesigner}
          supportsTableCommentOps={supportsTableCommentOps}
          openTableCommentModal={openTableCommentModal}
          isTDengineChildNewTable={isTDengineChildNewTable} handleAddColumn={handleAddColumn}
          handleAddColumnAfterSelected={handleAddColumnAfterSelected}
          selectedColumnRowKeys={selectedColumnRowKeys} columnClipboard={columnClipboard}
          selectedColumns={selectedColumns}
          openCopySelectedColumnsModal={openCopySelectedColumnsModal}
        />
        <TableDesignerTabs
          activeKey={activeKey} setActiveKey={setActiveKey} embedded={embedded}
          panelRadius={panelRadius} panelFrameColor={panelFrameColor} panelBodyBg={panelBodyBg}
          isTDengineNewTable={isTDengineNewTable} i18nLanguage={i18nLanguage}
          tdengineCombinedTabContent={tdengineCombinedTabContent}
          columnsTabContent={columnsTabContent} isStarRocksNewTable={isStarRocksNewTable}
          starRocksAdvancedTabContent={starRocksAdvancedTabContent} readOnly={readOnly}
          supportsIndexSchemaOps={supportsIndexSchemaOps}
          openCreateIndexModal={openCreateIndexModal} selectedIndexKeys={selectedIndexKeys}
          openEditIndexModal={openEditIndexModal} handleDeleteIndex={handleDeleteIndex}
          groupedIndexes={groupedIndexes} groupedIndexFieldCount={groupedIndexFieldCount}
          isNewTable={isNewTable} resizableIndexColumns={resizableIndexColumns}
          indexesLoading={indexesLoading} indexTableHeight={indexTableHeight}
          toggleIndexSelection={toggleIndexSelection}
          selectedIndexCreateSql={selectedIndexCreateSql} selectedIndex={selectedIndex}
          darkMode={darkMode} supportsForeignKeySchemaOps={supportsForeignKeySchemaOps}
          openCreateForeignKeyModal={openCreateForeignKeyModal}
          selectedForeignKey={selectedForeignKey}
          openEditForeignKeyModal={openEditForeignKeyModal}
          handleDeleteForeignKey={handleDeleteForeignKey} groupedForeignKeys={groupedForeignKeys}
          foreignKeysLoading={foreignKeysLoading} tableHeight={tableHeight}
          setSelectedForeignKey={setSelectedForeignKey} selectedTrigger={selectedTrigger}
          setIsTriggerModalOpen={setIsTriggerModalOpen} handleCreateTrigger={handleCreateTrigger}
          handleEditTrigger={handleEditTrigger} handleDeleteTrigger={handleDeleteTrigger}
          triggers={triggers} triggersLoading={triggersLoading}
          setSelectedTrigger={setSelectedTrigger} ddl={ddl}
        />

        <TableDesignerDialogs
          commentEditorColumnName={commentEditorColumnName} i18nLanguage={i18nLanguage}
          isCommentModalOpen={isCommentModalOpen} closeCommentEditor={closeCommentEditor}
          handleSaveColumnOptions={handleSaveColumnOptions}
          columnDefaultEnabled={columnDefaultEnabled}
          setColumnDefaultEnabled={setColumnDefaultEnabled} getDbType={getDbType}
          commentEditorColumnType={commentEditorColumnType}
          columnDefaultValue={columnDefaultValue} setColumnDefaultValue={setColumnDefaultValue}
          columnCharset={columnCharset} setColumnCharset={setColumnCharset}
          setColumnCollation={setColumnCollation} charsetOptions={charsetOptions}
          columnCollation={columnCollation} collationOptions={collationOptions}
          commentEditorValue={commentEditorValue} setCommentEditorValue={setCommentEditorValue}
          isCopyColumnsModalOpen={isCopyColumnsModalOpen} darkMode={darkMode}
          selectedColumns={selectedColumns} tab={tab} selectedSchema={selectedSchema}
          copyColumnsRpcConfig={copyColumnsRpcConfig} charset={charset} collation={collation}
          buildCreateTableSql={buildCreateTableSql}
          handleCopyColumnsExecute={handleCopyColumnsExecute}
          setIsCopyColumnsModalOpen={setIsCopyColumnsModalOpen} isNewTable={isNewTable}
          isTableCommentModalOpen={isTableCommentModalOpen}
          setIsTableCommentModalOpen={setIsTableCommentModalOpen}
          handleSaveTableComment={handleSaveTableComment} tableCommentSaving={tableCommentSaving}
          tableCommentDraft={tableCommentDraft} setTableCommentDraft={setTableCommentDraft}
          tableComment={tableComment} indexModalMode={indexModalMode}
          isIndexModalOpen={isIndexModalOpen} setIsIndexModalOpen={setIsIndexModalOpen}
          handleSubmitIndex={handleSubmitIndex} indexSaving={indexSaving} indexForm={indexForm}
          setIndexForm={setIndexForm} localColumnOptions={localColumnOptions}
          getIndexKindOptions={getIndexKindOptions} getFixedIndexType={getFixedIndexType}
          getIndexTypeOptions={getIndexTypeOptions} indexCreatePreviewSql={indexCreatePreviewSql}
          foreignKeyModalMode={foreignKeyModalMode} isForeignKeyModalOpen={isForeignKeyModalOpen}
          setIsForeignKeyModalOpen={setIsForeignKeyModalOpen}
          handleSubmitForeignKey={handleSubmitForeignKey} foreignKeySaving={foreignKeySaving}
          foreignKeyForm={foreignKeyForm} setForeignKeyForm={setForeignKeyForm}
          isPreviewOpen={isPreviewOpen} handleExecuteSave={handleExecuteSave}
          setIsPreviewOpen={setIsPreviewOpen} previewSql={previewSql}
          selectedTrigger={selectedTrigger} isTriggerModalOpen={isTriggerModalOpen}
          setIsTriggerModalOpen={setIsTriggerModalOpen} panelFrameColor={panelFrameColor}
          panelRadius={panelRadius} panelBodyBg={panelBodyBg} triggerEditMode={triggerEditMode}
          isTriggerEditModalOpen={isTriggerEditModalOpen}
          setIsTriggerEditModalOpen={setIsTriggerEditModalOpen}
          triggerExecuting={triggerExecuting} handleExecuteTriggerSql={handleExecuteTriggerSql}
          triggerEditSql={triggerEditSql} setTriggerEditSql={setTriggerEditSql}
        />
    </div>
  );
};

export default TableDesigner;
