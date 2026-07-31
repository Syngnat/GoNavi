import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { AIMCPToolDescriptor } from '../../types';
import { I18nProvider } from '../../i18n/provider';
import { buildOverlayWorkbenchTheme } from '../../utils/overlayWorkbenchTheme';
import AIMCPToolSchemaSummary, { buildMCPToolMinimalArgumentsExample } from './AIMCPToolSchemaSummary';

const buildTool = (inputSchema: AIMCPToolDescriptor['inputSchema']): AIMCPToolDescriptor => ({
  alias: 'execute_sql',
  serverId: 'gonavi',
  serverName: 'GoNavi',
  originalName: 'execute_sql',
  inputSchema,
});

describe('AIMCPToolSchemaSummary', () => {
  it('builds a minimal arguments example from required schema fields', () => {
    const example = buildMCPToolMinimalArgumentsExample(buildTool({
      type: 'object',
      required: ['connectionId', 'sql', 'allowMutating'],
      properties: {
        connectionId: { type: 'string' },
        dbName: { type: 'string' },
        sql: { type: 'string' },
        allowMutating: { type: 'boolean', default: true },
      },
    }));

    expect(example).toBe('{"connectionId":"<connectionId>","sql":"<sql>","allowMutating":true}');
  });

  it('uses enum, array, object, and number placeholders when defaults are absent', () => {
    const example = buildMCPToolMinimalArgumentsExample(buildTool({
      type: 'object',
      required: ['mode', 'limit', 'filters', 'tags'],
      properties: {
        mode: { enum: ['safe', 'force'] },
        limit: { type: 'number' },
        filters: { type: 'object', properties: { status: { type: 'string' } } },
        tags: { type: 'array', items: { type: 'string' } },
      },
    }));

    expect(example).toBe('{"mode":"safe","limit":0,"filters":{},"tags":[]}');
  });

  it('returns an empty object when no required parameters are declared', () => {
    const example = buildMCPToolMinimalArgumentsExample(buildTool({
      type: 'object',
      properties: {
        keyword: { type: 'string' },
      },
    }));

    expect(example).toBe('{}');
  });

  it('renders tool schema chrome through the English fallback catalog', () => {
    const markup = renderToStaticMarkup(
      <AIMCPToolSchemaSummary
        tools={[
          buildTool({
            type: 'object',
            required: ['connectionId', 'sql'],
            properties: {
              connectionId: { type: 'string', description: 'connection id' },
              sql: { type: 'string', description: 'SQL text' },
              dbName: { type: 'string', description: 'database name' },
            },
          }),
          buildTool(undefined),
        ]}
        cardBorder="rgba(0,0,0,0.08)"
        darkMode={false}
        overlayTheme={buildOverlayWorkbenchTheme(false)}
      />,
    );

    expect(markup).toContain('Discovered tools and parameter hints');
    expect(markup).toContain('3 parameters, 2 required; an asterisk marks required fields.');
    expect(markup).toContain('Minimum arguments example:');
    expect(markup).toContain('No inputSchema declared; check the service docs or use /mcptool before calling.');
    expect(markup).not.toContain('已发现工具和参数提示');
    expect(markup).not.toContain('未声明 inputSchema');
    expect(markup).toContain('class="gonavi-ai-mcp-tool-schema"');
    expect(markup).toContain('class="gonavi-ai-mcp-tool-schema-row"');
    expect(markup).toContain('border-top:1px solid rgba(0,0,0,0.08)');
    expect(markup).toContain('border-bottom:1px solid rgba(0,0,0,0.08)');
    expect(markup).toContain('background:transparent');
  });

  it('renders tool schema chrome in Chinese when an i18n provider is available', () => {
    const markup = renderToStaticMarkup(
      <I18nProvider preference="zh-CN" systemLanguages={['zh-CN']} onPreferenceChange={() => {}}>
        <AIMCPToolSchemaSummary
          tools={[
            buildTool({
              type: 'object',
              required: ['connectionId'],
              properties: {
                connectionId: { type: 'string' },
              },
            }),
          ]}
          cardBorder="rgba(0,0,0,0.08)"
          darkMode={false}
          overlayTheme={buildOverlayWorkbenchTheme(false)}
        />
      </I18nProvider>,
    );

    expect(markup).toContain('已发现工具和参数提示');
    expect(markup).toContain('1 个参数，必填 1 个；星号表示必填。');
    expect(markup).toContain('最小 arguments 示例：');
  });
});
