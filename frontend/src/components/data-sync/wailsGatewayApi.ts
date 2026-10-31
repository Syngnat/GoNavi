import type { syncjob } from '../../../wailsjs/go/models';
import type { WailsQueryResultLike } from './wailsDto';

type QueryResultPromise = Promise<WailsQueryResultLike>;

/** Narrow seam around Wails so protocol handling can be tested without a runtime. */
export interface WailsDataSyncApi {
  GetSavedConnections(): Promise<unknown>;
  SelectBackupDirectory(currentDirectory: string): QueryResultPromise;
  ExportTextFile(
    defaultName: string,
    content: string,
    format: string,
  ): QueryResultPromise;
  OpenExportedTextFile(filePath: string): QueryResultPromise;
  DataSyncDatabaseList(connectionId: string): QueryResultPromise;
  DataSyncObjectList(
    connectionId: string,
    database: string,
    schema: string,
  ): QueryResultPromise;
  DataSyncFieldList(
    connectionId: string,
    database: string,
    schema: string,
    objectName: string,
  ): QueryResultPromise;
  DataSyncCapabilityResolve(
    sourceConnectionId: string,
    sourceDatabase: string,
    sourceSchema: string,
    targetConnectionId: string,
    targetDatabase: string,
    targetSchema: string,
  ): QueryResultPromise;
  DataSyncCDCAdapterList(): QueryResultPromise;
  DataSyncCDCProbe(
    connectionId: string,
    database: string,
    schema: string,
    adapter: string,
  ): QueryResultPromise;
  DataSyncCheckpointGet(taskId: string): QueryResultPromise;
  DataSyncCheckpointReset(
    taskId: string,
    expectedJobRevision: number,
  ): QueryResultPromise;
  DataSyncErrorRowDiscard(errorRowId: string): QueryResultPromise;
  DataSyncErrorRowRetry(
    errorRowId: string,
    expectedJobRevision: number,
    approvalToken: string,
  ): QueryResultPromise;
  DataSyncErrorRowList(
    runId: string,
    status: string,
    limit: number,
  ): QueryResultPromise;
  DataSyncJobApprovalBegin(definition: syncjob.JobDefinition): QueryResultPromise;
  DataSyncJobApprove(
    definition: syncjob.JobDefinition,
    challenge: string,
  ): QueryResultPromise;
  DataSyncJobDelete(jobId: string): QueryResultPromise;
  DataSyncJobList(): QueryResultPromise;
  DataSyncJobPreflight(definition: syncjob.JobDefinition): QueryResultPromise;
  DataSyncJobSave(
    definition: syncjob.JobDefinition,
    approvalToken: string,
  ): QueryResultPromise;
  DataSyncRunCancel(runId: string): QueryResultPromise;
  DataSyncRunEventList(
    runId: string,
    afterSequence: number,
    limit: number,
  ): QueryResultPromise;
  DataSyncRunList(taskId: string, limit: number): QueryResultPromise;
  DataSyncRunPage(
    taskId: string,
    beforeCreatedAt: number,
    beforeId: string,
    limit: number,
  ): QueryResultPromise;
  DataSyncRunDelete(runId: string): QueryResultPromise;
  DataSyncRunClearTerminal(taskId: string): QueryResultPromise;
  DataSyncRunResume(runId: string): QueryResultPromise;
  DataSyncRunRetry(runId: string): QueryResultPromise;
  RollbackDataSyncRun(runId: string): QueryResultPromise;
  DataSyncRunStart(
    taskId: string,
    expectedRevision: number,
    approvalToken: string,
  ): QueryResultPromise;
}
