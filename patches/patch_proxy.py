"""
kakake-plugin-mkbot v2.3.12 补丁：YouTube/TikTok 走代理解析与下载

用法: python3 patch_proxy.py <插件目录>
对 <插件目录>/index.mjs、lib/api/yt.mjs、lib/api/tt.mjs 打补丁，
并新建 lib/api/proxy-fetch.mjs。代理地址读 mkbot config.json 的「代理」键。
"""
import os
import shutil
import sys

BASE = sys.argv[1] if len(sys.argv) > 1 else '/home/admin/kakake/plugins/kakake-plugin-mkbot'
IDX = os.path.join(BASE, 'index.mjs')
YT = os.path.join(BASE, 'lib', 'api', 'yt.mjs')
TT = os.path.join(BASE, 'lib', 'api', 'tt.mjs')
PF = os.path.join(BASE, 'lib', 'api', 'proxy-fetch.mjs')

changed = 0

def apply(path, old, new, expect, name):
    global changed
    s = open(path, encoding='utf-8').read()
    c = s.count(old)
    if c == expect:
        s = s.replace(old, new)
        open(path, 'w', encoding='utf-8').write(s)
        changed += 1
        print(f'{name}: OK')
    else:
        print(f'{name}: SKIP (count={c}, expect={expect})')

# ---------- 0) lib/api/proxy-fetch.mjs（新建，已存在则跳过） ----------
if os.path.exists(PF):
    print('proxy-fetch.mjs: already exists, keep')
else:
    open(PF, 'w', encoding='utf-8').write('''/**
 * 可选代理 fetch —— 仅供 YouTube / TikTok 解析使用。
 * 大陆服务器直连 youtube.com / tiktok.com 不通；Node 内置 fetch 不读代理
 * 环境变量（NODE_USE_ENV_PROXY 要 Node 24+），用 npm undici 的
 * ProxyAgent + fetch 走本地代理（如 mihomo 127.0.0.1:7890）。
 * 代理地址由宿主通过 ctx.proxy 注入（mkbot config.json「代理」键）。
 */
let _proxied = null;
let _setup = null;

export async function mkSetupProxyFetch(proxyUrl) {
  const proxy = String(proxyUrl || '').trim();
  if (!/^https?:\\/\\//i.test(proxy)) return null;
  if (_setup) return _setup;
  _setup = (async () => {
    try {
      const mod = await import('undici');
      const u = mod.default ?? mod;
      if (typeof u?.fetch !== 'function' || !u?.ProxyAgent) return null;
      const agent = new u.ProxyAgent(proxy);
      _proxied = (url, opts = {}) => u.fetch(url, { ...opts, dispatcher: agent });
      return _proxied;
    } catch {
      _proxied = null;
      return null;
    }
  })();
  return _setup;
}

export function mkProxyFetchOrNull() {
  return _proxied;
}
''')
    changed += 1
    print('proxy-fetch.mjs: created')

# ---------- 1) index.mjs ----------
# 1a) mkVideoApiCtx 注入 proxy
apply(IDX,
'''function mkVideoApiCtx() {
  return { cookies: mkVideoCookieReadAll(readB) };
}''',
'''function mkVideoApiCtx() {
  return { cookies: mkVideoCookieReadAll(readB), proxy: String(readB("config.json", "代理", "") || "").trim() };
}''', 1, 'idx-ctx')

# 1b) 顶部助手（插在 mkDownloadFileRanged 前）
helpers = '''function mkVideoReadProxyUrl() {
  return String(readB("config.json", "代理", "") || "").trim();
}
function mkUrlNeedsProxy(url) {
  try {
    const h = new URL(String(url || "")).hostname;
    return /(^|\\.)(youtube\\.com|youtu\\.be|googlevideo\\.com|ytimg\\.com|tiktok\\.com|tiktokcdn\\.com|tiktokcdn-us\\.com|tiktokv\\.com|muscdn\\.com|byteoversea\\.com|ttwstatic\\.com|ibyteimg\\.com|ipstatp\\.com)$/.test(h);
  } catch {
    return false;
  }
}
let mkProxiedFetchCache = null;
let mkProxiedFetchUrl = "";
async function mkEnsureProxiedFetch() {
  const proxyUrl = mkVideoReadProxyUrl();
  if (!proxyUrl) return null;
  if (mkProxiedFetchCache && mkProxiedFetchUrl === proxyUrl) return mkProxiedFetchCache;
  try {
    const mod = await import('undici');
    const u = mod.default ?? mod;
    if (typeof u?.fetch === 'function' && u?.ProxyAgent) {
      const agent = new u.ProxyAgent(proxyUrl);
      mkProxiedFetchCache = (url2, opts = {}) => u.fetch(url2, { ...opts, dispatcher: agent });
      mkProxiedFetchUrl = proxyUrl;
      return mkProxiedFetchCache;
    }
  } catch {
  }
  mkProxiedFetchUrl = proxyUrl;
  return null;
}
async function mkDownloadFileRanged(url, fullPath, timeoutMs) {'''
apply(IDX,
'async function mkDownloadFileRanged(url, fullPath, timeoutMs) {',
helpers, 1, 'idx-helpers')

