const DEFAULT_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/103.0.0.0 Safari/537.36";
const EDGE_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Edg/122.0.0.0";
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
function cleanUrlTail(url) {
  return url.replace(/[^\w\-./?=&:#]+$/u, "");
}
function isAllowedDomain(url, allowedDomains) {
  const cleaned = cleanUrlTail(url);
  return allowedDomains.some(
    (allowed) => new RegExp(`https?://[^/]*${allowed.replace(/\./g, "\\.")}`, "i").test(cleaned)
  );
}

const ALLOWED_DOMAINS = [
  "xiaohongshu.com",
  // 小红书现在的分享短链用 xhslink.cn（老的是 xhslink.com，两者都要收）
  "xhslink.com",
  "xhslink.cn",
  "xhs.com",
  "www.xiaohongshu.com",
  "sns-img-hw.xhscdn.com",
  "sns-video-bd.xhscdn.com"
];
const BACKUP_UA = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Mobile Safari/537.36 EdgA/143.0.0.0";
function resolveCookie(ctx) {
  const c = String(ctx?.cookies?.["小红书"] || "").trim();
  return c;
}
function extractId(url) {
  const patterns = [
    /discovery\/item\/([a-zA-Z0-9]+)/,
    /explore\/([a-zA-Z0-9]+)/,
    /item\/([a-zA-Z0-9]+)/,
    /note\/([a-zA-Z0-9]+)/
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  return null;
}
async function getRealUrl(url) {
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "manual",
      headers: { "User-Agent": EDGE_USER_AGENT }
    });
    const location = res.headers.get("location");
    if (location) {
      const loc = location;
      if (extractId(loc)) return loc;
      return loc;
    }
  } catch {
  }
  return followRedirect(url, EDGE_USER_AGENT);
}
async function requestPage(url, userAgent = EDGE_USER_AGENT, cookie = "") {
  if (!isAllowedDomain(url, ALLOWED_DOMAINS)) return false;
  try {
    return await fetchText(
      url,
      {
        headers: {
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
          "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6",
          ...cookie ? { Cookie: cookie } : {}
        }
      },
      userAgent
    );
  } catch {
    return false;
  }
}
function processImageUrl(url) {
  if (!url) return "";
  const notesMatch = url.match(/\/([a-zA-Z0-9_]+)\/([a-zA-Z0-9]+)!/);
  if (notesMatch) {
    const dir = notesMatch[1];
    if (!/^[a-f0-9]{32}$/.test(dir) && !/^\d+$/.test(dir)) {
      return `https://sns-img-hw.xhscdn.com/${dir}/${notesMatch[2]}?imageView2/2/w/1080/format/jpg`;
    }
  }
  const shortMatch = url.match(/(notes_pre_post|spectrum|notes_uhdr)\/([a-zA-Z0-9]+)/);
  if (shortMatch) {
    return `https://sns-img-hw.xhscdn.com/${shortMatch[1]}/${shortMatch[2]}?imageView2/2/w/1080/format/jpg`;
  }
  const bangMatch = url.match(/\/([a-zA-Z0-9]+)!/);
  if (bangMatch) {
    return `https://ci.xiaohongshu.com/${bangMatch[1]}?imageView2/2/w/1080/format/jpg`;
  }
  return url;
}
function formatNoteData(note) {
  let type = note.type ?? "unknown";
  if (type === "normal") type = "image";
  let coverUrl = "";
  const imageList = note.imageList;
  if (imageList?.length) {
    const firstImage = imageList[0];
    coverUrl = firstImage.urlPre || firstImage.urlDefault || firstImage.url || "";
  }
  const videoObj = note.video;
  const videoImage = videoObj?.image;
  if (!coverUrl && type === "video" && videoImage?.thumbnailFileid) {
    coverUrl = `https://sns-img-hw.xhscdn.com/${videoImage.thumbnailFileid}`;
  }
  const cover = note.cover;
  if (!coverUrl && cover?.url) {
    coverUrl = cover.url;
  }
  if (!coverUrl && cover?.fileId) {
    coverUrl = `https://sns-img-hw.xhscdn.com/${cover.fileId}?imageView2/2/w/1080/format/jpg`;
  }
  const user = note.user;
  const result = {
    类型: type,
    标题: note.title ?? "",
    描述: note.desc ?? "",
    作者: {
      名称: user?.nickname ?? user?.nickName ?? "",
      ID: user?.userId ?? "",
      头像: user?.avatar ?? ""
    },
    封面: processImageUrl(coverUrl),
    视频链接: null,
    图片: [],
    实况图: []
  };
  if (result.类型 === "video" && videoObj) {
    const streams = [];
    const media = videoObj.media;
    if (media?.stream?.h265) {
      for (const stream of media.stream.h265) {
        streams.push({ ...stream, _codec: "h265" });
      }
    }
    if (media?.stream?.h264) {
      for (const stream of media.stream.h264) {
        streams.push({ ...stream, _codec: "h264" });
      }
    }
    if (streams.length) {
      streams.sort((a, b) => {
        if (a._codec !== b._codec) {
          if (a._codec === "h265") return -1;
          if (b._codec === "h265") return 1;
        }
        const bitrateA = a.avgBitrate ?? a.videoBitrate ?? 0;
        const bitrateB = b.avgBitrate ?? b.videoBitrate ?? 0;
        return bitrateB - bitrateA;
      });
      result.视频链接 = streams[0].masterUrl ?? null;
      if (streams.length > 1) {
        result.备用视频链接 = streams[1].masterUrl ?? null;
      }
    }
    const consumer = videoObj.consumer;
    if (!result.视频链接 && consumer?.originVideoKey) {
      result.视频链接 = `http://sns-video-bd.xhscdn.com/${consumer.originVideoKey}`;
    }
  }
  if (imageList?.length) {
    for (const img of imageList) {
      const imageUrl = img.url || img.urlDefault || img.urlPre;
      if (imageUrl) {
        result.图片.push(processImageUrl(imageUrl));
      }
      const stream = img.stream;
      let liveVideoUrl = null;
      if (stream?.h264?.[0]?.masterUrl) {
        liveVideoUrl = stream.h264[0].masterUrl;
      } else if (stream?.h265?.[0]?.masterUrl) {
        liveVideoUrl = stream.h265[0].masterUrl;
      }
      if (liveVideoUrl) {
        result.实况图.push({
          图片: processImageUrl(imageUrl ?? ""),
          视频: liveVideoUrl
        });
      }
    }
    if (result.实况图.length) {
      result.类型 = "live";
    }
  }
  return result;
}
function extractJson(html, id) {
  const pattern = /<script>\s*window\.__INITIAL_STATE__\s*=\s*({[\s\S]*?})<\/script>/i;
  const match = html.match(pattern);
  if (!match) return null;
  const jsonStr = match[1].replace(/undefined/g, "null");
  let json;
  try {
    json = JSON.parse(jsonStr);
  } catch {
    return null;
  }
  const noteRoot = json.note;
  let note = noteRoot?.noteDetailMap?.[id]?.note ?? null;
  if (!note) {
    const noteData = json.noteData;
    note = noteData?.data?.noteData ?? null;
  }
  if (note) {
    return formatNoteData(note);
  }
  return null;
}
function extractXsecToken(...sources) {
  for (const src of sources) {
    const s = String(src || "");
    if (!s) continue;
    const queryMatch = s.match(/[?&]xsec_token=([^&\s"']+)/i);
    if (queryMatch?.[1]) return queryMatch[1];
    const jsonMatch = s.match(/"xsec_token"\s*:\s*"([^"]+)"/);
    if (jsonMatch?.[1]) return jsonMatch[1];
    const legacyMatch = s.match(/token=(.*?)&/);
    if (legacyMatch?.[1]) return legacyMatch[1];
  }
  return "";
}
async function tryParseWithToken(url, id, response, cookie = "") {
  const token = extractXsecToken(url, response);
  if (!token) return null;
  for (const source of ["pc_search", "pc_feed"]) {
    const webUrl = `https://www.xiaohongshu.com/explore/${id}?xsec_token=${token}&xsec_source=${source}`;
    const webResponse = await requestPage(webUrl, EDGE_USER_AGENT, cookie);
    if (webResponse) {
      const data = extractJson(webResponse, id);
      if (data) return data;
    }
  }
  const apiUrl = `https://www.xiaohongshu.com/discovery/item/${id}?app_platform=android&ignoreEngage=true&app_version=8.69.5&share_from_user_hidden=true&xsec_source=app_share&type=video&xsec_token=${token}`;
  const apiResponse = await requestPage(apiUrl, EDGE_USER_AGENT, cookie);
  if (!apiResponse) return null;
  return extractJson(apiResponse, id);
}
async function parse(urlInput, ctx) {
  try {
    const cookie = resolveCookie(ctx);
    let url = cleanUrlTail(stripTags(urlInput.trim()));
    if (!url) {
      throw new Error("请输入小红书链接");
    }
    if (!isAllowedDomain(url, ALLOWED_DOMAINS)) {
      throw new Error("不允许的域名，仅支持小红书官方链接");
    }
    url = url.replace(/^https?:\/\/xhs\.com\//i, "https://xhslink.com/");
    const domain = new URL(url).hostname;
    let id;
    if (domain === "www.xiaohongshu.com") {
      id = extractId(url);
    } else {
      url = await getRealUrl(url);
      id = extractId(url);
    }
    if (!id) {
      throw new Error(`链接格式错误，无法提取ID。处理后的链接: ${url}`);
    }
    let response = await requestPage(url, EDGE_USER_AGENT, cookie);
    if (!response) {
      throw new Error(cookie ? "请求失败（Cookie 已配置，可能已失效，请到「视频解析」页刷新）" : "请求失败（未配置 Cookie，请在「视频解析」页粘贴小红书网页版 Cookie）");
    }
    let data = extractJson(response, id);
    if (!data) {
      response = await requestPage(url, BACKUP_UA, cookie) || response;
      data = extractJson(response, id);
    }
    if (!data) {
      data = await tryParseWithToken(url, id, response, cookie);
    }
    if (data) {
      return { success: true, data };
    }
    throw new Error(
      cookie ? "解析失败，未找到有效内容（Cookie 可能已失效，请刷新）" : "解析失败，未找到有效内容（多数笔记需登录态，请在「视频解析」页配置小红书 Cookie）"
    );
  } catch (e) {
    return {
      success: false,
      error: e instanceof Error ? e.message : "解析失败",
      code: 400
    };
  }
}
function stripTags(text) {
  return text.replace(/<[^>]*>/g, "");
}
const xhs = { parse };

export { xhs as default, parse };
