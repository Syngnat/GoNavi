import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { filterAISlashCommands, getFeaturedAISlashCommands } from './aiSlashCommands';
const zhCnCatalog = JSON.parse(readFileSync(new URL('../../../../shared/i18n/zh-CN.json', import.meta.url), 'utf8'));
const zhTwCatalog = JSON.parse(readFileSync(new URL('../../../../shared/i18n/zh-TW.json', import.meta.url), 'utf8'));
const enUsCatalog = JSON.parse(readFileSync(new URL('../../../../shared/i18n/en-US.json', import.meta.url), 'utf8'));
const jaJpCatalog = JSON.parse(readFileSync(new URL('../../../../shared/i18n/ja-JP.json', import.meta.url), 'utf8'));
const deDeCatalog = JSON.parse(readFileSync(new URL('../../../../shared/i18n/de-DE.json', import.meta.url), 'utf8'));
const ruRuCatalog = JSON.parse(readFileSync(new URL('../../../../shared/i18n/ru-RU.json', import.meta.url), 'utf8'));

const zhCnTranslate = (key: string) => zhCnCatalog[key] || key;

describe('aiSlashCommands', () => {

  it('supports filtering builtin tool catalog diagnostics by keyword and command prefix', () => {
    expect(filterAISlashCommands('工具目录', zhCnTranslate).map((command) => command.cmd)).toContain('/tools');
    expect(filterAISlashCommands('参数提示', zhCnTranslate).map((command) => command.cmd)).toContain('/tools');
    expect(filterAISlashCommands('/too').map((command) => command.cmd)).toContain('/tools');
  });

  it('supports filtering context budget diagnostics by keyword and command prefix', () => {
    expect(filterAISlashCommands('上下文', zhCnTranslate).map((command) => command.cmd)).toContain('/budget');
    expect(filterAISlashCommands('变慢', zhCnTranslate).map((command) => command.cmd)).toContain('/budget');
    expect(filterAISlashCommands('/bud').map((command) => command.cmd)).toContain('/budget');
  });

  it('supports filtering code hotspot diagnostics by keyword and command prefix', () => {
    expect(filterAISlashCommands('大文件', zhCnTranslate).map((command) => command.cmd)).toContain('/hotspots');
    expect(filterAISlashCommands('拆分', zhCnTranslate).map((command) => command.cmd)).toContain('/hotspots');
    expect(filterAISlashCommands('/hot').map((command) => command.cmd)).toContain('/hotspots');
  });

  it('supports filtering shortcut diagnostics by chinese keyword and command prefix', () => {
    expect(filterAISlashCommands('快捷键', zhCnTranslate).map((command) => command.cmd)).toContain('/shortcuts');
    expect(filterAISlashCommands('/sho').map((command) => command.cmd)).toContain('/shortcuts');
  });

  it('supports filtering connection-failure diagnostics by chinese keyword and command prefix', () => {
    expect(filterAISlashCommands('连接失败', zhCnTranslate).map((command) => command.cmd)).toContain('/connfail');
    expect(filterAISlashCommands('/conn').map((command) => command.cmd)).toContain('/connfail');
  });

  it('supports filtering app-log diagnostics by chinese keyword and command prefix', () => {
    expect(filterAISlashCommands('日志', zhCnTranslate).map((command) => command.cmd)).toContain('/applog');
    expect(filterAISlashCommands('/app').map((command) => command.cmd)).toContain('/applog');
  });

  it('supports filtering ai-render diagnostics by chinese keyword and command prefix', () => {
    expect(filterAISlashCommands('气泡空白', zhCnTranslate).map((command) => command.cmd)).toContain('/airender');
    expect(filterAISlashCommands('/air').map((command) => command.cmd)).toContain('/airender');
  });

  it('supports filtering sql editor transaction diagnostics by keyword and command prefix', () => {
    expect(filterAISlashCommands('自动提交', zhCnTranslate).map((command) => command.cmd)).toContain('/tx');
    expect(filterAISlashCommands('未提交', zhCnTranslate).map((command) => command.cmd)).toContain('/tx');
    expect(filterAISlashCommands('/tx').map((command) => command.cmd)).toContain('/tx');
  });

  it('supports filtering mcp tool schema diagnostics by keyword and command prefix', () => {
    expect(filterAISlashCommands('arguments').map((command) => command.cmd)).toContain('/mcptool');
    expect(filterAISlashCommands('MCP工具参数', zhCnTranslate).map((command) => command.cmd)).toContain('/mcptool');
    expect(filterAISlashCommands('/mcpt').map((command) => command.cmd)).toContain('/mcptool');
  });

  it('supports filtering mcp runtime failure diagnostics by keyword and command prefix', () => {
    expect(filterAISlashCommands('运行期失败', zhCnTranslate).map((command) => command.cmd)).toContain('/mcpfail');
    expect(filterAISlashCommands('工具发现0个', zhCnTranslate).map((command) => command.cmd)).toContain('/mcpfail');
    expect(filterAISlashCommands('stdio').map((command) => command.cmd)).toContain('/mcpfail');
    expect(filterAISlashCommands('/mcpf').map((command) => command.cmd)).toContain('/mcpfail');
  });

  it('routes OpenCode questions to the MCP setup command in every catalog', () => {
    const command = filterAISlashCommands('opencode').find((item) => item.cmd === '/mcp');
    expect(command?.prompt).toContain('OpenCode');

    const catalogs = [zhCnCatalog, zhTwCatalog, enUsCatalog, jaJpCatalog, deDeCatalog, ruRuCatalog];
    const namedKeys = [
      'ai_chat.input.slash.mcp.prompt',
      'ai_chat.inspection.setup.next_action.connect_external_client',
      'ai_chat.inspection.setup.warning.external_client_not_connected',
      'ai_chat.inspection.tool_info.inspect_mcp_setup.detail',
      'ai_chat.system.inspection_guidance.inspect_mcp_setup',
      'ai_settings.mcp_server.remote_quick_start.guide.boundary.local_stdio',
    ];
    for (const catalog of catalogs) {
      expect(String(catalog['ai_chat.input.slash.mcp.keywords']).toLowerCase()).toContain('opencode');
      for (const key of namedKeys) {
        expect(catalog[key]).toContain('OpenCode');
      }
    }
  });

  it('supports filtering mcp draft validation diagnostics by keyword and command prefix', () => {
    expect(filterAISlashCommands('MCP草稿', zhCnTranslate).map((command) => command.cmd)).toContain('/mcpdraft');
    expect(filterAISlashCommands('启动命令', zhCnTranslate).map((command) => command.cmd)).toContain('/mcpdraft');
    expect(filterAISlashCommands('/mcpd').map((command) => command.cmd)).toContain('/mcpdraft');
  });

  it('keeps featured commands available for empty-state quick picks', () => {
    const featured = getFeaturedAISlashCommands().map((command) => command.cmd);

    expect(featured).toContain('/sql');
    expect(featured).toContain('/health');
    expect(featured).toContain('/mcp');
    expect(featured).toContain('/mcpadd');
    expect(featured).toContain('/connfail');
    expect(featured).toContain('/tx');
    expect(featured).not.toContain('/tools');
    expect(featured).not.toContain('/budget');
    expect(featured).not.toContain('/mcpfail');
    expect(featured).not.toContain('/shortcuts');
  });
});
