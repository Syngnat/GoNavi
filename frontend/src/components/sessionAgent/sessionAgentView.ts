import type { SessionBlockView, SessionMessageView, SessionTurnView } from './sessionAgentApi';

export type SessionToolCall = NonNullable<SessionBlockView['toolCall']>;

export interface SessionChangePatch {
  id: string;
  title: string;
  inputPreview?: string;
  inputText?: string;
  inputFull?: SessionToolCall['inputFull'];
}

export interface SessionChangeFile {
  path: string;
  op: string;
  added: number;
  removed: number;
  patches: SessionChangePatch[];
}

export const turnMessages = (turn: SessionTurnView, messages: SessionMessageView[]): SessionMessageView[] =>
  messages.slice(turn.firstMessageIndex, turn.lastMessageIndex + 1);

export const turnBlocks = (messages: SessionMessageView[]): SessionBlockView[] =>
  messages.flatMap((message) => message.blocks ?? []);

export const turnFileCount = (messages: SessionMessageView[]): number => {
  const paths = new Set<string>();
  for (const block of turnBlocks(messages)) {
    for (const file of block.toolCall?.diff?.files ?? []) paths.add(file.path);
  }
  return paths.size;
};

const blockSearchText = (block: SessionBlockView): string => [
  block.text?.text,
  block.thinking?.text,
  block.thinking?.summary,
  block.toolCall?.title,
  block.toolCall?.detail,
  block.toolCall?.inputPreview,
  block.toolCall?.rawName,
  block.toolResult?.preview,
  block.event?.text,
  block.event?.kind,
].filter(Boolean).join(' ');

export const sessionMessageSearchText = (message: SessionMessageView): string => [
  message.content,
  message.structured?.prose,
  ...(message.structured?.fields ?? []).flatMap((field) => [field.key, field.value, field.detail]),
  ...(message.blocks ?? []).map(blockSearchText),
].filter(Boolean).join(' ').toLowerCase();

export const sessionTurnMatches = (turn: SessionTurnView, messages: SessionMessageView[], needle: string): boolean => {
  if (!needle) return true;
  if (turn.questionPreview.toLowerCase().includes(needle)) return true;
  return turnMessages(turn, messages).some((message) => sessionMessageSearchText(message).includes(needle));
};

// 将多次 patch 按文件聚合，同时保留每次原始输入供 diff 展开。
export const buildSessionChanges = (messages: SessionMessageView[]): SessionChangeFile[] => {
  const files = new Map<string, SessionChangeFile>();
  for (const block of turnBlocks(messages)) {
    const call = block.toolCall;
    if (!call?.diff) continue;
    for (const file of call.diff.files) {
      const current = files.get(file.path) ?? {
        path: file.path,
        op: file.op,
        added: 0,
        removed: 0,
        patches: [],
      };
      current.op = file.op || current.op;
      current.added += file.added;
      current.removed += file.removed;
      current.patches.push({
        id: call.id,
        title: call.title,
        inputPreview: call.inputPreview,
        inputText: call.inputText,
        inputFull: call.inputFull,
      });
      files.set(file.path, current);
    }
  }
  return Array.from(files.values());
};

export const sessionChangeMatches = (file: SessionChangeFile, needle: string): boolean => {
  if (!needle) return true;
  return [file.path, file.op, ...file.patches.flatMap((patch) => [patch.title, patch.inputPreview])]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .includes(needle);
};

export const formatSessionDateTime = (ts: number): string => {
  if (!ts) return '—';
  return new Date(ts).toLocaleString([], {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
};
