// Sidebar.locate-toolbar.test.tsx 拆分前的共享测试辅助函数；只由测试文件导入。
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect } from 'vitest';
import Sidebar from './Sidebar';
import { SUPPORTED_LANGUAGES, getCurrentLanguage } from '../i18n';
import { I18nProvider } from '../i18n/provider';

export const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const readCssRuleBlock = (css: string, selector: string) => {
  const match = css.match(new RegExp(`${escapeRegExp(selector)}\\s*\\{(?<body>[^}]*)\\}`, 's'));
  expect(match, `Missing CSS rule for ${selector}`).not.toBeNull();
  return match?.groups?.body ?? '';
};

export type SidebarTestLanguage = (typeof SUPPORTED_LANGUAGES)[number];

export const renderSidebarMarkup = (
  props: React.ComponentProps<typeof Sidebar> = {},
  language: SidebarTestLanguage = getCurrentLanguage(),
) => renderToStaticMarkup(
  <I18nProvider
    preference={language}
    systemLanguages={[language]}
    onPreferenceChange={() => undefined}
  >
    <Sidebar {...props} />
  </I18nProvider>,
);
