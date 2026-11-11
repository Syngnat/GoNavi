import { useCallback, useEffect, useRef, useState } from "react";
import { OpenLogDirectory, ReadAppLogTail } from "../../../wailsjs/go/app/App";

/**
 * 连接测试失败弹窗的日志读取。
 *
 * 后端 ReadAppLogTail 只读日志文件末尾 256KB，并对 SQL 字段做了脱敏，
 * 因此这里可以放心把内容直接展示给用户。keyword 用错误消息里的关键片段，
 * 匹配不到时退回展示日志尾部——两种结果都比只重复一遍错误消息有帮助。
 */

export type ConnectionTestLogLine = {
  text: string;
  level: "INFO" | "WARN" | "ERROR" | "OTHER";
};

export type ConnectionTestLogSnapshot = {
  path: string;
  lines: ConnectionTestLogLine[];
  truncated: boolean;
};

type AppLogTailData = {
  logPath?: string;
  lines?: string[];
  fileWindowTruncated?: boolean;
  matchedLinesTruncated?: boolean;
};

const toLevel = (line: string): ConnectionTestLogLine["level"] => {
  if (line.includes("[ERROR]")) return "ERROR";
  if (line.includes("[WARN]")) return "WARN";
  if (line.includes("[INFO]")) return "INFO";
  return "OTHER";
};

/**
 * 从错误消息里挑一个用于过滤日志的关键词。
 *
 * 错误消息常常是多段中文说明拼起来的（「连接建立后验证失败：第1次连接验证失败: EOF」），
 * 太长或含中文时日志里往往匹配不到任何行。这里优先取最有辨识度的短片段：
 * 冒号/分号后的最后一段，且长度适中、含 ASCII 字母。
 */
// 错误消息末尾常带「（详细日志：C:\Users\x\.GoNavi\Logs\gonavi.log）」这类提示。
// 它同时含冒号和字母，会被上面的分段规则选中，结果是拿一个文件路径去过滤日志——
// 一条都匹配不到。这里显式识别路径形态并跳过。
const looksLikeFilePath = (segment: string): boolean => (
  /[\\/]/.test(segment)
  || /\.(?:log|txt|json|db|sqlite3?)\b/i.test(segment)
  || /^[A-Za-z]:$/.test(segment)
  || /详细日志|日志文件|log file/i.test(segment)
);

export const pickConnectionTestLogKeyword = (reason: string): string => {
  const text = String(reason || "").trim();
  if (!text) return "";
  // 括号里的「详细日志：...」是附加说明，不是错误本体，先整体剥掉；
  // 否则冒号落在括号内，错误本身会和说明粘成一个片段。
  const withoutHint = text
    .replace(/[（(][^）)]*详细日志[^）)]*[）)]/g, " ")
    .replace(/[（(][^）)]*[\\/][^）)]*[）)]/g, " ");
  const segments = withoutHint
    .split(/[：:；;，,。\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index];
    if (looksLikeFilePath(segment)) continue;
    // 日志里的可检索片段通常是英文错误（EOF、timeout、refused…）。
    if (segment.length >= 3 && segment.length <= 80 && /[A-Za-z]{2}/.test(segment)) {
      return segment;
    }
  }
  return "";
};

export type ConnectionTestLogState = {
  snapshot: ConnectionTestLogSnapshot | null;
  loading: boolean;
  error: string;
  reload: () => void;
  openLogDirectory: () => void;
};

export const useConnectionTestLog = ({
  enabled,
  reason,
}: {
  enabled: boolean;
  reason: string;
}): ConnectionTestLogState => {
  const [snapshot, setSnapshot] = useState<ConnectionTestLogSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const requestSeqRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    const requestId = requestSeqRef.current + 1;
    requestSeqRef.current = requestId;
    setLoading(true);
    setError("");
    try {
      const keyword = pickConnectionTestLogKeyword(reason);
      let result = await ReadAppLogTail(80, keyword);
      // 关键词过滤不到内容时退回纯尾部日志：用户至少能看到日志长什么样。
      // 只在「读成功但没命中」时重试：读取本身失败（文件不存在/无法打开）时再
      // 调一次必然同样失败，还会用第二次的空结果覆盖第一次的真实错误。
      const keywordMissed = Boolean(keyword)
        && result?.success === true
        && Array.isArray((result.data as AppLogTailData)?.lines)
        && ((result.data as AppLogTailData).lines || []).length === 0;
      if (keywordMissed) {
        result = await ReadAppLogTail(80, "");
      }
      if (!mountedRef.current || requestSeqRef.current !== requestId) {
        return;
      }
      if (!result?.success) {
        setSnapshot(null);
        setError(String(result?.message || ""));
        return;
      }
      const data = (result.data || {}) as AppLogTailData;
      const lines = (data.lines || []).map((line) => ({
        text: line,
        level: toLevel(line),
      }));
      setSnapshot({
        path: String(data.logPath || ""),
        lines,
        truncated: Boolean(data.fileWindowTruncated || data.matchedLinesTruncated),
      });
    } catch (loadError) {
      if (!mountedRef.current || requestSeqRef.current !== requestId) {
        return;
      }
      setSnapshot(null);
      setError(String((loadError as Error)?.message || loadError || ""));
    } finally {
      if (mountedRef.current && requestSeqRef.current === requestId) {
        setLoading(false);
      }
    }
  }, [reason]);

  useEffect(() => {
    if (!enabled) {
      // 关闭时清空，避免下次打开先闪一下上一次的日志。
      setSnapshot(null);
      setError("");
      return;
    }
    void load();
  }, [enabled, load]);

  const openLogDirectory = useCallback(() => {
    void OpenLogDirectory();
  }, []);

  return {
    snapshot,
    loading,
    error,
    reload: () => void load(),
    openLogDirectory,
  };
};
