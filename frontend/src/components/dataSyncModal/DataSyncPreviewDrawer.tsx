import { Drawer, Alert, Divider, Tabs, Table, Button, message } from "antd";
import { Text, Title } from "./dataSyncModalUiParts";
import Modal from "../common/ResizableDraggableModal";
import type { DataSyncModalStateApi } from "./hooks/useDataSyncModalState";
import type { DataSyncModalSyncActionsApi } from "./hooks/useDataSyncModalSyncActions";
import type { DataSyncModalTableSelectionApi } from "./hooks/useDataSyncModalTableSelection";

export interface DataSyncPreviewDrawerProps {
  tr: DataSyncModalStateApi['tr'];
  previewTable: DataSyncModalStateApi['previewTable'];
  darkMode: DataSyncModalStateApi['darkMode'];
  previewOpen: DataSyncModalStateApi['previewOpen'];
  previewRequestSeqRef: DataSyncModalStateApi['previewRequestSeqRef'];
  previewAbortRef: DataSyncModalStateApi['previewAbortRef'];
  setPreviewOpen: DataSyncModalStateApi['setPreviewOpen'];
  setPreviewTable: DataSyncModalStateApi['setPreviewTable'];
  setPreviewData: DataSyncModalStateApi['setPreviewData'];
  previewLoading: DataSyncModalStateApi['previewLoading'];
  previewData: DataSyncModalStateApi['previewData'];
  previewHasDataDiff: DataSyncModalSyncActionsApi['previewHasDataDiff'];
  previewSql: DataSyncModalSyncActionsApi['previewSql'];
  previewSchemaWarnings: DataSyncModalSyncActionsApi['previewSchemaWarnings'];
  previewHasSchemaStatements: DataSyncModalSyncActionsApi['previewHasSchemaStatements'];
  previewRowSelectionSupported: DataSyncModalSyncActionsApi['previewRowSelectionSupported'];
  isCompareEntry: DataSyncModalStateApi['isCompareEntry'];
  tableOptions: DataSyncModalStateApi['tableOptions'];
  updateTableOption: DataSyncModalTableSelectionApi['updateTableOption'];
}

