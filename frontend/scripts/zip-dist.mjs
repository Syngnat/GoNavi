// 将 frontend/dist 打包成 frontend/dist.zip 供 assets_prod.go 嵌入:
// 主程序启动时把 zip 挂成只读 fs.FS 交给 Wails assetserver,前端资源以
// deflate 压缩形态驻留二进制,避免未压缩 dist 直接撑大安装包/绿色版体积。
//
// 用法: node scripts/zip-dist.mjs [--stub]
//   --stub 生成仅含占位 index.html 的最小 zip(用于再生成 tools/stub-dist.zip)
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const frontendDir = dirname(scriptDir);
const distDir = join(frontendDir, 'dist');
const outPath = join(frontendDir, 'dist.zip');

const STUB_INDEX_HTML = '<!doctype html><title>GoNavi</title>\n';

if (process.argv.includes('--stub')) {
  const stub = zipSync({
    'index.html': [new TextEncoder().encode(STUB_INDEX_HTML), { level: 9 }],
  });
  writeFileSync(outPath, stub);
  console.log(`[zip-dist] stub -> ${outPath} (${stub.length} bytes)`);
  process.exit(0);
}

if (!existsSync(join(distDir, 'index.html'))) {
  console.error(`[zip-dist] ${distDir} 缺少 index.html,请先完成 vite build`);
  process.exit(1);
}

const collectFiles = (dir, acc = []) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collectFiles(full, acc);
    else if (entry.isFile()) acc.push(full);
  }
  return acc;
};

const files = collectFiles(distDir);
const data = {};
let rawTotal = 0;
for (const file of files) {
  const bytes = readFileSync(file);
  rawTotal += bytes.length;
  // fs.FS 只认正斜杠路径,统一转换
  const rel = relative(distDir, file).split(sep).join('/');
  data[rel] = [bytes, { level: 9 }];
}

const zipped = zipSync(data);
writeFileSync(outPath, zipped);
const ratio = rawTotal > 0 ? (zipped.length / rawTotal).toFixed(2) : 'n/a';
console.log(
  `[zip-dist] ${files.length} 个文件 -> ${outPath}:`
  + ` ${(rawTotal / 1024 / 1024).toFixed(2)}MB -> ${(zipped.length / 1024 / 1024).toFixed(2)}MB (ratio ${ratio})`,
);
