import { useMemo, useState } from "react";

import { pickConnectionTestLogKeyword } from "./useConnectionTestLog";
import type { ConnectionTestLogLine } from "./useConnectionTestLog";

/**
 * 连接测试失败弹窗的视图状态：页签选择 + 日志快照的派生值。
 *
 * 从组件里拆出来，一是让「默认页签 / 关键词命中 / 四态日志体」这些判断可以
 * 独立单测，二是避免弹窗组件继续膨胀。
 */

export type ConnectionTestFailureLogViewInput = {
  resolvedTestResultMessage?: string;
  testLog?: {
    loading?: boolean;
    error?: string;
    snapshot?: { path?: string; lines?: ConnectionTestLogLine[]; truncated?: boolean } | null;
  } | null;
};

/** 日志区域的四种状态。 */
export type ConnectionTestFailureLogState = "loading" | "error" | "empty" | "lines";

export const useConnectionTestFailureLogView = ({
  resolvedTestResultMessage,
  testLog,
}: ConnectionTestFailureLogViewInput) => {
  const snapshot = testLog?.snapshot || null;
  const logError = String(testLog?.error || "").trim();
  const logLines = snapshot?.lines || [];
  const keyword = pickConnectionTestLogKeyword(String(resolvedTestResultMessage || ""));

  // 关键词只有在日志里真的命中时才值得显示；否则那枚标签会把用户引向一个并不
  // 存在的匹配项。
  const keywordMatched = useMemo(() => (
    Boolean(keyword) && logLines.some((line) => (
      line.text.toLowerCase().includes(keyword.toLowerCase())
    ))
  ), [keyword, logLines]);

  // 默认停在有内容的那个页签：日志读到了就展示日志，读不到再看错误详情。
  //
  // 之后由用户主导：以前这里每次都把「无日志行」硬编码回落到错误页签，结果
  // 加载中、读取失败、日志为空三种情况下「运行日志」页签点不动，页面里的
  // spinner、读取失败兜底与空日志提示永远看不到。
  const [activeTab, setActiveTab] = useState<string | null>(null);
  const resolvedTab = activeTab ?? (logLines.length > 0 ? "log" : "error");

  let logState: ConnectionTestFailureLogState;
  if (testLog?.loading && !snapshot) {
    logState = "loading";
  } else if (logError) {
    logState = "error";
  } else if (logLines.length === 0) {
    logState = "empty";
  } else {
    logState = "lines";
  }

  return {
    snapshot,
    logError,
    logLines,
    keyword,
    keywordMatched,
    activeTab: resolvedTab,
    setActiveTab,
    logState,
  };
};
