import type { AIMCPHTTPServerStatus, AIResultMaskingSettings } from '../../types';
import type { AIMCPHTTPServerDraft } from '../ai/AIMCPHTTPServerPanel';

export const DEFAULT_MCP_HTTP_SERVER_STATUS: AIMCPHTTPServerStatus = {
    enabled: false,
    running: false,
    addr: '127.0.0.1:8765',
    path: '/mcp',
    url: 'http://127.0.0.1:8765/mcp',
    // 设置页始终开放全部数据库内置工具，与内置助手共用安全控制
    schemaOnly: false,
    message: '',
};

export const DEFAULT_MCP_HTTP_SERVER_DRAFT: AIMCPHTTPServerDraft = {
    addr: DEFAULT_MCP_HTTP_SERVER_STATUS.addr,
    path: DEFAULT_MCP_HTTP_SERVER_STATUS.path,
    authorizationHeader: '',
    schemaOnly: false,
};

export const DEFAULT_AI_RESULT_MASKING_SETTINGS: AIResultMaskingSettings = {
    enabled: false,
    fullMaskFields: [],
    partialMaskFields: [],
};

export const buildMCPHTTPServerDraftFromStatus = (
    status: AIMCPHTTPServerStatus,
    fallback: AIMCPHTTPServerDraft = DEFAULT_MCP_HTTP_SERVER_DRAFT,
): AIMCPHTTPServerDraft => ({
    addr: String(status.addr || fallback.addr || DEFAULT_MCP_HTTP_SERVER_STATUS.addr).trim(),
    path: String(status.path || fallback.path || DEFAULT_MCP_HTTP_SERVER_STATUS.path).trim(),
    authorizationHeader: String(
        status.authorizationHeader ||
        (status.token ? `Bearer ${status.token}` : '') ||
        fallback.authorizationHeader ||
        '',
    ).trim(),
    schemaOnly: status.running === true && status.schemaOnly === true,
});

export const normalizeMCPHTTPAuthorizationToken = (value: string): string => {
    const trimmed = String(value || '').trim();
    if (!trimmed) return '';
    const withoutHeaderName = trimmed.replace(/^Authorization\s*:\s*/i, '').trim();
    return withoutHeaderName.replace(/^Bearer\s+/i, '').trim();
};
