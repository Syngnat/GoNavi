/**
 * 会话管理前端 API seam：组件依赖本接口而非直接绑定，便于测试注入
 * （参照 sessionAssets/wailsSessionAssetsApi 模式）。对应后端
 * internal/sessionagent 的 SessionAgent* 绑定。
 */
import {
  SessionAgentList,
  SessionAgentDetail,
  SessionAgentReadPage,
  SessionAgentBlockContent,
  SessionAgentExportMarkdown,
  SessionAgentCopyResume,
  SessionAgentDelete,
  SessionAgentRevealPath,
  SessionAgentTimeGroups,
  SessionAgentImageDataURL,
  SessionAgentImageInlineDataURL,
} from '../../../wailsjs/go/app/App';
import { t } from '../../i18n';

/**
 * 后端失败时的展示文案：优先用后端已经 i18n 化并带 detail 的 message，
 * 没有时退回通用文案键。
 */
export const sessionAgentErrorText = (err: unknown, fallbackKey: string): string => {
  const detail = err instanceof Error ? err.message.trim() : '';
  return detail || t(fallbackKey);
};

/** 列表条目（对应后端 SessionMeta）。 */
export interface SessionAgentItem {
  providerId: string;
  sessionId: string;
  title: string;
  summary: string;
  /** 首条真实用户消息（卡片"首次"行）。 */
  firstMessage: string;
  projectDir: string;
  createdAt: number;
  lastActiveAt: number;
  sourcePath: string;
  resumeCommand: string;
  /** 派生来源会话 ID：非空即 fork 分支，列表需要区分标记。 */
  forkedFrom?: string;
}

/** 大内容引用（对应后端 ContentRef）。 */
export interface SessionContentRef {
  kind: 'jsonl' | 'file' | 'sidecar';
  offset?: number;
  len?: number;
  relPath?: string;
  pointer?: string;
}

/** 消息块（对应后端 SessionBlock）。 */
export interface SessionBlockView {
  type: 'text' | 'thinking' | 'tool_call' | 'tool_result' | 'image' | 'event' | 'step';
  text?: { text: string; full?: SessionContentRef };
  thinking?: { text: string; summary?: string; redacted?: boolean; full?: SessionContentRef };
  toolCall?: {
    id: string;
    rawName: string;
    kind: string;
    title: string;
    detail?: string;
    inputPreview?: string;
    inputText?: string;
    inputTotalLen?: number;
    inputFull?: SessionContentRef;
    diff?: { files: Array<{ path: string; op: string; added: number; removed: number }>; added: number; removed: number };
    byUser?: boolean;
  };
  toolResult?: {
    callId: string;
    status: string;
    preview?: string;
    totalLen?: number;
    truncated?: boolean;
    full?: SessionContentRef;
    exitCode?: number;
  };
  event?: { kind: string; text?: string; url?: string };
  image?: {
    source: 'inline' | 'local_file';
    content?: SessionContentRef;
    path?: string;
    mediaType?: string;
    size?: number;
    alt?: string;
  };
}

/** 结构化结论（后端解析阶段拆好，前端只负责渲染）。 */
export interface SessionStructuredBodyView {
  /** 承载自然语言的正文。 */
  prose: string;
  /** 正文来自哪个字段。 */
  proseField?: string;
  /** 其余字段的摘要。 */
  fields?: Array<{
    key: string;
    kind: 'scalar' | 'array' | 'object';
    value?: string;
    count?: number;
    detail?: string;
  }>;
}

/** 消息（对应后端 SessionMessage）。 */
export interface SessionMessageView {
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  ts: number;
  id?: string;
  turnId?: string;
  injected?: boolean;
  blocks?: SessionBlockView[];
  /** 正文是结构化 JSON 时的拆解结果（子 Agent 的结论）。 */
  structured?: SessionStructuredBodyView;
}

/** 轮次索引（对应后端 TurnIndex）。 */
export interface SessionTurnView {
  turnId: string;
  firstMessageIndex: number;
  lastMessageIndex: number;
  questionPreview: string;
  ts: number;
  stepCount: number;
  errorCount: number;
  hasFinalReply: boolean;
  aborted: boolean;
}

/** 按需内容一页（对应后端 BlockContent）。 */
export interface SessionBlockContent {
  text: string;
  totalLen: number;
  truncated: boolean;
  nextOffset?: number;
}

