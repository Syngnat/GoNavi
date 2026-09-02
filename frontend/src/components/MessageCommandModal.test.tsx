import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  dbQuery: vi.fn(),
}));

vi.mock('../../wailsjs/go/app/App', () => ({ DBQuery: mocks.dbQuery }));

vi.mock('../i18n/provider', async () => {
  const catalog = (await import('../../../shared/i18n/zh-CN.json')).default as Record<string, string>;
  const translate = (key: string, params: Record<string, unknown> = {}) => {
    let value = catalog[key] || key;
    Object.entries(params).forEach(([name, replacement]) => {
      value = value.split(`{{${name}}}`).join(String(replacement ?? ''));
    });
    return value;
  };
  return { useI18n: () => ({ t: translate }) };
});

vi.mock('@ant-design/icons', () => ({
  CodeOutlined: () => <i data-icon="code" />,
  PlayCircleOutlined: () => <i data-icon="play" />,
}));

vi.mock('antd', () => {
  const Input = {
    TextArea: (props: any) => <textarea {...props} />,
  };
  const Space = ({ children }: any) => <div>{children}</div>;
  return {
    Alert: ({ description, message, type }: any) => (
      <div data-alert={type}>{message}{description}</div>
    ),
    Button: ({ children, onClick }: any) => <button onClick={onClick}>{children}</button>,
    Input,
    Space,
    Tag: ({ children }: any) => <span>{children}</span>,
    Typography: { Text: ({ children }: any) => <span>{children}</span> },
  };
});

vi.mock('./common/ResizableDraggableModal', () => ({
  default: ({ children, open, onOk, title }: any) => open ? (
    <section data-testid="message-command-modal">
      <h1>{title}</h1>
      {children}
      <button data-testid="execute-message-command" onClick={onOk}>execute</button>
    </section>
  ) : null,
}));

import MessageCommandModal, { buildMessageCommandTemplates } from './MessageCommandModal';

const mqttConnection = {
  id: 'mqtt-1',
  name: 'MQTT 测试',
  config: { type: 'mqtt', host: '127.0.0.1', port: 1883 },
} as any;

const renderModal = (): ReactTestRenderer => {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      <MessageCommandModal
        open
        connection={mqttConnection}
        executionDbName="topics"
        defaultDestination="devices/#"
        defaultCommand={'CONSUME FROM "devices/#" QOS 1 LIMIT 100'}
        onCancel={() => undefined}
      />,
    );
  });
  return renderer;
};

describe('MessageCommandModal', () => {
  beforeEach(() => {
    mocks.dbQuery.mockReset();
  });

  it('runs an MQTT command in its message namespace and renders returned rows', async () => {
    mocks.dbQuery.mockResolvedValue({
      success: true,
      data: [{ topic: 'devices/a', payload: 'hello' }],
    });
    const renderer = renderModal();

    await act(async () => {
      renderer.root.findByProps({ 'data-testid': 'execute-message-command' }).props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.dbQuery).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'mqtt', host: '127.0.0.1', port: 1883 }),
      'topics',
      'CONSUME FROM "devices/#" QOS 1 LIMIT 100',
    );
    const rendered = JSON.stringify(renderer.toJSON());
    expect(rendered).toContain('执行结果');
    expect(rendered).toContain('1 行');
    expect(rendered).toContain('devices/a');
    expect(rendered).toContain('hello');
  });

  it('keeps the command console guidance and controls localized', () => {
    const renderer = renderModal();
    const rendered = JSON.stringify(renderer.toJSON());

    expect(rendered).toContain('MQTT 测试 · 命令控制台');
    expect(rendered).toContain('日常订阅与发送请继续使用工作台表单');
    expect(rendered).toContain('只接受查看和消费命令');
    expect(rendered).toContain('主题列表');
    expect(rendered).toContain('查看主题信息');
    expect(rendered).not.toContain('message_command_modal.');
  });

  it('rejects publish JSON so message sending cannot bypass the guided form', async () => {
    const renderer = renderModal();
    act(() => {
      renderer.root.findByType('textarea').props.onChange({
        target: { value: '{"topic":"devices/a","payload":"bypass"}' },
      });
    });

    await act(async () => {
      renderer.root.findByProps({ 'data-testid': 'execute-message-command' }).props.onClick();
      await Promise.resolve();
    });

    expect(mocks.dbQuery).not.toHaveBeenCalled();
    expect(JSON.stringify(renderer.toJSON())).toContain('只接受查看和消费命令');
  });

  it('uses parser-compatible RabbitMQ templates without trailing semicolons', () => {
    expect(buildMessageCommandTemplates('rabbitmq', 'orders.queue')).toEqual([
      expect.objectContaining({ command: 'SHOW QUEUES LIMIT 100' }),
      expect.objectContaining({ command: 'SHOW EXCHANGES LIMIT 100' }),
      expect.objectContaining({ command: 'DESCRIBE QUEUE "orders.queue"' }),
      expect.objectContaining({ command: 'SELECT * FROM "orders.queue" LIMIT 100' }),
    ]);
  });
});
