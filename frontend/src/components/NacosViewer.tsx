import React from 'react';
import {
  Alert,
  Button,
  Form,
  Input,
  Modal,
  Select,
  Space,
  message,
} from 'antd';
import NacosHistoryDetailModal from './NacosHistoryDetailModal';
import RedisResizableDivider from './RedisResizableDivider';
import { noAutoCapInputProps } from '../utils/inputAutoCap';
import {
  type NacosViewerProps,
  CONFIG_TYPE_OPTIONS,
} from './nacosViewer/nacosViewerModel';
import { useNacosViewerState } from './nacosViewer/hooks/useNacosViewerState';
import { useNacosViewerConfigActions } from './nacosViewer/hooks/useNacosViewerConfigActions';
import { useNacosViewerBatchActions } from './nacosViewer/hooks/useNacosViewerBatchActions';
import { NacosConfigListPane } from './nacosViewer/NacosConfigListPane';
import { NacosConfigDetailPane } from './nacosViewer/NacosConfigDetailPane';
import { NacosHistoryModal } from './nacosViewer/NacosHistoryModal';
import { NacosImportModal } from './nacosViewer/NacosImportModal';

const NacosViewer: React.FC<NacosViewerProps> = ({
  connectionId,
  namespaceId,
  namespaceName,
  initialGroup,
}) => {
  const {
    tr, darkMode, workbenchTheme, connection, readOnly, importRestricted, loadingList,
    loadingDetail, setLoadingDetail, publishing, setPublishing, items, pinnedItems, totalCount,
    pageNo, pageSize, filterDataId, setFilterDataId, filterGroup, setFilterGroup, groupSuggestions,
    dataIdSuggestions, setDataIdSuggestions, setSelectedKey, listScrollY, setListScrollY,
    listBodyRef, detail, setDetail, draftContent, setDraftContent, draftType, setDraftType,
    draftDirty, setDraftDirty, newModalOpen, setNewModalOpen, newForm, historyOpen, setHistoryOpen,
    historyLoading, setHistoryLoading, historyItems, setHistoryItems, historyTotal, setHistoryTotal,
    historyPageNo, setHistoryPageNo, historyDetailOpen, setHistoryDetailOpen, historyDetail,
    setHistoryDetail, historyDetailLoading, setHistoryDetailLoading, historyEditorLanguage,
    rollingBack, setRollingBack, remoteChanged, setRemoteChanged, listenActive, setListenActive,
    publishMode, setPublishMode, betaIps, setBetaIps, betaExists, setBetaExists, importModalOpen,
    setImportModalOpen, importPreview, setImportPreview, importConflictMode, setImportConflictMode,
    importSelectedKeys, setImportSelectedKeys, importing, setImporting, exporting, setExporting,
    deletingSelected, setDeletingSelected, selectedRowKeys, setSelectedRowKeys, leftPanelWidth,
    setLeftPanelWidth, leftPanelRef, watchIdRef, detailRef, draftDirtyRef, selectionGenerationRef,
    mountedRef, rpcConfig, selectionContextRef, selectedRowKey, importSelectionRows, selectedItems,
    selectedCount, allPageSelected, pageSelectionIndeterminate, stopListen, startListen,
    loadFilterSuggestions, loadList, loadBetaMeta,
  } = useNacosViewerState({ connectionId, namespaceId, initialGroup });

  const {
    loadDetail, fuzzyFilterOption, dataIdAutoOptions, groupAutoOptions, handlePublish,
    handleStopBeta, handleLoadBetaContent, handleExport, handlePreviewImport,
  } = useNacosViewerConfigActions({
    connectionId, namespaceId, rpcConfig, selectionGenerationRef, stopListen, selectionContextRef,
    setLoadingDetail, tr, detailRef, draftDirtyRef, setDetail, setDraftContent, setDraftType,
    setDraftDirty, setRemoteChanged, setPublishMode, setSelectedKey, startListen, loadBetaMeta,
    initialGroup, setListenActive, setBetaExists, setBetaIps, setFilterGroup, setDataIdSuggestions,
    setSelectedRowKeys, loadList, loadFilterSuggestions, listBodyRef, setListScrollY, items,
    pageSize, totalCount, dataIdSuggestions, groupSuggestions, watchIdRef, mountedRef, detail,
    readOnly, publishMode, betaIps, connection, setPublishing, draftContent, draftType, pageNo,
    namespaceName, selectedItems, setExporting, importRestricted, setImportPreview,
    setImportSelectedKeys, setImportConflictMode, setImportModalOpen,
  });

  const {
    handleImport, handleReloadRemote, handleDeleteSelected, handleDelete, handleCreate, loadHistory,
    openHistory, openHistoryDetail, handleRollback, columns, namespaceLabel, remoteChangedHint,
  } = useNacosViewerBatchActions({
    namespaceId, rpcConfig, importPreview, setImportPreview, importRestricted, connection, tr,
    setImporting, importSelectedKeys, importConflictMode, setImportModalOpen, loadList, detail,
    loadDetail, draftType, detailRef, draftDirtyRef, setDetail, setSelectedKey, setDraftContent,
    setDraftDirty, setRemoteChanged, setBetaExists, setBetaIps, selectedItems, readOnly,
    setDeletingSelected, setSelectedRowKeys, stopListen, totalCount, pageSize, pageNo, newForm,
    setNewModalOpen, setHistoryLoading, setHistoryItems, setHistoryTotal, setHistoryPageNo,
    setHistoryOpen, setHistoryDetailOpen, setHistoryDetailLoading, setHistoryDetail, setRollingBack,
    connectionId, namespaceName, draftDirty,
  });

  return (
    <div
      className={'gn-v2-nacos-workbench'}
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
        padding: 0,
        gap: 0,
        boxSizing: 'border-box',
        background: undefined,
        color: workbenchTheme.textPrimary,
      }}
    >
      {false ? (
        <Alert
          type="warning"
          showIcon
          message={tr('nacos_viewer.message.remote_changed_banner')}
          description={remoteChangedHint}
          action={
            <Space size={4}>
              <Button size="small" type="primary" onClick={() => void handleReloadRemote()}>
                {tr('nacos_viewer.action.reload_remote')}
              </Button>
              <Button
                size="small"
                onClick={() => setRemoteChanged(false)}
              >
                {tr('nacos_viewer.action.dismiss_remote')}
              </Button>
            </Space>
          }
        />
      ) : null}

      {/* Redis-style split: left | full-height divider | right (headers share one grid row) */}
      <div
        className={'gn-v2-nacos-split'}
        style={{
          display: undefined,
          minHeight: 0,
          flex: 1,
          overflow: 'hidden',
          ...({
                ['--gn-nacos-sidebar-width' as string]:
                  typeof leftPanelWidth === 'number' ? `${leftPanelWidth}px` : leftPanelWidth,
              }),
        }}
      >
        <NacosConfigListPane
          leftPanelRef={leftPanelRef} namespaceLabel={namespaceLabel} listenActive={listenActive}
          tr={tr} loadList={loadList} loadingList={loadingList} readOnly={readOnly}
          newForm={newForm} setNewModalOpen={setNewModalOpen} exporting={exporting}
          handleExport={handleExport} selectedCount={selectedCount}
          importRestricted={importRestricted} handlePreviewImport={handlePreviewImport}
          dataIdAutoOptions={dataIdAutoOptions} fuzzyFilterOption={fuzzyFilterOption}
          filterDataId={filterDataId} setFilterDataId={setFilterDataId} pageSize={pageSize}
          dataIdSuggestions={dataIdSuggestions} loadFilterSuggestions={loadFilterSuggestions}
          groupAutoOptions={groupAutoOptions} filterGroup={filterGroup}
          setFilterGroup={setFilterGroup} groupSuggestions={groupSuggestions}
          workbenchTheme={workbenchTheme} allPageSelected={allPageSelected}
          pageSelectionIndeterminate={pageSelectionIndeterminate} items={items}
          setSelectedRowKeys={setSelectedRowKeys} handleDeleteSelected={handleDeleteSelected}
          deletingSelected={deletingSelected} listBodyRef={listBodyRef} pinnedItems={pinnedItems}
          columns={columns} selectedRowKeys={selectedRowKeys} pageNo={pageNo}
          totalCount={totalCount} draftDirty={draftDirty} loadDetail={loadDetail}
          selectedRowKey={selectedRowKey} listScrollY={listScrollY}
        />

        <RedisResizableDivider
          targetRef={leftPanelRef}
          onResizeEnd={setLeftPanelWidth}
          minWidth={280}
          maxReservedWidth={321}
          containerWidthCssVariable={'--gn-nacos-sidebar-width'}
          title={tr('redis_viewer.tooltip.resize_panels')}
        />

        <NacosConfigDetailPane
          detail={detail} workbenchTheme={workbenchTheme} betaExists={betaExists} tr={tr}
          openHistory={openHistory} publishing={publishing} readOnly={readOnly}
          draftDirty={draftDirty} handlePublish={handlePublish} publishMode={publishMode}
          handleDelete={handleDelete} remoteChanged={remoteChanged}
          remoteChangedHint={remoteChangedHint} handleReloadRemote={handleReloadRemote}
          setRemoteChanged={setRemoteChanged} loadingDetail={loadingDetail} draftType={draftType}
          setDraftType={setDraftType} setDraftDirty={setDraftDirty}
          setPublishMode={setPublishMode} betaIps={betaIps} setBetaIps={setBetaIps}
          handleLoadBetaContent={handleLoadBetaContent} handleStopBeta={handleStopBeta}
          darkMode={darkMode} draftContent={draftContent} setDraftContent={setDraftContent}
        />
      </div>

      <Modal
        title={tr('nacos_viewer.action.new')}
        open={newModalOpen}
        onCancel={() => setNewModalOpen(false)}
        onOk={() => void handleCreate()}
        destroyOnHidden
      >
        <Form form={newForm} layout="vertical" initialValues={{ group: 'DEFAULT_GROUP', type: 'text' }}>
          <Form.Item
            name="dataId"
            label={tr('nacos_viewer.field.data_id')}
            rules={[{ required: true, message: tr('nacos.backend.error.data_id_required') }]}
          >
            <Input {...noAutoCapInputProps} />
          </Form.Item>
          <Form.Item name="group" label={tr('nacos_viewer.field.group')}>
            <Input {...noAutoCapInputProps} />
          </Form.Item>
          <Form.Item name="type" label={tr('nacos_viewer.field.type')}>
            <Select options={CONFIG_TYPE_OPTIONS} />
          </Form.Item>
          <Form.Item name="content" label={tr('nacos_viewer.field.content')}>
            <Input.TextArea rows={8} {...noAutoCapInputProps} />
          </Form.Item>
        </Form>
      </Modal>

      <NacosHistoryModal
        tr={tr} historyOpen={historyOpen} setHistoryOpen={setHistoryOpen}
        historyLoading={historyLoading} historyItems={historyItems} historyPageNo={historyPageNo}
        historyTotal={historyTotal} loadHistory={loadHistory}
        openHistoryDetail={openHistoryDetail} detail={detail} readOnly={readOnly}
        handleRollback={handleRollback} rollingBack={rollingBack}
      />

      <NacosHistoryDetailModal
        open={historyDetailOpen}
        loading={historyDetailLoading}
        history={historyDetail}
        currentConfig={detail}
        language={historyEditorLanguage}
        loadCurrentContent={async (record) => {
          const result = await (window as any).go.app.App.NacosGetConfig(rpcConfig, namespaceId || '', record.group, record.dataId);
          if (!result?.success) throw new Error(result?.message || tr('nacos_viewer.message.load_failed', { detail: '' }));
          return String(result.data?.content ?? '');
        }}
        readOnly={readOnly}
        rollingBack={rollingBack}
        onClose={() => setHistoryDetailOpen(false)}
        onRollback={(item) => { void handleRollback(item); }}
        tr={tr}
      />

      <NacosImportModal
        tr={tr} importModalOpen={importModalOpen} setImportModalOpen={setImportModalOpen}
        handleImport={handleImport} importing={importing} importRestricted={importRestricted}
        importSelectedKeys={importSelectedKeys} importPreview={importPreview}
        importConflictMode={importConflictMode} setImportConflictMode={setImportConflictMode}
        importSelectionRows={importSelectionRows} setImportSelectedKeys={setImportSelectedKeys}
      />
    </div>
  );
};

export default NacosViewer;
