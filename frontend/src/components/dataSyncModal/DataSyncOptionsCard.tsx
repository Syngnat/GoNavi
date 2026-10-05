import { Card, Form, Select, Alert, Input, Checkbox } from "antd";
import { Text, Option } from "./dataSyncModalUiParts";
import type { DataSyncModalSyncActionsApi } from "./hooks/useDataSyncModalSyncActions";
import type { DataSyncModalStateApi } from "./hooks/useDataSyncModalState";
import type { DataSyncModalPresentationApi } from "./hooks/useDataSyncModalPresentation";

export interface DataSyncOptionsCardProps {
  isMigrationWorkflow: DataSyncModalSyncActionsApi['isMigrationWorkflow'];
  tr: DataSyncModalStateApi['tr'];
  isCompareEntry: DataSyncModalStateApi['isCompareEntry'];
  entryPresentation: DataSyncModalStateApi['entryPresentation'];
  shellCardStyle: DataSyncModalPresentationApi['shellCardStyle'];
  darkMode: DataSyncModalStateApi['darkMode'];
  quietPanelStyle: DataSyncModalPresentationApi['quietPanelStyle'];
  workflowType: DataSyncModalStateApi['workflowType'];
  targetTableStrategyTouchedRef: DataSyncModalStateApi['targetTableStrategyTouchedRef'];
  setWorkflowType: DataSyncModalStateApi['setWorkflowType'];
  isSourceQueryMode: DataSyncModalStateApi['isSourceQueryMode'];
  isSchemaCompareEntry: DataSyncModalStateApi['isSchemaCompareEntry'];
  sourceDatasetMode: DataSyncModalStateApi['sourceDatasetMode'];
  setSourceDatasetMode: DataSyncModalStateApi['setSourceDatasetMode'];
  isDataCompareEntry: DataSyncModalStateApi['isDataCompareEntry'];
  syncContent: DataSyncModalStateApi['syncContent'];
  setSyncContent: DataSyncModalStateApi['setSyncContent'];
  syncMode: DataSyncModalStateApi['syncMode'];
  setSyncMode: DataSyncModalStateApi['setSyncMode'];
  tableCreationAllowed: DataSyncModalSyncActionsApi['tableCreationAllowed'];
  targetTableStrategy: DataSyncModalStateApi['targetTableStrategy'];
  setTargetTableStrategy: DataSyncModalStateApi['setTargetTableStrategy'];
  migrationCapabilityStatus: DataSyncModalStateApi['migrationCapabilityStatus'];
  capabilityPresentation: DataSyncModalSyncActionsApi['capabilityPresentation'];
  migrationCapability: DataSyncModalStateApi['migrationCapability'];
  isRedisMongoKeyspaceMigration: DataSyncModalPresentationApi['isRedisMongoKeyspaceMigration'];
  sourceType: DataSyncModalSyncActionsApi['sourceType'];
  mongoCollectionName: DataSyncModalStateApi['mongoCollectionName'];
  setMongoCollectionName: DataSyncModalStateApi['setMongoCollectionName'];
  defaultMongoCollectionName: DataSyncModalPresentationApi['defaultMongoCollectionName'];
  autoAddColumns: DataSyncModalStateApi['autoAddColumns'];
  setAutoAddColumns: DataSyncModalStateApi['setAutoAddColumns'];
  createIndexes: DataSyncModalStateApi['createIndexes'];
  setCreateIndexes: DataSyncModalStateApi['setCreateIndexes'];
  capabilityStatusPresentation: DataSyncModalSyncActionsApi['capabilityStatusPresentation'];
}

