// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest';

import { GONAVI_MONACO_LANGUAGE_LOADERS } from './monacoLanguageLoaders';

/**
 * Monaco 只在真实浏览器环境里跑得起来，jsdom 缺少数个浏览器 API，
 * 这里按需补齐最小桩，只为让分词器可被加载与验证。
 */
const installBrowserStubs = () => {
  const scope = globalThis as any;
  scope.CSS = scope.CSS || {};
  if (typeof scope.CSS.escape !== 'function') scope.CSS.escape = (value: string) => value;
  if (typeof scope.postMessage !== 'function') scope.postMessage = () => undefined;
  if (typeof scope.matchMedia !== 'function') {
    scope.matchMedia = () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
    });
  }
  if (typeof scope.requestAnimationFrame !== 'function') {
    scope.requestAnimationFrame = (callback: any) => Number(setTimeout(() => callback(Date.now()), 0));
  }
  if (typeof scope.cancelAnimationFrame !== 'function') scope.cancelAnimationFrame = (id: number) => clearTimeout(id);
  if (typeof scope.ResizeObserver !== 'function') {
    scope.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  }
  const doc = document as any;
  if (typeof doc.queryCommandSupported !== 'function') doc.queryCommandSupported = () => false;
  if (typeof doc.queryCommandEnabled !== 'function') doc.queryCommandEnabled = () => false;
  if (typeof doc.execCommand !== 'function') doc.execCommand = () => false;
};

/** colorize 输出里不同 mtk 颜色类别的数量，1 表示整段单色（等价于无高亮）。 */
const distinctColorClasses = (html: string): number => new Set(html.match(/mtk\d+/g) || []).size;

const loadAppLanguages = async () => {
  const monaco = await import('monaco-editor/esm/vs/editor/editor.api.js');
  await import('monaco-editor/esm/vs/editor/editor.all.js');
  await Promise.all(GONAVI_MONACO_LANGUAGE_LOADERS.map((load) => load()));
  return monaco;
};

// 这些语言 id 由界面按 Nacos 配置 type 请求（见 NacosViewer.resolveEditorLanguage）。
const REQUESTED_LANGUAGE_IDS = ['sql', 'mysql', 'redis', 'json', 'yaml', 'xml', 'ini'];

// 分词器纯本地，无需 worker 即可验证着色效果；样例取自真实配置形态。
const CONFIG_SAMPLES_WITHOUT_WORKER: Array<[languageId: string, sample: string, minColors: number]> = [
  ['yaml', 'server:\n  port: 8080\n  enabled: true\n# note\n', 3],
  ['yaml', 'spring:\n  datasource:\n    url: jdbc:mysql://db:3306/app\n', 2],
  ['ini', 'spring.datasource.username=root\nspring.datasource.driver=com.mysql.jdbc.Driver\n', 2],
  ['xml', '<?xml version="1.0"?>\n<root id="1">text</root>\n', 2],
];

describe('MonacoEditor Nacos 配置语法高亮', () => {
  beforeAll(installBrowserStubs);

  it('注册界面会请求的全部语言 id，Nacos 配置正文按 type 取得高亮', async () => {
    const monaco = await loadAppLanguages();

    const registered = monaco.languages.getLanguages().map((language) => language.id);
    expect(registered).toEqual(expect.arrayContaining(REQUESTED_LANGUAGE_IDS));
  }, 60000);

  it('yaml/xml/properties 分词器生效，配置正文不再单色显示', async () => {
    const monaco = await loadAppLanguages();
    const { TokenizationRegistry } = await import('monaco-editor/esm/vs/editor/common/languages.js');

    const observed: string[] = [];
    for (const [languageId, sample, minColors] of CONFIG_SAMPLES_WITHOUT_WORKER) {
      await TokenizationRegistry.getOrCreate(languageId);
      const html = await monaco.editor.colorize(sample, languageId, {});
      const colors = distinctColorClasses(html);
      observed.push(`${languageId}=${colors}`);
      expect(colors, `${languageId} 应被分词着色，实际输出: ${html}`).toBeGreaterThanOrEqual(minColors);
    }
    expect(observed).toHaveLength(CONFIG_SAMPLES_WITHOUT_WORKER.length);
  }, 60000);

  it('未提供分词器的纯文本仍为单色，确认上面的断言确实取决于分词器', async () => {
    const monaco = await loadAppLanguages();

    const html = await monaco.editor.colorize('server:\n  port: 8080\n', 'plaintext', {});
    expect(distinctColorClasses(html)).toBe(1);
  }, 60000);
});
