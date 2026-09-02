import { describe, expect, it } from 'vitest';

import {
  buildAIChatInlineHistorySessions,
  buildAIChatInsights,
  calculateAIContextUsageChars,
  collectAIChatContextTableNames,
  inferAIChatConnectionContext,
  resolveAIChatPanelMode,
} from './aiChatPanelDerivedState';
import { t as translateCatalog } from '../../i18n';

describe('aiChatPanelDerivedState', () => {
  it('uses only the active workspace context', () => {
    const result = inferAIChatConnectionContext({
      activeConnectionId: 'conn-orders',
      activeDbName: 'sales',
    });

    expect(result).toEqual({
      inferredConnectionId: 'conn-orders',
      inferredDbName: 'sales',
    });
  });

  it('builds insight cards from recent sql logs and linked table contexts', () => {
    const insights = buildAIChatInsights({
      translate: (key, params) => translateCatalog(key, params, 'zh-CN'),
      contextTableNames: ['sales.orders', 'sales.order_items', 'sales.customers', 'sales.payments'],
      sqlLogs: [
        {
          id: 'log-1',
          timestamp: 1,
          sql: 'SELECT * FROM orders',
          status: 'success',
          duration: 1520,
        },
        {
          id: 'log-2',
          timestamp: 2,
          sql: 'UPDATE orders SET status = 1',
          status: 'error',
          duration: 120,
          message: 'Deadlock found',
        },
      ],
    });

    expect(insights[0]).toMatchObject({
      tone: 'info',
      title: '已关联 4 张表',
    });
    expect(insights[0].body).toContain('sales.orders、sales.order_items、sales.customers');
    expect(insights[1]).toMatchObject({
      tone: 'warn',
      title: '最近最慢查询 1,520ms',
    });
    expect(insights[2]).toMatchObject({
      tone: 'warn',
      title: '1 条最近查询失败',
      body: 'Deadlock found',
    });
    expect(insights[3]).toMatchObject({
      tone: 'warn',
      title: '检测到 1 条写操作',
    });
  });

  it('localizes insight cards while preserving raw sql and database errors', () => {
    const insights = buildAIChatInsights({
      translate: (key, params) => translateCatalog(key, params, 'en-US'),
      contextTableNames: ['sales.orders', 'sales.order_items', 'sales.customers', 'sales.payments'],
      sqlLogs: [
        {
          id: 'log-1',
          timestamp: 1,
          sql: 'SELECT * FROM orders',
          status: 'success',
          duration: 1520,
        },
        {
          id: 'log-2',
          timestamp: 2,
          sql: 'UPDATE orders SET status = 1',
          status: 'error',
          duration: 120,
          message: 'Deadlock found',
        },
      ],
    });

    expect(insights[0]).toMatchObject({
      tone: 'info',
      title: '4 linked tables',
      body: 'This conversation includes structure context for sales.orders, sales.order_items, sales.customers and more tables.',
    });
    expect(insights[1]).toMatchObject({
      tone: 'warn',
      title: 'Slowest recent query 1,520ms',
      body: 'SELECT * FROM orders',
    });
    expect(insights[2]).toMatchObject({
      tone: 'warn',
      title: '1 recent query failures',
      body: 'Deadlock found',
    });
    expect(insights[3]).toMatchObject({
      tone: 'warn',
      title: 'Detected 1 write operations',
    });
  });

  it('collects context table names, usage chars, panel mode, and inline history sessions', () => {
    expect(collectAIChatContextTableNames({
      aiContexts: {
        'conn-1:analytics': [
          { dbName: 'analytics', tableName: 'orders', ddl: 'create table orders (...)' },
          { dbName: 'analytics', tableName: 'events', ddl: 'create table events (...)' },
        ],
      },
      activeConnectionId: 'conn-1',
      activeDbName: 'analytics',
    })).toEqual(['analytics.orders', 'analytics.events']);

    expect(calculateAIContextUsageChars([
      {
        id: 'msg-1',
        role: 'assistant',
        content: 'abc',
        reasoning_content: 'xy',
        tool_calls: [{ id: 'tool-1', type: 'function', function: { name: 'inspect', arguments: '{}' } }],
        timestamp: 1,
      },
    ])).toBeGreaterThan(5);

    expect(buildAIChatInlineHistorySessions([
      { id: '1', title: 'one', updatedAt: 1 },
      { id: '2', title: 'two', updatedAt: 2 },
      { id: '3', title: 'three', updatedAt: 3 },
    ], 2)).toEqual([
      { id: '1', title: 'one', updatedAt: 1 },
      { id: '2', title: 'two', updatedAt: 2 },
    ]);

    expect(resolveAIChatPanelMode(true, 'history')).toBe('history');
    expect(resolveAIChatPanelMode(false, 'history')).toBe('chat');
  });
});
