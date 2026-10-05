import { t } from '../../i18n';

export const createBrowserMockMcp = () => {
    const mockMCPServersRef: { current: any[] } = { current: [] };
    const mockMCPHTTPServerStatusRef: { current: any } = { current: {
        enabled: false,
        running: false,
        addr: '127.0.0.1:8765',
        path: '/mcp',
        url: 'http://127.0.0.1:8765/mcp',
        schemaOnly: false,
        message: t('app.browser_mock.mcp_http.not_running'),
    } };
    const mockMCPClientStatusesRef: { current: any[] } = { current: [
        {
            client: 'claude-code',
            displayName: 'Claude Code',
            installed: false,
            matchesCurrent: false,
            clientDetected: false,
            clientCommand: 'claude',
            message: t('app.browser_mock.mcp_client.claude_code.not_detected'),
            configPath: 'C:/Users/mock/.claude.json',
            command: 'C:/Program Files/GoNavi/GoNavi.exe',
            args: ['mcp-server'],
        },
        {
            client: 'codex',
            displayName: 'Codex',
            installed: true,
            matchesCurrent: false,
            clientDetected: true,
            clientCommand: 'codex',
            clientPath: 'C:/Users/mock/AppData/Roaming/npm/codex.cmd',
            message: t('app.browser_mock.mcp_client.codex.path_mismatch'),
            configPath: 'C:/Users/mock/.codex/config.toml',
            command: 'C:/Old/GoNavi.exe',
            args: ['mcp-server'],
        },
        {
            client: 'opencode',
            displayName: 'OpenCode',
            installMode: 'auto',
            installed: false,
            matchesCurrent: false,
            clientDetected: false,
            clientCommand: 'opencode',
            message: t('app.browser_mock.mcp_client.opencode.not_detected'),
            configPath: 'C:/Users/mock/.config/opencode/opencode.json',
            command: 'C:/Program Files/GoNavi/GoNavi.exe',
            args: ['mcp-server'],
        },
        {
            client: 'cursor',
            displayName: 'Cursor',
            installMode: 'auto',
            installed: false,
            matchesCurrent: false,
            clientDetected: false,
            clientCommand: 'cursor',
            message: t('ai_chat.mcp_client.install.summary.missing', { label: 'Cursor' }),
            configPath: 'C:/Users/mock/.cursor/mcp.json',
            command: 'C:/Program Files/GoNavi/GoNavi.exe',
            args: ['mcp-server'],
        },
        {
            client: 'zcode',
            displayName: 'ZCode',
            installMode: 'auto',
            installed: false,
            matchesCurrent: false,
            clientDetected: false,
            clientCommand: 'zcode',
            message: t('ai_chat.mcp_client.install.summary.missing', { label: 'ZCode' }),
            configPath: 'C:/Users/mock/.zcode/cli/config.json',
            command: 'C:/Program Files/GoNavi/GoNavi.exe',
            args: ['mcp-server'],
        },
        {
            client: 'deepseek-harness',
            displayName: 'DeepSeek Harness',
            installMode: 'auto',
            installed: false,
            matchesCurrent: false,
            clientDetected: false,
            clientCommand: 'dsh',
            message: t('ai_chat.mcp_client.install.summary.missing', { label: 'DeepSeek Harness' }),
            configPath: 'C:/Users/mock/.dsh/cordis.patch.yml',
            command: 'C:/Program Files/GoNavi/GoNavi.exe',
            args: ['mcp-server'],
        },
        {
            client: 'kimi',
            displayName: 'Kimi Code',
            installMode: 'auto',
            installed: false,
            matchesCurrent: false,
            clientDetected: false,
            clientCommand: 'kimi',
            message: t('ai_chat.mcp_client.install.summary.missing', { label: 'Kimi Code' }),
            configPath: 'C:/Users/mock/.kimi-code/mcp.json',
            command: 'C:/Program Files/GoNavi/GoNavi.exe',
            args: ['mcp-server'],
        },
        {
            client: 'grok-build',
            displayName: 'Grok Build',
            installMode: 'auto',
            installed: false,
            matchesCurrent: false,
            clientDetected: false,
            clientCommand: 'grok',
            message: t('ai_chat.mcp_client.install.summary.missing', { label: 'Grok Build' }),
            configPath: 'C:/Users/mock/.grok/config.toml',
            command: 'C:/Program Files/GoNavi/GoNavi.exe',
            args: ['mcp-server'],
        },
    ] };
    const requireBrowserMockMCPClientDetected = (client: string, displayName: string) => {
        const status = mockMCPClientStatusesRef.current.find((item) => item.client === client);
        if (status?.clientDetected) {
            return;
        }
        throw new Error(t('ai.service.mcp_client.local_client_not_detected', {
            label: displayName,
            command: String(status?.clientCommand || client).trim() || client,
        }));
    };
    const installBrowserMockMCPClient = (client: string, displayName: string, configPath: string) => {
        requireBrowserMockMCPClientDetected(client, displayName);
        const message = t('ai_chat.mcp_client.install.message.install_success', { label: displayName });
        mockMCPClientStatusesRef.current = mockMCPClientStatusesRef.current.map((item) => item.client === client
            ? {
                ...item,
                installed: true,
                matchesCurrent: true,
                message,
                command: 'C:/Program Files/GoNavi/GoNavi.exe',
                args: ['mcp-server'],
            }
            : item);
        return {
            success: true,
            client,
            message,
            configPath,
            command: 'C:/Program Files/GoNavi/GoNavi.exe',
            args: ['mcp-server'],
        };
    };
    return {
        mockMCPServersRef, mockMCPHTTPServerStatusRef, mockMCPClientStatusesRef,
        requireBrowserMockMCPClientDetected, installBrowserMockMCPClient,
    };
};
