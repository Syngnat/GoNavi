import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// 全局 CSS 语法守卫：每个 .css 文件的花括号与圆括号都必须配对。
//
// 为什么需要它：CSS 里少一个右括号不会让构建失败，但会让解析器把后面的内容
// 当成未闭合函数（例如 var(...)）的值一直吞到文件末尾。Vite 会把多个源 CSS
// 合并进同一个 chunk，于是同一 chunk 中排在这条规则之后的样式全部静默失效：
// 页面塌成无样式的裸布局，而构建成功、单元测试全绿，肉眼很难立刻定位到根因。
//
// 本用例覆盖全仓库 CSS（与 i18n/keyResolution.test.ts 同属全局不变式扫描），
// 任何文件括号不配对即失败，从源头堵住这类"样式整片消失"的回归。

// 统一成以 / 结尾的根路径，拼接子路径时不会再漏掉分隔符。
const srcRoot = `${fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]+$/, '').split('\\').join('/')}/`;

const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    // 悬空符号链接等 stat 失败的情况：不是目录，按文件处理。
    return false;
  }
};

const collectCssFiles = (directory: string): string[] =>
  readdirSync(directory).flatMap((entry) => {
    const absolutePath = `${directory}${entry}`;
    if (isDirectory(absolutePath)) {
      return entry === 'node_modules' ? [] : collectCssFiles(`${absolutePath}/`);
    }
    return entry.endsWith('.css') ? [absolutePath] : [];
  });

// 去掉注释与字符串后再数括号：注释和字面量里的括号不参与语法配平。
const stripCommentsAndStrings = (css: string): string => css
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/"(?:[^"\\]|\\.)*"/g, '""')
  .replace(/'(?:[^'\\]|\\.)*'/g, "''");

const countChar = (text: string, character: string): number =>
  text.split(character).length - 1;

describe('css syntax: brackets are balanced', () => {
  const files = collectCssFiles(srcRoot);

  it('scans a plausible number of css files', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('has balanced braces and parentheses in every css file', () => {
    const offenders = files
      .map((file) => {
        const stripped = stripCommentsAndStrings(readFileSync(file, 'utf8'));
        return {
          file: file.slice(srcRoot.length),
          braces: countChar(stripped, '{') - countChar(stripped, '}'),
          parens: countChar(stripped, '(') - countChar(stripped, ')'),
        };
      })
      .filter((entry) => entry.braces !== 0 || entry.parens !== 0);

    expect(offenders).toEqual([]);
  });
});
