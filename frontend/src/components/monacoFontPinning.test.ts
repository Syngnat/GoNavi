import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const target = path.join(dir, name);
    if (statSync(target).isDirectory()) return walk(target);
    return /\.tsx?$/.test(name) && !name.includes('.test.') ? [target] : [];
  });

// 同一个对象在查看与编辑下必须是同一套排版与分词器：Monaco 调用点一旦写死字号、字体族或 sql 分词器，
// 查看器就会和编辑器不一致，所以把「不允许写死」钉成仓库级约束。
const inspectMonacoBlocks = (source: string, onBlock: (block: string[], start: number) => void) => {
  const lines = source.split(/\r?\n/);
  let start = -1;
  lines.forEach((line, index) => {
    if (/<Editor\b|<MonacoEditor\b/.test(line)) start = index;
    if (start >= 0 && /\/>\s*$/.test(line)) {
      onBlock(lines.slice(start, index + 1), start);
      start = -1;
    }
  });
};

// 仍缺连接/方言信息的展示面（接线后逐个删除）；LivePreviewEditor 是设置页字体预览，与方言无关。
const PENDING_LANGUAGE_WIRING = new Set([
  'components/DataGridModals.tsx',
  'components/DataGridV2DdlWorkspace.tsx',
  'components/TableDesignerSqlPreview.tsx',
  'components/databaseJobs/JobManagementPanel.tsx',
  'components/settings/preferences/livePreview/LivePreviewEditor.tsx',
]);

describe('Monaco typography and tokenizer uniformity', () => {
  it('keeps every Monaco surface on the shared typography settings', () => {
    const offenders: string[] = [];
    for (const file of walk(sourceRoot)) {
      inspectMonacoBlocks(readFileSync(file, 'utf8'), (block, start) => {
        block.forEach((line, offset) => {
          if (/^\s*(fontSize|lineHeight|fontFamily)\s*:/.test(line)) {
            offenders.push(`${path.relative(sourceRoot, file).replace(/\\/g, '/')} ${start + offset + 1}: ${line.trim()}`);
          }
        });
      });
    }
    expect(offenders).toEqual([]);
  });

  it('keeps every wired SQL surface on the connection tokenizer', () => {
    const offenders: string[] = [];
    for (const file of walk(sourceRoot)) {
      const relative = path.relative(sourceRoot, file).replace(/\\/g, '/');
      if (PENDING_LANGUAGE_WIRING.has(relative)) continue;
      inspectMonacoBlocks(readFileSync(file, 'utf8'), (block, start) => {
        block.forEach((line, offset) => {
          if (/language="sql"/.test(line)) {
            offenders.push(`${relative} ${start + offset + 1}: ${line.trim()}`);
          }
        });
      });
    }
    expect(offenders).toEqual([]);
  });
});