export type SessionAgentApi = {
  list(provider: string, search: string): Promise<SessionAgentItem[]>;
  detail(provider: string, sourcePath: string): Promise<{ messages: SessionMessageView[]; turns: SessionTurnView[]; cached: boolean } | null>;
  readPage(provider: string, sourcePath: string, offset: number, limit: number): Promise<SessionMessageView[]>;
  blockContent(provider: string, sourcePath: string, ref: SessionContentRef, offset: number, limit: number): Promise<SessionBlockContent | null>;
  exportMarkdown(provider: string, sourcePath: string): Promise<string>;
  copyResume(provider: string, sessionId: string): Promise<string>;
  delete(provider: string, sourcePath: string, sessionId: string): Promise<boolean>;
  revealPath(sourcePath: string): Promise<string>;
  /** 读取本机图片并返回 data URL（webview 不能直接加载本机路径图片）。 */
  imageDataUrl(path: string): Promise<string>;
  /** 读取会话内联图片（Claude 的 base64 图片块）并返回 data URL。 */
  imageInlineDataUrl(provider: string, sourcePath: string, ref: SessionContentRef, mediaType: string): Promise<string>;
  timeGroups(provider: string, search: string): Promise<{ groups: Record<string, SessionAgentItem[]>; total: number }>;
};

/**
 * 拆后端 QueryResult。
 *
 * 后端失败时抛错：QueryResult.message 已经 i18n 化并带了 detail，原样
 * 带出才能让调用方给出可见反馈。旧实现失败时返回 null/空数组，调用方的
 * catch 永远不触发——用户只看到「空列表」，分不清是没有会话、智能体没
 * 添加还是扫描失败。
 */
const unwrap = <T,>(result: { success?: boolean; data?: unknown; message?: string } | null | undefined): T | null => {
  if (!result) {
    throw new Error('');
  }
  if (!result.success) {
    throw new Error(result.message ?? '');
  }
  return (result.data ?? null) as T | null;
};

export const wailsSessionAgentApi: SessionAgentApi = {
  async list(provider, search) {
    const result = await SessionAgentList(provider, search);
    return unwrap<{ items: SessionAgentItem[] }>(result)?.items ?? [];
  },
  async detail(provider, sourcePath) {
    return unwrap<{ messages: SessionMessageView[]; turns: SessionTurnView[]; cached: boolean }>(
      await SessionAgentDetail(provider, sourcePath),
    );
  },
  async readPage(provider, sourcePath, offset, limit) {
    const result = await SessionAgentReadPage(provider, sourcePath, offset, limit);
    return unwrap<{ messages: SessionMessageView[] }>(result)?.messages ?? [];
  },
  async blockContent(provider, sourcePath, ref, offset, limit) {
    return unwrap<SessionBlockContent>(
      await SessionAgentBlockContent(provider, sourcePath, ref, offset, limit),
    );
  },
  async exportMarkdown(provider, sourcePath) {
    const result = await SessionAgentExportMarkdown(provider, sourcePath);
    return unwrap<{ markdown: string }>(result)?.markdown ?? '';
  },
  async copyResume(provider, sessionId) {
    const result = await SessionAgentCopyResume(provider, sessionId);
    return unwrap<{ command: string }>(result)?.command ?? '';
  },
  async delete(provider, sourcePath, sessionId) {
    const result = await SessionAgentDelete(provider, sourcePath, sessionId);
    return Boolean(result?.success);
  },
  async revealPath(sourcePath) {
    const result = await SessionAgentRevealPath(sourcePath);
    return unwrap<{ path: string }>(result)?.path ?? '';
  },
  async imageDataUrl(path) {
    const result = await SessionAgentImageDataURL(path);
    return unwrap<{ dataUrl: string }>(result)?.dataUrl ?? '';
  },
  async imageInlineDataUrl(provider, sourcePath, ref, mediaType) {
    const result = await SessionAgentImageInlineDataURL(provider, sourcePath, ref, mediaType);
    return unwrap<{ dataUrl: string }>(result)?.dataUrl ?? '';
  },
  async timeGroups(provider, search) {
    return (
      unwrap<{ groups: Record<string, SessionAgentItem[]>; total: number }>(
        await SessionAgentTimeGroups(provider, search),
      ) ?? { groups: {}, total: 0 }
    );
  },
};