export const DataSyncOptionsCard = ({
  isMigrationWorkflow, tr, isCompareEntry, entryPresentation, shellCardStyle, darkMode,
  quietPanelStyle, workflowType, targetTableStrategyTouchedRef, setWorkflowType, isSourceQueryMode,
  isSchemaCompareEntry, sourceDatasetMode, setSourceDatasetMode, isDataCompareEntry, syncContent,
  setSyncContent, syncMode, setSyncMode, tableCreationAllowed, targetTableStrategy,
  setTargetTableStrategy, migrationCapabilityStatus, capabilityPresentation, migrationCapability,
  isRedisMongoKeyspaceMigration, sourceType, mongoCollectionName, setMongoCollectionName,
  defaultMongoCollectionName, autoAddColumns, setAutoAddColumns, createIndexes, setCreateIndexes,
  capabilityStatusPresentation,
}: DataSyncOptionsCardProps) => (
  <Card
    title={
      isMigrationWorkflow
        ? tr("data_sync.title.migration_options")
        : isCompareEntry
          ? entryPresentation.optionTitle
          : tr("data_sync.title.sync_options")
    }
    style={{ ...shellCardStyle, marginTop: 18 }}
    styles={{
      header: {
        borderBottom: darkMode
          ? "1px solid rgba(255,255,255,0.08)"
          : "1px solid rgba(15,23,42,0.06)",
        fontWeight: 700,
      },
      body: { padding: 18 },
    }}
  >
    <div style={{ ...quietPanelStyle, marginBottom: 14 }}>
      <Text
        style={{
          color: darkMode
            ? "rgba(255,255,255,0.72)"
            : "rgba(15,23,42,0.68)",
          lineHeight: 1.7,
        }}
      >
        {isCompareEntry
          ? tr("data_sync.compare_entry.workflow_help")
          : tr("data_sync.help.workflow_type")}
      </Text>
    </div>
    <Form layout="vertical">
      {!isCompareEntry && (
        <Form.Item label={tr("data_sync.field.workflow_type")}>
          <Select
            value={workflowType}
            onChange={(value) => {
              targetTableStrategyTouchedRef.current = false;
              setWorkflowType(value);
            }}
          >
            <Option value="sync">
              {tr("data_sync.option.workflow.sync")}
            </Option>
            <Option value="migration" disabled={isSourceQueryMode}>
              {tr("data_sync.option.workflow.migration")}
            </Option>
          </Select>
        </Form.Item>
      )}
      {!isSchemaCompareEntry && (
        <Form.Item label={tr("data_sync.field.source_dataset_mode")}>
          <Select
            value={sourceDatasetMode}
            onChange={setSourceDatasetMode}
          >
            <Option value="table">
              {isCompareEntry
                ? tr(
                    "data_sync.compare_entry.option.source_dataset.table",
                  )
                : tr("data_sync.option.source_dataset.table")}
            </Option>
            <Option value="query">
              {isCompareEntry
                ? tr(
                    "data_sync.compare_entry.option.source_dataset.query",
                  )
                : tr("data_sync.option.source_dataset.query")}
            </Option>
          </Select>
        </Form.Item>
      )}
      <Alert
        type={
          isMigrationWorkflow || isCompareEntry ? "info" : "success"
        }
        showIcon
        style={{ marginBottom: 12 }}
        message={
          isMigrationWorkflow
            ? tr("data_sync.alert.migration_mode")
            : isSchemaCompareEntry
              ? tr("data_sync.compare_entry.alert.schema")
              : isDataCompareEntry
                ? tr("data_sync.compare_entry.alert.data")
                : tr("data_sync.alert.sync_mode")
        }
      />
      {isSourceQueryMode && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message={tr("data_sync.alert.query_mode")}
        />
      )}
      {!isCompareEntry && (
        <Form.Item
          label={
            isMigrationWorkflow
              ? tr("data_sync.field.migration_content")
              : tr("data_sync.field.sync_content")
          }
        >
          <Select value={syncContent} onChange={setSyncContent}>
            <Option value="data">
              {tr("data_sync.option.content.data")}
            </Option>
            <Option value="schema" disabled={isSourceQueryMode}>
              {tr("data_sync.option.content.schema")}
            </Option>
            <Option value="both" disabled={isSourceQueryMode}>
              {tr("data_sync.option.content.both")}
            </Option>
          </Select>
        </Form.Item>
      )}
      {!isCompareEntry && (
        <Form.Item
          label={
            isMigrationWorkflow
              ? tr("data_sync.field.migration_mode")
              : tr("data_sync.field.sync_mode")
          }
        >
          <Select
            value={syncMode}
            onChange={setSyncMode}
            disabled={syncContent === "schema"}
          >
            <Option value="insert_update">
              {tr("data_sync.option.sync_mode.insert_update")}
            </Option>
            <Option value="insert_only">
              {tr("data_sync.option.sync_mode.insert_only")}
            </Option>
            <Option value="full_overwrite">
              {tr("data_sync.option.sync_mode.full_overwrite")}
            </Option>
          </Select>
        </Form.Item>
      )}
      {!isCompareEntry && (
        <Form.Item
          label={
            tableCreationAllowed
              ? tr("data_sync.field.target_table_strategy")
              : tr("data_sync.field.target_table_requirement")
          }
        >
          <Select
            value={targetTableStrategy}
            onChange={(value) => {
              targetTableStrategyTouchedRef.current = true;
              setTargetTableStrategy(value);
            }}
            disabled={
              !tableCreationAllowed ||
              isSourceQueryMode ||
              migrationCapabilityStatus !== "ready" ||
              capabilityPresentation?.forceExistingTarget === true
            }
          >
            <Option value="existing_only">
              {tr("data_sync.option.target_strategy.existing_only")}
            </Option>
            <Option
              value="auto_create_if_missing"
              disabled={migrationCapability?.supportsAutoCreate !== true}
            >
              {tr(
                "data_sync.option.target_strategy.auto_create_if_missing",
              )}
            </Option>
            <Option
              value="smart"
              disabled={migrationCapability?.supportsAutoCreate !== true}
            >
              {tr("data_sync.option.target_strategy.smart")}
            </Option>
          </Select>
        </Form.Item>
      )}
      {isRedisMongoKeyspaceMigration && (
        <Form.Item
          label={tr("data_sync.field.mongo_collection_name")}
          extra={
            sourceType === "redis"
              ? tr("data_sync.help.mongo_collection_redis_to_mongo")
              : tr("data_sync.help.mongo_collection_mongo_to_redis")
          }
        >
          <Input
            value={mongoCollectionName}
            onChange={(e) => setMongoCollectionName(e.target.value)}
            placeholder={
              defaultMongoCollectionName ||
              tr("data_sync.placeholder.mongo_collection_name")
            }
            allowClear
            maxLength={128}
          />
        </Form.Item>
      )}
      {(!isCompareEntry || isSchemaCompareEntry) && (
        <Form.Item>
          <Checkbox
            checked={autoAddColumns}
            onChange={(e) => setAutoAddColumns(e.target.checked)}
            disabled={
              isSourceQueryMode ||
              syncContent === "data" ||
              migrationCapability?.supportsAutoAddColumns !== true
            }
          >
            {isSchemaCompareEntry
              ? tr("data_sync.compare_entry.option.auto_add_columns")
              : tr("data_sync.option.auto_add_columns")}
          </Checkbox>
        </Form.Item>
      )}
      {!isCompareEntry && (
        <Form.Item>
          <Checkbox
            checked={createIndexes}
            onChange={(e) => setCreateIndexes(e.target.checked)}
            disabled={
              !tableCreationAllowed ||
              targetTableStrategy === "existing_only" ||
              isSourceQueryMode ||
              migrationCapability?.supportsAutoCreate !== true
            }
          >
            {tr("data_sync.option.create_indexes")}
          </Checkbox>
        </Form.Item>
      )}
      {!isSourceQueryMode && capabilityStatusPresentation && (
        <Alert
          type={capabilityStatusPresentation.alertType}
          showIcon
          message={capabilityStatusPresentation.message}
          style={{ marginBottom: 12 }}
        />
      )}
      {!isSourceQueryMode &&
        capabilityPresentation &&
        (isMigrationWorkflow ||
          capabilityPresentation.blocksExecution) && (
          <Alert
            type={capabilityPresentation.alertType}
            showIcon
            message={capabilityPresentation.message}
            style={{ marginBottom: 12 }}
          />
        )}
      {isMigrationWorkflow &&
        !capabilityPresentation &&
        targetTableStrategy !== "existing_only" && (
          <Alert
            type="info"
            showIcon
            message={tr("data_sync.alert.auto_create_planner_scope")}
            style={{ marginBottom: 12 }}
          />
        )}
      {!isCompareEntry &&
        !isMigrationWorkflow &&
        !capabilityPresentation?.blocksExecution && (
          <Alert
            type="info"
            showIcon
            message={tr("data_sync.alert.existing_target_only")}
            style={{ marginBottom: 12 }}
          />
        )}
      {syncContent !== "schema" && syncMode === "full_overwrite" && (
        <Alert
          type="warning"
          showIcon
          message={tr("data_sync.alert.full_overwrite")}
        />
      )}
    </Form>
  </Card>
);
