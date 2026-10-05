import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 大样式表已拆为 @import 索引 + 分片，源码断言需要读取展开后的完整样式文本。
const CSS_IMPORT_LINE = /^@import\s+['"]([^'"]+)['"];[ \t]*\r?\n?/gm;

export const readCssWithImports = (file: string | URL): string => {
  const filePath = typeof file === 'string' ? file : fileURLToPath(file);
  // 统一为 LF：Windows CRLF 检出与 CI 的 LF 检出读出相同文本，多行选择器断言不受行尾影响。
  const css = readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');
  return css.replace(CSS_IMPORT_LINE, (_line: string, importPath: string) => (
    readCssWithImports(path.resolve(path.dirname(filePath), importPath))
  ));
};
