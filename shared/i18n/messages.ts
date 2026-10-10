import type { SupportedLanguage } from "./locales";
import { zhCNMessages } from "./messagesZhCN";
import { zhCNDriverMessages } from "./messagesZhCNDriver";
import { enUSMessages } from "./messagesEnUS";
import { enUSDriverMessages } from "./messagesEnUSDriver";

export type MessageKey = string;

export const messages: Record<SupportedLanguage, Record<MessageKey, string>> = {
  "zh-CN": {
    ...zhCNMessages,
    ...zhCNDriverMessages,
    "data_grid.message.navicat_http_tunnel_save_unsupported": "Navicat HTTP 脚本隧道无法跨请求保留事务，数据网格为只读，不能保证修改的原子提交。请使用直连、SSH 或 HTTP CONNECT 代理。",
    "data_grid.toolbar.navicat_http_tunnel_read_only": "HTTP 脚本隧道只读",
  },
  "en-US": {
    ...enUSMessages,
    ...enUSDriverMessages,
    "data_grid.message.navicat_http_tunnel_save_unsupported": "Navicat HTTP script tunnels cannot keep transactions across requests. The data grid is read-only and cannot save changes atomically. Use a direct connection, SSH, or an HTTP CONNECT proxy.",
    "data_grid.toolbar.navicat_http_tunnel_read_only": "Read-only HTTP script tunnel",
  },
};
