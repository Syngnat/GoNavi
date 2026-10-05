import type { SupportedLanguage } from "./locales";
import { zhCNMessages } from "./messagesZhCN";
import { zhCNDriverMessages } from "./messagesZhCNDriver";
import { enUSMessages } from "./messagesEnUS";
import { enUSDriverMessages } from "./messagesEnUSDriver";

export type MessageKey = string;

export const messages: Record<SupportedLanguage, Record<MessageKey, string>> = {
  "zh-CN": { ...zhCNMessages, ...zhCNDriverMessages },
  "en-US": { ...enUSMessages, ...enUSDriverMessages },
};
