export const CLICKHOUSE_PROTOCOL_OPTIONS: Array<{
  value: "auto" | "http" | "native";
  label?: string;
  labelKey?: string;
}> = [
  { value: "auto", labelKey: "connection.modal.field.clickHouseProtocol.auto" },
  { value: "http", label: "HTTP" },
  { value: "native", label: "Native" },
];

export const OCEANBASE_PROTOCOL_OPTIONS: Array<{
  value: "mysql" | "oracle";
  label: string;
}> = [
  { value: "mysql", label: "MySQL" },
  { value: "oracle", label: "Oracle" },
];

// URI 操作反馈统一保留 4 秒，便于用户读取后自动回收空间。
export const URI_FEEDBACK_AUTO_DISMISS_MS = 4000;
