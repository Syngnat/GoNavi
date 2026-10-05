import { Checkbox, Transfer, Form, Alert, Select, Divider, Table, Button } from "antd";
import { Text, TextArea, Option } from "./dataSyncModalUiParts";
import type { DataSyncModalPresentationApi } from "./hooks/useDataSyncModalPresentation";
import type { DataSyncModalStateApi } from "./hooks/useDataSyncModalState";
import type { DataSyncModalSyncActionsApi } from "./hooks/useDataSyncModalSyncActions";
import type { DataSyncModalTableSelectionApi } from "./hooks/useDataSyncModalTableSelection";

export interface DataSyncCompareStepProps {
  quietPanelStyle: DataSyncModalPresentationApi['quietPanelStyle'];
  isSourceQueryMode: DataSyncModalStateApi['isSourceQueryMode'];
  isCompareEntry: DataSyncModalStateApi['isCompareEntry'];
  entryPresentation: DataSyncModalStateApi['entryPresentation'];
  tr: DataSyncModalStateApi['tr'];
  showSameTables: DataSyncModalStateApi['showSameTables'];
  setShowSameTables: DataSyncModalStateApi['setShowSameTables'];
  allTables: DataSyncModalStateApi['allTables'];
  selectedTables: DataSyncModalStateApi['selectedTables'];
  setSelectedTables: DataSyncModalStateApi['setSelectedTables'];
  sourceQuery: DataSyncModalStateApi['sourceQuery'];
  setSourceQuery: DataSyncModalStateApi['setSourceQuery'];
  diffTables: DataSyncModalStateApi['diffTables'];
  analysisWarnings: DataSyncModalSyncActionsApi['analysisWarnings'];
  tableOptions: DataSyncModalStateApi['tableOptions'];
  analyzing: DataSyncModalStateApi['analyzing'];
  updateTableOption: DataSyncModalTableSelectionApi['updateTableOption'];
  openPreview: DataSyncModalSyncActionsApi['openPreview'];
}

