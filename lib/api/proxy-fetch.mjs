/**
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
  if (!/^https?:\/\//i.test(proxy)) return null;
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
