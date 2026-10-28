const DEFAULT_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/103.0.0.0 Safari/537.36";
const FETCH_TIMEOUT_MS = 15e3;
const PAGE_TIMEOUT_MS = 2e4;
function fetchWithTimeout(url, init = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const timer = AbortSignal.timeout(timeoutMs);
  if (!init.signal) return fetch(url, { ...init, signal: timer });
  const ctrl = new AbortController();
  const forward = () => ctrl.abort();
  init.signal.addEventListener("abort", forward, { once: true });
  timer.addEventListener("abort", forward, { once: true });
  return fetch(url, { ...init, signal: ctrl.signal }).finally(() => {
    init.signal?.removeEventListener("abort", forward);
  });
}
async function fetchText(url, init = {}, userAgent = DEFAULT_USER_AGENT) {
  const headers = new Headers(init.headers);
  if (!headers.has("User-Agent")) {
    headers.set("User-Agent", userAgent);
  }
  const res = await fetchWithTimeout(url, {
    ...init,
    headers,
    redirect: init.redirect ?? "follow"
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  return res.text();
}
async function followRedirect(url, userAgent = DEFAULT_USER_AGENT) {
  const res = await fetchWithTimeout(
    url,
    { method: "GET", redirect: "follow", headers: { "User-Agent": userAgent } },
    PAGE_TIMEOUT_MS
  );
  return res.url || url;
}

let _buvid3 = "";
let _buvid3At = 0;
function 随机buvid3() {
  return "X" + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 10).toUpperCase();
}
async function 获取buvid3() {
  if (_buvid3 && Date.now() - _buvid3At < 6 * 3600 * 1e3) return _buvid3;
  try {
    const res = await fetchWithTimeout(
      "https://api.bilibili.com/x/frontend/finger/spi",
      { headers: { "User-Agent": DEFAULT_USER_AGENT, Referer: "https://www.bilibili.com/" } },
      8e3
    );
    const json = await res.json();
    const b = String(json?.data?.b_3 || "").trim();
    if (b) {
      _buvid3 = b;
      _buvid3At = Date.now();
      return b;
    }
  } catch {
  }
  return "";
}

function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor(seconds % 3600 / 60);
  const s = seconds % 60;
  return [h, m, s].map((n) => String(n).padStart(2, "0")).join(":");
}
function formatPubDate(ts) {
  const d = new Date(ts * 1e3);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
async function parse(lq, ctx) {
  const 原始链接 = lq.trim();
  if (!原始链接) {
    return { 状态码: 403, 消息: "参数lq为空", 数据: null };
  }
  const cookie = String(ctx?.cookies?.["哔哩哔哩"] || "").trim();
  // 机房 IP（如阿里云）无 Cookie 访问 api.bilibili.com 会被 WAF 412：自动补 buvid3 + Referer
  let buvid3 = (cookie.match(/buvid3=([^;]+)/)?.[1] || "").trim();
  if (!buvid3) buvid3 = await 获取buvid3();
  if (!buvid3) buvid3 = 随机buvid3();
  const 拼Cookie = (bv) => (/buvid3=/.test(cookie) ? cookie : cookie ? `${cookie}; buvid3=${bv}` : `buvid3=${bv}`);
  let authHeaders = { Cookie: 拼Cookie(buvid3), Referer: "https://www.bilibili.com/" };
  const 短链接匹配 = 原始链接.match(/https?:\/\/b23\.tv\/[a-zA-Z0-9]{7}/i);
  const BV号匹配 = 原始链接.match(/BV[a-zA-Z0-9]{10}/i);
  let BV号 = null;
  if (短链接匹配) {
    const 跳转后链接 = await followRedirect(短链接匹配[0], DEFAULT_USER_AGENT);
    const 跳转BV号匹配 = 跳转后链接.match(/BV[a-zA-Z0-9]{10}/i);
    BV号 = 跳转BV号匹配?.[0] ?? BV号匹配?.[0] ?? null;
  } else {
    BV号 = BV号匹配?.[0] ?? null;
  }
  if (!BV号) {
    return { 状态码: 403, 消息: "未找到b23.tv短链接或BV号", 数据: null };
  }
  const 视图接口 = `https://api.bilibili.com/x/web-interface/wbi/view?bvid=${BV号}`;
  let 视频信息Raw;
  try {
    视频信息Raw = await fetchText(视图接口, { headers: authHeaders }, DEFAULT_USER_AGENT);
  } catch (e) {
    if (/412/.test(String(e?.message || ""))) {
      // WAF 只校验 buvid3 是否存在，换一个随机值重试一次
      _buvid3 = "";
      _buvid3At = 0;
      const bv2 = 随机buvid3();
      authHeaders = { Cookie: 拼Cookie(bv2), Referer: "https://www.bilibili.com/" };
      视频信息Raw = await fetchText(视图接口, { headers: authHeaders }, DEFAULT_USER_AGENT);
    } else {
      throw e;
    }
  }
  const 视频信息 = JSON.parse(视频信息Raw);
  if (视频信息.code !== 0 || !视频信息.data) {
    return { 状态码: 403, 消息: "获取视频信息失败", 数据: null };
  }
  const cid = 视频信息.data.cid;
  const 画质参数 = cookie ? "&qn=120" : "";
  const 播放信息Raw = await fetchText(
    `https://api.bilibili.com/x/player/wbi/playurl?gaia_source=view-card&fnval=4048&platform=html5&bvid=${BV号}&cid=${cid}${画质参数}`,
    { headers: authHeaders },
    DEFAULT_USER_AGENT
  );
  const 播放信息 = JSON.parse(播放信息Raw);
  if (播放信息.code !== 0 || !播放信息.data?.durl?.[0]?.url) {
    return { 状态码: 403, 消息: "获取播放地址失败", 数据: null };
  }
  const durl = 播放信息.data.durl[0];
  let 视频时长 = 0;
  let 视频大小 = 0;
  if (durl.length != null) {
    视频时长 = Math.round(durl.length / 1e3);
  }
  if (durl.size != null) {
    视频大小 = Math.round(durl.size / (1024 * 1024) * 100) / 100;
  }
  const stat = 视频信息.data.stat ?? {};
  const 数据 = {
    视频标题: 视频信息.data.title ?? "",
    视频封面: 视频信息.data.pic ?? "",
    发布时间: 视频信息.data.pubdate ? formatPubDate(视频信息.data.pubdate) : "未知",
    // B 站未填简介时返回空字符串，?? 兜不住，需按空白判断
    视频描述: String(视频信息.data.desc ?? "").trim() || "无描述",
    视频链接: (durl.url ?? "").replace(/\\/g, ""),
    视频时长: formatDuration(视频时长),
    视频大小: `${视频大小}MB`,
    播放次数: stat.view ?? 0,
    弹幕数量: stat.danmaku ?? 0,
    点赞数量: stat.like ?? 0,
    投币数量: stat.coin ?? 0,
    收藏数量: stat.favorite ?? 0,
    分享数量: stat.share ?? 0,
    评论数量: stat.reply ?? 0
  };
  if (视频信息.data.owner?.mid != null) {
    数据.UP主信息 = {
      UP主ID: 视频信息.data.owner.mid,
      UP主名称: 视频信息.data.owner.name ?? "",
      UP主头像: 视频信息.data.owner.face ?? ""
    };
  }
  return { 状态码: 200, 消息: "获取成功", 数据 };
}
const blbl = { parse };

export { blbl as default, parse };