export const DataSyncCompareStep = ({
  quietPanelStyle, isSourceQueryMode, isCompareEntry, entryPresentation, tr, showSameTables,
  setShowSameTables, allTables, selectedTables, setSelectedTables, sourceQuery, setSourceQuery,
  diffTables, analysisWarnings, tableOptions, analyzing, updateTableOption, openPreview,
}: DataSyncCompareStepProps) => (
  <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
    <div style={quietPanelStyle}>
      {!isSourceQueryMode && (
        <>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: 10,
            }}
          >
            <Text type="secondary">
              {isCompareEntry
                ? entryPresentation.tableSelectLabel
                : tr("data_sync.help.select_tables")}
            </Text>
            <Checkbox
              checked={showSameTables}
              onChange={(e) => setShowSameTables(e.target.checked)}
            >
              {tr("data_sync.option.show_same_tables")}
            </Checkbox>
          </div>
          <Transfer
            dataSource={allTables.map((t) => ({ key: t, title: t }))}
            titles={[
              tr("data_sync.transfer.source_tables"),
              tr("data_sync.transfer.selected_tables"),
            ]}
            targetKeys={selectedTables}
            onChange={(keys) => setSelectedTables(keys as string[])}
            render={(item) => item.title}
            listStyle={{
              width: 390,
              height: 320,
              marginTop: 0,
              borderRadius: 14,
              overflow: "hidden",
            }}
            locale={{
              itemUnit: tr("data_sync.transfer.item_unit"),
              itemsUnit: tr("data_sync.transfer.items_unit"),
              searchPlaceholder: tr(
                "data_sync.transfer.search_placeholder",
              ),
              notFoundContent: tr("data_sync.transfer.empty"),
            }}
          />
        </>
      )}
      {isSourceQueryMode && (
        <Form layout="vertical">
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 12 }}
            message={tr("data_sync.help.source_query_mode")}
          />
          <Form.Item label={tr("data_sync.field.source_query_sql")}>
            <TextArea
              value={sourceQuery}
              onChange={(e) => setSourceQuery(e.target.value)}
              rows={8}
              placeholder={tr("data_sync.placeholder.source_query_sql")}
              spellCheck={false}
            />
          </Form.Item>
          <Form.Item label={tr("data_sync.field.target_table")}>
            <Select
              value={selectedTables[0]}
              onChange={(value) =>
                setSelectedTables(value ? [value] : [])
              }
              showSearch
              allowClear
              placeholder={tr("data_sync.placeholder.target_table")}
              optionFilterProp="children"
            >
              {allTables.map((table) => (
                <Option key={table} value={table}>
                  {table}
                </Option>
              ))}
            </Select>
          </Form.Item>
        </Form>
      )}
    </div>

    {diffTables.length > 0 && (
      <div style={quietPanelStyle}>
        <Divider orientation="left" style={{ marginTop: 0 }}>
          {tr("data_sync.title.compare_result")}
        </Divider>
        {analysisWarnings.length > 0 && (
          <Alert
            type="warning"
            showIcon
            message={tr("data_sync.message.precheck_warnings")}
            description={
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {analysisWarnings.slice(0, 8).map((item) => (
                  <li key={item}>{item}</li>
                ))}
                {analysisWarnings.length > 8 && (
                  <li>
                    {tr("data_sync.message.more_items_collapsed", {
                      count: analysisWarnings.length - 8,
                    })}
                  </li>
                )}
              </ul>
            }
            style={{ marginBottom: 12 }}
          />
        )}
        <Table
          size="small"
          pagination={false}
          rowKey={(r: any) => r.table}
          dataSource={diffTables.filter((t) => {
            const ins = Number(t.inserts || 0);
            const upd = Number(t.updates || 0);
            const del = Number(t.deletes || 0);
            const same = Number(t.same || 0);
            const msg = String(t.message || "").trim();
            const can = !!t.canSync;
            const warns = Array.isArray(t.warnings)
              ? t.warnings.length
              : 0;
            const unsupported = Array.isArray(t.unsupportedObjects)
              ? t.unsupportedObjects.length
              : 0;
            if (showSameTables) return true;
            if (!can) return true;
            if (msg || warns > 0 || unsupported > 0) return true;
            return ins > 0 || upd > 0 || del > 0 || same === 0;
          })}
          columns={[
            {
              title: tr("data_sync.table.table_name"),
              dataIndex: "table",
              key: "table",
              ellipsis: true,
            },
            {
              title: tr("data_sync.table.target_table"),
              key: "targetTableExists",
              width: 90,
              render: (_: any, r: any) =>
                r.targetTableExists
                  ? tr("data_sync.table.target_exists")
                  : tr("data_sync.table.target_missing"),
            },
            {
              title: tr("data_sync.table.plan"),
              dataIndex: "plannedAction",
              key: "plannedAction",
              width: 220,
              ellipsis: true,
              render: (v: any) => String(v || ""),
            },
            {
              title: tr("data_sync.table.insert"),
              key: "inserts",
              width: 90,
              render: (_: any, r: any) => {
                const ops = tableOptions[r.table] || {
                  insert: true,
                  update: true,
                  delete: false,
                };
                const disabled =
                  !r.canSync ||
                  analyzing ||
                  Number(r.inserts || 0) === 0;
                return (
                  <Checkbox
                    checked={!!ops.insert}
                    disabled={disabled}
                    onChange={(e) =>
                      updateTableOption(
                        r.table,
                        "insert",
                        e.target.checked,
                      )
                    }
                  >
                    {Number(r.inserts || 0)}
                  </Checkbox>
                );
              },
            },
            {
              title: tr("data_sync.table.update"),
              key: "updates",
              width: 90,
              render: (_: any, r: any) => {
                const ops = tableOptions[r.table] || {
                  insert: true,
                  update: true,
                  delete: false,
                };
                const disabled =
                  !r.canSync ||
                  analyzing ||
                  Number(r.updates || 0) === 0;
                return (
                  <Checkbox
                    checked={!!ops.update}
                    disabled={disabled}
                    onChange={(e) =>
                      updateTableOption(
                        r.table,
                        "update",
                        e.target.checked,
                      )
                    }
                  >
                    {Number(r.updates || 0)}
                  </Checkbox>
                );
              },
            },
            {
              title: tr("data_sync.table.delete"),
              key: "deletes",
              width: 90,
              render: (_: any, r: any) => {
                const ops = tableOptions[r.table] || {
                  insert: true,
                  update: true,
                  delete: false,
                };
                const disabled =
                  !r.canSync ||
                  analyzing ||
                  Number(r.deletes || 0) === 0;
                return (
                  <Checkbox
                    checked={!!ops.delete}
                    disabled={disabled}
                    onChange={(e) =>
                      updateTableOption(
                        r.table,
                        "delete",
                        e.target.checked,
                      )
                    }
                  >
                    {Number(r.deletes || 0)}
                  </Checkbox>
                );
              },
            },
            {
              title: tr("data_sync.table.same"),
              dataIndex: "same",
              key: "same",
              width: 70,
              render: (v: any) => Number(v || 0),
            },
            {
              title: tr("data_sync.table.risk"),
              key: "warnings",
              width: 220,
              render: (_: any, r: any) => {
                const warns = [
                  ...(Array.isArray(r.warnings) ? r.warnings : []),
                  ...(Array.isArray(r.unsupportedObjects)
                    ? r.unsupportedObjects
                    : []),
                ];
                if (warns.length === 0) return "-";
                return (
                  <div
                    style={{
                      color: "#d48806",
                      fontSize: 12,
                      lineHeight: 1.5,
                    }}
                  >
                    {warns.slice(0, 2).map((item: string) => (
                      <div key={item}>{item}</div>
                    ))}
                    {warns.length > 2 && (
                      <div>
                        {tr("data_sync.message.more_items_collapsed", {
                          count: warns.length - 2,
                        })}
                      </div>
                    )}
                  </div>
                );
              },
            },
            {
              title: tr("data_sync.table.preview"),
              key: "preview",
              width: 80,
              render: (_: any, r: any) => {
                const can = !!r.canSync;
                const hasDiff =
                  Number(r.inserts || 0) +
                    Number(r.updates || 0) +
                    Number(r.deletes || 0) >
                  0;
                const hasSchemaDiff =
                  Number(r.schemaDiffCount || 0) > 0;
                return (
                  <Button
                    size="small"
                    disabled={
                      !can || !(hasDiff || hasSchemaDiff) || analyzing
                    }
                    onClick={() => openPreview(r.table)}
                  >
                    {tr("data_sync.action.view")}
                  </Button>
                );
              },
            },
          ]}
        />
      </div>
    )}
  </div>
);