# 1c) 并发分段下载走代理
apply(IDX,
'''    const res = await fetch(url, {
      headers: { ...mkBuildDownloadHeaders(url, 0) || {}, Range: `bytes=${start}-${end}` },
      signal: 超时器.signal
    });''',
'''    const 代理F = mkUrlNeedsProxy(url) ? await mkEnsureProxiedFetch() : null;
    const res = await (代理F || fetch)(url, {
      headers: { ...mkBuildDownloadHeaders(url, 0) || {}, Range: `bytes=${start}-${end}` },
      signal: 超时器.signal
    });''', 1, 'idx-range')

# 1d) 整段下载走代理
apply(IDX,
'''    const res = await fetch(url, {
      headers: mkBuildDownloadHeaders(url, 落盘字节),
      signal: 超时器.signal
    });''',
'''    const 代理F = mkUrlNeedsProxy(url) ? await mkEnsureProxiedFetch() : null;
    const res = await (代理F || fetch)(url, {
      headers: mkBuildDownloadHeaders(url, 落盘字节),
      signal: 超时器.signal
    });''', 1, 'idx-attempt')

# 1e) 体积探测走代理
apply(IDX,
'''        const res = await fetch(url, {
          method,
          headers: { ...mkBuildDownloadHeaders(url), ...extraHeaders || {} },
          signal: controller.signal
        });''',
'''        const 代理F = mkUrlNeedsProxy(url) ? await mkEnsureProxiedFetch() : null;
        const res = await (代理F || fetch)(url, {
          method,
          headers: { ...mkBuildDownloadHeaders(url), ...extraHeaders || {} },
          signal: controller.signal
        });''', 1, 'idx-probe')

# ---------- 2) yt.mjs ----------
s = open(YT, encoding='utf-8').read()
if "from './proxy-fetch.mjs'" not in s:
    s = "import { mkSetupProxyFetch, mkProxyFetchOrNull } from './proxy-fetch.mjs';\n\n" + s
    changed += 1
    print('yt-import: OK')
open(YT, 'w', encoding='utf-8').write(s)
apply(YT,
'''async function parse(urlInput) {
  const url = extractYoutubeUrl(urlInput);''',
'''async function parse(urlInput, ctx) {
  await mkSetupProxyFetch(ctx?.proxy);
  const url = extractYoutubeUrl(urlInput);''', 1, 'yt-parse')
apply(YT,
'  const res = await fetch("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", {',
'  const res = await (mkProxyFetchOrNull() || fetch)("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", {', 1, 'yt-fetch')

# ---------- 3) tt.mjs ----------
s = open(TT, encoding='utf-8').read()
if "from './proxy-fetch.mjs'" not in s:
    s = "import { mkSetupProxyFetch, mkProxyFetchOrNull } from './proxy-fetch.mjs';\n\n" + s
    changed += 1
    print('tt-import: OK')
open(TT, 'w', encoding='utf-8').write(s)
apply(TT,
'''async function parse(urlInput) {''',
'''async function parse(urlInput, ctx) {
  await mkSetupProxyFetch(ctx?.proxy);''', 1, 'tt-parse')
apply(TT,
'    const res = await fetch(`https://vt.tiktok.com/${shortCode}`, {',
'    const res = await (mkProxyFetchOrNull() || fetch)(`https://vt.tiktok.com/${shortCode}`, {', 1, 'tt-short')
apply(TT,
'''  const res = await fetch(url, {
    method: "GET",
    redirect: "follow",''',
'''  const res = await (mkProxyFetchOrNull() || fetch)(url, {
    method: "GET",
    redirect: "follow",''', 1, 'tt-page')

print(f'PROXY-PATCH: {changed} operations applied')
