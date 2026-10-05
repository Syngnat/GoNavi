// 将 frontend/dist 打包成 frontend/dist.tar.br 供 assets_prod.go 嵌入:
// 整个 dist 先打成 tar 再整体 brotli 压缩(固实)。各 JS chunk 之间大量重复的
// 代码在固实压缩下能互相引用,比逐文件 deflate 的 zip 小约 2.2 MB;安装包的 LZMA
// 对已压缩数据无能为力,这部分节省会原样体现在安装包与安装后体积上。
// tar 条目按路径排序、mtime 归零,同一份 dist 每次产出的字节完全一致。
//
// 用法: node scripts/pack-dist.mjs [--stub]
//   --stub 生成仅含占位 index.html 的最小包(用于再生成 tools/stub-dist.tar.br)
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, constants as zlibConstants } from 'node:zlib';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const frontendDir = dirname(scriptDir);
const distDir = join(frontendDir, 'dist');
const outPath = join(frontendDir, 'dist.tar.br');

const STUB_INDEX_HTML = '<!doctype html><title>GoNavi</title>\n';
const TAR_BLOCK = 512;

// 写入 ustar 头里的定长字段;数字字段为八进制并以 NUL 结尾。
const writeField = (header, offset, length, value) => {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length > length) {
    throw new Error(`tar 字段超长: ${value}`);
  }
  bytes.copy(header, offset);
};
const octal = (value, length) => `${value.toString(8).padStart(length - 1, '0')}\0`;

// 路径超过 100 字节时按 ustar 规则拆到 prefix(最多 155 字节)。
const splitTarName = (name) => {
  if (Buffer.byteLength(name) <= 100) return ['', name];
  const slash = name.lastIndexOf('/', name.length - 1);
  for (let index = slash; index > 0; index = name.lastIndexOf('/', index - 1)) {
    const prefix = name.slice(0, index);
    const rest = name.slice(index + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(rest) <= 100) return [prefix, rest];
  }
  throw new Error(`tar 路径过长: ${name}`);
};

const tarHeader = (name, size) => {
  const header = Buffer.alloc(TAR_BLOCK);
  const [prefix, shortName] = splitTarName(name);
  writeField(header, 0, 100, shortName);
  writeField(header, 100, 8, '0000644\0');
  writeField(header, 108, 8, '0000000\0');
  writeField(header, 116, 8, '0000000\0');
  writeField(header, 124, 12, octal(size, 12));
  writeField(header, 136, 12, octal(0, 12));
  header.fill(0x20, 148, 156); // 计算校验和时校验和字段按空格计
  writeField(header, 156, 1, '0');
  writeField(header, 257, 6, 'ustar\0');
  writeField(header, 263, 2, '00');
  writeField(header, 345, 155, prefix);
  let checksum = 0;
  for (const byte of header) checksum += byte;
  writeField(header, 148, 8, `${checksum.toString(8).padStart(6, '0')}\0 `);
  return header;
};

const buildTar = (entries) => {
  const chunks = [];
  for (const [name, bytes] of entries) {
    chunks.push(tarHeader(name, bytes.length), bytes);
    const padding = (TAR_BLOCK - (bytes.length % TAR_BLOCK)) % TAR_BLOCK;
    if (padding) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(TAR_BLOCK * 2));
  return Buffer.concat(chunks);
};

const compress = (tar) => brotliCompressSync(tar, {
  params: {
    [zlibConstants.BROTLI_PARAM_QUALITY]: zlibConstants.BROTLI_MAX_QUALITY,
    [zlibConstants.BROTLI_PARAM_LGWIN]: zlibConstants.BROTLI_MAX_WINDOW_BITS,
    [zlibConstants.BROTLI_PARAM_SIZE_HINT]: tar.length,
  },
});

if (process.argv.includes('--stub')) {
  const stub = compress(buildTar([['index.html', Buffer.from(STUB_INDEX_HTML, 'utf8')]]));
  writeFileSync(outPath, stub);
  console.log(`[pack-dist] stub -> ${outPath} (${stub.length} bytes)`);
  process.exit(0);
}

if (!existsSync(join(distDir, 'index.html'))) {
  console.error(`[pack-dist] ${distDir} 缺少 index.html,请先完成 vite build`);
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

// fs.FS 只认正斜杠路径,统一转换;按路径排序保证产物可复现。
const entries = collectFiles(distDir)
  .map((file) => [relative(distDir, file).split(sep).join('/'), readFileSync(file)])
  .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
const rawTotal = entries.reduce((total, [, bytes]) => total + bytes.length, 0);

const startedAt = Date.now();
const packed = compress(buildTar(entries));
writeFileSync(outPath, packed);
const ratio = rawTotal > 0 ? (packed.length / rawTotal).toFixed(2) : 'n/a';
console.log(
  `[pack-dist] ${entries.length} 个文件 -> ${outPath}:`
  + ` ${(rawTotal / 1024 / 1024).toFixed(2)}MB -> ${(packed.length / 1024 / 1024).toFixed(2)}MB`
  + ` (ratio ${ratio}, ${((Date.now() - startedAt) / 1000).toFixed(1)}s)`,
);
