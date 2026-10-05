import React from 'react';
import { TabData } from '../types';
import DataGrid from './DataGrid';
import { useDataViewerState } from './dataViewer/hooks/useDataViewerState';
import { useDataViewerFetchData } from './dataViewer/hooks/useDataViewerFetchData';
import { useDataViewerActions } from './dataViewer/hooks/useDataViewerActions';

export interface DataViewerProps { tab: TabData; isActive?: boolean }

const DataViewer: React.FC<DataViewerProps> = React.memo(({ tab, isActive = true }) => {
  const {
    viewerLoadContextKey, data, setData, columnNames, setColumnNames, pkColumns, setPkColumns,
    editLocator, setEditLocator, setLoading, loadingContextKeyRef, loading, connections, addSqlLog,
    tr, fetchSeqRef, countSeqRef, countKeyRef, duckdbApproxSeqRef, duckdbApproxKeyRef,
    oracleApproxSeqRef, oracleApproxKeyRef, autoCountKeyRef, manualCountSeqRef, manualCountKeyRef,
    pkSeqRef, pkKeyRef, latestConfigRef, latestDbTypeRef, latestDbNameRef, latestCountSqlRef,
    latestCountKeyRef, scrollSnapshotRef, initialLoadRef, skipNextAutoFetchRef,
    deferredInitialFetchRef, rabbitMQPreviewConfirmedRef, pagination, setPagination, sortInfo,
    setSortInfo, showFilter, setShowFilter, filterConditions, setFilterConditions,
    quickWhereCondition, setQuickWhereCondition, duckdbSafeSelectCacheRef, currentConnConfig,
    forceReadOnly, preferManualTotalCount, supportsApproximateTableCount,
    supportsApproximateTotalPages, rocketMQTagTotalCountUnavailable, totalCountUnavailableLabel,
    totalCountUnavailableReason, handleTableScrollSnapshotChange, handleManualTotalCount,
    handleCancelManualTotalCount, ensureRabbitMQPreviewConfirmed,
  } = useDataViewerState({ tab });

  const { fetchData } = useDataViewerFetchData({
    tab, pagination, setPagination, fetchSeqRef, loadingContextKeyRef, viewerLoadContextKey,
    setLoading, connections, tr, quickWhereCondition, filterConditions, rabbitMQPreviewConfirmedRef,
    ensureRabbitMQPreviewConfirmed, pkColumns, setPkColumns, editLocator, setEditLocator,
    forceReadOnly, pkKeyRef, pkSeqRef, countSeqRef, manualCountSeqRef, duckdbApproxSeqRef,
    oracleApproxSeqRef, countKeyRef, autoCountKeyRef, manualCountKeyRef, duckdbApproxKeyRef,
    oracleApproxKeyRef, latestConfigRef, latestDbTypeRef, latestDbNameRef, latestCountSqlRef,
    latestCountKeyRef, addSqlLog, sortInfo, supportsApproximateTotalPages, duckdbSafeSelectCacheRef,
    setColumnNames, setData, preferManualTotalCount, supportsApproximateTableCount,
  });
  const {
    handleDataViewActivate, handleReload, handleSort, handlePageChange, handleLastPage,
    handleToggleFilter, handleApplyFilter, handleApplyQuickWhereCondition, exportSqlWithFilter,
  } = useDataViewerActions({
    deferredInitialFetchRef, initialLoadRef, fetchData, pagination, countSeqRef, manualCountSeqRef,
    duckdbApproxSeqRef, oracleApproxSeqRef, countKeyRef, autoCountKeyRef, manualCountKeyRef,
    duckdbApproxKeyRef, oracleApproxKeyRef, setPagination, setSortInfo,
    rocketMQTagTotalCountUnavailable, tr, setShowFilter, skipNextAutoFetchRef, setFilterConditions,
    setQuickWhereCondition, tab, currentConnConfig, filterConditions, quickWhereCondition, sortInfo,
    editLocator, pkColumns,
  }); // Initial load and re-load on sort/filter

  return (
    <div className="gn-v2-data-viewer" style={{ flex: '1 1 auto', minHeight: 0, minWidth: 0, height: '100%', width: '100%', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
      <DataGrid
          data={data}
          columnNames={columnNames}
          loading={loading}
          tableName={tab.tableName}
          objectType={tab.objectType || 'table'}
          exportScope="table"
          dbName={tab.dbName}
          schemaName={tab.schemaName}
          connectionId={tab.connectionId}
          pkColumns={pkColumns}
          editLocator={editLocator}
          onReload={handleReload}
          onSort={handleSort}
          onPageChange={handlePageChange}
          onLastPage={handleLastPage}
          pagination={{
            ...pagination,
            totalKnown: rocketMQTagTotalCountUnavailable ? false : pagination.totalKnown,
            totalApprox: rocketMQTagTotalCountUnavailable ? false : pagination.totalApprox,
            approximateTotal: rocketMQTagTotalCountUnavailable ? undefined : pagination.approximateTotal,
            totalCountUnavailableLabel,
            totalCountUnavailableReason,
          }}
          onRequestTotalCount={preferManualTotalCount ? handleManualTotalCount : undefined}
          onCancelTotalCount={preferManualTotalCount ? handleCancelManualTotalCount : undefined}
          showFilter={showFilter}
          onToggleFilter={handleToggleFilter}
          onApplyFilter={handleApplyFilter}
          appliedFilterConditions={filterConditions}
          quickWhereCondition={quickWhereCondition}
          onApplyQuickWhereCondition={handleApplyQuickWhereCondition}
          readOnly={forceReadOnly || !editLocator || editLocator.readOnly}
          sortInfoExternal={sortInfo}
          exportSqlWithFilter={exportSqlWithFilter || undefined}
          scrollSnapshot={scrollSnapshotRef.current}
          onScrollSnapshotChange={handleTableScrollSnapshotChange}
          isActive={isActive}
          enableSqlLogEvent
          initialViewMode={tab.initialViewMode}
          initialViewModeRequestId={tab.initialViewModeRequestId}
          onDataViewActivate={handleDataViewActivate}
          workbenchTabId={tab.id}
      />
    </div>
  );
});

export default DataViewer;
