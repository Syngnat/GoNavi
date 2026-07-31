import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getCurrentLanguage, setCurrentLanguage } from '../i18n';
import JVMResourceBrowser from './JVMResourceBrowser';

vi.mock('@monaco-editor/react', () => ({
  default: ({ language, value }: { language?: string; value?: string }) => (
    <div data-monaco-editor-mock="true" data-language={language}>
      {value}
    </div>
  ),
}));

vi.mock('../store', () => ({
  useStore: (selector: (state: any) => any) => selector({
    connections: [
      {
        id: 'conn-jvm-1',
        name: 'localhost',
        config: {
          host: 'localhost',
          jvm: {
            preferredMode: 'jmx',
            readOnly: true,
          },
        },
      },
      {
        id: 'conn-jvm-2',
        name: 'writable-jvm',
        config: {
          host: 'localhost',
          jvm: {
            preferredMode: 'jmx',
            readOnly: false,
          },
        },
      },
    ],
    addTab: vi.fn(),
    aiPanelVisible: false,
    setAIPanelVisible: vi.fn(),
  }),
}));

vi.mock('./jvm/JVMModeBadge', () => ({
  default: ({ mode }: { mode: string }) => <span>{mode}</span>,
}));

vi.mock('./jvm/JVMChangePreviewModal', () => ({
  default: () => null,
}));

describe('JVMResourceBrowser layout', () => {
  let previousLanguage: ReturnType<typeof getCurrentLanguage>;

  beforeEach(() => {
    previousLanguage = getCurrentLanguage();
    setCurrentLanguage('zh-CN');
  });

  afterEach(() => {
    setCurrentLanguage(previousLanguage);
  });

  it('renders a dedicated vertical scroll shell for tall snapshot content', () => {
    const markup = renderToStaticMarkup(
      <JVMResourceBrowser
        tab={{
          id: 'tab-jvm-resource-1',
          type: 'jvm-resource',
          title: '[localhost] JVM 资源',
          connectionId: 'conn-jvm-1',
          providerMode: 'jmx',
          resourcePath: 'jmx:/mbean/com.alibaba.druid:type=DruidDriver',
          resourceKind: 'mbean',
        } as any}
      />,
    );

    expect(markup).toContain('data-jvm-resource-browser-scroll-shell="true"');
    expect(markup).toContain('data-jvm-workspace-shell="true"');
    expect(markup).toContain('data-jvm-workspace-hero="true"');
    expect(markup).toContain('data-jvm-resource-workbench="true"');
    expect(markup).toContain('height:100%');
    expect(markup).toContain('overflow-y:auto');
    expect(markup).toContain('grid-template-columns:minmax(0, 1fr) minmax(360px, 440px)');
  });

  it('shows the draft action field with a Chinese label', () => {
    const markup = renderToStaticMarkup(
      <JVMResourceBrowser
        tab={{
          id: 'tab-jvm-resource-2',
          type: 'jvm-resource',
          title: '[localhost] JVM 资源',
          connectionId: 'conn-jvm-2',
          providerMode: 'jmx',
          resourcePath: 'jmx:/mbean/com.alibaba.druid:type=DruidDriver',
          resourceKind: 'mbean',
        } as any}
      />,
    );

    expect(markup).toContain('动作');
    expect(markup).not.toContain('>Action<');
  });

  it('hides the change draft form entirely for read-only JVM connections', () => {
    const markup = renderToStaticMarkup(
      <JVMResourceBrowser
        tab={{
          id: 'tab-jvm-resource-3',
          type: 'jvm-resource',
          title: '[localhost] JVM 资源',
          connectionId: 'conn-jvm-1',
          providerMode: 'jmx',
          resourcePath: 'jmx:/mbean/com.alibaba.druid:type=DruidDriver',
          resourceKind: 'mbean',
        } as any}
      />,
    );

    expect(markup).not.toContain('变更草稿');
    expect(markup).not.toContain('预览变更');
    expect(markup).not.toContain('Payload(JSON)');
  });
});
