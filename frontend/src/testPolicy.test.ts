import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * 测试策略守卫：禁止新增「读取源码文件并断言其文本」型测试。
 *
 * 背景：这类测试把源码当字符串读进来，断言它包含某段代码片段（甚至断言片段的字符下标顺序）。
 * 它们不执行被测代码，因此无法发现任何行为缺陷——实测把 isCloseShortcutInteractionBlocked
 * 改为恒返回 false（守卫彻底失效）后，对应的守卫测试仍 9/9 通过；同时它们会因换行符、
 * 格式化、等价重构而误报，并使每次源码改动都被迫连带改测试。
 *
 * 正确做法：
 * - 验证行为   → 渲染组件或调用函数后断言其输出
 * - 验证全局不变式（如「所有 t() 引用的 key 都能解析」）→ 写成覆盖全仓库的扫描型用例，
 *   见 src/i18n/keyResolution.test.ts、src/i18n/catalogIntegrity.test.ts
 * - 验证架构约束（如「所有 Modal 必须走公共包装」）→ 同上，写成一条全局用例而非逐组件复制
 *
 * 本守卫以基线名单记录存量债务：名单内的文件允许暂时保留，但**只能减少不能增加**。
 * 清理某个文件后请从 testPolicy-sourceReadingBaseline.json 中删除对应条目。
 */

// Windows 下 fileURLToPath 返回反斜杠路径，统一归一化为正斜杠以便与拼接结果比较
const srcRoot = `${fileURLToPath(new URL('.', import.meta.url)).replace(/[\\/]+$/, '').split('\\').join('/')}/`;

const baseline = new Set(
  JSON.parse(readFileSync(`${srcRoot}testPolicy-sourceReadingBaseline.json`, 'utf8')) as string[],
);

/** 经评审认可的全局不变式扫描用例：读源码是为了覆盖全仓库，而非锁定某个文件的实现文本 */
const SANCTIONED_GLOBAL_SCANNERS = new Set([
  'i18n/keyResolution.test.ts',
  'testPolicy.test.ts',
]);

const collectTestFiles = (directory: string): string[] => readdirSync(directory)
  .flatMap((entry) => {
    const absolutePath = `${directory}/${entry}`;
    if (statSync(absolutePath).isDirectory()) {
      return /^(?:node_modules|dist)$/.test(entry) ? [] : collectTestFiles(absolutePath);
    }
    return /\.(?:test|spec)\.(?:ts|tsx)$/.test(entry) ? [absolutePath] : [];
  });

/**
 * 判定「从磁盘读取 .ts/.tsx 源码」。读 JSON 等数据文件不在禁止之列——
 * 被禁止的是把源码当字符串断言，而非读取测试夹具。
 */
const readsSourceFromDisk = (source: string): boolean => (
  /\breaddirSync\b|\breadFileSync\b/.test(source) && /\.tsx?['"`]/.test(source)
);

describe('test policy: no new source-text assertions', () => {
  const testFiles = collectTestFiles(srcRoot.slice(0, -1))
    .map((file) => file.slice(srcRoot.length));

  it('scans a plausible number of test files', () => {
    expect(testFiles.length).toBeGreaterThan(300);
  });

  it('adds no new test that reads source files from disk', () => {
    const offenders = testFiles.filter((file) => {
      if (baseline.has(file) || SANCTIONED_GLOBAL_SCANNERS.has(file)) return false;
      return readsSourceFromDisk(readFileSync(`${srcRoot}${file}`, 'utf8'));
    });

    expect(offenders).toEqual([]);
  });

  it('keeps the debt baseline free of stale entries', () => {
    const present = new Set(testFiles);
    const stale = [...baseline].filter((file) => {
      if (!present.has(file)) return true;
      return !readsSourceFromDisk(readFileSync(`${srcRoot}${file}`, 'utf8'));
    });

    expect(stale).toEqual([]);
  });
});
