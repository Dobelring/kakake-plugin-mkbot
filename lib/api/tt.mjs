function cleanUrlTail(url) {
  return url.replace(/[^\w\-./?=&:#]+$/u, "");
}
function isAllowedDomain(url, allowedDomains) {
  const cleaned = cleanUrlTail(url);
  return allowedDomains.some(
    (allowed) => new RegExp(`https?://[^/]*${allowed.replace(/\./g, "\\.")}`, "i").test(cleaned)
  );
}

const ALLOWED_DOMAINS = ["tiktok.com", "tiktokv.com", "tiktokcdn.com", "musical.ly"];
const UA_COBALT_LIKE = "MKbot/2.3.9 (+tiktok-webapp)";
const UA_IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1";
const UA_ANDROID = "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36";
const UA_DESKTOP = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";
const UA_SHORT_LINK = UA_DESKTOP.split(" Chrome/")[0];
const FETCH_UA_LIST = [UA_COBALT_LIKE, UA_IPHONE, UA_ANDROID, UA_DESKTOP];
function output(code, msg, data) {
  return data ? { code, msg, data } : { code, msg };
}
function extractTikTokUrl(text) {
  const pathShort = text.match(/https?:\/\/(?:www\.)?tiktok\.com\/t\/[\w-]+\/?(?:\?[^\s]*)?/i);
  if (pathShort) return cleanUrlTail(pathShort[0]);
  const vm = text.match(/https?:\/\/(?:vm|vt|t)\.tiktok\.com\/[\w-]+\/?(?:\?[^\s]*)?/i);
  if (vm) return cleanUrlTail(vm[0]);
  const video = text.match(
    /https?:\/\/(?:www\.|m\.)?tiktok\.com\/@[^/\s]+\/video\/\d+(?:\?[^\s]*)?/i
  );
  if (video) return cleanUrlTail(video[0]);
  const photo = text.match(
    /https?:\/\/(?:www\.|m\.)?tiktok\.com\/@[^/\s]+\/photo\/\d+(?:\?[^\s]*)?/i
  );
  if (photo) return cleanUrlTail(photo[0]);
  const any = text.match(/https?:\/\/[^\s]*tiktok\.com\/[^\s]*/i);
  if (any) return cleanUrlTail(any[0]);
  return cleanUrlTail(text.trim());
}
function mergeCookies(...parts) {
  const map = /* @__PURE__ */ new Map();
  for (const part of parts) {
    for (const piece of String(part || "").split(";")) {
      const s = piece.trim();
      if (!s || !s.includes("=")) continue;
      const eq = s.indexOf("=");
      const k = s.slice(0, eq).trim();
      const v = s.slice(eq + 1).trim();
      if (k) map.set(k, v);
    }
  }
  return [...map.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}
function pickCookieHeader(res) {
  const list = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  if (list.length) {
    return list.map((c) => c.split(";")[0].trim()).filter(Boolean).join("; ");
  }
  const single = res.headers.get("set-cookie");
  if (!single) return "";
  return single.split(",").map((p) => p.split(";")[0].trim()).filter((s) => s.includes("=")).join("; ");
}
function extractVideoId(url) {
  const m = String(url || "").match(/\/video\/(\d+)/i) || String(url || "").match(/\/photo\/(\d+)/i) || String(url || "").match(/\/v\/(\d+)/i) || String(url || "").match(/[?&]item_id=(\d+)/i) || String(url || "").match(/[?&]aweme_id=(\d+)/i);
  return m?.[1] ?? null;
}
function extractShortLinkCode(url) {
  const m = String(url || "").match(/(?:vm|vt|t)\.tiktok\.com\/([\w-]+)/i) || String(url || "").match(/tiktok\.com\/t\/([\w-]+)/i);
  return m?.[1] ?? null;
}
async function resolveShortLinkPostId(shortCode) {
  try {
    const res = await fetch(`https://vt.tiktok.com/${shortCode}`, {
      method: "GET",
      redirect: "manual",
      headers: { "User-Agent": UA_SHORT_LINK }
    });
    const loc = res.headers.get("location") || "";
    if (loc) {
      const postId2 = extractVideoId(loc);
      if (postId2) return { postId: postId2, finalUrl: loc };
    }
    const html = await res.text();
    if (html.startsWith('<a href="https://')) {
      const href = html.split('<a href="')[1]?.split("?")[0] || "";
      const postId2 = extractVideoId(href);
      if (postId2) return { postId: postId2, finalUrl: href };
    }
    const fromHtml = html.match(/https?:\/\/(?:www\.)?tiktok\.com\/@[^/\s"']+\/(?:video|photo)\/\d+/i)?.[0] || "";
    const postId = extractVideoId(fromHtml) || extractVideoId(html);
    if (postId) return { postId, finalUrl: fromHtml || `https://www.tiktok.com/@i/video/${postId}` };
  } catch {
  }
  return null;
}
function extractBalancedObject(src, fromIdx) {
  const braceStart = src.indexOf("{", fromIdx);
  if (braceStart < 0) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  let quote = "";
  for (let i = braceStart; i < src.length; i++) {
    const ch = src[i];
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === quote) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return src.slice(braceStart, i + 1);
    }
  }
  return null;
}
function extractUniversalJson(html) {
  const marker = 'id="__UNIVERSAL_DATA_FOR_REHYDRATION__"';
  const alt = "id='__UNIVERSAL_DATA_FOR_REHYDRATION__'";
  let idx = html.indexOf(marker);
  if (idx < 0) idx = html.indexOf(alt);
  if (idx >= 0) {
    const gt = html.indexOf(">", idx);
    const end = html.indexOf("<\/script>", gt);
    if (gt >= 0 && end > gt) {
      const raw = html.slice(gt + 1, end).trim();
      try {
        return JSON.parse(raw);
      } catch {
      }
    }
  }
  const re = /<script\b[^>]*\bid=["']__UNIVERSAL_DATA_FOR_REHYDRATION__["'][^>]*>\s*([\s\S]*?)\s*<\/script>/i;
  const m = html.match(re);
  if (m?.[1]) {
    try {
      return JSON.parse(m[1]);
    } catch {
    }
  }
  const start = html.indexOf("__UNIVERSAL_DATA_FOR_REHYDRATION__");
  if (start >= 0) {
    const raw = extractBalancedObject(html, start);
    if (raw) {
      try {
        return JSON.parse(raw);
      } catch {
      }
    }
  }
  return null;
}
function pickItemStruct(root) {
  const scope = root.__DEFAULT_SCOPE__ || {};
  const candidates = [
    scope["webapp.video-detail"],
    scope["webapp.reflow.video.detail"]
  ];
  for (const block of candidates) {
    const item = block?.itemInfo?.itemStruct;
    if (item && typeof item === "object") return item;
  }
  return null;
}
function extractItemStructFromHtml(html) {
  const uni = extractUniversalJson(html);
  if (uni) {
    const item = pickItemStruct(uni);
    if (item) return item;
  }
  const key = '"itemStruct"';
  let from = 0;
  while (from < html.length) {
    const idx = html.indexOf(key, from);
    if (idx < 0) break;
    const colon = html.indexOf(":", idx + key.length);
    if (colon < 0) break;
    const raw = extractBalancedObject(html, colon);
    if (raw) {
      try {
        const obj = JSON.parse(raw);
        if (obj && (obj.video || obj.id || obj.desc)) return obj;
      } catch {
      }
    }
    from = idx + key.length;
  }
  return null;
}
function firstUrl(value) {
  if (typeof value === "string" && /^https?:\/\//i.test(value)) return value;
  if (Array.isArray(value)) {
    for (const x of value) {
      const u = firstUrl(x);
      if (u) return u;
    }
  }
  if (value && typeof value === "object") {
    const o = value;
    for (const k of ["urlList", "UrlList", "url", "Url"]) {
      const u = firstUrl(o[k]);
      if (u) return u;
    }
  }
  return "";
}
function pickVideoUrl(video, preferH265 = true) {
  if (!video) return "";
  if (preferH265) {
    const bitrate2 = video.bitrateInfo;
    if (Array.isArray(bitrate2)) {
      for (const b of bitrate2) {
        const codec = String(b?.CodecType ?? b?.codecType ?? "");
        if (/h265|hevc/i.test(codec)) {
          const u = firstUrl(
            b?.PlayAddr ?? b?.playAddr
          );
          if (u) return u;
        }
      }
    }
  }
  const play = firstUrl(video.playAddr);
  if (play) return play;
  const download = firstUrl(video.downloadAddr);
  if (download) return download;
  const bitrate = video.bitrateInfo;
  if (Array.isArray(bitrate)) {
    for (const b of bitrate) {
      const u = firstUrl(
        b?.PlayAddr ?? b?.playAddr
      );
      if (u) return u;
    }
  }
  return "";
}
function pickImageList(item) {
  const images = [];
  const push = (u) => {
    if (u && !images.includes(u)) images.push(u);
  };
  const imagePost = item.imagePost;
  if (Array.isArray(imagePost?.images)) {
    for (const img of imagePost.images) {
      const list = firstUrl(img?.imageURL) || firstUrl(img?.urlList) || firstUrl(img);
      if (list) {
        const jpegPrefer = (Array.isArray(img?.imageURL?.urlList) ? img.imageURL.urlList.find(
          (p) => String(p).includes(".jpeg?")
        ) : "") || list;
        push(String(jpegPrefer));
      }
    }
  }
  const slideshow = item.image_post_info || item.imagePostInfo;
  if (slideshow && typeof slideshow === "object") {
    const arr = slideshow.images;
    if (Array.isArray(arr)) {
      for (const img of arr) push(firstUrl(img));
    }
  }
  return images.filter(Boolean);
}
function pickMusic(item) {
  const music = item.music;
  if (!music) return void 0;
  const url = firstUrl(music.playUrl);
  if (!url) return void 0;
  return {
    title: music.title ? String(music.title) : void 0,
    author: String(music.authorName || music.author || "") || void 0,
    url
  };
}
async function fetchPage(url, ua, cookie = "") {
  const res = await fetch(url, {
    method: "GET",
    redirect: "follow",
    headers: {
      "User-Agent": ua,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9,zh-CN;q=0.8",
      ...cookie ? { Cookie: cookie } : {}
    }
  });
  const nextCookie = mergeCookies(cookie, pickCookieHeader(res));
  const html = await res.text();
  return {
    ok: res.ok,
    status: res.status,
    finalUrl: res.url || url,
    html,
    cookie: nextCookie
  };
}
function formatFromItem(item, cookie) {
  const video = item.video;
  const images = pickImageList(item);
  const streamUrl = pickVideoUrl(video);
  const authorObj = item.author || {};
  const author = String(authorObj.nickname || authorObj.uniqueId || "");
  const title = String(item.desc || "");
  const cover = firstUrl(video?.cover) || firstUrl(video?.originCover) || images[0] || "";
  const durationRaw = Number(video?.duration);
  const videoId = String(item.id || video?.id || "");
  const music = pickMusic(item);
  if (images.length && !streamUrl) {
    return output(200, "解析成功", {
      type: "image",
      title,
      author,
      cover,
      url: "",
      duration: null,
      video_id: videoId,
      images,
      ...music ? { music } : {},
      ...cookie ? { cookie } : {}
    });
  }
  if (!streamUrl) return output(404, "未找到视频直链");
  return output(200, "解析成功", {
    type: "video",
    title,
    author,
    cover,
    url: streamUrl,
    duration: Number.isFinite(durationRaw) ? durationRaw : null,
    video_id: videoId,
    ...music ? { music } : {},
    ...cookie ? { cookie } : {}
  });
}
async function parse(urlInput) {
  const url = extractTikTokUrl(urlInput);
  if (!url) return output(400, "请输入 TikTok 链接");
  if (!isAllowedDomain(url, ALLOWED_DOMAINS)) {
    return output(400, "非 TikTok 域名链接");
  }
  try {
    let cookie = "";
    let finalUrl = url;
    let item = null;
    let lastStatus = 0;
    let postId = extractVideoId(url);
    if (!postId) {
      const shortCode = extractShortLinkCode(url);
      if (shortCode) {
        const resolved = await resolveShortLinkPostId(shortCode);
        if (resolved) {
          postId = resolved.postId;
          finalUrl = resolved.finalUrl || finalUrl;
        }
      }
    }
    if (postId) {
      const detailUrls = [
        `https://www.tiktok.com/@i/video/${postId}`,
        `https://www.tiktok.com/@/video/${postId}`,
        `https://m.tiktok.com/v/${postId}`
      ];
      for (const detailUrl of detailUrls) {
        for (const ua of FETCH_UA_LIST) {
          const page = await fetchPage(detailUrl, ua, cookie);
          cookie = page.cookie;
          finalUrl = page.finalUrl || finalUrl;
          lastStatus = page.status;
          item = extractItemStructFromHtml(page.html);
          if (item) break;
        }
        if (item) break;
      }
    }
    if (!item) {
      for (const ua of FETCH_UA_LIST) {
        const page = await fetchPage(url, ua, cookie);
        cookie = page.cookie;
        finalUrl = page.finalUrl || finalUrl;
        lastStatus = page.status;
        if (!page.ok && page.status >= 400) continue;
        item = extractItemStructFromHtml(page.html);
        if (item) break;
      }
    }
    if (!item) {
      const id2 = extractVideoId(finalUrl) || postId;
      if (id2 && id2 !== postId) {
        for (const ua of FETCH_UA_LIST) {
          const page = await fetchPage(`https://www.tiktok.com/@i/video/${id2}`, ua, cookie);
          cookie = page.cookie;
          lastStatus = page.status;
          item = extractItemStructFromHtml(page.html);
          if (item) break;
        }
      }
    }
    if (!item) {
      if (lastStatus && lastStatus >= 400) {
        return output(500, `页面获取失败 HTTP ${lastStatus}`);
      }
      return output(404, "未找到页面嵌入数据");
    }
    return formatFromItem(item, cookie);
  } catch (e) {
    return output(500, e instanceof Error ? e.message : "解析失败");
  }
}
const tt = { parse };

export { tt as default, parse };
