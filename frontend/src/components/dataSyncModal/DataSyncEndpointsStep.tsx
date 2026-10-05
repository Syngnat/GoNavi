import { Card, Form, Select, Input } from "antd";
import { SwapOutlined } from "@ant-design/icons";
import { Option } from "./dataSyncModalUiParts";
import type { DataSyncModalStateApi } from "./hooks/useDataSyncModalState";
import type { DataSyncModalPresentationApi } from "./hooks/useDataSyncModalPresentation";
import type { DataSyncModalTableSelectionApi } from "./hooks/useDataSyncModalTableSelection";

export interface DataSyncEndpointsStepProps {
  tr: DataSyncModalStateApi['tr'];
  shellCardStyle: DataSyncModalPresentationApi['shellCardStyle'];
  darkMode: DataSyncModalStateApi['darkMode'];
  sourceConnId: DataSyncModalStateApi['sourceConnId'];
  handleSourceConnChange: DataSyncModalTableSelectionApi['handleSourceConnChange'];
  connections: DataSyncModalStateApi['connections'];
  sourceDbs: DataSyncModalStateApi['sourceDbs'];
  sourceDb: DataSyncModalStateApi['sourceDb'];
  setSourceDb: DataSyncModalStateApi['setSourceDb'];
  badgeStyle: DataSyncModalPresentationApi['badgeStyle'];
  targetConnId: DataSyncModalStateApi['targetConnId'];
  handleTargetConnChange: DataSyncModalTableSelectionApi['handleTargetConnChange'];
  targetDbs: DataSyncModalStateApi['targetDbs'];
  targetDb: DataSyncModalStateApi['targetDb'];
  setTargetDb: DataSyncModalStateApi['setTargetDb'];
  targetSupportsSchemaSelection: DataSyncModalStateApi['targetSupportsSchemaSelection'];
  targetSchema: DataSyncModalStateApi['targetSchema'];
  setTargetSchema: DataSyncModalStateApi['setTargetSchema'];
  targetSchemaLoading: DataSyncModalStateApi['targetSchemaLoading'];
  targetSchemas: DataSyncModalStateApi['targetSchemas'];
}

export const DataSyncEndpointsStep = ({
  tr, shellCardStyle, darkMode, sourceConnId, handleSourceConnChange, connections, sourceDbs,
  sourceDb, setSourceDb, badgeStyle, targetConnId, handleTargetConnChange, targetDbs, targetDb,
  setTargetDb, targetSupportsSchemaSelection, targetSchema, setTargetSchema, targetSchemaLoading,
  targetSchemas,
}: DataSyncEndpointsStepProps) => (
  <div
    style={{
      display: "grid",
      gridTemplateColumns: "minmax(0, 1fr) 44px minmax(0, 1fr)",
      gap: 18,
      alignItems: "stretch",
    }}
  >
    <Card
      title={tr("data_sync.title.source_database")}
      style={shellCardStyle}
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
      <Form layout="vertical">
        <Form.Item label={tr("data_sync.field.connection")}>
          <Select
            value={sourceConnId}
            onChange={handleSourceConnChange}
          >
            {connections.map((c) => (
              <Option key={c.id} value={c.id}>
                {c.name} ({c.config.type})
              </Option>
            ))}
          </Select>
        </Form.Item>
        <Form.Item label={tr("data_sync.field.database")}>
          {sourceDbs.length > 0 ? (
            <Select value={sourceDb} onChange={setSourceDb} showSearch>
              {sourceDbs.map((d) => (
                <Option key={d} value={d}>
                  {d}
                </Option>
              ))}
            </Select>
          ) : (
            <Input
              value={sourceDb}
              onChange={(event) => setSourceDb(event.target.value)}
              placeholder={tr("data_sync.placeholder.database_manual")}
            />
          )}
        </Form.Item>
      </Form>
    </Card>
    <div style={{ display: "grid", placeItems: "center" }}>
      <div
        style={{
          ...badgeStyle,
          width: 44,
          height: 44,
          borderRadius: 14,
          justifyContent: "center",
          padding: 0,
        }}
      >
        <SwapOutlined />
      </div>
    </div>
    <Card
      title={tr("data_sync.title.target_database")}
      style={shellCardStyle}
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
      <Form layout="vertical">
        <Form.Item label={tr("data_sync.field.connection")}>
          <Select
            value={targetConnId}
            onChange={handleTargetConnChange}
          >
            {connections.map((c) => (
              <Option key={c.id} value={c.id}>
                {c.name} ({c.config.type})
              </Option>
            ))}
          </Select>
        </Form.Item>
        <Form.Item label={tr("data_sync.field.database")}>
          {targetDbs.length > 0 ? (
            <Select value={targetDb} onChange={setTargetDb} showSearch>
              {targetDbs.map((d) => (
                <Option key={d} value={d}>
                  {d}
                </Option>
              ))}
            </Select>
          ) : (
            <Input
              value={targetDb}
              onChange={(event) => setTargetDb(event.target.value)}
              placeholder={tr("data_sync.placeholder.database_manual")}
            />
          )}
        </Form.Item>
        {targetSupportsSchemaSelection && (
          <Form.Item label={tr("data_sync.field.schema")}>
            <Select
              value={targetSchema || undefined}
              onChange={(value) =>
                setTargetSchema(String(value || ""))
              }
              showSearch
              allowClear
              loading={targetSchemaLoading}
              disabled={!targetDb}
            >
              {targetSchemas.map((schemaName) => (
                <Option key={schemaName} value={schemaName}>
                  {schemaName}
                </Option>
              ))}
            </Select>
          </Form.Item>
        )}
      </Form>
    </Card>
  </div>
);
