#!/usr/bin/env node
/**
 * Wails dev 服务器的模块预热器。
 *
 * 背景：macOS WKWebView 通过 wails:// 代理并发拉取上千个 ESM 模块时，
 * vite 按需转换 + Go 反代在冷启动窗口期可能对个别请求回 502，导致原生窗口
 * 报「Importing a module script failed」。浏览器直连 vite 不受影响。
 *
 * 做法：dev server 就绪后，按浏览器的方式 BFS 抓取整张 import 图，
 * 把 vite 的转换缓存焐热，再触发一次 /wails/reload。
 *
 * 独立使用：node tools/wailsDevWarmup.mjs [baseUrl]
 * （fast-dev 会在应用启动后自动调用。）
 */

const DEFAULT_BASE = 'http://localhost:34115';

const crawlModuleGraph = async (baseUrl) => {
  const seen = new Set();
  const queue = ['/src/bootstrap.ts', '/@vite/client'];
  let fetched = 0;
  const failures = [];

  const resolveUrl = (from, spec) => {
    if (spec.startsWith('/')) return new URL(spec, baseUrl);
    const baseDir = new URL(from, baseUrl).pathname.replace(/[^/]*$/, '');
    return new URL(baseDir + spec, baseUrl);
  };

  while (queue.length > 0) {
    const path = queue.shift();
    if (seen.has(path)) continue;
    seen.add(path);
    let res;
    try {
      res = await fetch(baseUrl + path);
    } catch (error) {
      failures.push(`FETCH-ERROR ${path}: ${error.message}`);
      continue;
    }
    fetched += 1;
    if (!res.ok) {
      failures.push(`HTTP ${res.status} ${path}`);
      continue;
    }
    if (fetched > 3000) break;
    const type = res.headers.get('content-type') || '';
    if (!type.includes('javascript')) continue;
    const text = await res.text();
    const specs = [
      ...text.matchAll(/(?:^|[^\w$.])(?:import|export)\s[^'";]*?from\s*["']([^"']+)["']/g),
      ...text.matchAll(/(?:^|[^\w$.])import\s*\(\s*["']([^"']+)["']\s*\)/g),
    ].map(match => match[1]);
    for (const spec of specs) {
      if (!spec || spec.startsWith('data:') || spec.startsWith('blob:')) continue;
      try {
        const url = resolveUrl(path, spec);
        if (url.origin !== new URL(baseUrl).origin) continue;
        const target = url.pathname + url.search;
        // 依赖优化目录里的合法 URL 一定带 .js（+ ?v=哈希）；解析后不带扩展名的
        // 命中来自字符串字面量误报，跳过以免 vite 刷「file does not exist」警告。
        if (target.startsWith('/node_modules/.vite/deps/') && !/\.(js|mjs)(\?|$)/.test(target)) continue;
        queue.push(target);
      } catch {
        // 忽略非法 URL（字符串字面量里的示例代码等）
      }
    }
  }
  return { fetched, failures };
};

const waitForServer = async (baseUrl, timeoutMs = 120_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(baseUrl, { method: 'GET' });
      if (res.ok || res.status === 405) return true;
    } catch {
      // 服务未就绪，继续等待
    }
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
  return false;
};

export const warmupWailsDevServer = async (baseUrl = DEFAULT_BASE) => {
  const ready = await waitForServer(baseUrl);
  if (!ready) {
    console.warn(`[warmup] dev server ${baseUrl} 未在超时内就绪，跳过预热`);
    return false;
  }
  const startedAt = Date.now();
  const { fetched, failures } = await crawlModuleGraph(baseUrl);
  // 405/404 里可能混有字符串字面量误报；只要入口链路可抓取即视为成功。
  const hardFailures = failures.filter(line => !line.includes('/node_modules/.vite/deps/'));
  console.log(`[warmup] 已预热 ${fetched} 个模块（${Math.round((Date.now() - startedAt) / 1000)}s），失败 ${hardFailures.length} 个`);
  if (hardFailures.length > 0) {
    for (const line of hardFailures.slice(0, 10)) console.warn(`[warmup]   ${line}`);
  }
  // 预热完成后让原生窗口重载一次，吃到热缓存。
  try {
    await fetch(`${baseUrl}/wails/reload`);
    console.log('[warmup] 已触发原生窗口重载');
  } catch {
    console.warn('[warmup] 触发 /wails/reload 失败（窗口可能尚未启动）');
  }
  return hardFailures.length === 0;
};

const isDirectRun = process.argv[1] && process.argv[1].endsWith('wailsDevWarmup.mjs');
if (isDirectRun) {
  const baseUrl = process.argv[2] || DEFAULT_BASE;
  void warmupWailsDevServer(baseUrl);
}
