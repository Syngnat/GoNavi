import { Spin } from "antd";

import { t } from "../../i18n";
import type { ConnectionTestLogLine } from "./useConnectionTestLog";
import type { ConnectionTestFailureLogState } from "./useConnectionTestFailureLogView";

/**
 * 连接测试失败弹窗里的日志区内容：加载中 / 读取失败 / 空日志 / 有内容四态。
 *
 * 从弹窗组件里拆出来，一是组件本身已经超长，二是这四种形态各自有独立的
 * 文案与样式，放在一起更容易看错分支。
 */

const LEVEL_COLORS: Record<ConnectionTestLogLine["level"], string> = {
  ERROR: "#a8071a",
  WARN: "#ad6800",
  INFO: "#595959",
  OTHER: "#8c8c8c",
};

const codeBlockStyle: React.CSSProperties = {
  margin: 0,
  maxHeight: 320,
  overflowY: "auto",
  padding: 12,
  borderRadius: 6,
  whiteSpace: "pre-wrap",
  wordBreak: "break-all",
  lineHeight: "20px",
  fontSize: 13,
  fontFamily: "var(--gn-font-mono)",
};

export type ConnectionTestFailureLogBodyProps = {
  state: ConnectionTestFailureLogState;
  lines: ConnectionTestLogLine[];
  error: string;
  truncated?: boolean;
  path?: string;
};

export const ConnectionTestFailureLogBody = ({
  state, lines, error, truncated, path,
}: ConnectionTestFailureLogBodyProps) => {
  if (state === "loading") {
    return (
      <div style={{ padding: 24, textAlign: "center" }}>
        <Spin size="small" />
      </div>
    );
  }
  if (state === "error") {
    return (
      <pre style={{ ...codeBlockStyle, background: "#fff2f0", border: "1px solid #ffccc7", color: "#a8071a" }}>
        {t("connection.modal.failureDialog.logUnavailable", { detail: error })}
      </pre>
    );
  }
  if (state === "empty") {
    return (
      <pre style={{ ...codeBlockStyle, background: "#fafafa", border: "1px solid #f0f0f0", color: "#595959" }}>
        {t("connection.modal.failureDialog.logEmpty")}
      </pre>
    );
  }
  return (
    <div>
      <pre style={{ ...codeBlockStyle, background: "#fafafa", border: "1px solid #f0f0f0" }}>
        {lines.map((line, index) => (
          <div key={`${index}-${line.level}`} style={{ color: LEVEL_COLORS[line.level] }}>
            {line.text}
          </div>
        ))}
      </pre>
      {truncated && (
        <div style={{ marginTop: 6, fontSize: 12, color: "#8c8c8c" }}>
          {t("connection.modal.failureDialog.logTruncated", { count: lines.length })}
        </div>
      )}
      {path && (
        <div style={{ marginTop: 4, fontSize: 12, color: "#8c8c8c", wordBreak: "break-all" }}>
          {t("connection.modal.failureDialog.logPath", { path })}
        </div>
      )}
    </div>
  );
};