export const DataSyncPreviewDrawer = ({
  tr, previewTable, darkMode, previewOpen, previewRequestSeqRef, previewAbortRef, setPreviewOpen,
  setPreviewTable, setPreviewData, previewLoading, previewData, previewHasDataDiff, previewSql,
  previewSchemaWarnings, previewHasSchemaStatements, previewRowSelectionSupported, isCompareEntry,
  tableOptions, updateTableOption,
}: DataSyncPreviewDrawerProps) => (
  <Drawer
    title={tr("data_sync.preview.title", { table: previewTable })}
    styles={{
      body: { background: darkMode ? "rgba(9,13,20,0.98)" : "#f8fafc" },
    }}
    open={previewOpen}
    onClose={() => {
      previewRequestSeqRef.current += 1;
      previewAbortRef.current?.abort();
      previewAbortRef.current = null;
      setPreviewOpen(false);
      setPreviewTable("");
      setPreviewData(null);
    }}
    width={900}
  >
    {previewLoading && (
      <Alert
        type="info"
        showIcon
        message={tr("data_sync.preview.loading")}
      />
    )}
    {!previewLoading && previewData && (
      <div>
        <Alert
          type="info"
          showIcon
          message={
            previewHasDataDiff
              ? tr("data_sync.preview.data_summary", {
                  inserts: previewData.totalInserts || 0,
                  updates: previewData.totalUpdates || 0,
                  deletes: previewData.totalDeletes || 0,
                })
              : previewData.schemaSummary ||
                tr("data_sync.preview.schema_statement_count", {
                  count: previewSql.statementCount,
                })
          }
        />
        {previewSchemaWarnings.length > 0 && (
          <Alert
            style={{ marginTop: 12 }}
            type="warning"
            showIcon
            message={tr("data_sync.preview.schema_warning_title")}
            description={
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {previewSchemaWarnings.slice(0, 8).map((item) => (
                  <li key={item}>{item}</li>
                ))}
                {previewSchemaWarnings.length > 8 && (
                  <li>
                    {tr("data_sync.message.more_items_collapsed", {
                      count: previewSchemaWarnings.length - 8,
                    })}
                  </li>
                )}
              </ul>
            }
          />
        )}
        <Divider />
        <Tabs
          items={[
            ...(previewHasSchemaStatements
              ? [
                  {
                    key: "schema",
                    label: tr("data_sync.preview.tab.schema", {
                      count: Array.isArray(previewData.schemaStatements)
                        ? previewData.schemaStatements.length
                        : 0,
                    }),
                    children: (
                      <div>
                        <Text type="secondary">
                          {previewData.schemaSummary ||
                            tr("data_sync.preview.schema_plan_help")}
                        </Text>
                        <pre
                          style={{
                            marginTop: 8,
                            marginBottom: 0,
                            padding: 10,
                            border: "1px solid #f0f0f0",
                            borderRadius: 6,
                            background: "#fafafa",
                            maxHeight: 420,
                            overflow: "auto",
                            whiteSpace: "pre-wrap",
                            wordBreak: "break-word",
                          }}
                        >
                          {Array.isArray(previewData.schemaStatements) &&
                          previewData.schemaStatements.length > 0
                            ? previewData.schemaStatements.join("\n")
                            : tr("data_sync.preview.sql.no_schema_changes")}
                        </pre>
                      </div>
                    ),
                  },
                ]
              : []),
            ...(previewHasDataDiff
              ? [
                  {
                    key: "insert",
                    label: tr("data_sync.preview.tab.insert", {
                      count: previewData.totalInserts || 0,
                    }),
                    children: (
                      <div>
                        {previewRowSelectionSupported && (
                          <Text type="secondary">
                            {isCompareEntry
                              ? tr(
                                  "data_sync.compare_entry.preview.selection_hint",
                                )
                              : tr("data_sync.preview.selection_hint.insert")}
                          </Text>
                        )}
                        <Table
                          size="small"
                          style={{ marginTop: 8 }}
                          rowKey={(r: any, index?: number) =>
                            r.pk || `preview-insert-${index ?? 0}`}
                          dataSource={(previewData.inserts || []).map(
                            (r: any, index: number) => ({
                              ...r,
                              key: r.pk || `preview-insert-${index}`,
                            }),
                          )}
                          pagination={false}
                          rowSelection={
                            previewRowSelectionSupported
                              ? {
                                  selectedRowKeys: (tableOptions[previewTable]
                                    ?.selectedInsertPks || []) as any,
                                  onChange: (keys) =>
                                    updateTableOption(
                                      previewTable,
                                      "selectedInsertPks",
                                      keys as string[],
                                    ),
                                  getCheckboxProps: () => ({
                                    disabled: !tableOptions[previewTable]?.insert,
                                  }),
                                }
                              : undefined
                          }
                          columns={[
                            {
                              title:
                                previewData.pkColumn ||
                                tr("data_sync.preview.column.primary_key"),
                              dataIndex: "pk",
                              key: "pk",
                              width: 200,
                              ellipsis: true,
                            },
                            {
                              title: tr("data_sync.preview.column.data"),
                              dataIndex: "row",
                              key: "row",
                              render: (v: any) => (
                                <pre
                                  style={{
                                    margin: 0,
                                    maxHeight: 140,
                                    overflow: "auto",
                                  }}
                                >
                                  {JSON.stringify(v, null, 2)}
                                </pre>
                              ),
                            },
                          ]}
                        />
                      </div>
                    ),
                  },
                  {
                    key: "update",
                    label: tr("data_sync.preview.tab.update", {
                      count: previewData.totalUpdates || 0,
                    }),
                    children: (
                      <div>
                        {previewRowSelectionSupported && (
                          <Text type="secondary">
                            {isCompareEntry
                              ? tr(
                                  "data_sync.compare_entry.preview.selection_hint",
                                )
                              : tr("data_sync.preview.selection_hint.update")}
                          </Text>
                        )}
                        <Table
                          size="small"
                          style={{ marginTop: 8 }}
                          rowKey={(r: any) => r.pk}
                          dataSource={(previewData.updates || []).map(
                            (r: any) => ({ ...r, key: r.pk }),
                          )}
                          pagination={false}
                          rowSelection={
                            previewRowSelectionSupported
                              ? {
                                  selectedRowKeys: (tableOptions[previewTable]
                                    ?.selectedUpdatePks || []) as any,
                                  onChange: (keys) =>
                                    updateTableOption(
                                      previewTable,
                                      "selectedUpdatePks",
                                      keys as string[],
                                    ),
                                  getCheckboxProps: () => ({
                                    disabled: !tableOptions[previewTable]?.update,
                                  }),
                                }
                              : undefined
                          }
                          columns={[
                            {
                              title:
                                previewData.pkColumn ||
                                tr("data_sync.preview.column.primary_key"),
                              dataIndex: "pk",
                              key: "pk",
                              width: 200,
                              ellipsis: true,
                            },
                            {
                              title: tr(
                                "data_sync.preview.column.changed_columns",
                              ),
                              dataIndex: "changedColumns",
                              key: "changedColumns",
                              render: (v: any) =>
                                Array.isArray(v) ? v.join(", ") : "",
                            },
                            {
                              title: tr("data_sync.preview.column.detail"),
                              key: "detail",
                              width: 80,
                              render: (_: any, r: any) => (
                                <Button
                                  size="small"
                                  onClick={() => {
                                    Modal.info({
                                      title: tr(
                                        "data_sync.preview.update_detail_title",
                                        { table: previewTable, pk: r.pk },
                                      ),
                                      width: 900,
                                      content: (
                                        <div
                                          style={{
                                            display: "flex",
                                            gap: 12,
                                          }}
                                        >
                                          <div style={{ flex: 1 }}>
                                            <Title level={5}>
                                              {tr(
                                                "data_sync.preview.side.source",
                                              )}
                                            </Title>
                                            <pre
                                              style={{
                                                maxHeight: 360,
                                                overflow: "auto",
                                                background: "#f5f5f5",
                                                padding: 8,
                                              }}
                                            >
                                              {JSON.stringify(
                                                r.source,
                                                null,
                                                2,
                                              )}
                                            </pre>
                                          </div>
                                          <div style={{ flex: 1 }}>
                                            <Title level={5}>
                                              {tr(
                                                "data_sync.preview.side.target",
                                              )}
                                            </Title>
                                            <pre
                                              style={{
                                                maxHeight: 360,
                                                overflow: "auto",
                                                background: "#f5f5f5",
                                                padding: 8,
                                              }}
                                            >
                                              {JSON.stringify(
                                                r.target,
                                                null,
                                                2,
                                              )}
                                            </pre>
                                          </div>
                                        </div>
                                      ),
                                    });
                                  }}
                                >
                                  {tr("data_sync.action.view")}
                                </Button>
                              ),
                            },
                          ]}
                        />
                      </div>
                    ),
                  },
                  {
                    key: "delete",
                    label: tr("data_sync.preview.tab.delete", {
                      count: previewData.totalDeletes || 0,
                    }),
                    children: (
                      <div>
                        <Alert
                          type="warning"
                          showIcon
                          message={tr("data_sync.preview.delete_warning")}
                        />
                        {previewRowSelectionSupported && (
                          <Text type="secondary">
                            {isCompareEntry
                              ? tr(
                                  "data_sync.compare_entry.preview.selection_hint",
                                )
                              : tr("data_sync.preview.selection_hint.delete")}
                          </Text>
                        )}
                        <Table
                          size="small"
                          style={{ marginTop: 8 }}
                          rowKey={(r: any) => r.pk}
                          dataSource={(previewData.deletes || []).map(
                            (r: any) => ({ ...r, key: r.pk }),
                          )}
                          pagination={false}
                          rowSelection={
                            previewRowSelectionSupported
                              ? {
                                  selectedRowKeys: (tableOptions[previewTable]
                                    ?.selectedDeletePks || []) as any,
                                  onChange: (keys) =>
                                    updateTableOption(
                                      previewTable,
                                      "selectedDeletePks",
                                      keys as string[],
                                    ),
                                  getCheckboxProps: () => ({
                                    disabled: !tableOptions[previewTable]?.delete,
                                  }),
                                }
                              : undefined
                          }
                          columns={[
                            {
                              title:
                                previewData.pkColumn ||
                                tr("data_sync.preview.column.primary_key"),
                              dataIndex: "pk",
                              key: "pk",
                              width: 200,
                              ellipsis: true,
                            },
                            {
                              title: tr("data_sync.preview.column.data"),
                              dataIndex: "row",
                              key: "row",
                              render: (v: any) => (
                                <pre
                                  style={{
                                    margin: 0,
                                    maxHeight: 140,
                                    overflow: "auto",
                                  }}
                                >
                                  {JSON.stringify(v, null, 2)}
                                </pre>
                              ),
                            },
                          ]}
                        />
                      </div>
                    ),
                  },
                ]
              : []),
            {
              key: "sql",
              label: tr("data_sync.preview.tab.sql", {
                count: previewSql.statementCount,
              }),
              children: (
                <div>
                  <Alert
                    type="info"
                    showIcon
                    message={
                      previewHasDataDiff
                        ? isCompareEntry
                          ? tr(
                              "data_sync.compare_entry.preview.sql.data_help",
                            )
                          : tr("data_sync.preview.sql.data_help")
                        : isCompareEntry
                          ? tr(
                              "data_sync.compare_entry.preview.sql.schema_help",
                            )
                          : tr("data_sync.preview.sql.schema_help")
                    }
                  />
                  <div
                    style={{
                      marginTop: 8,
                      marginBottom: 8,
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                    }}
                  >
                    <Text type="secondary">
                      {previewHasDataDiff
                        ? tr("data_sync.preview.sql.statement_count", {
                            count: previewSql.statementCount,
                          })
                        : tr(
                            "data_sync.preview.sql.schema_statement_count",
                            { count: previewSql.statementCount },
                          )}
                    </Text>
                    <Button
                      size="small"
                      disabled={!previewSql.sqlText}
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(
                            previewSql.sqlText || "",
                          );
                          message.success(
                            tr("data_sync.preview.message.sql_copied"),
                          );
                        } catch {
                          message.error(
                            tr("data_sync.preview.message.copy_failed"),
                          );
                        }
                      }}
                    >
                      {tr("data_sync.preview.action.copy_sql")}
                    </Button>
                  </div>
                  <pre
                    style={{
                      margin: 0,
                      padding: 10,
                      border: "1px solid #f0f0f0",
                      borderRadius: 6,
                      background: "#fafafa",
                      maxHeight: 420,
                      overflow: "auto",
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-word",
                    }}
                  >
                    {previewSql.sqlText ||
                      (previewHasDataDiff
                        ? tr("data_sync.preview.sql.no_data_sql")
                        : tr("data_sync.preview.sql.no_schema_changes"))}
                  </pre>
                </div>
              ),
            },
          ]}
        />
      </div>
    )}
  </Drawer>
);
