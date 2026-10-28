import { parentPort } from 'node:worker_threads';
import fs from 'fs';
import path from 'path';
import { pathToFileURL, fileURLToPath } from 'url';
import crypto from 'crypto';
import https from 'https';
import http from 'http';
import 'node:fs';
import 'node:path';
import 'node:url';

let pngCompressionLevel = null;
function configureSharpPngCompressionLevel(value, logger) {
  const raw = String(value ?? "").trim();
  if (!raw) {
    pngCompressionLevel = null;
    return;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 9) {
    pngCompressionLevel = null;
    return;
  }
  const next = Math.floor(n);
  pngCompressionLevel = next;
}
function MK_PNG_OUT() {
  return pngCompressionLevel == null ? {} : { compressionLevel: pngCompressionLevel };
}
const MK_JPEG_DEFAULT_QUALITY = 85;
function MK_JPEG_OUT() {
  return { quality: MK_JPEG_DEFAULT_QUALITY, mozjpeg: true };
}

let sharpModule = null;
let searchPaths = [];
let sharpConcurrency = null;
const SHARP_RUNTIME_DEPS_DIR = "runtime-deps";
function resolveSharpRuntimeDepsDir(dataDir) {
  const resolved = path.resolve(String(dataDir || "").trim());
  if (!resolved) return path.join(".", SHARP_RUNTIME_DEPS_DIR);
  return path.join(path.dirname(path.dirname(resolved)), SHARP_RUNTIME_DEPS_DIR);
}
function configureSharpRuntimePaths(paths) {
  const dataDir = String(paths.dataDir || "").trim();
  const pluginDir = String(paths.pluginDir || "").trim();
  const next = [];
  if (dataDir) next.push(resolveSharpRuntimeDepsDir(dataDir));
  if (pluginDir) next.push(path.resolve(pluginDir));
  searchPaths = next;
}
function fileExists(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}
function sharpEntryCandidates(baseDir) {
  const root = path.join(baseDir, "node_modules", "sharp");
  return [
    path.join(root, "dist", "index.mjs"),
    path.join(root, "dist", "index.cjs"),
    path.join(root, "lib", "index.js"),
    path.join(root, "lib", "sharp.js")
  ];
}
function recordSharpLoadError(e, where) {
  e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}
async function importSharpFromDir(baseDir) {
  for (const entry of sharpEntryCandidates(baseDir)) {
    if (!fileExists(entry)) continue;
    try {
      const mod = await import(pathToFileURL(entry).href);
      const factory = mod.default ?? mod;
      if (typeof factory === "function") return factory;
      recordSharpLoadError(new Error("模块加载成功但导出不是可调用工厂"), entry);
    } catch (e) {
      recordSharpLoadError(e);
    }
  }
  return null;
}
function configureSharpConcurrency(value, logger) {
  const raw = String(value ?? "").trim();
  if (!raw) {
    sharpConcurrency = null;
    return;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    sharpConcurrency = null;
    return;
  }
  const next = Math.max(1, Math.min(16, Math.floor(n)));
  sharpConcurrency = next;
  if (sharpModule) applySharpConcurrency(sharpModule);
}
function applySharpConcurrency(factory) {
  if (sharpConcurrency == null) return;
  try {
    const fn = factory.concurrency;
    if (typeof fn === "function") fn.call(factory, sharpConcurrency);
  } catch {
  }
}
async function loadSharp() {
  if (sharpModule) return sharpModule;
  for (const dir of searchPaths) {
    const loaded = await importSharpFromDir(dir);
    if (loaded) {
      sharpModule = loaded;
      applySharpConcurrency(sharpModule);
      return loaded;
    }
  }
  try {
    const mod = await import('sharp');
    sharpModule = mod.default ?? mod;
    applySharpConcurrency(sharpModule);
    return sharpModule;
  } catch (e) {
    recordSharpLoadError(
      e,
      searchPaths.length ? `runtime-deps(${searchPaths.join(" | ")}) 及内置 sharp` : "内置 sharp"
    );
    throw e;
  }
}

const DEFAULT_MAX_ENTRIES = 6;
let enabled = true;
let maxEntries = DEFAULT_MAX_ENTRIES;
const cache = /* @__PURE__ */ new Map();
function applyBgCacheState(on, max, logger) {
  enabled = !!on;
  maxEntries = max;
  if (!enabled && cache.size) {
    cache.clear();
  }
  while (enabled && cache.size > maxEntries) {
    const oldest = cache.keys().next().value;
    if (oldest === void 0) break;
    cache.delete(oldest);
  }
}
function applySharpBgCacheConfig(cfg, logger) {
  if (!cfg || typeof cfg !== "object") return;
  applyBgCacheState(cfg.enabled !== false, Number(cfg.maxEntries) || DEFAULT_MAX_ENTRIES);
}
function fingerprint(buf) {
  return crypto.createHash("sha1").update(buf).digest("hex").slice(0, 16);
}
function makeSharpBgLayerKey(bgBuf, width, height, blurSigma) {
  if (!enabled) return null;
  if (!bgBuf || !bgBuf.length) return null;
  return `${fingerprint(bgBuf)}|${width}x${height}|${blurSigma}`;
}
function getSharpBgLayer(key) {
  if (!key) return null;
  const hit = cache.get(key);
  if (!hit) return null;
  cache.delete(key);
  cache.set(key, hit);
  return hit;
}
function setSharpBgLayer(key, buf) {
  if (!key || !buf || !buf.length) return;
  cache.set(key, buf);
  while (cache.size > maxEntries) {
    const oldest = cache.keys().next().value;
    if (oldest === void 0) break;
    cache.delete(oldest);
  }
}

let directEnabled = true;
function configureSharpSvgDirect(value, logger) {
  const raw = String(value ?? "").trim().toLowerCase();
  directEnabled = !(raw === "关闭" || raw === "false" || raw === "0" || raw === "off");
}
function looksLikeSvg(buf) {
  if (!buf || !buf.length) return false;
  const head = buf.subarray(0, 512).toString("utf8").replace(/^﻿/, "").replace(/^\s+/, "");
  return head.startsWith("<svg") || head.startsWith("<?xml");
}
async function probeSvgSize(sharp, buf) {
  try {
    const meta = await sharp(buf).metadata();
    const w = Number(meta?.width);
    const h = Number(meta?.height);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
    return { width: w, height: h };
  } catch {
    return null;
  }
}
async function canCompositeSvgDirect(sharp, buf, width, height) {
  if (!directEnabled) return false;
  if (!looksLikeSvg(buf)) return false;
  const size = await probeSvgSize(sharp, buf);
  if (!size) return false;
  return Math.abs(size.width - width) <= 1 && Math.abs(size.height - height) <= 1;
}
async function rasterizeLayer(sharp, buf, width, height) {
  return sharp(buf).resize(width, height, { fit: "fill" }).ensureAlpha().png(MK_PNG_OUT()).toBuffer();
}
async function svgCompositeLayer(sharp, buf, width, height) {
  if (await canCompositeSvgDirect(sharp, buf, width, height)) return buf;
  return rasterizeLayer(sharp, buf, width, height);
}

const MENU_ICON_SVGS = {
  key: "M17 8h1a4 4 0 110 8h-1M15 8V6a4 4 0 00-8 0v2M9 8v10",
  shield: "M12 3l8 4v6c0 5-8 8-8 8s-8-3-8-8V7l8-4z",
  "user-add": ["M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2", "M9 11a4 4 0 100-8 4 4 0 000 8z", "M19 8v6", "M22 11h-6"],
  settings: "M12 15.5A3.5 3.5 0 1012 8.5a3.5 3.5 0 000 7zM19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z",
  music: "M9 18V5l12-2v13M9 13a3 3 0 100 6 3 3 0 000-6zM21 11a3 3 0 100 6 3 3 0 000-6z",
  video: "M15 10l4-2v8l-4-2V10zM5 6h10a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2z",
  account: ["M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2", "M12 11a4 4 0 100-8 4 4 0 000 8z"],
  "file-settings": "M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6zM14 2v6h6M12 18v-6M9 15h6",
  links: "M10 13a5 5 0 007.54.54l2-2a5 5 0 00-7.07-7.07l-1.17 1.17M14 11a5 5 0 00-7.54-.54l-2 2a5 5 0 007.07 7.07l1.17-1.17",
  fire: "M12 3c2 4 6 5 6 10a6 6 0 11-12 0c0-3 2-5 4-7 1 2 2 3 2 4z",
  qa: "M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2v10z",
  card: "M3 10h18M7 15h2M3 6a2 2 0 012-2h14a2 2 0 012 2v12a2 2 0 01-2 2H5a2 2 0 01-2-2V6z",
  calendar: ["M8 2v4M16 2v4", "M3 10h18", "M5 4h14a2 2 0 012 2v14a2 2 0 01-2 2H5a2 2 0 01-2-2V6a2 2 0 012-2z", "M9 16l2 2 4-4"],
  anchor: "M12 22V8M5 12H2a10 10 0 0020 0h-3M12 6a3 3 0 100-6 3 3 0 000 6z",
  "id-card": "M4 6h16v12H4V6zM8 10h8M8 14h5M12 6v12",
  bank: "M3 10h18M5 10V20M9 10V20M15 10V20M19 10V20M12 3l9 5H3l9-5z",
  dice: "M5 5h14v14H5V5zM9 9h.01M15 9h.01M9 15h.01M15 15h.01",
  "mail-send": "M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z",
  chat: "M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2v10z",
  heart: "M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z",
  trophy: "M8 21h8M12 17v4M7 4h10v5a5 5 0 01-10 0V4zM5 4H3v2a3 3 0 003 3M19 4h2v2a3 3 0 01-3 3",
  mute: ["M11 5L6 9H2v6h4l5 4V5z", "M23 9l-6 6", "M17 9l6 6"],
  briefcase: ["M4 7h16v13H4V7z", "M9 7V5a2 2 0 012-2h2a2 2 0 012 2v2", "M4 12h16"]
};
const MENU_BASIC_ITEMS = [
  { title: "授权系统", desc: "插件内置的授权系统", icon: "key" },
  { title: "群管系统", desc: "仅限于群内使用", icon: "shield" },
  { title: "邀人统计", desc: "开启后可记录邀请次数，并且可一系列控制", icon: "user-add" },
  { title: "事件管理", desc: "各种开关的管理及介绍", icon: "settings" },
  { title: "音乐系统", desc: "听歌的，共4种音源，可语音、链接、卡片返回", icon: "music" },
  { title: "视频菜单", desc: "接入了大量的视频接口，注：接口来源于网络", icon: "video" },
  { title: "账号设置", desc: "配置登录的机器人账号信息的，如头像昵称签名等", icon: "account" },
  { title: "插件配置", desc: "该功能仅配置MK的config.json文件", icon: "file-settings" },
  { title: "接口功能", desc: "这个是本插件接入的第三方接口，都会在里面", icon: "links" },
  { title: "管理续火", desc: "每日续火，需先开启相关事件，支持好友/群聊，支持图片或文案", icon: "fire" },
  { title: "问答系统", desc: "有模糊问答 和 精准问答，支持图片回复", icon: "qa" },
  { title: "发卡系统", desc: "全局发卡系统，可用于其他分发娱乐，使用归笺兑换，支持定价、改名等操作", icon: "card" }
];
const MENU_ENT_ITEMS = [
  { title: "签到", desc: "每日签到获取奖励", icon: "calendar" },
  { title: "钓鱼", desc: "通过「每日签到」可获取诱饵钓鱼哦～", icon: "anchor" },
  { title: "我的信息", desc: "查看游戏中你的信息", icon: "id-card" },
  { title: "银行系统", desc: "存钱的，有利润，非常建议把货币存进去", icon: "bank" },
  { title: "幸运轮盘", desc: "要来一把豪赌的轮盘吗！", icon: "dice" },
  { title: "漂流瓶", desc: "字面意思，不过没有隐私保护，直接公开瓶子主人", icon: "mail-send" },
  { title: "伪造聊天", desc: "目前版本仅支持纯文本伪造", icon: "chat" },
  { title: "群老婆", desc: "支持单群或全群", icon: "heart" },
  { title: "排行榜", desc: "各种类型的排行名单", icon: "trophy" },
  { title: "禁言卡", desc: "使用禁言卡@别人", icon: "mute" },
  { title: "打工", desc: "13个岗位各有独立工资公式；查看打工状态 / 结算工资", icon: "briefcase" }
];
function renderMenuIconForSharp(iconKey, x, y, boxSize, color) {
  const paths = MENU_ICON_SVGS[iconKey];
  if (!paths) return "";
  const inner = 18;
  const scale = inner / 24;
  const tx = x + (boxSize - inner) / 2;
  const ty = y + (boxSize - inner) / 2;
  const list = Array.isArray(paths) ? paths : [paths];
  const pathEls = list.map(
    (d) => `<path d="${d}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`
  ).join("");
  return `<g transform="translate(${tx},${ty}) scale(${scale})">${pathEls}</g>`;
}

const SHARP_BG_DIM_CONFIG_KEY = "Sharp背景暗度";
const SHARP_BG_BLUR_CONFIG_KEY = "Sharp背景模糊";
const DEFAULT_SHARP_BG_DIM_PERCENT = 40;
const DEFAULT_SHARP_BG_BLUR = 0;
const MAX_SHARP_BG_BLUR = 30;
function parseSharpBgDimPercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_SHARP_BG_DIM_PERCENT;
  return Math.min(100, Math.max(0, n));
}
function parseSharpBgBlurSigma(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_SHARP_BG_BLUR;
  return Math.min(MAX_SHARP_BG_BLUR, Math.max(0, n));
}
function resolveSharpBgEffectsFromConfig(config) {
  const dimPct = parseSharpBgDimPercent(config?.[SHARP_BG_DIM_CONFIG_KEY]);
  const blurSigma = parseSharpBgBlurSigma(config?.[SHARP_BG_BLUR_CONFIG_KEY]);
  return {
    dimAlpha: dimPct / 100,
    blurSigma
  };
}
function loadSharpBgEffectsFromDataPath(dataPath) {
  const dir = String(dataPath || "").trim();
  if (!dir) return resolveSharpBgEffectsFromConfig(null);
  try {
    const cfgPath = path.join(dir, "config.json");
    if (!fs.existsSync(cfgPath)) return resolveSharpBgEffectsFromConfig(null);
    const raw = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
    return resolveSharpBgEffectsFromConfig(raw);
  } catch {
    return resolveSharpBgEffectsFromConfig(null);
  }
}
async function prepareSharpPhotoBackgroundLayer(sharp, bgBuf, width, height, effects) {
  let pipeline = sharp(bgBuf).resize(width, height, { fit: "cover", position: "centre" });
  if (effects.blurSigma > 0) {
    pipeline = pipeline.blur(effects.blurSigma);
  }
  return pipeline.ensureAlpha().png(MK_PNG_OUT()).toBuffer();
}
async function createSharpDimOverlayLayer(sharp, width, height, dimAlpha) {
  if (dimAlpha <= 0) return null;
  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: dimAlpha }
    }
  }).png(MK_PNG_OUT()).toBuffer();
}
async function applySharpPhotoBackgroundLayers(sharp, composites, bgBuf, width, height, dataPath, effectsOverride) {
  const effects = loadSharpBgEffectsFromDataPath(String(dataPath || ""));
  const cacheKey = makeSharpBgLayerKey(bgBuf, width, height, effects.blurSigma);
  let bgLayer = getSharpBgLayer(cacheKey);
  if (!bgLayer) {
    bgLayer = await prepareSharpPhotoBackgroundLayer(sharp, bgBuf, width, height, effects);
    setSharpBgLayer(cacheKey, bgLayer);
  }
  composites.push({ input: bgLayer, top: 0, left: 0 });
  const dimOverlay = await createSharpDimOverlayLayer(sharp, width, height, effects.dimAlpha);
  if (dimOverlay) composites.push({ input: dimOverlay, top: 0, left: 0 });
}

const SHARP_TEXT_COLOR_CONFIG_KEY = "Sharp全局字体色";
const HEX_COLOR_RE = /^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/;
function parseSharpTextColor(value) {
  const s = String(value ?? "").trim();
  if (!s) return null;
  if (!HEX_COLOR_RE.test(s)) return null;
  if (s.length === 4) {
    const r = s[1];
    const g = s[2];
    const b = s[3];
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  return s.length === 9 ? s.slice(0, 7) : s;
}
function resolveSharpTextColorFromConfig(config) {
  return parseSharpTextColor(config?.[SHARP_TEXT_COLOR_CONFIG_KEY]);
}
function loadSharpTextColorFromDataPath(dataPath) {
  const dir = String(dataPath || "").trim();
  if (!dir) return null;
  try {
    const cfgPath = path.join(dir, "config.json");
    if (!fs.existsSync(cfgPath)) return null;
    const raw = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
    return resolveSharpTextColorFromConfig(raw);
  } catch {
    return null;
  }
}
function resolveSharpTextFill(custom, fallback) {
  return custom ?? fallback;
}

function escapeXml$b(text) {
  return String(text ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
function wrapText$2(text, maxChars) {
  const s = String(text || "").trim();
  if (!s) return [""];
  const lines = [];
  let cur = "";
  for (const ch of s) {
    if (cur.length >= maxChars) {
      lines.push(cur);
      cur = "";
    }
    cur += ch;
  }
  if (cur) lines.push(cur);
  return lines.slice(0, 3);
}
function fetchUrlBuffer$6(url, timeoutMs = 15e3) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.get(
      url,
      { timeout: timeoutMs, headers: { "User-Agent": "MKbot-SharpRender/1.0" } },
      (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          fetchUrlBuffer$6(res.headers.location, timeoutMs).then(resolve).catch(reject);
          return;
        }
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}`));
          res.resume();
          return;
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        res.on("end", () => resolve(Buffer.concat(chunks)));
        res.on("error", reject);
      }
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy(new Error("timeout"));
    });
  });
}
async function loadBackgroundSource(options, pluginDir, dataPath) {
  const width = options.width ?? 1680;
  const height = options.height ?? 1010;
  const landscape = width >= height;
  const candidates = [];
  const push = (v) => {
    const s = String(v || "").trim();
    if (s && !candidates.includes(s)) candidates.push(s);
  };
  if (landscape) {
    push(options.bgLocalPath);
  } else {
    push(options.bgLocalPortraitPath);
    push(options.bgLocalPath);
  }
  const localNames = landscape ? ["heng.jpg", "heng.jpeg", "heng.png", "heng.webp"] : ["shu.jpg", "shu.jpeg", "shu.png", "shu.webp", "heng.jpg"];
  const roots = [
    path.join(String(pluginDir || "").trim(), "默认资源", "image")
  ];
  for (const root of roots) {
    if (!String(root || "").trim()) continue;
    for (const name of localNames) {
      push(path.join(root, name));
    }
  }
  push(options.bgUrl);
  push(landscape ? options.bgLandscape : options.bgPortrait);
  push(options.bgLandscape);
  push(options.bgPortrait);
  for (const src of candidates) {
    try {
      if (/^file:\/\//i.test(src)) {
        const abs2 = fileURLToPath(src);
        if (fs.existsSync(abs2)) return fs.readFileSync(abs2);
        continue;
      }
      if (/^https?:\/\//i.test(src)) {
        const buf = await fetchUrlBuffer$6(src, 2e4);
        if (buf.length > 0) return buf;
        continue;
      }
      const abs = path.isAbsolute(src) ? src : path.resolve(src);
      if (fs.existsSync(abs)) {
        return fs.readFileSync(abs);
      }
    } catch (_e) {
    }
  }
  return null;
}
function buildMenuSvg(width, height, theme, customText) {
  const isLight = theme === "light";
  const titleColor = resolveSharpTextFill(customText, isLight ? "#3a2f1c" : "#fff3dc");
  const labelColor = resolveSharpTextFill(customText, isLight ? "rgba(42,36,24,0.78)" : "rgba(255,255,255,0.88)");
  const groupBg = isLight ? "rgba(255,255,255,0.22)" : "rgba(0,0,0,0.14)";
  const groupColor = resolveSharpTextFill(customText, isLight ? "#3a2f1c" : "#fff3dc");
  const boxBg = isLight ? "rgba(255,255,255,0.16)" : "rgba(255,255,255,0.05)";
  const boxBorder = isLight ? "rgba(255,255,255,0.45)" : "rgba(255,255,255,0.38)";
  const cellBg = isLight ? "rgba(255,255,255,0.12)" : "transparent";
  const cellAltBg = isLight ? "rgba(255,255,255,0.18)" : "rgba(255,255,255,0.025)";
  const itemTitle = resolveSharpTextFill(customText, isLight ? "#2f2718" : "#fff6e8");
  const itemDesc = isLight ? "rgba(42,36,24,0.78)" : "rgba(255,255,255,0.92)";
  const iconBg = isLight ? "rgba(255,255,255,0.38)" : "rgba(255,255,255,0.1)";
  const iconBorder = isLight ? "rgba(255,255,255,0.72)" : "rgba(255,255,255,0.42)";
  const iconStroke = resolveSharpTextFill(customText, isLight ? "#6b5434" : "#fff6e8");
  const footerColor = "rgba(238,238,238,0.35)";
  const padX = 20;
  const contentW = width - padX * 2;
  const cols = width >= 560 ? 3 : width >= 380 ? 2 : 1;
  const colW = contentW / cols;
  const rowH = 88;
  const iconSize = 32;
  let y = 56;
  const parts = [];
  parts.push(
    `<text x="${width / 2}" y="${y}" text-anchor="middle" font-family="Microsoft YaHei, Noto Sans SC, sans-serif" font-size="46" font-weight="800" fill="${titleColor}">使用帮助</text>`
  );
  y += 38;
  parts.push(
    `<text x="${width / 2}" y="${y}" text-anchor="middle" font-family="Microsoft YaHei, Noto Sans SC, sans-serif" font-size="16" fill="${labelColor}">MK-Bot · NapCat 综合娱乐与群管</text>`
  );
  y += 28;
  const renderSection = (groupTitle, items) => {
    const rows = Math.ceil(items.length / cols);
    const groupH = 42 + rows * rowH + 8;
    const boxX = padX;
    const boxY = y;
    parts.push(
      `<rect x="${boxX}" y="${boxY}" width="${contentW}" height="${groupH}" rx="18" ry="18" fill="${boxBg}" stroke="${boxBorder}" stroke-width="1"/>`
    );
    parts.push(
      `<rect x="${boxX}" y="${boxY}" width="${contentW}" height="38" rx="18" ry="18" fill="${groupBg}"/>`
    );
    parts.push(
      `<text x="${boxX + 18}" y="${boxY + 26}" font-family="Microsoft YaHei, Noto Sans SC, sans-serif" font-size="16" font-weight="700" fill="${groupColor}">${escapeXml$b(groupTitle)}</text>`
    );
    const gridTop = boxY + 42;
    items.forEach((item, idx) => {
      const col = idx % cols;
      const row = Math.floor(idx / cols);
      const cx = boxX + col * colW;
      const cy = gridTop + row * rowH;
      const alt = row % 2 === 1;
      parts.push(
        `<rect x="${cx + 1}" y="${cy + 1}" width="${colW - 2}" height="${rowH - 2}" fill="${alt ? cellAltBg : cellBg}" stroke="${isLight ? "rgba(255,255,255,0.28)" : "rgba(255,255,255,0.12)"}" stroke-width="1"/>`
      );
      const ix = cx + 10;
      const iy = cy + 12;
      parts.push(
        `<rect x="${ix}" y="${iy}" width="${iconSize}" height="${iconSize}" rx="7" fill="${iconBg}" stroke="${iconBorder}" stroke-width="1"/>`
      );
      parts.push(renderMenuIconForSharp(item.icon, ix, iy, iconSize, iconStroke));
      const tx = ix + iconSize + 10;
      parts.push(
        `<text x="${tx}" y="${iy + 16}" font-family="Microsoft YaHei, Noto Sans SC, sans-serif" font-size="14" font-weight="700" fill="${itemTitle}">${escapeXml$b(item.title)}</text>`
      );
      const descLines = wrapText$2(item.desc, cols === 1 ? 28 : cols === 2 ? 18 : 14);
      descLines.forEach((line, li) => {
        parts.push(
          `<text x="${tx}" y="${iy + 34 + li * 16}" font-family="Microsoft YaHei, Noto Sans SC, sans-serif" font-size="11" fill="${itemDesc}">${escapeXml$b(line)}</text>`
        );
      });
    });
    y += groupH + 14;
  };
  renderSection("基础功能", MENU_BASIC_ITEMS);
  renderSection("娱乐功能", MENU_ENT_ITEMS);
  parts.push(
    `<text x="${width / 2}" y="${height - 18}" text-anchor="middle" font-family="Microsoft YaHei, Noto Sans SC, sans-serif" font-size="11" fill="${footerColor}" letter-spacing="2">发送「菜单」或「/MK」查看本帮助</text>`
  );
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <defs>
    <linearGradient id="topFade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="rgba(0,0,0,0.08)"/>
      <stop offset="100%" stop-color="rgba(0,0,0,0)"/>
    </linearGradient>
  </defs>
  ${parts.join("\n  ")}
  <rect x="0" y="0" width="${width}" height="220" fill="url(#topFade)"/>
</svg>`;
}
async function fitCompositeLayer$5(sharp, input, width, height) {
  return svgCompositeLayer(sharp, input, width, height);
}
async function renderMenuWithSharpImpl(pluginDir, dataPath, options, logger) {
  const width = options.width ?? 1680;
  const height = options.height ?? 1010;
  const theme = String(options.uiTheme || "0").trim() === "1" ? "light" : "clear";
  try {
    const sharp = await loadSharp();
    const bgBuf = await loadBackgroundSource(options, pluginDir, dataPath);
    const composites = [];
    if (bgBuf && bgBuf.length > 0) {
      await applySharpPhotoBackgroundLayers(sharp, composites, bgBuf, width, height, dataPath);
    }
    const customText = loadSharpTextColorFromDataPath(dataPath);
    const svg = buildMenuSvg(width, height, theme, customText);
    const uiLayer = await fitCompositeLayer$5(sharp, Buffer.from(svg), width, height);
    composites.push({ input: uiLayer, top: 0, left: 0 });
    let canvas = sharp({
      create: {
        width,
        height,
        channels: 4,
        background: { r: 15, g: 25, b: 35, alpha: 1 }
      }
    });
    if (composites.length > 0) {
      canvas = canvas.composite(composites);
    }
    const out = await canvas.png(MK_PNG_OUT()).toBuffer();
    return out.toString("base64");
  } catch (error) {
    error instanceof Error ? error.message : String(error);
    return null;
  }
}

const API_INTERFACE_MENU_SECTIONS = [
  {
    title: "API接口功能",
    items: [
      { name: "图片菜单", icon: "video" },
      { name: "三角洲密码", icon: "key" },
      { name: "EPIC免费游戏", icon: "dice" },
      { name: "搜饰品[关键词]", icon: "qa" },
      { name: "发病文学[对象名]", icon: "chat" },
      { name: "查MC服务器[IP/域名]", icon: "settings" }
    ]
  },
  {
    title: "表情包系统",
    items: [
      { name: "爬", note: "静态图，随机模板", icon: "heart", tag: "静态" },
      { name: "顶", note: "GIF", icon: "heart", tag: "GIF" },
      { name: "啃", note: "GIF", icon: "heart", tag: "GIF" },
      { name: "摸头", note: "GIF", icon: "heart", tag: "GIF" },
      { name: "吃", note: "GIF", icon: "heart", tag: "GIF" },
      { name: "吸", note: "GIF", icon: "heart", tag: "GIF" },
      { name: "啾", note: "GIF", icon: "heart", tag: "GIF" },
      { name: "挠头", note: "GIF", icon: "heart", tag: "GIF" },
      { name: "贴贴", note: "GIF，需 @ 对方", icon: "heart", tag: "@" },
      { name: "戒导", note: "证书 PNG，可带日期", icon: "card", tag: "PNG" },
      { name: "二次元入口", note: "PNG", icon: "links", tag: "PNG" },
      { name: "上瘾", note: "PNG", icon: "heart", tag: "PNG" },
      { name: "别碰", note: "PNG", icon: "shield", tag: "PNG" },
      { name: "捣", note: "GIF", icon: "heart", tag: "GIF" },
      { name: "灰飞烟灭", note: "GIF", icon: "fire", tag: "GIF" },
      { name: "卖掉了", note: "PNG", icon: "fire", tag: "PNG" },
      { name: "嘲讽", note: "PNG", icon: "chat", tag: "PNG" },
      { name: "想什么", note: "PNG", icon: "qa", tag: "PNG" },
      { name: "我想上的", note: "PNG", icon: "heart", tag: "PNG" },
      { name: "你不懂啦", note: "PNG", icon: "chat", tag: "PNG" }
    ]
  }
];
const API_INTERFACE_MENU_FOOTER = "事件管理开启「表情制作」；可 @ 指定头像；贴贴必须 @";

const TAG_COLORS = {
  GIF: { bg: "rgba(255,138,101,0.22)", stroke: "rgba(255,138,101,0.55)", text: "#ffc9b8" },
  PNG: { bg: "rgba(129,212,250,0.2)", stroke: "rgba(129,212,250,0.5)", text: "#c8ecff" },
  静态: { bg: "rgba(186,255,168,0.18)", stroke: "rgba(186,255,168,0.45)", text: "#d9ffd0" },
  "@": { bg: "rgba(255,213,79,0.2)", stroke: "rgba(255,213,79,0.5)", text: "#ffe9a8" }
};
function escapeXml$a(text) {
  return String(text ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
function wrapText$1(text, maxChars, maxLines = 2) {
  const s = String(text || "").trim();
  if (!s) return [""];
  const lines = [];
  let cur = "";
  for (const ch of s) {
    if (cur.length >= maxChars) {
      lines.push(cur);
      cur = "";
      if (lines.length >= maxLines) break;
    }
    cur += ch;
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  return lines.length ? lines : [""];
}
function fetchUrlBuffer$5(url, timeoutMs = 15e3) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(
      url,
      { timeout: timeoutMs, headers: { "User-Agent": "MKbot-ApiMenuSharp/1.0" } },
      (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          fetchUrlBuffer$5(res.headers.location, timeoutMs).then(resolve).catch(reject);
          return;
        }
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}`));
          res.resume();
          return;
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        res.on("end", () => resolve(Buffer.concat(chunks)));
        res.on("error", reject);
      }
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
  });
}
async function loadBackgroundBuffer(options) {
  const candidates = [];
  const push = (v) => {
    const s = String(v || "").trim();
    if (s && !candidates.includes(s)) candidates.push(s);
  };
  push(options.bgLocalPath);
  const roots = [
    path.join(String(options.dataPath || "").trim(), "默认资源", "image"),
    path.join(String(options.pluginDir || "").trim(), "data", "默认资源", "image")
  ];
  for (const root of roots) {
    if (!root.trim()) continue;
    for (const name of ["heng.jpg", "heng.jpeg", "heng.png", "heng.webp"]) {
      push(path.join(root, name));
    }
  }
  for (const src of candidates) {
    try {
      if (/^file:\/\//i.test(src)) {
        const abs2 = fileURLToPath(src);
        if (fs.existsSync(abs2)) return fs.readFileSync(abs2);
        continue;
      }
      if (/^https?:\/\//i.test(src)) {
        const buf = await fetchUrlBuffer$5(src, 2e4);
        if (buf.length > 0) return buf;
        continue;
      }
      const abs = path.isAbsolute(src) ? src : path.resolve(src);
      if (fs.existsSync(abs)) return fs.readFileSync(abs);
    } catch {
    }
  }
  return null;
}
function calcSectionGrid(section, cols, rowH) {
  const rows = Math.ceil(section.items.length / cols);
  return 42 + rows * rowH + 10;
}
function calcMenuHeight(width, cols, rowH) {
  const padY = 36;
  const titleBlock = 86;
  const sectionGap = 16;
  const footerH = 40;
  let body = 0;
  for (const section of API_INTERFACE_MENU_SECTIONS) {
    body += calcSectionGrid(section, cols, rowH) + sectionGap;
  }
  return padY + titleBlock + body + footerH + padY;
}
function renderTagPill(x, y, tag) {
  const colors = TAG_COLORS[tag] || TAG_COLORS.GIF;
  const w = tag.length <= 2 ? 34 : 44;
  return [
    `<rect x="${x}" y="${y}" width="${w}" height="18" rx="9" fill="${colors.bg}" stroke="${colors.stroke}" stroke-width="1"/>`,
    `<text x="${x + w / 2}" y="${y + 13}" text-anchor="middle" font-family="Microsoft YaHei, Noto Sans SC, sans-serif" font-size="10" font-weight="700" fill="${colors.text}">${escapeXml$a(tag)}</text>`
  ].join("");
}
function buildApiInterfaceMenuSvg(width, height, customText) {
  const titleColor = resolveSharpTextFill(customText, "#fff3dc");
  const labelColor = resolveSharpTextFill(customText, "rgba(255,255,255,0.88)");
  const groupBg = "rgba(0,0,0,0.14)";
  const groupColor = resolveSharpTextFill(customText, "#fff3dc");
  const boxBg = "rgba(255,255,255,0.05)";
  const boxBorder = "rgba(255,255,255,0.38)";
  const cellBg = "transparent";
  const cellAltBg = "rgba(255,255,255,0.025)";
  const itemTitle = resolveSharpTextFill(customText, "#fff6e8");
  const itemDesc = "rgba(255,255,255,0.82)";
  const iconBg = "rgba(255,255,255,0.1)";
  const iconBorder = "rgba(255,255,255,0.42)";
  const iconStroke = resolveSharpTextFill(customText, "#fff6e8");
  const footerColor = "rgba(238,238,238,0.35)";
  const padX = 24;
  const contentW = width - padX * 2;
  const cols = width >= 900 ? 3 : width >= 620 ? 2 : 1;
  const colW = contentW / cols;
  const rowH = cols === 3 ? 78 : cols === 2 ? 82 : 72;
  const iconSize = 30;
  const parts = [];
  let y = 40;
  parts.push(
    `<text x="${width / 2}" y="${y}" text-anchor="middle" font-family="Microsoft YaHei, Noto Sans SC, sans-serif" font-size="42" font-weight="800" fill="${titleColor}">接口功能</text>`
  );
  y += 36;
  parts.push(
    `<text x="${width / 2}" y="${y}" text-anchor="middle" font-family="Microsoft YaHei, Noto Sans SC, sans-serif" font-size="15" fill="${labelColor}">MK-Bot · 第三方 API 与表情包指令</text>`
  );
  y += 34;
  const renderGridSection = (groupTitle, items) => {
    const rows = Math.ceil(items.length / cols);
    const groupH = 42 + rows * rowH + 10;
    const boxX = padX;
    const boxY = y;
    parts.push(
      `<rect x="${boxX}" y="${boxY}" width="${contentW}" height="${groupH}" rx="18" ry="18" fill="${boxBg}" stroke="${boxBorder}" stroke-width="1"/>`
    );
    parts.push(
      `<rect x="${boxX}" y="${boxY}" width="${contentW}" height="38" rx="18" ry="18" fill="${groupBg}"/>`
    );
    parts.push(
      `<text x="${boxX + 18}" y="${boxY + 26}" font-family="Microsoft YaHei, Noto Sans SC, sans-serif" font-size="16" font-weight="700" fill="${groupColor}">${escapeXml$a(groupTitle)}</text>`
    );
    const gridTop = boxY + 42;
    items.forEach((item, idx) => {
      const col = idx % cols;
      const row = Math.floor(idx / cols);
      const cx = boxX + col * colW;
      const cy = gridTop + row * rowH;
      const alt = row % 2 === 1;
      parts.push(
        `<rect x="${cx + 1}" y="${cy + 1}" width="${colW - 2}" height="${rowH - 2}" fill="${alt ? cellAltBg : cellBg}" stroke="rgba(255,255,255,0.12)" stroke-width="1"/>`
      );
      const ix = cx + 12;
      const iy = cy + 14;
      parts.push(
        `<rect x="${ix}" y="${iy}" width="${iconSize}" height="${iconSize}" rx="8" fill="${iconBg}" stroke="${iconBorder}" stroke-width="1"/>`
      );
      if (item.icon) {
        parts.push(renderMenuIconForSharp(item.icon, ix, iy, iconSize, iconStroke));
      }
      const tx = ix + iconSize + 10;
      const titleLines = wrapText$1(item.name, cols === 1 ? 24 : cols === 2 ? 14 : 10, 1);
      parts.push(
        `<text x="${tx}" y="${iy + 16}" font-family="Microsoft YaHei, Noto Sans SC, sans-serif" font-size="14" font-weight="700" fill="${itemTitle}">${escapeXml$a(titleLines[0])}</text>`
      );
      if (item.tag) {
        parts.push(renderTagPill(cx + colW - 48, cy + 10, item.tag));
      }
      const descSource = item.note || (item.tag ? "" : "");
      if (descSource) {
        const descLines = wrapText$1(descSource, cols === 1 ? 28 : cols === 2 ? 16 : 12, 2);
        descLines.forEach((line, li) => {
          parts.push(
            `<text x="${tx}" y="${iy + 34 + li * 15}" font-family="Microsoft YaHei, Noto Sans SC, sans-serif" font-size="11" fill="${itemDesc}">${escapeXml$a(line)}</text>`
          );
        });
      } else if (!item.tag && cols >= 2) {
        parts.push(
          `<text x="${tx}" y="${iy + 34}" font-family="Microsoft YaHei, Noto Sans SC, sans-serif" font-size="11" fill="${itemDesc}">发送指令即可使用</text>`
        );
      }
    });
    y += groupH + 16;
  };
  for (const section of API_INTERFACE_MENU_SECTIONS) {
    renderGridSection(section.title, section.items);
  }
  parts.push(
    `<text x="${width / 2}" y="${height - 18}" text-anchor="middle" font-family="Microsoft YaHei, Noto Sans SC, sans-serif" font-size="11" fill="${footerColor}" letter-spacing="1">${escapeXml$a(API_INTERFACE_MENU_FOOTER)}</text>`
  );
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <defs>
    <linearGradient id="topFade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="rgba(0,0,0,0.1)"/>
      <stop offset="100%" stop-color="rgba(0,0,0,0)"/>
    </linearGradient>
  </defs>
  ${parts.join("\n  ")}
  <rect x="0" y="0" width="${width}" height="180" fill="url(#topFade)"/>
</svg>`;
}
async function fitCompositeLayer$4(sharp, input, width, height) {
  return svgCompositeLayer(sharp, input, width, height);
}
async function renderApiInterfaceMenuWithSharpImpl(options = {}, logger) {
  const width = options.width ?? 1080;
  const cols = width >= 900 ? 3 : width >= 620 ? 2 : 1;
  const rowH = cols === 3 ? 78 : cols === 2 ? 82 : 72;
  const height = calcMenuHeight(width, cols, rowH);
  const dataPath = String(options.dataPath || "").trim();
  try {
    const sharp = await loadSharp();
    const composites = [];
    const bgBuf = await loadBackgroundBuffer(options);
    if (bgBuf && bgBuf.length > 0) {
      await applySharpPhotoBackgroundLayers(sharp, composites, bgBuf, width, height, dataPath);
    }
    const customText = loadSharpTextColorFromDataPath(dataPath);
    const svg = buildApiInterfaceMenuSvg(width, height, customText);
    const uiLayer = await fitCompositeLayer$4(sharp, Buffer.from(svg), width, height);
    composites.push({ input: uiLayer, top: 0, left: 0 });
    let canvas = sharp({
      create: {
        width,
        height,
        channels: 4,
        background: { r: 15, g: 25, b: 35, alpha: 1 }
      }
    });
    if (composites.length > 0) {
      canvas = canvas.composite(composites);
    }
    const out = await canvas.png(MK_PNG_OUT()).toBuffer();
    return out.toString("base64");
  } catch (error) {
    error instanceof Error ? error.message : String(error);
    return null;
  }
}

function escapeXml$9(text) {
  return String(text ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
function wrapText(text, maxChars, maxLines = 6) {
  const s = String(text || "").trim();
  if (!s) return [""];
  const lines = [];
  let cur = "";
  for (const ch of s) {
    if (cur.length >= maxChars) {
      lines.push(cur);
      cur = "";
      if (lines.length >= maxLines) break;
    }
    cur += ch;
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  return lines.length ? lines : [""];
}
function fetchUrlBuffer$4(url, timeoutMs = 2e4) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(
      url,
      { timeout: timeoutMs, headers: { "User-Agent": "MKbot-FortuneSharp/1.0" } },
      (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          fetchUrlBuffer$4(res.headers.location, timeoutMs).then(resolve).catch(reject);
          return;
        }
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}`));
          res.resume();
          return;
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        res.on("end", () => resolve(Buffer.concat(chunks)));
        res.on("error", reject);
      }
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
  });
}
function decodeDataUrl$1(dataUrl) {
  const m = String(dataUrl || "").match(/^data:[^;]+;base64,(.+)$/i);
  if (!m) return null;
  try {
    return Buffer.from(m[1], "base64");
  } catch {
    return null;
  }
}
async function loadFortuneBackground(card, pluginDir, dataPath) {
  const candidates = [];
  const push = (v) => {
    const s = String(v || "").trim();
    if (s && !candidates.includes(s)) candidates.push(s);
  };
  push(card.backgroundImageUrl);
  const imageName = String(card.image_name || "").trim();
  if (imageName) {
    if (path.isAbsolute(imageName)) push(imageName);
    const roots = [
      path.join(String(dataPath || "").trim(), "默认资源", "image"),
      path.join(String(pluginDir || "").trim(), "data", "默认资源", "image")
    ];
    for (const root of roots) {
      if (!root.trim()) continue;
      push(path.join(root, imageName));
    }
  }
  for (const src of candidates) {
    try {
      if (/^data:/i.test(src)) {
        const buf = decodeDataUrl$1(src);
        if (buf && buf.length) return buf;
        continue;
      }
      if (/^file:\/\//i.test(src)) {
        const abs = fileURLToPath(src);
        if (fs.existsSync(abs)) return fs.readFileSync(abs);
        continue;
      }
      if (/^https?:\/\//i.test(src)) {
        const buf = await fetchUrlBuffer$4(src, 25e3);
        if (buf.length > 0) return buf;
        continue;
      }
      if (fs.existsSync(src)) return fs.readFileSync(src);
    } catch (_e) {
    }
  }
  return null;
}
function calcFortuneCardLayout(width, height, unSignText) {
  const cardW = Math.min(480, width - 40);
  const cardX = (width - cardW) / 2;
  const bottomPad = 50;
  const subLines = wrapText(unSignText, 26, 6);
  const cardH = 30 + 88 + 25 + 54 + subLines.length * 24 + 16 + 48 + 30;
  const cardY = height - bottomPad - cardH;
  return { cardW, cardX, cardY, cardH, subLines };
}
function buildFortuneOverlaySvg(width, height, card, customText) {
  const font = "Microsoft YaHei, Noto Sans SC, sans-serif";
  const accent = "#FFB6C1";
  const mainFill = resolveSharpTextFill(customText, "#ffffff");
  const glass = "rgba(15,15,18,0.5)";
  const title = escapeXml$9(card.Sorte || "大吉");
  const stars = escapeXml$9(card.Estrelas || "★★★★★★★");
  const time = escapeXml$9(card.time || "");
  escapeXml$9(card.signText || "福星高照，万事如意");
  const unSignText = String(card.unSignText || "此签为大吉之兆");
  const { cardW, cardX, cardY, cardH, subLines } = calcFortuneCardLayout(width, height, unSignText);
  const pad = 30;
  const avatarSize = 80;
  const avatarX = cardX + pad;
  const avatarY = cardY + pad;
  const infoX = avatarX + avatarSize + 18;
  const infoTimeY = avatarY + 18;
  const infoTitleY = avatarY + 44;
  const infoStarsY = avatarY + 72;
  const parts = [];
  parts.push(
    `<rect x="${cardX}" y="${cardY}" width="${cardW}" height="${cardH}" rx="35" ry="35" fill="${glass}" stroke="rgba(255,255,255,0.12)" stroke-width="1"/>`
  );
  parts.push(
    `<circle cx="${avatarX + avatarSize / 2}" cy="${avatarY + avatarSize / 2}" r="${avatarSize / 2 + 1.5}" fill="none" stroke="#ffffff" stroke-width="3"/>`
  );
  parts.push(
    `<text x="${infoX}" y="${infoTimeY}" font-family="${font}" font-size="13" font-weight="900" fill="${accent}" letter-spacing="1">time:${time}</text>`
  );
  parts.push(
    `<text x="${infoX}" y="${infoTitleY}" font-family="${font}" font-size="26" font-weight="700" fill="${mainFill}">${title}</text>`
  );
  parts.push(
    `<text x="${infoX}" y="${infoStarsY}" font-family="${font}" font-size="18" fill="${accent}">${stars}</text>`
  );
  const mainTop = avatarY + avatarSize + 25;
  const barX = cardX + pad;
  const textX = barX + 16;
  parts.push(
    `<rect x="${barX}" y="${mainTop + 2}" width="4" height="24" rx="2" fill="#ffffff" opacity="0.95"/>`
  );
  const signLines = wrapText(card.signText || "", 22, 2);
  signLines.forEach((line, i) => {
    parts.push(
      `<text x="${textX}" y="${mainTop + 20 + i * 26}" font-family="${font}" font-size="19" font-weight="600" fill="${mainFill}">${escapeXml$9(line)}</text>`
    );
  });
  const subTop = mainTop + 20 + signLines.length * 26 + 14;
  const subX = cardX + pad + 17;
  parts.push(
    `<line x1="${cardX + pad}" y1="${subTop - 8}" x2="${cardX + pad}" y2="${subTop - 8 + subLines.length * 24 + 8}" stroke="rgba(255,255,255,0.2)" stroke-width="1"/>`
  );
  subLines.forEach((line, i) => {
    parts.push(
      `<text x="${subX}" y="${subTop + i * 24}" font-family="${font}" font-size="15" fill="rgba(255,255,255,0.7)">${escapeXml$9(line)}</text>`
    );
  });
  const noteY = cardY + cardH - 22;
  parts.push(
    `<text x="${cardX + cardW / 2}" y="${noteY}" text-anchor="middle" font-family="${font}" font-size="11" fill="rgba(255,255,255,0.3)" letter-spacing="2">本内容为虚拟生成，切勿迷信！</text>`
  );
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${parts.join("\n")}</svg>`;
}
async function roundAvatar$4(sharp, buf, size) {
  try {
    const mask = Buffer.from(
      `<svg width="${size}" height="${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="white"/></svg>`
    );
    return sharp(buf).resize(size, size, { fit: "cover" }).ensureAlpha().composite([{ input: mask, blend: "dest-in" }]).png(MK_PNG_OUT()).toBuffer();
  } catch {
    return null;
  }
}
async function renderFortuneWithSharpImpl(options, logger) {
  const width = options.width ?? 720;
  const height = options.height ?? 1280;
  const card = options.card || {};
  const pluginDir = String(options.pluginDir || "").trim();
  const dataPath = String(options.dataPath || "").trim();
  try {
    const sharp = await loadSharp();
    const bgBuf = await loadFortuneBackground(card, pluginDir, dataPath);
    const composites = [];
    if (bgBuf && bgBuf.length > 0) {
      await applySharpPhotoBackgroundLayers(sharp, composites, bgBuf, width, height, dataPath);
    } else {
      const fallback = await sharp({
        create: {
          width,
          height,
          channels: 3,
          background: { r: 255, g: 240, b: 243 }
        }
      }).png(MK_PNG_OUT()).toBuffer();
      composites.push({ input: fallback, top: 0, left: 0 });
      logger?.warn?.("[Sharp渲染] 今日运势背景图不可用，已使用默认底色");
    }
    const customText = loadSharpTextColorFromDataPath(dataPath);
    const overlaySvg = buildFortuneOverlaySvg(width, height, card, customText);
    const overlayLayer = await svgCompositeLayer(sharp, Buffer.from(overlaySvg), width, height);
    composites.push({ input: overlayLayer, top: 0, left: 0 });
    const { cardX, cardY } = calcFortuneCardLayout(width, height, String(card.unSignText || ""));
    const avatarUrl = `https://q4.qlogo.cn/g?b=qq&nk=${card.qq || ""}&s=5`;
    try {
      const avatarBuf = await fetchUrlBuffer$4(avatarUrl, 1e4);
      if (avatarBuf.length > 0) {
        const rounded = await roundAvatar$4(sharp, avatarBuf, 80);
        if (rounded) {
          composites.push({ input: rounded, top: Math.round(cardY + 30), left: Math.round(cardX + 30) });
        }
      }
    } catch (_e) {
    }
    const out = await sharp({
      create: {
        width,
        height,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 1 }
      }
    }).composite(composites).flatten({ background: { r: 255, g: 255, b: 255 } }).jpeg(MK_JPEG_OUT()).toBuffer();
    return out.toString("base64");
  } catch (error) {
    error instanceof Error ? error.message : String(error);
    return null;
  }
}

const MDI_ICON_VIEWBOX = 24;
const MDI_ICON_PATHS = {
  "robot-happy": ["M22 14h-1c0-3.87-3.13-7-7-7h-1V5.73A2 2 0 1 0 10 4c0 .74.4 1.39 1 1.73V7h-1c-3.87 0-7 3.13-7 7H2c-.55 0-1 .45-1 1v3c0 .55.45 1 1 1h1v1a2 2 0 0 0 2 2h14c1.11 0 2-.89 2-2v-1h1c.55 0 1-.45 1-1v-3c0-.55-.45-1-1-1M9.79 16.5C9.4 15.62 8.53 15 7.5 15s-1.9.62-2.29 1.5c-.13-.31-.21-.64-.21-1a2.5 2.5 0 0 1 5 0c0 .36-.08.69-.21 1m9 0c-.39-.88-1.29-1.5-2.29-1.5s-1.9.62-2.29 1.5c-.13-.31-.21-.64-.21-1a2.5 2.5 0 0 1 5 0c0 .36-.08.69-.21 1"],
  "cpu-64-bit": ["M9 3v2H7a2 2 0 0 0-2 2v2H3v2h2v2H3v2h2v2a2 2 0 0 0 2 2h2v2h2v-2h2v2h2v-2h2a2 2 0 0 0 2-2v-2h2v-2h-2v-2h2V9h-2V7a2 2 0 0 0-2-2h-2V3h-2v2h-2V3M8 9h3.5v1.5h-3v.75h2a1 1 0 0 1 1 1V14a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1m4.5 0H14v2h1.5V9H17v6h-1.5v-2.5h-3m-4 .25v.75H10v-.75"],
  "memory": ["M17 17H7V7h10m4 4V9h-2V7a2 2 0 0 0-2-2h-2V3h-2v2h-2V3H9v2H7c-1.11 0-2 .89-2 2v2H3v2h2v2H3v2h2v2a2 2 0 0 0 2 2h2v2h2v-2h2v2h2v-2h2a2 2 0 0 0 2-2v-2h2v-2h-2v-2m-6 2h-2v-2h2m2-2H9v6h6z"],
  "harddisk": ["M6 2h12a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2m6 2a6 6 0 0 0-6 6c0 3.31 2.69 6 6.1 6l-.88-2.23a1.01 1.01 0 0 1 .37-1.37l.86-.5a1.01 1.01 0 0 1 1.37.37l1.92 2.42A5.98 5.98 0 0 0 18 10a6 6 0 0 0-6-6m0 5a1 1 0 0 1 1 1a1 1 0 0 1-1 1a1 1 0 0 1-1-1a1 1 0 0 1 1-1m-5 9a1 1 0 0 0-1 1a1 1 0 0 0 1 1a1 1 0 0 0 1-1a1 1 0 0 0-1-1m5.09-4.73l2.49 6.31l2.59-1.5l-4.22-5.31z"],
  "speedometer": ["M12 16a3 3 0 0 1-3-3c0-1.12.61-2.1 1.5-2.61l9.71-5.62l-5.53 9.58c-.5.98-1.51 1.65-2.68 1.65m0-13c1.81 0 3.5.5 4.97 1.32l-2.1 1.21C14 5.19 13 5 12 5a8 8 0 0 0-8 8c0 2.21.89 4.21 2.34 5.65h.01c.39.39.39 1.02 0 1.41s-1.03.39-1.42.01A9.97 9.97 0 0 1 2 13A10 10 0 0 1 12 3m10 10c0 2.76-1.12 5.26-2.93 7.07c-.39.38-1.02.38-1.41-.01a.996.996 0 0 1 0-1.41A7.95 7.95 0 0 0 20 13c0-1-.19-2-.54-2.9L20.67 8C21.5 9.5 22 11.18 22 13"],
  "server-network": ["M13 19h1a1 1 0 0 1 1 1h7v2h-7a1 1 0 0 1-1 1h-4a1 1 0 0 1-1-1H2v-2h7a1 1 0 0 1 1-1h1v-2H4a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1h16a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1h-7zM4 3h16a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1m5 4h1V5H9zm0 8h1v-2H9zM5 5v2h2V5zm0 8v2h2v-2z"],
  "nodejs": ["M12 1.85c-.27 0-.55.07-.78.2l-7.44 4.3c-.48.28-.78.8-.78 1.36v8.58c0 .56.3 1.08.78 1.36l1.95 1.12c.95.46 1.27.47 1.71.47c1.4 0 2.21-.85 2.21-2.33V8.44c0-.12-.1-.22-.22-.22H8.5c-.13 0-.23.1-.23.22v8.47c0 .66-.68 1.31-1.77.76L4.45 16.5a.26.26 0 0 1-.11-.21V7.71c0-.09.04-.17.11-.21l7.44-4.29c.06-.04.16-.04.22 0l7.44 4.29c.07.04.11.12.11.21v8.58c0 .08-.04.16-.11.21l-7.44 4.29c-.06.04-.16.04-.23 0L10 19.65c-.08-.03-.16-.04-.21-.01c-.53.3-.63.36-1.12.51c-.12.04-.31.11.07.32l2.48 1.47q.36.21.78.21t.78-.21l7.44-4.29c.48-.28.78-.8.78-1.36V7.71c0-.56-.3-1.08-.78-1.36l-7.44-4.3c-.23-.13-.5-.2-.78-.2M14 8c-2.12 0-3.39.89-3.39 2.39c0 1.61 1.26 2.08 3.3 2.28c2.43.24 2.62.6 2.62 1.08c0 .83-.67 1.18-2.23 1.18c-1.98 0-2.4-.49-2.55-1.47a.226.226 0 0 0-.22-.18h-.96c-.12 0-.21.09-.21.22c0 1.24.68 2.74 3.94 2.74c2.35 0 3.7-.93 3.7-2.55c0-1.61-1.08-2.03-3.37-2.34c-2.31-.3-2.54-.46-2.54-1c0-.45.2-1.05 1.91-1.05c1.5 0 2.09.33 2.32 1.36c.02.1.11.17.21.17h.97c.05 0 .11-.02.15-.07c.04-.04.07-.1.05-.16C17.56 8.82 16.38 8 14 8"],
  "puzzle": ["M20.5 11H19V7a2 2 0 0 0-2-2h-4V3.5A2.5 2.5 0 0 0 10.5 1A2.5 2.5 0 0 0 8 3.5V5H4a2 2 0 0 0-2 2v3.8h1.5c1.5 0 2.7 1.2 2.7 2.7S5 16.2 3.5 16.2H2V20a2 2 0 0 0 2 2h3.8v-1.5c0-1.5 1.2-2.7 2.7-2.7s2.7 1.2 2.7 2.7V22H17a2 2 0 0 0 2-2v-4h1.5a2.5 2.5 0 0 0 2.5-2.5a2.5 2.5 0 0 0-2.5-2.5"],
  "cube-outline": ["M21 16.5c0 .38-.21.71-.53.88l-7.9 4.44c-.16.12-.36.18-.57.18s-.41-.06-.57-.18l-7.9-4.44A.99.99 0 0 1 3 16.5v-9c0-.38.21-.71.53-.88l7.9-4.44c.16-.12.36-.18.57-.18s.41.06.57.18l7.9 4.44c.32.17.53.5.53.88zM12 4.15L6.04 7.5L12 10.85l5.96-3.35zM5 15.91l6 3.38v-6.71L5 9.21zm14 0v-6.7l-6 3.37v6.71z"],
  "account-multiple": ["M16 17v2H2v-2s0-4 7-4s7 4 7 4m-3.5-9.5A3.5 3.5 0 1 0 9 11a3.5 3.5 0 0 0 3.5-3.5m3.44 5.5A5.32 5.32 0 0 1 18 17v2h4v-2s0-3.63-6.06-4M15 4a3.4 3.4 0 0 0-1.93.59a5 5 0 0 1 0 5.82A3.4 3.4 0 0 0 15 11a3.5 3.5 0 0 0 0-7"],
  "account-heart": ["M15 14c-2.7 0-8 1.3-8 4v2h16v-2c0-2.7-5.3-4-8-4m0-2a4 4 0 0 0 4-4a4 4 0 0 0-4-4a4 4 0 0 0-4 4a4 4 0 0 0 4 4M5 15l-.6-.5C2.4 12.6 1 11.4 1 9.9c0-1.2 1-2.2 2.2-2.2c.7 0 1.4.3 1.8.8c.4-.5 1.1-.8 1.8-.8C8 7.7 9 8.6 9 9.9c0 1.5-1.4 2.7-3.4 4.6z"],
  "clock-time-four": ["M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10s10-4.5 10-10S17.5 2 12 2m4.3 13.2L11 12.3V7h1.5v4.4l4.5 2.5z"],
  "chart-box": ["M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2M9 17H7v-7h2zm4 0h-2V7h2zm4 0h-2v-4h2z"],
  "database": ["M12 3C7.58 3 4 4.79 4 7s3.58 4 8 4s8-1.79 8-4s-3.58-4-8-4M4 9v3c0 2.21 3.58 4 8 4s8-1.79 8-4V9c0 2.21-3.58 4-8 4s-8-1.79-8-4m0 5v3c0 2.21 3.58 4 8 4s8-1.79 8-4v-3c0 2.21-3.58 4-8 4s-8-1.79-8-4"],
  "star-four-points": ["M12 1L9 9l-8 3l8 3l3 8l3-8l8-3l-8-3z"],
  "heart": ["m12 21.35l-1.45-1.32C5.4 15.36 2 12.27 2 8.5C2 5.41 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.08C13.09 3.81 14.76 3 16.5 3C19.58 3 22 5.41 22 8.5c0 3.77-3.4 6.86-8.55 11.53z"],
  "monitor-dashboard": ["M21 16V4H3v12zm0-14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-7v2h2v2H8v-2h2v-2H3a2 2 0 0 1-2-2V4c0-1.11.89-2 2-2zM5 6h9v5H5zm10 0h4v2h-4zm4 3v5h-4V9zM5 12h4v2H5zm5 0h4v2h-4z"],
  "view-dashboard": ["M13 3v6h8V3m-8 18h8V11h-8M3 21h8v-6H3m0-2h8V3H3z"],
  "cog": ["M12 15.5A3.5 3.5 0 0 1 8.5 12A3.5 3.5 0 0 1 12 8.5a3.5 3.5 0 0 1 3.5 3.5a3.5 3.5 0 0 1-3.5 3.5m7.43-2.53c.04-.32.07-.64.07-.97s-.03-.66-.07-1l2.11-1.63c.19-.15.24-.42.12-.64l-2-3.46c-.12-.22-.39-.31-.61-.22l-2.49 1c-.52-.39-1.06-.73-1.69-.98l-.37-2.65A.506.506 0 0 0 14 2h-4c-.25 0-.46.18-.5.42l-.37 2.65c-.63.25-1.17.59-1.69.98l-2.49-1c-.22-.09-.49 0-.61.22l-2 3.46c-.13.22-.07.49.12.64L4.57 11c-.04.34-.07.67-.07 1s.03.65.07.97l-2.11 1.66c-.19.15-.25.42-.12.64l2 3.46c.12.22.39.3.61.22l2.49-1.01c.52.4 1.06.74 1.69.99l.37 2.65c.04.24.25.42.5.42h4c.25 0 .46-.18.5-.42l.37-2.65c.63-.26 1.17-.59 1.69-.99l2.49 1.01c.22.08.49 0 .61-.22l2-3.46c.12-.22.07-.49-.12-.64z"],
  "pulse": ["M3 13h2.79l4.31-8.21l1.18 8.96l3.22-4.09L17.83 13H21v2h-4l-2.33-2.33l-4.75 6.06l-.98-7.42L7 15H3z"],
  "chip": ["M6 4h12v1h3v2h-3v2h3v2h-3v2h3v2h-3v2h3v2h-3v1H6v-1H3v-2h3v-2H3v-2h3v-2H3V9h3V7H3V5h3zm5 11v3h1v-3zm2 0v3h1v-3zm2 0v3h1v-3z"],
  "gauge": ["M12 2A10 10 0 0 0 2 12a10 10 0 0 0 10 10a10 10 0 0 0 10-10A10 10 0 0 0 12 2m0 2a8 8 0 0 1 8 8c0 2.4-1 4.5-2.7 6c-1.4-1.3-3.3-2-5.3-2s-3.8.7-5.3 2C5 16.5 4 14.4 4 12a8 8 0 0 1 8-8m2 1.89c-.38.01-.74.26-.9.65l-1.29 3.23l-.1.23c-.71.13-1.3.6-1.57 1.26c-.41 1.03.09 2.19 1.12 2.6s2.19-.09 2.6-1.12c.26-.66.14-1.42-.29-1.98l.1-.26l1.29-3.21l.01-.03c.2-.51-.05-1.09-.56-1.3c-.13-.05-.26-.07-.41-.07M10 6a1 1 0 0 0-1 1a1 1 0 0 0 1 1a1 1 0 0 0 1-1a1 1 0 0 0-1-1M7 9a1 1 0 0 0-1 1a1 1 0 0 0 1 1a1 1 0 0 0 1-1a1 1 0 0 0-1-1m10 0a1 1 0 0 0-1 1a1 1 0 0 0 1 1a1 1 0 0 0 1-1a1 1 0 0 0-1-1"],
  "water": ["M12 20a6 6 0 0 1-6-6c0-4 6-10.75 6-10.75S18 10 18 14a6 6 0 0 1-6 6"],
  "folder-multiple": ["M22 4h-8l-2-2H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2M2 6H0v14a2 2 0 0 0 2 2h18v-2H2z"],
  "lan-connect": ["M4 1c-1.11 0-2 .89-2 2v4c0 1.11.89 2 2 2H1v2h12V9h-3c1.11 0 2-.89 2-2V3c0-1.11-.89-2-2-2zm0 2h6v4H4zM3 13v7h7v-2H5v-5zm11 0c-1.11 0-2 .89-2 2v4c0 1.11.89 2 2 2h-3v2h12v-2h-3c1.11 0 2-.89 2-2v-4c0-1.11-.89-2-2-2zm0 2h6v4h-6z"],
  "cloud-outline": ["M6.5 20q-2.28 0-3.89-1.57Q1 16.85 1 14.58q0-1.95 1.17-3.48q1.18-1.53 3.08-1.95q.63-2.3 2.5-3.72Q9.63 4 12 4q2.93 0 4.96 2.04Q19 8.07 19 11q1.73.2 2.86 1.5q1.14 1.28 1.14 3q0 1.88-1.31 3.19T18.5 20m-12-2h12q1.05 0 1.77-.73q.73-.72.73-1.77t-.73-1.77Q19.55 13 18.5 13H17v-2q0-2.07-1.46-3.54Q14.08 6 12 6Q9.93 6 8.46 7.46Q7 8.93 7 11h-.5q-1.45 0-2.47 1.03Q3 13.05 3 14.5T4.03 17q1.02 1 2.47 1m5.5-6"],
  "download": ["M5 20h14v-2H5m14-9h-4V3H9v6H5l7 7z"],
  "upload": ["M9 16v-6H5l7-7l7 7h-4v6zm-4 4v-2h14v2z"],
  "arrow-down-bold": ["M9 4h6v8h4.84L12 19.84L4.16 12H9z"],
  "arrow-up-bold": ["M15 20H9v-8H4.16L12 4.16L19.84 12H15z"],
  "swap-vertical": ["M9 3L5 7h3v7h2V7h3m3 10v-7h-2v7h-3l4 4l4-4z"],
  "router-network": ["M5 9c-1.1 0-2 .9-2 2v4a2 2 0 0 0 2 2h6v2h-1c-.55 0-1 .45-1 1H2v2h7c0 .55.45 1 1 1h4c.55 0 1-.45 1-1h7v-2h-7c0-.55-.45-1-1-1h-1v-2h6c1.11 0 2-.89 2-2v-4a2 2 0 0 0-2-2zm1 3h2v2H6zm3.5 0h2v2h-2zm3.5 0h2v2h-2z"],
  "rocket-launch": ["m13.16 22.19l-1.66-3.84c1.6-.58 3.07-1.35 4.43-2.27l-2.78 6.11m-7.5-9.69l-3.84-1.65l6.11-2.78a20 20 0 0 0-2.27 4.43M21.66 2.35S23.78 7.31 18.11 13c-2.2 2.17-4.58 3.5-6.73 4.34c-.74.28-1.57.1-2.12-.46l-2.13-2.13c-.56-.56-.74-1.38-.47-2.13C7.5 10.5 8.83 8.09 11 5.89C16.69.216 21.66 2.35 21.66 2.35M6.25 22H4.84l4.09-4.1c.3.21.63.36.97.45zM2 22v-1.41l4.77-4.78l1.43 1.42L3.41 22zm0-2.84v-1.41l3.65-3.65c.09.35.24.68.45.97zM16 6a2 2 0 1 0 0 4c1.11 0 2-.89 2-2a2 2 0 0 0-2-2"],
  "flash": ["M7 2v11h3v9l7-12h-4l4-8z"]
};

const STATUS_BG_REMOTE_URL = "http://xn--mk-ub3cl61ae1v.xn--c5w857b.xn--fiqs8s/mkbot/image/yunxing.jpg";
const STATUS_CARD_WIDTH = 800;
const LOCAL_BG_NAMES = [
  "运势5.png",
  "运势5.jpg",
  "运势5.jpeg",
  "运势5.webp",
  "运行状态.jpg",
  "运行状态.png",
  "yunxing.jpg"
];
const FONT = "Microsoft YaHei, PingFang SC, Noto Sans SC, sans-serif";
const HUE = {
  blue: "#5B9CFF",
  purple: "#A183FF",
  green: "#3FCF9A",
  pink: "#FF8FB4",
  orange: "#FFAC5B",
  cyan: "#4FCBE3",
  yellow: "#FFCF5C",
  red: "#FF7B8A"
};
const INK = "#2B2440";
const INK_SOFT = "rgba(43,36,64,0.68)";
const GLASS_BLUR = 0.7;
const GLASS_SATURATION = 1.06;
const GLASS_CONTRAST = 0.88;
const GLASS_LIFT = 26;
const LENS_BANDS = [
  { from: 15, to: 30, push: 5, feather: 4, soft: 0.6 },
  { from: 5, to: 17, push: 15, feather: 3.5, soft: 0.5 },
  { from: 0, to: 8, push: 32, feather: 2.4, soft: 0.4, disperse: true }
];
const BODY_PUSH = 6;
const LENS_DEPTH = 30;
const LENS_DISPERSION = 0.14;
const MENISCUS_FROM = 1.2;
const MENISCUS_TO = 10;
const MENISCUS_BLUR = 2.6;
const MENISCUS_ALPHA = 0.5;
const DASH_PATTERN = "9 7";
const CARD_HUES = [
  HUE.pink,
  HUE.blue,
  HUE.pink,
  HUE.purple,
  HUE.green,
  HUE.blue,
  HUE.cyan,
  HUE.pink
];
function escapeXml$8(text) {
  return String(text ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
function toPercentNum(v) {
  const n = Number(String(v ?? "").replace("%", "").trim());
  return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 0;
}
function fmtPercent(v) {
  return `${v.toFixed(v % 1 === 0 ? 0 : 1)}%`;
}
function alpha(hex, a) {
  const m = /^#([0-9a-f]{6})$/i.exec(String(hex || "").trim());
  if (!m) return `rgba(255,255,255,${a})`;
  const int = parseInt(m[1], 16);
  const r = int >> 16 & 255;
  const g = int >> 8 & 255;
  const b = int & 255;
  return `rgba(${r},${g},${b},${a})`;
}
function usageHue(percent) {
  if (percent < 60) return HUE.green;
  if (percent < 85) return HUE.orange;
  return HUE.red;
}
function shade(hex, amt) {
  const m = /^#([0-9a-f]{6})$/i.exec(String(hex || "").trim());
  if (!m) return String(hex || "#ffffff");
  const int = parseInt(m[1], 16);
  const mix = (c) => amt >= 0 ? Math.round(c + (255 - c) * amt) : Math.round(c * (1 + amt));
  const hex2 = (c) => Math.max(0, Math.min(255, c)).toString(16).padStart(2, "0");
  return `#${hex2(mix(int >> 16 & 255))}${hex2(mix(int >> 8 & 255))}${hex2(mix(int & 255))}`;
}
function textWidth(text, fontSize) {
  let w = 0;
  for (const ch of String(text || "")) {
    w += /[\u2e80-\u9fff\uff00-\uffef]/.test(ch) ? fontSize : fontSize * 0.56;
  }
  return w;
}
function formatTraffic(bytes) {
  const v = Math.max(0, Number(bytes) || 0);
  if (v <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let i = 0;
  let n = v;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : n >= 10 ? 1 : 2)} ${units[i]}`;
}
function formatRate(bytesPerSec) {
  return `${formatTraffic(bytesPerSec)}/s`;
}
function fitText(text, fontSize, maxWidth) {
  const s = String(text ?? "").trim();
  if (!s || maxWidth <= 0) return s;
  if (textWidth(s, fontSize) <= maxWidth) return s;
  const dotW = textWidth("…", fontSize);
  let out = "";
  let w = 0;
  for (const ch of s) {
    const cw = textWidth(ch, fontSize);
    if (w + cw + dotW > maxWidth) break;
    out += ch;
    w += cw;
  }
  return `${out.trimEnd()}…`;
}
function mdiIcon(name, cx, cy, size, fill = "#ffffff") {
  const paths = MDI_ICON_PATHS[name];
  if (!paths || !paths.length) return "";
  const scale = size / MDI_ICON_VIEWBOX;
  const tx = cx - size / 2;
  const ty = cy - size / 2;
  const body = paths.map((d) => `<path d="${d}"/>`).join("");
  return `<g transform="translate(${tx.toFixed(2)} ${ty.toFixed(2)}) scale(${scale.toFixed(4)})" fill="${fill}">${body}</g>`;
}
function healthLabel(worst) {
  if (worst < 60) return "状态良好";
  if (worst < 85) return "负载偏高";
  return "负载告警";
}
function formatUptime(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const d = Math.floor(total / 86400);
  const h = Math.floor(total % 86400 / 3600);
  const m = Math.floor(total % 3600 / 60);
  const s = total % 60;
  const p2 = (n) => String(n).padStart(2, "0");
  if (d > 0) return `${d}天${p2(h)}时${p2(m)}分`;
  if (h > 0) return `${p2(h)}时${p2(m)}分`;
  if (m > 0) return `${p2(m)}分${p2(s)}秒`;
  return `${s}秒`;
}
function fetchUrlBuffer$3(url, timeoutMs = 2e4) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(
      url,
      { timeout: timeoutMs, headers: { "User-Agent": "MKbot-StatusSharp/2.0" } },
      (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          fetchUrlBuffer$3(res.headers.location, timeoutMs).then(resolve).catch(reject);
          return;
        }
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}`));
          res.resume();
          return;
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        res.on("end", () => resolve(Buffer.concat(chunks)));
        res.on("error", reject);
      }
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
  });
}
function decodeDataUrl(dataUrl) {
  const m = String(dataUrl || "").match(/^data:[^;]+;base64,(.+)$/i);
  if (!m) return null;
  try {
    return Buffer.from(m[1], "base64");
  } catch {
    return null;
  }
}
async function loadStatusBackground(backgroundImageUrl, bgLocalPath, pluginDir, pluginPath, dataPath) {
  const candidates = [];
  const push = (v) => {
    const s = String(v || "").trim();
    if (s && !candidates.includes(s)) candidates.push(s);
  };
  push(bgLocalPath);
  const roots = [
    path.join(String(dataPath || "").trim(), "默认资源", "image"),
    path.join(String(pluginPath || "").trim(), "data", "默认资源", "image"),
    path.join(String(pluginDir || "").trim(), "data", "默认资源", "image"),
    path.join(String(pluginDir || "").trim(), "默认资源", "image")
  ];
  for (const root of roots) {
    if (!String(root || "").trim()) continue;
    for (const name of LOCAL_BG_NAMES) push(path.join(root, name));
  }
  push(backgroundImageUrl);
  if (backgroundImageUrl !== STATUS_BG_REMOTE_URL) push(STATUS_BG_REMOTE_URL);
  for (const src of candidates) {
    try {
      if (/^data:/i.test(src)) {
        const buf = decodeDataUrl(src);
        if (buf && buf.length) return buf;
        continue;
      }
      if (/^file:\/\//i.test(src)) {
        const abs = fileURLToPath(src);
        if (fs.existsSync(abs)) return fs.readFileSync(abs);
        continue;
      }
      if (/^https?:\/\//i.test(src)) {
        const buf = await fetchUrlBuffer$3(src, 12e3);
        if (buf.length > 0) return buf;
        continue;
      }
      if (fs.existsSync(src)) return fs.readFileSync(src);
    } catch (_e) {
    }
  }
  return null;
}
const CARD_PAD = 26;
const CARD_GAP = 18;
const TITLE_BASE = 42;
const DASH_OFFSET = 16;
const BODY_TOP = 74;
const TOP_ROW_H = 44;
const TOP_ROW_GAP = 8;
const TOP_TITLE_W = 256;
const TOP_TAG_W = 136;
const ACC_WIDE_H = 84;
const ACC_GRID_H = 84;
const ACC_CARD_GAP = 14;
const ACC_CARD_PAD = 14;
const ACC_AV_WIDE = 52;
const ACC_AV_GRID = 52;
const ACC_CHIP_H = 22;
const ACC_CHIP_GAP = 6;
const DONUT_BLOCK_H = 130;
const DONUT_CY_IN_BLOCK = 59;
const FOOT_H = 34;
const FOOT_GAP = 10;
const MINI_R = 33;
const MINI_STROKE = 10;
const MINI_COL_GAP = 6;
const MINI_ICON = 30;
const MINI_NAME_GAP = 11;
const MINI_PCT_GAP = 21;
const MINI_SUB_GAP = 34;
const DISK_ROW_H = 52;
const DISK_ROW_STEP = 58;
const MAX_DISK_ROWS = 5;
const DISK_NAME_MIN_W = 46;
const DISK_NAME_MAX_W = 190;
const DISK_NAME_GAP = 18;
const DISK_RIGHT_RESERVE = 250;
const NET_FLOW_H = 124;
const NET_STAT_H = 60;
const NET_STAT_GAP = 12;
const ENV_CAPTION_H = 26;
const ENV_CHIP_H = 34;
const ENV_CHIP_STEP = 40;
const ENV_PROC_H = 28;
const ENV_PROC_STEP = 32;
const ENV_PROC_HEAD_H = 18;
const PROC_NAME_X = 118;
const PROC_PID_R = 186;
const ENV_GROUP_GAP = 20;
const ENV_GROUP_SPEC = [
  { kind: "chip", rows: 3 },
  { kind: "chip", rows: 2 },
  { kind: "chip", rows: 1 },
  { kind: "proc", rows: 3 }
];
function layoutEnvGroups(envY) {
  const groups = [];
  let y = envY + BODY_TOP;
  ENV_GROUP_SPEC.forEach((spec, i) => {
    const step = spec.kind === "chip" ? ENV_CHIP_STEP : ENV_PROC_STEP;
    const head = ENV_CAPTION_H + (spec.kind === "proc" ? ENV_PROC_HEAD_H : 0);
    const height = head + spec.rows * step;
    groups.push({ y, bodyY: y + head, rows: spec.rows, kind: spec.kind, height });
    y += height;
    if (i < ENV_GROUP_SPEC.length - 1) y += ENV_GROUP_GAP;
  });
  return { groups, height: y - envY + 12 };
}
function makeAccountCard(index, variant, x, y, w) {
  const size = variant === "wide" ? ACC_AV_WIDE : ACC_AV_GRID;
  const h = variant === "wide" ? ACC_WIDE_H : ACC_GRID_H;
  return {
    index,
    x,
    y,
    w,
    h,
    variant,
    // 头像在卡片内垂直居中（两种形态等高、头像同径）
    avatar: { x: x + ACC_CARD_PAD, y: y + (h - size) / 2, size }
  };
}
function planAccountCards(y, pad, cardW, count) {
  const twoCols = count >= 2;
  const cards = [];
  let cursor = y;
  let i = 0;
  if (!twoCols) {
    for (; i < count; i += 1) {
      cards.push(makeAccountCard(i, "wide", pad, cursor, cardW));
      cursor += ACC_WIDE_H + ACC_CARD_GAP;
    }
  } else {
    const halfW = (cardW - ACC_CARD_GAP) / 2;
    while (i < count) {
      if (count - i === 1) {
        cards.push(makeAccountCard(i, "wide", pad, cursor, cardW));
        cursor += ACC_WIDE_H + ACC_CARD_GAP;
        i += 1;
      } else {
        cards.push(makeAccountCard(i, "grid", pad, cursor, halfW));
        cards.push(makeAccountCard(i + 1, "grid", pad + halfW + ACC_CARD_GAP, cursor, halfW));
        cursor += ACC_GRID_H + ACC_CARD_GAP;
        i += 2;
      }
    }
  }
  return { cards, height: cards.length ? cursor - ACC_CARD_GAP - y : 0, twoCols };
}
function computeLayout(width, minHeight = 0, diskRowCount = 2, accountCount = 1, footerParts = []) {
  const pad = CARD_PAD;
  const gap = CARD_GAP;
  const cardW = width - pad * 2;
  const topY = 24;
  const titlePill = { x: pad, y: topY, w: TOP_TITLE_W, h: TOP_ROW_H, rx: TOP_ROW_H / 2 };
  const sentPill = { x: width - pad - TOP_TAG_W, y: topY, w: TOP_TAG_W, h: TOP_ROW_H, rx: TOP_ROW_H / 2 };
  const recvPill = {
    x: sentPill.x - TOP_ROW_GAP - TOP_TAG_W,
    y: topY,
    w: TOP_TAG_W,
    h: TOP_ROW_H,
    rx: TOP_ROW_H / 2
  };
  const count = Math.max(1, Math.floor(accountCount) || 1);
  const accountPlan = planAccountCards(topY + TOP_ROW_H + gap, pad, cardW, count);
  const accBottom = accountPlan.cards.length ? Math.max(...accountPlan.cards.map((c) => c.y + c.h)) : topY + TOP_ROW_H;
  const basic = { x: pad, y: accBottom + gap, w: cardW, h: BODY_TOP + DONUT_BLOCK_H + 12, rx: 28 };
  const donutInnerX = basic.x + 22;
  const donutInnerW = basic.w - 44;
  const donutColW = (donutInnerW - MINI_COL_GAP * 3) / 4;
  const basicDonuts = Array.from({ length: 4 }, (_, i) => ({
    cx: donutInnerX + donutColW / 2 + i * (donutColW + MINI_COL_GAP),
    cy: basic.y + BODY_TOP + DONUT_CY_IN_BLOCK,
    colW: donutColW
  }));
  const diskRows = Math.max(1, Math.min(MAX_DISK_ROWS, Math.floor(diskRowCount) || 1));
  const diskH = BODY_TOP + diskRows * DISK_ROW_STEP - (DISK_ROW_STEP - DISK_ROW_H) + 12;
  const disk = { x: pad, y: basic.y + basic.h + gap, w: cardW, h: diskH, rx: 28 };
  const netH = BODY_TOP + NET_FLOW_H + NET_STAT_GAP + NET_STAT_H + 14;
  const net = { x: pad, y: disk.y + disk.h + gap, w: cardW, h: netH, rx: 28 };
  const envY = net.y + net.h + gap;
  const envLayout = layoutEnvGroups(envY);
  const env = { x: pad, y: envY, w: cardW, h: envLayout.height, rx: 28 };
  const footTexts = footerParts.map((t) => String(t || "").trim()).filter(Boolean);
  const footWidths = footTexts.map((t) => Math.max(74, 26 + textWidth(t, 12.5) + 26));
  const footTotal = footWidths.reduce((a, b) => a + b, 0) + Math.max(0, footTexts.length - 1) * FOOT_GAP;
  const footH = footTexts.length ? FOOT_H : 0;
  const height = Math.max(minHeight, env.y + env.h + 12 + footH + 22);
  const footerBubbles = [];
  if (footH) {
    let fx = (width - footTotal) / 2;
    for (const w of footWidths) {
      footerBubbles.push({ x: fx, y: height - 22 - FOOT_H, w, h: FOOT_H, rx: FOOT_H / 2 });
      fx += w + FOOT_GAP;
    }
  }
  return {
    width,
    height,
    pad,
    cardW,
    titlePill,
    recvPill,
    sentPill,
    accountCards: accountPlan.cards,
    accountTwoCols: accountPlan.twoCols,
    basic,
    basicDonuts,
    disk,
    diskRows,
    net,
    env,
    envGroups: envLayout.groups,
    footerBubbles,
    footerTexts: footTexts,
    glass: [
      titlePill,
      recvPill,
      sentPill,
      ...accountPlan.cards.map((c) => ({ x: c.x, y: c.y, w: c.w, h: c.h, rx: 22 })),
      basic,
      disk,
      net,
      env,
      ...footerBubbles
    ],
    footerY: footerBubbles.length ? footerBubbles[0].y + FOOT_H / 2 + 4.5 : height - 22 - FOOT_H / 2 + 4.5
  };
}
computeLayout(STATUS_CARD_WIDTH).height;
function glassCard(r, _hue, idx) {
  const rimId = `gRim${idx}`;
  return [
    `<defs>`,
    // 玻璃边对环境光的包裹：顶部最亮，两侧收敛，底部回亮
    `<linearGradient id="${rimId}" x1="0" y1="0" x2="0.25" y2="1">`,
    `<stop offset="0%" stop-color="rgba(255,255,255,0.96)"/>`,
    `<stop offset="34%" stop-color="rgba(255,255,255,0.46)"/>`,
    `<stop offset="66%" stop-color="rgba(255,255,255,0.30)"/>`,
    `<stop offset="100%" stop-color="rgba(255,255,255,0.72)"/>`,
    `</linearGradient>`,
    `</defs>`,
    `<rect x="${r.x + 0.7}" y="${r.y + 0.7}" width="${r.w - 1.4}" height="${r.h - 1.4}" rx="${r.rx}" ry="${r.rx}" fill="none" stroke="url(#${rimId})" stroke-width="1.4"/>`
  ].join("\n");
}
function iconMark(x, y, size, hue, icon) {
  return mdiIcon(icon, x + size / 2, y + size / 2, size, shade(hue, -0.14));
}
function tileFlat(x, y, w, h, rx, hue, on = true) {
  const fill = on ? alpha(shade(hue, 0.8), 0.5) : "rgba(255,255,255,0.4)";
  const stroke = on ? alpha(hue, 0.36) : "rgba(43,36,64,0.14)";
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" ry="${rx}" fill="${fill}" stroke="${stroke}" stroke-width="1.3"/>`;
}
function sectionTitle(x, y, w, title, hint, hue, icon) {
  const badge = 25;
  const textX = x + badge + 9;
  const titleW = textWidth(title, 20);
  return [
    iconMark(x, y - 19, badge, hue, icon),
    // 马克笔高亮：扁平色块压在标题文字下缘
    `<rect x="${textX - 2}" y="${y - 6}" width="${titleW + 6}" height="9" rx="4.5" fill="${alpha(hue, 0.34)}"/>`,
    `<text x="${textX}" y="${y}" font-family="${FONT}" font-size="20" font-weight="bold" fill="${INK}">${escapeXml$8(title)}</text>`,
    // 标题后的小星星：二次元点缀
    sparkle(textX + titleW + 13, y - 13, 11, hue, 0.7),
    hint ? `<text x="${x + w}" y="${y}" text-anchor="end" font-family="${FONT}" font-size="12.5" fill="${INK_SOFT}">${escapeXml$8(hint)}</text>` : "",
    `<line x1="${x}" y1="${y + DASH_OFFSET}" x2="${x + w}" y2="${y + DASH_OFFSET}" stroke="${alpha(hue, 0.5)}" stroke-width="2" stroke-linecap="round" stroke-dasharray="${DASH_PATTERN}"/>`
  ].join("\n");
}
function progressBar(x, y, w, h, percent, hue) {
  const fillW = Math.max(h, Math.min(w, w * percent / 100));
  return [
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="rgba(43,36,64,0.09)" stroke="${alpha(hue, 0.26)}" stroke-width="1.2"/>`,
    `<rect x="${x}" y="${y}" width="${fillW}" height="${h}" rx="${h / 2}" fill="${hue}"/>`
  ].join("\n");
}
function sparkle(cx, cy, size, color, opacity = 1) {
  const g = mdiIcon("star-four-points", cx, cy, size, color);
  return opacity >= 1 ? g : `<g opacity="${opacity}">${g}</g>`;
}
function miniDonut(cx, cy, colW, percent, hue, name, sub, icon) {
  const strokeW = MINI_STROKE;
  const r = MINI_R - strokeW / 2;
  const circ = 2 * Math.PI * r;
  const arc = circ * (Math.max(0, Math.min(100, percent)) / 100);
  const dash = `${arc} ${Math.max(0, circ - arc)}`;
  const rot = `rotate(-90 ${cx} ${cy})`;
  const innerR = r - strokeW / 2 - 1;
  const maxW = colW - 4;
  return [
    // 组件正上方：中文名
    `<text x="${cx}" y="${cy - MINI_R - MINI_NAME_GAP}" text-anchor="middle" font-family="${FONT}" font-size="15" font-weight="bold" fill="${INK}">${escapeXml$8(fitText(name, 15, maxW))}</text>`,
    // 环体：淡底 + 轨道 + 进度弧，环内只放一枚放大的图标
    `<circle cx="${cx}" cy="${cy}" r="${innerR}" fill="#ffffff" fill-opacity="0.5"/>`,
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${alpha(hue, 0.22)}" stroke-width="${strokeW}"/>`,
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${hue}" stroke-width="${strokeW}"
      stroke-dasharray="${dash}" stroke-linecap="round" transform="${rot}"/>`,
    mdiIcon(icon, cx, cy, MINI_ICON, shade(hue, -0.06)),
    // 组件正下方：百分比 + 说明
    `<text x="${cx}" y="${cy + MINI_R + MINI_PCT_GAP}" text-anchor="middle" font-family="${FONT}" font-size="17" font-weight="bold" fill="${shade(hue, -0.32)}">${fmtPercent(percent)}</text>`,
    `<text x="${cx}" y="${cy + MINI_R + MINI_SUB_GAP}" text-anchor="middle" font-family="${FONT}" font-size="11" fill="${INK_SOFT}">${escapeXml$8(fitText(sub, 11, maxW))}</text>`
  ].join("\n");
}
function flatDot(cx, cy, r, hue, on = true) {
  const fill = on ? hue : "rgba(43,36,64,0.28)";
  return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}"/>`;
}
function paramChip(x, y, w, hue, label, value) {
  const h = ENV_CHIP_H;
  const cy = y + h / 2;
  const labelW = textWidth(label, 12.5);
  const valueMaxW = w - 12 - (26 + labelW) - 12;
  return [
    tileFlat(x, y, w, h, 12, hue),
    flatDot(x + 14, cy, 4.6, hue),
    `<text x="${x + 26}" y="${cy + 4.5}" font-family="${FONT}" font-size="12.5" fill="${INK_SOFT}">${escapeXml$8(label)}</text>`,
    `<text x="${x + w - 12}" y="${cy + 4.5}" text-anchor="end" font-family="${FONT}" font-size="13" font-weight="bold" fill="${INK}">${escapeXml$8(fitText(value, 13, valueMaxW))}</text>`
  ].join("\n");
}
function groupCaption(x, y, w, hue, text, icon, hint = "") {
  const badge = 18;
  return [
    iconMark(x, y + 2, badge, hue, icon),
    `<text x="${x + badge + 7}" y="${y + 16}" font-family="${FONT}" font-size="13.5" font-weight="bold" fill="${INK}">${escapeXml$8(text)}</text>`,
    hint ? `<text x="${x + w}" y="${y + 16}" text-anchor="end" font-family="${FONT}" font-size="11" fill="${INK_SOFT}">${escapeXml$8(hint)}</text>` : ""
  ].join("\n");
}
function keyProcRow(x, y, w, hue, row) {
  const h = ENV_PROC_H;
  const cy = y + h / 2;
  const on = row.running !== false;
  const nameX = x + PROC_NAME_X;
  return [
    tileFlat(x, y, w, h, 11, hue, on),
    flatDot(x + 14, cy, 4.4, hue, on),
    `<text x="${x + 26}" y="${cy + 4.5}" font-family="${FONT}" font-size="12.5" font-weight="bold" fill="${INK}">${escapeXml$8(fitText(row.label || "-", 12.5, PROC_NAME_X - 34))}</text>`,
    `<text x="${nameX}" y="${cy + 4.5}" font-family="${FONT}" font-size="11.5" fill="${INK_SOFT}">${escapeXml$8(fitText(row.name || "-", 11.5, w - PROC_PID_R - 46 - PROC_NAME_X))}</text>`,
    `<text x="${x + w - PROC_PID_R}" y="${cy + 4.5}" text-anchor="end" font-family="${FONT}" font-size="11.5" fill="${INK_SOFT}">${escapeXml$8(String(row.pid || "—"))}</text>`,
    `<text x="${x + w - 92}" y="${cy + 4.5}" text-anchor="end" font-family="${FONT}" font-size="12.5" font-weight="bold" fill="${INK}">${escapeXml$8(String(row.memoryMB || "—"))}${on ? " MB" : ""}</text>`,
    `<text x="${x + w - 12}" y="${cy + 4.5}" text-anchor="end" font-family="${FONT}" font-size="12" fill="${INK_SOFT}">${escapeXml$8(String(row.cpuPercent || "—"))}${on ? "%" : ""}</text>`
  ].join("\n");
}
function isDriveLetter(name) {
  return /^[A-Za-z]:$/.test(String(name || "").trim());
}
function buildDiskRows(opts) {
  const vols = (opts.diskVolumes || []).filter((v) => v && Number(v.total) > 0);
  if (!vols.length) {
    return [
      {
        name: "系统磁盘",
        sub: "全部分区汇总",
        percent: toPercentNum(opts.diskUsagePercent),
        usedText: String(opts.diskUsedGB || "-"),
        totalText: String(opts.diskTotalGB || "-")
      }
    ];
  }
  const single = (v) => {
    const total2 = Math.max(0, Number(v.total) || 0);
    const used2 = Math.max(0, Math.min(total2, Number(v.used) || Math.max(0, total2 - (Number(v.free) || 0))));
    return {
      name: String(v.name || "-"),
      sub: String(v.label || "").trim() || "本地磁盘",
      percent: total2 > 0 ? used2 / total2 * 100 : 0,
      usedText: formatTraffic(used2),
      totalText: formatTraffic(total2)
    };
  };
  if (vols.length <= MAX_DISK_ROWS) return vols.map(single);
  const head = vols.slice(0, MAX_DISK_ROWS - 1).map(single);
  const rest = vols.slice(MAX_DISK_ROWS - 1);
  const total = rest.reduce((s, v) => s + Math.max(0, Number(v.total) || 0), 0);
  const used = rest.reduce(
    (s, v) => s + Math.max(0, Number(v.used) || Math.max(0, (Number(v.total) || 0) - (Number(v.free) || 0))),
    0
  );
  const names = rest.map((v) => String(v.name || "").trim()).filter(Boolean);
  const joined = names.every(isDriveLetter) ? `${names.map((n) => n.replace(/:$/, "")).join("")}:` : names.join(" ");
  head.push({
    name: `其余磁盘(${joined})`,
    sub: `合并 ${rest.length} 个磁盘`,
    percent: total > 0 ? used / total * 100 : 0,
    usedText: formatTraffic(used),
    totalText: formatTraffic(total)
  });
  return head;
}
function diskRow(x, y, w, hue, row, nameColW) {
  const h = DISK_ROW_H;
  const cy = y + h / 2;
  const nameX = x + 16;
  const barX = nameX + nameColW + DISK_NAME_GAP;
  const barW = Math.max(80, w - (barX - x) - DISK_RIGHT_RESERVE);
  const pct = Math.max(0, Math.min(100, row.percent));
  const rowHue = usageHue(pct);
  return [
    tileFlat(x, y, w, h, 14, hue),
    `<text x="${nameX}" y="${cy - 3}" font-family="${FONT}" font-size="15" font-weight="bold" fill="${INK}">${escapeXml$8(fitText(row.name, 15, nameColW))}</text>`,
    `<text x="${nameX}" y="${cy + 14}" font-family="${FONT}" font-size="11" fill="${INK_SOFT}">${escapeXml$8(fitText(row.sub, 11, nameColW))}</text>`,
    progressBar(barX, cy - 7, barW, 14, pct, rowHue),
    `<text x="${barX + barW + 14}" y="${cy + 5}" font-family="${FONT}" font-size="15" font-weight="bold" fill="${shade(rowHue, -0.32)}">${fmtPercent(pct)}</text>`,
    `<text x="${x + w - 14}" y="${cy + 5}" text-anchor="end" font-family="${FONT}" font-size="12" fill="${INK_SOFT}">已用 <tspan font-size="12.5" font-weight="bold" fill="${INK}">${escapeXml$8(row.usedText)}</tspan> · 共 <tspan font-size="12.5" font-weight="bold" fill="${INK}">${escapeXml$8(row.totalText)}</tspan></text>`
  ].join("\n");
}
function diskNameColWidth(rows) {
  let need = 0;
  for (const r of rows) {
    need = Math.max(need, textWidth(r.name, 15), textWidth(r.sub, 11));
  }
  return Math.max(DISK_NAME_MIN_W, Math.min(DISK_NAME_MAX_W, Math.ceil(need) + 6));
}
function netNode(cx, cy, r, hue, icon, caption) {
  return [
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${alpha(shade(hue, 0.74), 0.6)}" stroke="${alpha(hue, 0.5)}" stroke-width="1.6"/>`,
    mdiIcon(icon, cx, cy, r * 1.08, shade(hue, -0.12)),
    `<text x="${cx}" y="${cy + r + 18}" text-anchor="middle" font-family="${FONT}" font-size="12" font-weight="bold" fill="${INK}">${escapeXml$8(caption)}</text>`
  ].join("\n");
}
function netLane(x0, x1, cy, h, hue, dir, rate, label, value, labelAbove) {
  const len = Math.max(48, x1 - x0);
  const live = rate > 0;
  const pw = 15;
  const ph = h - 7;
  const busy = Math.min(1, rate / (2 * 1024 * 1024));
  const count = live ? 3 + Math.round(busy * 5) : 0;
  const span = Math.max(0, len - 22 - pw);
  const packets = [];
  for (let i = 0; i < count; i += 1) {
    const t = count === 1 ? 1 : i / (count - 1);
    const px = x0 + 11 + span * (dir === "right" ? t : 1 - t);
    const op = 0.3 + 0.7 * t;
    packets.push(
      `<rect x="${px.toFixed(1)}" y="${(cy - ph / 2).toFixed(1)}" width="${pw}" height="${ph}" rx="${(ph / 2).toFixed(1)}" fill="${hue}" fill-opacity="${op.toFixed(2)}"/>`
    );
  }
  const tip = dir === "right" ? x1 + 13 : x0 - 13;
  const base = dir === "right" ? x1 + 3 : x0 - 3;
  const labelY = labelAbove ? cy - h / 2 - 9 : cy + h / 2 + 19;
  return [
    `<rect x="${x0}" y="${cy - h / 2}" width="${len}" height="${h}" rx="${h / 2}" fill="${live ? alpha(hue, 0.18) : "rgba(43,36,64,0.07)"}" stroke="${live ? alpha(hue, 0.4) : "rgba(43,36,64,0.14)"}" stroke-width="1.3"/>`,
    ...packets,
    `<path d="M${tip} ${cy} L${base} ${cy - 7} L${base} ${cy + 7} Z" fill="${live ? hue : "rgba(43,36,64,0.2)"}"/>`,
    `<text x="${(x0 + x1) / 2}" y="${labelY}" text-anchor="middle" font-family="${FONT}" font-size="11.5" fill="${INK_SOFT}">${escapeXml$8(label)} <tspan font-size="14.5" font-weight="bold" fill="${shade(hue, -0.3)}">${escapeXml$8(value)}</tspan></text>`
  ].join("\n");
}
function netFlowScene(x, y, w, h, hue, rxRate, txRate, rxText, txText) {
  const nodeR = 28;
  const nodeCy = y + 56;
  const leftCx = x + 64;
  const rightCx = x + w - 64;
  const laneX0 = leftCx + nodeR + 20;
  const laneX1 = rightCx - nodeR - 20;
  return [
    tileFlat(x, y, w, h, 18, hue),
    netNode(leftCx, nodeCy, nodeR, HUE.blue, "cloud-outline", "互联网"),
    netNode(rightCx, nodeCy, nodeR, HUE.pink, "robot-happy", "本机"),
    sparkle(leftCx - nodeR - 7, nodeCy - nodeR + 2, 11, HUE.cyan, 0.75),
    sparkle(rightCx + nodeR + 7, nodeCy + nodeR - 2, 10, HUE.yellow, 0.8),
    netLane(laneX0, laneX1, nodeCy - 19, 15, HUE.green, "right", rxRate, "下行", rxText, true),
    netLane(laneX0, laneX1, nodeCy + 19, 15, HUE.orange, "left", txRate, "上行", txText, false)
  ].join("\n");
}
function netStat(x, y, w, h, hue, icon, label, value) {
  const cx = x + w / 2;
  const iconSize = 15;
  const gw = iconSize + 6 + textWidth(label, 12);
  const gx = cx - gw / 2;
  return [
    tileFlat(x, y, w, h, 14, hue),
    mdiIcon(icon, gx + iconSize / 2, y + 20, iconSize, shade(hue, -0.1)),
    `<text x="${gx + iconSize + 6}" y="${y + 24.5}" font-family="${FONT}" font-size="12" fill="${INK_SOFT}">${escapeXml$8(label)}</text>`,
    `<text x="${cx}" y="${y + 47}" text-anchor="middle" font-family="${FONT}" font-size="17" font-weight="bold" fill="${shade(hue, -0.34)}">${escapeXml$8(fitText(value, 17, w - 20))}</text>`
  ].join("\n");
}
function normalizeStatusAccounts(opts) {
  const list = Array.isArray(opts.accounts) ? opts.accounts : [];
  const cleaned = list.filter((a) => a && String(a.name || "").trim()).map((a) => ({
    qq: String(a.qq || "").trim(),
    appId: String(a.appId || "").trim(),
    name: String(a.name || "").trim(),
    avatar: String(a.avatar || "").trim(),
    typeText: String(a.typeText || "").trim(),
    directionText: String(a.directionText || "").trim(),
    statusText: String(a.statusText || "").trim(),
    phase: String(a.phase || "").trim(),
    connected: a.connected !== false
  }));
  if (cleaned.length) return cleaned;
  return [
    {
      qq: String(opts.qq || "").trim(),
      appId: "",
      name: String(opts.name || "").trim() || "Bot",
      avatar: "",
      typeText: "",
      directionText: "",
      statusText: "",
      // 兜底单账号来自「正在发消息的这个账号」，必定是已连接
      phase: "connected",
      connected: true
    }
  ];
}
function accountChips(account) {
  const chips = [];
  const typeText = String(account.typeText || "").trim();
  const dirText = String(account.directionText || "").trim();
  if (typeText) chips.push({ label: typeText, hue: HUE.blue });
  if (dirText) chips.push({ label: dirText, hue: HUE.purple });
  return chips;
}
function accountStrokeHue(account) {
  const phase = String(account.phase || "").toLowerCase();
  if (phase === "connected") return HUE.green;
  if (phase === "failed") return HUE.red;
  if (phase === "reconnecting" || phase === "connecting" || phase === "waiting") return HUE.yellow;
  if (phase === "disabled") return "#ffffff";
  if (account.connected === false) return HUE.red;
  if (account.connected === true) return HUE.green;
  return "#ffffff";
}
function bubbleChip(x, y, w, h, hue, label, spacing = 0) {
  const cy = y + h / 2;
  const spacingAttr = spacing > 0.05 ? ` letter-spacing="${spacing.toFixed(2)}"` : "";
  return [
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="${alpha(shade(hue, 0.76), 0.58)}" stroke="${alpha(hue, 0.42)}" stroke-width="1.1"/>`,
    `<circle cx="${x + 11}" cy="${cy}" r="2.8" fill="${hue}"/>`,
    `<text x="${x + 20}" y="${cy + 3.8}"${spacingAttr} font-family="${FONT}" font-size="11" font-weight="bold" fill="${shade(hue, -0.4)}">${escapeXml$8(label)}</text>`
  ].join("\n");
}
const FOOTER_HUES = [HUE.blue, HUE.pink, HUE.green];
function accountCardSvg(card, account, hue) {
  const av = card.avatar;
  const avCx = av.x + av.size / 2;
  const avCy = av.y + av.size / 2;
  const avR = av.size / 2;
  const wide = card.variant === "wide";
  const nameFont = wide ? 16.5 : 14.5;
  const idFont = wide ? 12 : 11.5;
  const idRaw = account.qq ? `QQ · ${account.qq}` : account.appId ? `AppID · ${account.appId}` : "";
  const chips = accountChips(account);
  const chipTextW = chips.map((c) => textWidth(c.label, 11));
  const maxTextW = chipTextW.length ? Math.max(...chipTextW) : 0;
  const chipW = maxTextW ? maxTextW + 32 : 0;
  const chipRows = wide ? 1 : chips.length;
  const chipBlockH = chipRows * ACC_CHIP_H + Math.max(0, chipRows - 1) * ACC_CHIP_GAP;
  const textX = av.x + av.size + 14;
  const textMaxW = Math.max(40, card.x + card.w - 14 - (chipW ? chipW + 14 : 0) - textX);
  const nameY = card.y + card.h / 2 - 6;
  const idY = nameY + 20;
  const nameText = fitText(String(account.name || "Bot"), nameFont, textMaxW);
  const idText = idRaw ? fitText(idRaw, idFont, textMaxW) : "";
  const stroke = accountStrokeHue(account);
  const strokeW = 2.6;
  const out = [
    `<circle cx="${avCx}" cy="${avCy}" r="${avR + strokeW / 2}" fill="none" stroke="${stroke}" stroke-width="${strokeW}"/>`,
    `<text x="${textX}" y="${nameY}" font-family="${FONT}" font-size="${nameFont}" font-weight="bold" fill="${INK}">${escapeXml$8(nameText)}</text>`
  ];
  if (idText) {
    out.push(
      `<text x="${textX}" y="${idY}" font-family="${FONT}" font-size="${idFont}" fill="${INK_SOFT}">${escapeXml$8(idText)}</text>`
    );
  }
  if (chips.length && chipW > 0) {
    const rightX = card.x + card.w - 14;
    const spacingOf = (i) => {
      const len = chips[i].label.length;
      if (len < 2 || maxTextW <= 0) return 0;
      return Math.max(0, (maxTextW - chipTextW[i]) / len);
    };
    if (wide) {
      const total = chips.length * chipW + (chips.length - 1) * ACC_CHIP_GAP;
      const startX = rightX - total;
      const chipY = card.y + card.h / 2 - ACC_CHIP_H / 2;
      chips.forEach((c, i) => {
        out.push(bubbleChip(startX + i * (chipW + ACC_CHIP_GAP), chipY, chipW, ACC_CHIP_H, c.hue, c.label, spacingOf(i)));
      });
    } else {
      const blockTop = card.y + (card.h - chipBlockH) / 2;
      chips.forEach((c, i) => {
        out.push(bubbleChip(rightX - chipW, blockTop + i * (ACC_CHIP_H + ACC_CHIP_GAP), chipW, ACC_CHIP_H, c.hue, c.label, spacingOf(i)));
      });
    }
  }
  return out.filter(Boolean).join("\n");
}
function buildStatusOverlaySvg(layout, opts, customText) {
  const ink = resolveSharpTextFill(customText, INK);
  const cpuPct = toPercentNum(opts.cpuUsagePercent);
  const memPct = toPercentNum(opts.memoryUsagePercent);
  const diskPct = toPercentNum(opts.diskUsagePercent);
  const worst = Math.max(cpuPct, memPct, diskPct);
  const parts = [];
  layout.glass.forEach((rect, i) => parts.push(glassCard(rect, CARD_HUES[i] || HUE.pink, i)));
  const tp = layout.titlePill;
  const tpCy = tp.y + tp.h / 2;
  const logoSize = 27;
  const titleText = "MKbot";
  const titleX = tp.x + 14 + logoSize + 9;
  parts.push(
    iconMark(tp.x + 14, tpCy - logoSize / 2, logoSize, HUE.pink, "robot-happy"),
    `<text x="${titleX}" y="${tpCy + 7}" font-family="${FONT}" font-size="19" font-weight="bold" fill="${ink}">${titleText}</text>`
  );
  const verFont = 12;
  const verAvail = tp.x + tp.w - 14 - (titleX + textWidth(titleText, 19) + 10);
  const verText = fitText(`v${String(opts.pluginVersion || "").replace(/^v/i, "") || "-"}`, verFont, Math.max(32, verAvail - 20));
  const verW = Math.max(52, 20 + textWidth(verText, verFont));
  const verX = tp.x + tp.w - 14 - verW;
  const verY = tpCy - 11;
  parts.push(
    `<rect x="${verX}" y="${verY}" width="${verW}" height="22" rx="11" fill="${alpha(HUE.purple, 0.2)}" stroke="${alpha(HUE.purple, 0.5)}" stroke-width="1.3"/>`,
    `<text x="${verX + verW / 2}" y="${tpCy + 4.5}" text-anchor="middle" font-family="${FONT}" font-size="${verFont}" font-weight="bold" fill="${shade(HUE.purple, -0.42)}">${escapeXml$8(verText)}</text>`
  );
  const recvText = opts.recvCount == null ? "—" : String(Math.max(0, Math.floor(opts.recvCount)));
  const sentText = opts.sentCount == null ? "—" : String(Math.max(0, Math.floor(opts.sentCount)));
  for (const t of [
    { rect: layout.recvPill, hue: HUE.green, icon: "arrow-down-bold", label: "接收", value: recvText },
    { rect: layout.sentPill, hue: HUE.orange, icon: "arrow-up-bold", label: "发送", value: sentText }
  ]) {
    const cy = t.rect.y + t.rect.h / 2;
    const iconSize = 17;
    const tagFont = 14.5;
    const gap = 8;
    const withLabel = iconSize + gap + textWidth(t.label, tagFont) + gap + textWidth(t.value, tagFont) <= t.rect.w - 26;
    const contentW = iconSize + gap + (withLabel ? textWidth(t.label, tagFont) + gap : 0) + textWidth(t.value, tagFont);
    const startX = t.rect.x + (t.rect.w - contentW) / 2;
    parts.push(
      `<rect x="${t.rect.x}" y="${t.rect.y}" width="${t.rect.w}" height="${t.rect.h}" rx="${t.rect.rx}" fill="${alpha(shade(t.hue, 0.7), 0.5)}" stroke="${alpha(t.hue, 0.5)}" stroke-width="1.3"/>`,
      mdiIcon(t.icon, startX + iconSize / 2, cy, iconSize, alpha(t.hue, 0.95)),
      withLabel ? `<text x="${startX + iconSize + gap}" y="${cy + 5}" font-family="${FONT}" font-size="${tagFont}" fill="${shade(t.hue, -0.28)}">${escapeXml$8(t.label)}</text>` : "",
      `<text x="${startX + iconSize + gap + (withLabel ? textWidth(t.label, tagFont) + gap : 0)}" y="${cy + 5}" font-family="${FONT}" font-size="${tagFont}" font-weight="bold" fill="${shade(t.hue, -0.45)}">${escapeXml$8(t.value)}</text>`
    );
  }
  const accounts = normalizeStatusAccounts(opts);
  accounts.forEach((acc, i) => {
    const card = layout.accountCards.find((c) => c.index === i);
    if (!card) return;
    parts.push(accountCardSvg(card, acc));
  });
  const bcs = layout.basic;
  parts.push(sectionTitle(bcs.x + 28, bcs.y + TITLE_BASE, bcs.w - 56, "基本数据", "实时负载", HUE.purple, "database"));
  const miniCols = [
    { hue: HUE.blue, pct: cpuPct, name: "CPU", sub: `${opts.cpuCount ?? 0} 核心`, icon: "chip" },
    { hue: HUE.purple, pct: memPct, name: "内存", sub: `共 ${opts.totalMemoryGB || "-"}`, icon: "memory" },
    { hue: HUE.green, pct: diskPct, name: "磁盘", sub: `共 ${opts.diskTotalGB || "-"}`, icon: "harddisk" },
    { hue: usageHue(worst), pct: worst, name: "健康度", sub: healthLabel(worst), icon: "speedometer" }
  ];
  layout.basicDonuts.forEach((slot, i) => {
    const g = miniCols[i];
    if (!g) return;
    parts.push(miniDonut(slot.cx, slot.cy, slot.colW, g.pct, g.hue, g.name, g.sub, g.icon));
  });
  const dk = layout.disk;
  const diskRowsData = buildDiskRows(opts).slice(0, MAX_DISK_ROWS);
  const diskNameW = diskNameColWidth(diskRowsData);
  const volCount = (opts.diskVolumes || []).filter((v) => v && Number(v.total) > 0).length;
  const diskHint = volCount > 0 ? `共 ${volCount} 个 · 总占用 ${fmtPercent(diskPct)}` : `总占用 ${fmtPercent(diskPct)}`;
  parts.push(sectionTitle(dk.x + 28, dk.y + TITLE_BASE, dk.w - 56, "磁盘储存", diskHint, HUE.green, "harddisk"));
  diskRowsData.forEach((row, i) => {
    parts.push(diskRow(dk.x + 22, dk.y + BODY_TOP + i * DISK_ROW_STEP, dk.w - 44, HUE.green, row, diskNameW));
  });
  const nt = layout.net;
  const netOk = opts.netAvailable !== false;
  const rxRate = Math.max(0, Number(opts.netRxRate) || 0);
  const txRate = Math.max(0, Number(opts.netTxRate) || 0);
  const rxTotal = Math.max(0, Number(opts.netRxTotal) || 0);
  const txTotal = Math.max(0, Number(opts.netTxTotal) || 0);
  const netHint = netOk ? `网卡 ${fitText(String(opts.netInterface || "主网卡"), 12.5, 210)}` : "网卡数据不可用";
  parts.push(sectionTitle(nt.x + 28, nt.y + TITLE_BASE, nt.w - 56, "网络数据", netHint, HUE.blue, "lan-connect"));
  const netX = nt.x + 22;
  const netW = nt.w - 44;
  parts.push(
    netFlowScene(
      netX,
      nt.y + BODY_TOP,
      netW,
      NET_FLOW_H,
      HUE.blue,
      netOk ? rxRate : 0,
      netOk ? txRate : 0,
      netOk ? formatRate(rxRate) : "—",
      netOk ? formatRate(txRate) : "—"
    )
  );
  const netStatY = nt.y + BODY_TOP + NET_FLOW_H + NET_STAT_GAP;
  const netStatW = (netW - NET_STAT_GAP * 2) / 3;
  [
    { hue: HUE.green, icon: "download", label: "总接收", value: netOk ? formatTraffic(rxTotal) : "—" },
    { hue: HUE.orange, icon: "upload", label: "总发送", value: netOk ? formatTraffic(txTotal) : "—" },
    {
      hue: HUE.purple,
      icon: "swap-vertical",
      label: "总流量",
      value: netOk ? formatTraffic(rxTotal + txTotal) : "—"
    }
  ].forEach((s, i) => {
    parts.push(
      netStat(
        netX + i * (netStatW + NET_STAT_GAP),
        netStatY,
        netStatW,
        NET_STAT_H,
        s.hue,
        s.icon,
        s.label,
        s.value
      )
    );
  });
  const env = layout.env;
  parts.push(sectionTitle(env.x + 28, env.y + TITLE_BASE, env.w - 56, "运行环境", "", HUE.cyan, "server-network"));
  const gridX = env.x + 24;
  const gridW = env.w - 48;
  const colGap = 14;
  const colW = (gridW - colGap) / 2;
  const groups = layout.envGroups;
  const chipGroups = [
    {
      caption: "系统与硬件",
      hue: HUE.cyan,
      icon: "monitor-dashboard",
      items: [
        { hue: HUE.cyan, label: "操作系统", value: `${opts.type || "-"} · ${opts.arch || "-"}` },
        { hue: HUE.blue, label: "主机名称", value: String(opts.hostname || "-") },
        { hue: HUE.purple, label: "处理器", value: String(opts.cpuModel || "-"), full: true },
        { hue: HUE.orange, label: "CPU 负载", value: fmtPercent(cpuPct) },
        { hue: HUE.green, label: "CPU 核心", value: `${opts.cpuCount ?? 0} 核` }
      ]
    },
    {
      caption: "版本与框架",
      hue: HUE.pink,
      icon: "puzzle",
      items: [
        { hue: HUE.pink, label: "插件版本", value: `MKbot ${opts.pluginVersion || "-"}` },
        { hue: HUE.yellow, label: "运行框架", value: String(opts.frameworkName || "-") },
        { hue: HUE.green, label: "Node", value: String(opts.nodeVersion || "-") },
        { hue: HUE.red, label: "插件内存", value: `${opts.processMemoryMB || "-"} MB` }
      ]
    },
    {
      caption: "运行时长",
      hue: HUE.blue,
      icon: "clock-time-four",
      items: [
        { hue: HUE.blue, label: "插件运行", value: formatUptime(opts.pluginUptimeSec) },
        { hue: HUE.cyan, label: "系统运行", value: formatUptime(opts.systemUptimeSec) }
      ]
    }
  ];
  groups.forEach((g, i) => {
    if (i === 0) return;
    const lineY = g.y - ENV_GROUP_GAP / 2;
    parts.push(
      `<line x1="${gridX}" y1="${lineY}" x2="${gridX + gridW}" y2="${lineY}" stroke="rgba(36,31,51,0.16)" stroke-width="1.6" stroke-linecap="round" stroke-dasharray="${DASH_PATTERN}"/>`
    );
  });
  chipGroups.forEach((group, gi) => {
    const box = groups[gi];
    if (!box) return;
    parts.push(groupCaption(gridX, box.y, gridW, group.hue, group.caption, group.icon, group.hint || ""));
    let slot = 0;
    for (const item of group.items) {
      const row = Math.floor(slot / 2);
      const col = slot % 2;
      const y = box.bodyY + row * ENV_CHIP_STEP;
      if (item.full) {
        const fullY = box.bodyY + (col === 0 ? row : row + 1) * ENV_CHIP_STEP;
        parts.push(paramChip(gridX, fullY, gridW, item.hue, item.label, item.value));
        slot = (col === 0 ? row + 1 : row + 2) * 2;
        continue;
      }
      parts.push(paramChip(gridX + col * (colW + colGap), y, colW, item.hue, item.label, item.value));
      slot += 1;
    }
  });
  const procBox = groups[groups.length - 1];
  if (procBox) {
    parts.push(groupCaption(gridX, procBox.y, gridW, HUE.orange, "关键进程", "chart-box", ""));
    const headY = procBox.bodyY - 6;
    const colHead = `font-family="${FONT}" font-size="11" font-weight="bold" fill="rgba(43,36,64,0.86)"`;
    parts.push(
      `<text x="${gridX + 26}" y="${headY}" ${colHead}>组件</text>`,
      `<text x="${gridX + PROC_NAME_X}" y="${headY}" ${colHead}>进程名</text>`,
      `<text x="${gridX + gridW - PROC_PID_R}" y="${headY}" text-anchor="end" ${colHead}>PID</text>`,
      `<text x="${gridX + gridW - 92}" y="${headY}" text-anchor="end" ${colHead}>内存</text>`,
      `<text x="${gridX + gridW - 12}" y="${headY}" text-anchor="end" ${colHead}>CPU</text>`
    );
    const keyRows = (opts.keyProcesses || []).slice(0, procBox.rows);
    const procHues = [HUE.orange, HUE.pink, HUE.blue, HUE.purple];
    if (keyRows.length) {
      keyRows.forEach((row, i) => {
        parts.push(
          keyProcRow(gridX, procBox.bodyY + i * ENV_PROC_STEP, gridW, procHues[i] || HUE.blue, row)
        );
      });
    } else {
      parts.push(
        `<text x="${gridX + gridW / 2}" y="${procBox.bodyY + 24}" text-anchor="middle" font-family="${FONT}" font-size="13" fill="${INK_SOFT}">暂无进程数据</text>`
      );
    }
  }
  layout.footerBubbles.forEach((b, i) => {
    const hue = FOOTER_HUES[i % FOOTER_HUES.length];
    parts.push(
      `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="${b.rx}" fill="${alpha(shade(hue, 0.7), 0.5)}" stroke="${alpha(hue, 0.5)}" stroke-width="1.3"/>`,
      `<text x="${b.x + b.w / 2}" y="${b.y + b.h / 2 + 4.5}" text-anchor="middle" font-family="${FONT}" font-size="12.5" font-weight="bold" fill="${shade(hue, -0.45)}">${escapeXml$8(layout.footerTexts[i] || "")}</text>`
    );
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${layout.width}" height="${layout.height}">${parts.join("\n")}</svg>`;
}
const SVG_NS = "http://www.w3.org/2000/svg";
function rrPath(x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, Math.min(w, h) / 2));
  return [
    `M${x + rr},${y}`,
    `H${x + w - rr}`,
    `A${rr},${rr} 0 0 1 ${x + w},${y + rr}`,
    `V${y + h - rr}`,
    `A${rr},${rr} 0 0 1 ${x + w - rr},${y + h}`,
    `H${x + rr}`,
    `A${rr},${rr} 0 0 1 ${x},${y + h - rr}`,
    `V${y + rr}`,
    `A${rr},${rr} 0 0 1 ${x + rr},${y}`,
    "Z"
  ].join(" ");
}
function ringPath(w, h, rx, from, to, a = 1) {
  const oW = w - from * 2;
  const oH = h - from * 2;
  const iW = w - to * 2;
  const iH = h - to * 2;
  if (oW <= 2 || oH <= 2 || iW <= 0 || iH <= 0 || to - from < 0.6) return "";
  const outer = rrPath(from, from, oW, oH, Math.max(0.5, rx - from));
  const inner = rrPath(to, to, iW, iH, Math.max(0.5, rx - to));
  const op = a >= 1 ? "" : ` fill-opacity="${a.toFixed(3)}"`;
  return `<path fill="#ffffff" fill-rule="evenodd"${op} d="${outer} ${inner}"/>`;
}
function ringSvg(w, h, rx, from, to, a = 1) {
  const p = ringPath(w, h, rx, from, to, a);
  return p ? `<svg xmlns="${SVG_NS}" width="${w}" height="${h}">${p}</svg>` : "";
}
async function edgeSqueeze(sharp, backdrop, layout, box, push, disperse = false) {
  const { left, top, w, h } = box;
  const once = async (p) => {
    const x0 = Math.max(0, Math.round(left - p));
    const y0 = Math.max(0, Math.round(top - p));
    const x1 = Math.min(layout.width, Math.round(left + w + p));
    const y1 = Math.min(layout.height, Math.round(top + h + p));
    return await sharp(backdrop).extract({ left: x0, top: y0, width: Math.max(2, x1 - x0), height: Math.max(2, y1 - y0) }).resize(w, h, { fit: "fill" }).ensureAlpha().png(MK_PNG_OUT()).toBuffer();
  };
  if (!disperse) return once(push);
  try {
    const [rBuf, gBuf, bBuf] = await Promise.all([
      once(push * (1 + LENS_DISPERSION)),
      once(push),
      once(push * (1 - LENS_DISPERSION))
    ]);
    const [rc, gc, bc] = await Promise.all([
      sharp(rBuf).extractChannel("red").png(MK_PNG_OUT()).toBuffer(),
      sharp(gBuf).extractChannel("green").png(MK_PNG_OUT()).toBuffer(),
      sharp(bBuf).extractChannel("blue").png(MK_PNG_OUT()).toBuffer()
    ]);
    return await sharp(rc).joinChannel([gc, bc]).ensureAlpha().png(MK_PNG_OUT()).toBuffer();
  } catch {
    return once(push);
  }
}
async function buildCardGlass(sharp, backdrop, layout, r) {
  const left = Math.max(0, Math.round(r.x));
  const top = Math.max(0, Math.round(r.y));
  const w = Math.min(layout.width - left, Math.round(r.w));
  const h = Math.min(layout.height - top, Math.round(r.h));
  if (w < 12 || h < 12) return null;
  const scale = Math.min(1, Math.min(w, h) / (LENS_DEPTH * 2.4));
  const limit = Math.min(w, h) / 2 - 1;
  const dense = h <= 56;
  const bodyContrast = dense ? 0.34 : GLASS_CONTRAST;
  const bodyLift = dense ? GLASS_LIFT + 128 : GLASS_LIFT;
  const bodyBlur = dense ? 3.2 : GLASS_BLUR;
  const region = await edgeSqueeze(sharp, backdrop, layout, { left, top, w, h }, BODY_PUSH * Math.max(0.5, scale));
  const body = await sharp(region).blur(bodyBlur).modulate({ saturation: GLASS_SATURATION }).linear(bodyContrast, bodyLift).png(MK_PNG_OUT()).toBuffer();
  const lensLayers = [];
  for (const band of dense ? [] : LENS_BANDS) {
    const from = band.from * scale;
    const to = Math.min(band.to * scale, limit);
    if (to - from < 1.2) continue;
    const ring = ringSvg(w, h, r.rx, from, to);
    if (!ring) continue;
    const zoomed = await edgeSqueeze(
      sharp,
      backdrop,
      layout,
      { left, top, w, h },
      band.push * Math.max(0.5, scale),
      band.disperse === true
    );
    const tuned = await sharp(zoomed).blur(Math.max(0.4, band.soft * scale)).modulate({ saturation: GLASS_SATURATION + 0.24, brightness: 1.04 }).linear(GLASS_CONTRAST + 0.16, GLASS_LIFT - 28).png(MK_PNG_OUT()).toBuffer();
    const mask = await sharp(Buffer.from(ring)).blur(Math.max(0.4, band.feather * scale)).png(MK_PNG_OUT()).toBuffer();
    lensLayers.push(
      await sharp(tuned).composite([{ input: mask, blend: "dest-in" }]).png(MK_PNG_OUT()).toBuffer()
    );
  }
  const menOuter = ringPath(w, h, r.rx, MENISCUS_FROM * scale, Math.min(4.2 * scale, limit), MENISCUS_ALPHA);
  const menInner = ringPath(w, h, r.rx, 4 * scale, Math.min(MENISCUS_TO * scale, limit), MENISCUS_ALPHA * 0.42);
  const meniscus = menOuter || menInner ? await sharp(Buffer.from(`<svg xmlns="${SVG_NS}" width="${w}" height="${h}">${menInner}${menOuter}</svg>`)).blur(Math.max(0.4, MENISCUS_BLUR * scale)).png(MK_PNG_OUT()).toBuffer() : null;
  const skyH = Math.max(6, Math.min(h * 0.22, 34 * Math.max(0.5, scale)));
  const blobRx = w * 0.42;
  const blobRy = Math.max(10, h * 0.34);
  const sheenSvg = `<svg xmlns="${SVG_NS}" width="${w}" height="${h}">
    <defs>
      <linearGradient id="skyBand" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="rgba(255,255,255,0.30)"/>
        <stop offset="45%" stop-color="rgba(236,250,255,0.10)"/>
        <stop offset="100%" stop-color="rgba(255,255,255,0)"/>
      </linearGradient>
      <linearGradient id="sky" x1="0" y1="0" x2="0.18" y2="1">
        <stop offset="0%" stop-color="rgba(228,246,255,0.13)"/>
        <stop offset="34%" stop-color="rgba(255,255,255,0.05)"/>
        <stop offset="100%" stop-color="rgba(255,255,255,0.01)"/>
      </linearGradient>
      <radialGradient id="blob" cx="0.3" cy="0.16" r="0.62">
        <stop offset="0%" stop-color="rgba(255,255,255,0.16)"/>
        <stop offset="55%" stop-color="rgba(255,255,255,0.04)"/>
        <stop offset="100%" stop-color="rgba(255,255,255,0)"/>
      </radialGradient>
      <linearGradient id="caustic" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="rgba(255,255,255,0)"/>
        <stop offset="13%" stop-color="rgba(255,255,255,0.18)"/>
        <stop offset="21%" stop-color="rgba(255,255,255,0.02)"/>
        <stop offset="62%" stop-color="rgba(255,255,255,0)"/>
        <stop offset="73%" stop-color="rgba(255,255,255,0.11)"/>
        <stop offset="82%" stop-color="rgba(255,255,255,0)"/>
      </linearGradient>
      <linearGradient id="caustic2" x1="1" y1="0" x2="0.1" y2="1">
        <stop offset="0%" stop-color="rgba(255,255,255,0)"/>
        <stop offset="26%" stop-color="rgba(255,255,255,0.10)"/>
        <stop offset="36%" stop-color="rgba(255,255,255,0)"/>
        <stop offset="100%" stop-color="rgba(255,255,255,0)"/>
      </linearGradient>
      <linearGradient id="sink" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="rgba(34,40,64,0)"/>
        <stop offset="70%" stop-color="rgba(34,40,64,0.015)"/>
        <stop offset="100%" stop-color="rgba(34,40,64,0.09)"/>
      </linearGradient>
    </defs>
    <rect width="${w}" height="${h}" fill="url(#sky)"/>
    <rect width="${w}" height="${skyH.toFixed(1)}" fill="url(#skyBand)"/>
    <ellipse cx="${(w * 0.3).toFixed(1)}" cy="${(h * 0.14).toFixed(1)}" rx="${blobRx.toFixed(1)}" ry="${blobRy.toFixed(1)}" fill="url(#blob)"/>
    <rect width="${w}" height="${h}" fill="url(#caustic)"/>
    <rect width="${w}" height="${h}" fill="url(#caustic2)"/>
    <rect width="${w}" height="${h}" fill="url(#sink)"/>
  </svg>`;
  const shapeSvg = `<svg xmlns="${SVG_NS}" width="${w}" height="${h}"><rect width="${w}" height="${h}" rx="${r.rx}" ry="${r.rx}" fill="#ffffff"/></svg>`;
  const overlays = lensLayers.map((input) => ({ input, blend: "over" }));
  if (meniscus) overlays.push({ input: meniscus, blend: "over" });
  overlays.push({ input: Buffer.from(sheenSvg), blend: "over" });
  const merged = await sharp(body).composite(overlays).png(MK_PNG_OUT()).toBuffer();
  const clipped = await sharp(merged).composite([{ input: Buffer.from(shapeSvg), blend: "dest-in" }]).png(MK_PNG_OUT()).toBuffer();
  return { input: clipped, top, left };
}
async function buildLiquidGlassLayers(sharp, backdrop, layout) {
  const layers = [];
  for (const rect of layout.glass) {
    try {
      const layer = await buildCardGlass(sharp, backdrop, layout, rect);
      if (layer) layers.push(layer);
    } catch {
    }
  }
  return layers;
}
async function buildBackdrop(sharp, bgBuf, layout, effects) {
  let pipeline = sharp(bgBuf).resize(layout.width, layout.height, { fit: "cover", position: "centre" });
  if (effects.blurSigma > 0) pipeline = pipeline.blur(effects.blurSigma);
  const base = await pipeline.ensureAlpha().png(MK_PNG_OUT()).toBuffer();
  if (effects.dimAlpha <= 0) return base;
  const dim = await sharp({
    create: {
      width: layout.width,
      height: layout.height,
      channels: 4,
      background: { r: 12, g: 10, b: 24, alpha: effects.dimAlpha }
    }
  }).png(MK_PNG_OUT()).toBuffer();
  return await sharp(base).composite([{ input: dim, blend: "over" }]).png(MK_PNG_OUT()).toBuffer();
}
async function buildFallbackBackground(sharp, layout) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${layout.width}" height="${layout.height}">
    <defs>
      <linearGradient id="bgFall" x1="0" y1="0" x2="0.6" y2="1">
        <stop offset="0%" stop-color="#FFD9E8"/>
        <stop offset="50%" stop-color="#D9E4FF"/>
        <stop offset="100%" stop-color="#CFF3E6"/>
      </linearGradient>
    </defs>
    <rect width="${layout.width}" height="${layout.height}" fill="url(#bgFall)"/>
    <circle cx="${layout.width * 0.18}" cy="${layout.height * 0.22}" r="150" fill="rgba(255,255,255,0.35)"/>
    <circle cx="${layout.width * 0.86}" cy="${layout.height * 0.34}" r="110" fill="rgba(255,255,255,0.28)"/>
  </svg>`;
  return sharp(Buffer.from(svg)).png(MK_PNG_OUT()).toBuffer();
}
async function roundAvatar$3(sharp, buf, size) {
  try {
    const mask = Buffer.from(
      `<svg width="${size}" height="${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="white"/></svg>`
    );
    return await sharp(buf).resize(size, size, { fit: "cover" }).ensureAlpha().composite([{ input: mask, blend: "dest-in" }]).png(MK_PNG_OUT()).toBuffer();
  } catch {
    return null;
  }
}
const STATUS_AVATAR_TIMEOUT_MS = 1e4;
const STATUS_AVATAR_CONCURRENCY = 6;
async function mapWithLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      for (; ; ) {
        const i = cursor;
        cursor += 1;
        if (i >= items.length) return;
        out[i] = await fn(items[i], i);
      }
    })
  );
  return out;
}
async function fetchRoundStatusAvatar(sharp, url, size) {
  const target = String(url || "").trim();
  if (!target || size <= 0) return null;
  try {
    const buf = await fetchUrlBuffer$3(target, STATUS_AVATAR_TIMEOUT_MS);
    if (!buf || buf.length === 0) return null;
    return await roundAvatar$3(sharp, buf, size);
  } catch (_e) {
    return null;
  }
}
async function renderStatusWithSharpImpl(options, logger) {
  const width = options.width ?? STATUS_CARD_WIDTH;
  const accounts = normalizeStatusAccounts(options);
  const fwName = String(options.frameworkName || "").trim();
  const fwVer = String(options.frameworkVersion || "").replace(/^v/i, "").trim();
  const footerParts = [
    `MKbot ${String(options.pluginVersion || "")}`.trim(),
    `${fwName}${fwVer ? ` v${fwVer}` : ""}`.trim(),
    `Node ${String(options.nodeVersion || "")}`.trim()
  ].filter((t) => t.replace(/^(MKbot|Node)\s*$/, "").trim());
  const layout = computeLayout(width, 0, buildDiskRows(options).length, accounts.length, footerParts);
  const height = layout.height;
  const pluginDir = String(options.pluginDir || "").trim();
  const pluginPath = String(options.pluginPath || "").trim();
  const dataPath = String(options.dataPath || "").trim();
  const bgLocalPath = String(options.bgLocalPath || "").trim();
  try {
    const sharp = await loadSharp();
    const bgBuf = await loadStatusBackground(
      String(options.backgroundImageUrl || ""),
      bgLocalPath,
      pluginDir,
      pluginPath,
      dataPath
    );
    const composites = [];
    const effects = loadSharpBgEffectsFromDataPath(dataPath);
    let backdrop;
    if (bgBuf && bgBuf.length > 0) {
      backdrop = await buildBackdrop(sharp, bgBuf, layout, effects);
    } else {
      backdrop = await buildFallbackBackground(sharp, layout);
      logger?.warn?.("[Sharp渲染] 运行状态背景图不可用，已使用卡通渐变底色");
    }
    composites.push({ input: backdrop, top: 0, left: 0 });
    composites.push(...await buildLiquidGlassLayers(sharp, backdrop, layout));
    const customText = loadSharpTextColorFromDataPath(dataPath);
    const overlaySvg = buildStatusOverlaySvg(layout, options, customText);
    const overlayLayer = await sharp(Buffer.from(overlaySvg)).png(MK_PNG_OUT()).toBuffer();
    composites.push({ input: overlayLayer, top: 0, left: 0 });
    const avatarJobs = [];
    for (const card of layout.accountCards) {
      const account = accounts[card.index];
      const qq = String(account?.qq || "").trim();
      const url = String(account?.avatar || "").trim() || (qq ? `https://q4.qlogo.cn/g?b=qq&nk=${qq}&s=5` : "");
      if (!url) continue;
      avatarJobs.push({ url, size: card.avatar.size, x: card.avatar.x, y: card.avatar.y });
    }
    const avatarBufs = await mapWithLimit(
      avatarJobs,
      STATUS_AVATAR_CONCURRENCY,
      (job) => fetchRoundStatusAvatar(sharp, job.url, job.size)
    );
    avatarBufs.forEach((buf, i) => {
      const job = avatarJobs[i];
      if (!buf || !job) return;
      composites.push({ input: buf, top: Math.round(job.y), left: Math.round(job.x) });
    });
    const out = await sharp({
      create: {
        width,
        height,
        channels: 4,
        background: { r: 20, g: 18, b: 32, alpha: 1 }
      }
    }).composite(composites).png({ compressionLevel: 6 }).toBuffer();
    return out.toString("base64");
  } catch (error) {
    error instanceof Error ? error.message : String(error);
    return null;
  }
}

function escapeXml$7(text) {
  return String(text ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
function truncateText$5(text, maxLen) {
  const s = String(text || "").trim();
  if (s.length <= maxLen) return s;
  return `${s.slice(0, maxLen - 1)}…`;
}
function approxTextWidth(text, size) {
  let w = 0;
  for (const ch of String(text || "")) {
    w += /[\x00-\xff]/.test(ch) ? size * 0.56 : size;
  }
  return w;
}
function valueFontSize$1(text, base = 82, min = 40) {
  const len = String(text || "").length;
  if (len <= 6) return base;
  if (len <= 8) return 68;
  if (len <= 10) return 56;
  return min;
}
function fetchUrlBuffer$2(url, timeoutMs = 12e3) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(
      url,
      { timeout: timeoutMs, headers: { "User-Agent": "MKbot-SignInSharp/1.0" } },
      (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          fetchUrlBuffer$2(res.headers.location, timeoutMs).then(resolve).catch(reject);
          return;
        }
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}`));
          res.resume();
          return;
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        res.on("end", () => resolve(Buffer.concat(chunks)));
        res.on("error", reject);
      }
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
  });
}
async function loadSignInBackground(bgLocalPath, pluginDir, dataPath) {
  const candidates = [];
  const push = (v) => {
    const s = String(v || "").trim();
    if (s && !candidates.includes(s)) candidates.push(s);
  };
  push(bgLocalPath);
  const localNames = ["签到.jpg", "签到.jpeg", "签到.png", "签到.webp", "heng.jpg"];
  const roots = [
    path.join(String(pluginDir || "").trim(), "默认资源", "image"),
    path.join(String(dataPath || "").trim(), "默认资源", "image")
  ];
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    roots.push(path.join(here, "默认资源", "image"));
    roots.push(path.join(here, "..", "默认资源", "image"));
  } catch {
  }
  for (const root of roots) {
    if (!String(root || "").trim()) continue;
    for (const name of localNames) push(path.join(root, name));
  }
  for (const src of candidates) {
    try {
      if (/^https?:\/\//i.test(src)) {
        const buf = await fetchUrlBuffer$2(src, 2e4);
        if (buf?.length) return buf;
        continue;
      }
      if (fs.existsSync(src) && fs.statSync(src).isFile()) return fs.readFileSync(src);
    } catch {
    }
  }
  return null;
}
function glassRect$2(x, y, w, h, r = 22) {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" ry="${r}" fill="rgba(255,255,255,0.12)" stroke="rgba(255,255,255,0.28)" stroke-width="1.5"/>`;
}
function buildSignInSvg(width, height, opts, customText, hasBg = false) {
  const 货币单位 = escapeXml$7(opts.货币名 || "归笺");
  const isDay = opts.theme === "day";
  const font = "Microsoft YaHei, Noto Sans SC, sans-serif";
  const mainFill = resolveSharpTextFill(customText, isDay ? "#ff5722" : "#f8fafc");
  const subFill = isDay ? "rgba(120,72,20,0.88)" : "rgba(226,232,240,0.88)";
  const labelFill = isDay ? "rgba(120,72,20,0.78)" : "rgba(203,213,225,0.8)";
  const rankFill = isDay ? "#ff9800" : "#fbbf24";
  const glow = isDay ? "url(#glowLight)" : "url(#glowDark)";
  const pad = 30;
  const cardX = pad;
  const cardY = pad;
  const cardW = width - pad * 2;
  const cardH = height - pad * 2;
  const radius = 30;
  const parts = [];
  parts.push(`<defs>
    <clipPath id="cardClip"><rect x="${cardX}" y="${cardY}" width="${cardW}" height="${cardH}" rx="${radius}" ry="${radius}"/></clipPath>
    <linearGradient id="bgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      ${isDay ? '<stop offset="0%" stop-color="#ffe0b2"/><stop offset="100%" stop-color="#b3e5fc"/>' : '<stop offset="0%" stop-color="#0f172a"/><stop offset="50%" stop-color="#1e293b"/><stop offset="100%" stop-color="#0f172a"/>'}
    </linearGradient>
    <linearGradient id="rankGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      ${isDay ? '<stop offset="0%" stop-color="#ff9800"/><stop offset="100%" stop-color="#ff5722"/>' : '<stop offset="0%" stop-color="#f59e0b"/><stop offset="100%" stop-color="#ea580c"/>'}
    </linearGradient>
    <linearGradient id="guiGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      ${isDay ? '<stop offset="0%" stop-color="#ff9800"/><stop offset="100%" stop-color="#ff5722"/>' : '<stop offset="0%" stop-color="#f59e0b"/><stop offset="100%" stop-color="#ea580c"/>'}
    </linearGradient>
    <linearGradient id="yuGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      ${isDay ? '<stop offset="0%" stop-color="#00b8d4"/><stop offset="100%" stop-color="#4dd0e1"/>' : '<stop offset="0%" stop-color="#3b82f6"/><stop offset="100%" stop-color="#06b6d4"/>'}
    </linearGradient>
    <linearGradient id="avatarBorder" x1="0%" y1="0%" x2="100%" y2="100%">
      ${isDay ? '<stop offset="0%" stop-color="#ff5722"/><stop offset="50%" stop-color="#ff9800"/><stop offset="100%" stop-color="#48cae4"/>' : '<stop offset="0%" stop-color="#f59e0b"/><stop offset="50%" stop-color="#3b82f6"/><stop offset="100%" stop-color="#06b6d4"/>'}
    </linearGradient>
    <filter id="glowLight" x="-40%" y="-40%" width="180%" height="180%">
      <feDropShadow dx="0" dy="0" stdDeviation="3" flood-color="#ffffff" flood-opacity="0.9"/>
      <feDropShadow dx="0" dy="1" stdDeviation="5" flood-color="#7c5a2a" flood-opacity="0.3"/>
    </filter>
    <filter id="glowDark" x="-40%" y="-40%" width="180%" height="180%">
      <feDropShadow dx="0" dy="0" stdDeviation="3" flood-color="#000000" flood-opacity="0.55"/>
      <feDropShadow dx="0" dy="1" stdDeviation="6" flood-color="#000000" flood-opacity="0.35"/>
    </filter>
    <filter id="blobBlur" x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur stdDeviation="34"/>
    </filter>
  </defs>`);
  parts.push(`<g clip-path="url(#cardClip)">`);
  if (!hasBg) {
    parts.push(`<rect x="${cardX}" y="${cardY}" width="${cardW}" height="${cardH}" fill="url(#bgGrad)"/>`);
  } else {
    parts.push(
      `<rect x="${cardX}" y="${cardY}" width="${cardW}" height="${cardH}" fill="${isDay ? "rgba(255,248,230,0.16)" : "rgba(8,12,22,0.30)"}"/>`
    );
  }
  const blobOpacity = hasBg ? 0.26 : 0.5;
  if (isDay) {
    parts.push(`<circle cx="${cardX + cardW * 0.82}" cy="${cardY + 30}" r="150" fill="#ffcc80" opacity="${blobOpacity}" filter="url(#blobBlur)"/>`);
    parts.push(`<circle cx="${cardX + 40}" cy="${cardY + cardH * 0.78}" r="130" fill="#90e0ef" opacity="${blobOpacity}" filter="url(#blobBlur)"/>`);
  } else {
    parts.push(`<circle cx="${cardX + cardW * 0.82}" cy="${cardY + 30}" r="150" fill="#3b82f6" opacity="${blobOpacity}" filter="url(#blobBlur)"/>`);
    parts.push(`<circle cx="${cardX + 40}" cy="${cardY + cardH * 0.78}" r="130" fill="#f59e0b" opacity="${blobOpacity}" filter="url(#blobBlur)"/>`);
  }
  parts.push(glassRect$2(cardX, cardY, cardW, cardH, radius));
  const avatarSize = 84;
  const avatarX = cardX + 24;
  const avatarY = cardY + 24;
  parts.push(
    `<rect x="${avatarX}" y="${avatarY}" width="${avatarSize}" height="${avatarSize}" rx="20" ry="20" fill="url(#avatarBorder)"/>`
  );
  parts.push(
    `<rect x="${avatarX + 3}" y="${avatarY + 3}" width="${avatarSize - 6}" height="${avatarSize - 6}" rx="17" ry="17" fill="#ffffff"/>`
  );
  const textX = avatarX + avatarSize + 20;
  const rightX = cardX + cardW - 26;
  parts.push(
    `<text x="${textX}" y="${avatarY + 33}" font-family="${font}" font-size="27" font-weight="800" fill="${mainFill}" filter="${glow}">${escapeXml$7(truncateText$5(opts.userName, 12))}</text>`
  );
  parts.push(
    `<text x="${textX}" y="${avatarY + 60}" font-family="${font}" font-size="14" fill="${subFill}" filter="${glow}">QQ: ${escapeXml$7(String(opts.userId))}</text>`
  );
  parts.push(
    `<text x="${rightX}" y="${avatarY + 58}" text-anchor="end" font-family="${font}" font-size="42" font-weight="900" fill="${rankFill}" filter="${glow}">${escapeXml$7(opts.rankText)}</text>`
  );
  const midW = cardW - 120;
  const midX = cardX + 60;
  if (opts.signed) {
    const midY = avatarY + avatarSize + 34;
    const midH = 240;
    parts.push(glassRect$2(midX, midY, midW, midH, 26));
    parts.push(
      `<text x="${cardX + cardW / 2 + 4}" y="${midY + midH / 2 + 34}" text-anchor="middle" font-family="${font}" font-size="96" font-weight="900" fill="${mainFill}" letter-spacing="8" filter="${glow}">已签到</text>`
    );
  } else {
    const gj = Number(opts.guiJian ?? 0);
    const ye = Number(opts.yuEr ?? 0);
    const gjText = `+${gj}`;
    const yeText = `+${ye}`;
    const tileGap = 24;
    const tileW = (midW - tileGap) / 2;
    const tileY = avatarY + avatarSize + 34;
    const tileH = 240;
    const cols = [
      { x: midX, label: 货币单位, value: gjText, grad: "url(#guiGrad)" },
      { x: midX + tileW + tileGap, label: "诱饵", value: yeText, grad: "url(#yuGrad)" }
    ];
    for (const col of cols) {
      const cx = col.x + tileW / 2;
      const vSize = valueFontSize$1(col.value);
      const valueFill = customText ? customText : col.grad;
      parts.push(glassRect$2(col.x, tileY, tileW, tileH, 26));
      parts.push(
        `<text x="${cx}" y="${tileY + 82}" text-anchor="middle" font-family="${font}" font-size="30" font-weight="800" fill="${labelFill}" filter="${glow}">${escapeXml$7(col.label)}</text>`
      );
      parts.push(
        `<text x="${cx}" y="${tileY + 168}" text-anchor="middle" font-family="${font}" font-size="${vSize}" font-weight="900" fill="${valueFill}" filter="${glow}">${escapeXml$7(col.value)}</text>`
      );
    }
  }
  const statsH = 152;
  const statsX = cardX + 24;
  const statsW = cardW - 48;
  const statsY = cardY + cardH - 18 - statsH;
  parts.push(glassRect$2(statsX, statsY, statsW, statsH, 24));
  const col1 = statsX + statsW * 0.25;
  const col2 = statsX + statsW * 0.75;
  const daysSize = valueFontSize$1(opts.totalDays, 38, 24);
  const streakSize = valueFontSize$1(truncateText$5(opts.streakText, 12), 32, 22);
  const statFill = customText ? customText : "url(#rankGrad)";
  parts.push(
    `<text x="${col1}" y="${statsY + 42}" text-anchor="middle" font-family="${font}" font-size="16" font-weight="700" fill="${labelFill}" filter="${glow}">累计天数</text>`
  );
  parts.push(
    `<text x="${col1}" y="${statsY + 86}" text-anchor="middle" font-family="${font}" font-size="${daysSize}" font-weight="900" fill="${statFill}" filter="${glow}">${escapeXml$7(opts.totalDays)}</text>`
  );
  parts.push(
    `<text x="${col2}" y="${statsY + 42}" text-anchor="middle" font-family="${font}" font-size="16" font-weight="700" fill="${labelFill}" filter="${glow}">连签次数</text>`
  );
  parts.push(
    `<text x="${col2}" y="${statsY + 86}" text-anchor="middle" font-family="${font}" font-size="${streakSize}" font-weight="900" fill="${statFill}" filter="${glow}">${escapeXml$7(truncateText$5(opts.streakText, 12))}</text>`
  );
  parts.push(
    `<rect x="${statsX + 26}" y="${statsY + 106}" width="${statsW - 52}" height="1" fill="${isDay ? "rgba(120,72,20,0.2)" : "rgba(255,255,255,0.18)"}"/>`
  );
  const events = Array.isArray(opts.events) ? opts.events.filter((e) => String(e?.text || "").trim()) : [];
  if (events.length > 0) {
    let tagX = statsX + 26;
    const tagY = statsY + 116;
    const tagH = 28;
    const maxX = statsX + statsW - 20;
    for (const ev of events.slice(0, 4)) {
      const text = truncateText$5(ev.text, 14);
      const tagW = Math.ceil(approxTextWidth(text, 13)) + 26;
      if (tagX + tagW > maxX) break;
      const fill = ev.bonus ? "url(#rankGrad)" : isDay ? "rgba(255,152,0,0.18)" : "rgba(59,130,246,0.22)";
      const stroke = ev.bonus ? "none" : isDay ? "rgba(255,152,0,0.35)" : "rgba(59,130,246,0.38)";
      const textFill = ev.bonus ? "#ffffff" : isDay ? "#b45309" : "#93c5fd";
      parts.push(
        `<rect x="${tagX}" y="${tagY}" width="${tagW}" height="${tagH}" rx="14" ry="14" fill="${fill}" stroke="${stroke}" stroke-width="1"/>`
      );
      parts.push(
        `<text x="${tagX + tagW / 2}" y="${tagY + 19}" text-anchor="middle" font-family="${font}" font-size="13" font-weight="600" fill="${textFill}">${escapeXml$7(text)}</text>`
      );
      tagX += tagW + 10;
    }
  }
  parts.push(`</g>`);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${parts.join("\n")}</svg>`;
}
async function roundAvatar$2(sharp, buf, size) {
  try {
    const mask = Buffer.from(
      `<svg width="${size}" height="${size}"><rect x="0" y="0" width="${size}" height="${size}" rx="18" ry="18" fill="white"/></svg>`
    );
    return sharp(buf).resize(size, size, { fit: "cover" }).ensureAlpha().composite([{ input: mask, blend: "dest-in" }]).png(MK_PNG_OUT()).toBuffer();
  } catch {
    return null;
  }
}
async function fitCompositeLayer$3(sharp, input, width, height) {
  return svgCompositeLayer(sharp, input, width, height);
}
async function renderSignInWithSharpImpl(options, logger) {
  const width = options.width ?? 900;
  const height = options.height ?? 620;
  const pluginDir = String(options.pluginDir || "").trim();
  const dataPath = String(options.dataPath || "").trim();
  const bgLocalPath = String(options.bgLocalPath || "").trim();
  try {
    const sharp = await loadSharp();
    const composites = [];
    const bgBuf = await loadSignInBackground(bgLocalPath, pluginDir, dataPath);
    if (bgBuf && bgBuf.length > 0) {
      await applySharpPhotoBackgroundLayers(sharp, composites, bgBuf, width, height, dataPath);
    } else {
      const fallback = await sharp({
        create: {
          width,
          height,
          channels: 4,
          background: { r: 18, g: 22, b: 30, alpha: 1 }
        }
      }).png(MK_PNG_OUT()).toBuffer();
      composites.push({ input: fallback, top: 0, left: 0 });
      logger?.warn?.("[Sharp渲染] 签到背景图不可用，已使用默认底色");
    }
    const customText = loadSharpTextColorFromDataPath(dataPath);
    const svg = buildSignInSvg(width, height, options, customText, Boolean(bgBuf && bgBuf.length > 0));
    const uiLayer = await fitCompositeLayer$3(sharp, Buffer.from(svg), width, height);
    composites.push({ input: uiLayer, top: 0, left: 0 });
    const avatarSize = 84;
    const avatarTop = 30 + 24;
    const avatarLeft = 30 + 24;
    const avatarUrl = String(options.avatarUrl || "").trim() || `https://q4.qlogo.cn/g?b=qq&nk=${options.userId}&s=5`;
    try {
      const avatarBuf = await fetchUrlBuffer$2(avatarUrl, 1e4);
      if (avatarBuf.length > 0) {
        const rounded = await roundAvatar$2(sharp, avatarBuf, avatarSize);
        if (rounded) composites.push({ input: rounded, top: avatarTop, left: avatarLeft });
      }
    } catch (_e) {
    }
    const out = await sharp({
      create: {
        width,
        height,
        channels: 4,
        background: { r: 18, g: 22, b: 30, alpha: 1 }
      }
    }).composite(composites).png(MK_PNG_OUT()).toBuffer();
    return out.toString("base64");
  } catch (error) {
    error instanceof Error ? error.message : String(error);
    return null;
  }
}

function escapeXml$6(text) {
  return String(text ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
function truncateText$4(text, maxLen) {
  const s = String(text).trim();
  if (s.length <= maxLen) return s;
  return `${s.slice(0, maxLen - 1)}…`;
}
function valueFontSize(text, base = 34, min = 20) {
  const len = String(text || "").length;
  if (len <= 8) return base;
  if (len <= 12) return 28;
  if (len <= 18) return 24;
  return min;
}
function fetchUrlBuffer$1(url, timeoutMs = 12e3) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(
      url,
      { timeout: timeoutMs, headers: { "User-Agent": "MKbot-WalletSharp/1.0" } },
      (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          fetchUrlBuffer$1(res.headers.location, timeoutMs).then(resolve).catch(reject);
          return;
        }
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}`));
          res.resume();
          return;
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        res.on("end", () => resolve(Buffer.concat(chunks)));
        res.on("error", reject);
      }
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
  });
}
function glassRect$1(x, y, w, h, r = 18) {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" ry="${r}" fill="rgba(255,255,255,0.12)" stroke="rgba(255,255,255,0.28)" stroke-width="1.5"/>`;
}
async function loadWalletBackground(bgLocalPath, pluginDir, dataPath) {
  const candidates = [];
  const push = (v) => {
    const s = String(v || "").trim();
    if (s && !candidates.includes(s)) candidates.push(s);
  };
  push(bgLocalPath);
  const localNames = ["运行状态.jpg", "运行状态.jpeg", "运行状态.png", "运行状态.webp"];
  const roots = [
    path.join(String(pluginDir || "").trim(), "默认资源", "image"),
    path.join(String(dataPath || "").trim(), "默认资源", "image")
  ];
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    roots.push(path.join(here, "默认资源", "image"));
    roots.push(path.join(here, "..", "默认资源", "image"));
  } catch {
  }
  for (const root of roots) {
    if (!String(root || "").trim()) continue;
    for (const name of localNames) {
      push(path.join(root, name));
    }
  }
  for (const src of candidates) {
    try {
      if (/^https?:\/\//i.test(src)) {
        const buf = await fetchUrlBuffer$1(src, 2e4);
        if (buf?.length) return buf;
        continue;
      }
      if (fs.existsSync(src) && fs.statSync(src).isFile()) {
        return fs.readFileSync(src);
      }
    } catch {
    }
  }
  return null;
}
function buildWalletSvg(width, height, opts, customText) {
  const 货币单位 = escapeXml$6(opts.货币名 || "归笺");
  const font = "Microsoft YaHei, Noto Sans SC, sans-serif";
  const mainFill = resolveSharpTextFill(customText, "#ffffff");
  const pad = 28;
  const cardX = pad;
  const cardY = pad;
  const cardW = width - pad * 2;
  const cardH = height - pad * 2;
  const title = escapeXml$6(opts.title || "我的信息");
  const userName = escapeXml$6(truncateText$4(opts.userName || "旅人", 14));
  const userId = escapeXml$6(String(opts.userId || ""));
  const time = escapeXml$6(opts.time || "");
  const currentMoney = escapeXml$6(opts.currentMoney || `0${货币单位}`);
  const bankMoney = escapeXml$6(opts.bankMoney || `0${货币单位}`);
  const baitCount = escapeXml$6(String(opts.baitCount ?? "0"));
  const muteCardCount = escapeXml$6(String(opts.muteCardCount ?? "0"));
  const signTotal = escapeXml$6(String(opts.signTotal ?? "0"));
  const signStreak = escapeXml$6(String(opts.signStreak ?? "0"));
  const parts = [];
  parts.push(`<defs>
    <linearGradient id="valGrad" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="100%" stop-color="#c8e7ff"/>
    </linearGradient>
    <linearGradient id="accentGrad" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#e8f4ff"/>
      <stop offset="100%" stop-color="#9ec9e8"/>
    </linearGradient>
    <filter id="titleGlow" x="-30%" y="-30%" width="160%" height="160%">
      <feDropShadow dx="0" dy="0" stdDeviation="2" flood-color="#ffffff" flood-opacity="0.85"/>
      <feDropShadow dx="0" dy="1" stdDeviation="4" flood-color="#8eb8d8" flood-opacity="0.35"/>
    </filter>
    <filter id="valGlow" x="-35%" y="-35%" width="170%" height="170%">
      <feDropShadow dx="0" dy="0" stdDeviation="2" flood-color="#ffffff" flood-opacity="0.55"/>
      <feDropShadow dx="0" dy="1" stdDeviation="5" flood-color="#9ec9e8" flood-opacity="0.35"/>
    </filter>
  </defs>`);
  parts.push(glassRect$1(cardX, cardY, cardW, cardH, 26));
  const avatarX = cardX + 22;
  const avatarY = cardY + 22;
  const avatarSize = 86;
  parts.push(
    `<circle cx="${avatarX + avatarSize / 2}" cy="${avatarY + avatarSize / 2}" r="${avatarSize / 2 + 1.5}" fill="rgba(255,255,255,0.14)" stroke="rgba(255,255,255,0.45)" stroke-width="2.5"/>`
  );
  const infoX = avatarX + avatarSize + 18;
  parts.push(
    `<text x="${infoX}" y="${avatarY + 26}" font-family="${font}" font-size="13" font-weight="700" fill="rgba(255,255,255,0.72)" letter-spacing="1">time:${time}</text>`
  );
  parts.push(
    `<text x="${infoX}" y="${avatarY + 58}" font-family="${font}" font-size="30" font-weight="900" fill="${mainFill}" filter="url(#titleGlow)">${title}</text>`
  );
  parts.push(
    `<text x="${infoX}" y="${avatarY + 82}" font-family="${font}" font-size="15" fill="rgba(255,255,255,0.82)">${userName} (${userId})</text>`
  );
  const tileY = cardY + 118;
  const gap = 14;
  const tileW = (cardW - 44 - gap) / 2;
  const tileH = 112;
  const tileX0 = cardX + 22;
  const tiles = [
    { label: "现有货币", value: currentMoney },
    { label: "银行储存", value: bankMoney },
    { label: "诱饵数量", value: baitCount, unit: "个" },
    { label: "禁言卡", value: muteCardCount, unit: "张" }
  ];
  tiles.forEach((tile, i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const x = tileX0 + col * (tileW + gap);
    const y = tileY + row * (tileH + gap);
    const displayValue = tile.unit ? `${tile.value}${tile.unit}` : tile.value;
    const valSize = valueFontSize(displayValue, 30, 18);
    parts.push(glassRect$1(x, y, tileW, tileH, 18));
    parts.push(
      `<circle cx="${x + 22}" cy="${y + 24}" r="4.5" fill="rgba(200,231,255,0.9)"/>`
    );
    parts.push(
      `<text x="${x + 36}" y="${y + 28}" font-family="${font}" font-size="16" font-weight="800" fill="rgba(255,255,255,0.92)">${escapeXml$6(tile.label)}</text>`
    );
    parts.push(
      `<text x="${x + 22}" y="${y + 78}" font-family="${font}" font-size="${valSize}" font-weight="900" fill="url(#valGrad)" filter="url(#valGlow)">${escapeXml$6(displayValue)}</text>`
    );
  });
  const footY = tileY + tileH * 2 + gap + 14;
  const footW = (cardW - 44 - gap) / 2;
  const footH = 74;
  const footItems = [
    { label: "累计签到", value: signTotal, unit: "天" },
    { label: "连续签到", value: signStreak, unit: "天" }
  ];
  footItems.forEach((item, i) => {
    const x = tileX0 + i * (footW + gap);
    parts.push(glassRect$1(x, footY, footW, footH, 16));
    parts.push(
      `<text x="${x + 16}" y="${footY + 26}" font-family="${font}" font-size="13" font-weight="600" fill="rgba(255,255,255,0.78)">${escapeXml$6(item.label)}</text>`
    );
    parts.push(
      `<text x="${x + 16}" y="${footY + 54}" font-family="${font}" font-size="26" font-weight="900" fill="url(#accentGrad)" filter="url(#valGlow)">${escapeXml$6(item.value)}<tspan font-size="13" fill="rgba(255,255,255,0.7)" filter="none"> ${escapeXml$6(item.unit)}</tspan></text>`
    );
  });
  parts.push(
    `<text x="${cardX + cardW / 2}" y="${cardY + cardH - 14}" text-anchor="middle" font-family="${font}" font-size="11" fill="rgba(255,255,255,0.38)" letter-spacing="2">MK-Bot · 娱乐经济数据</text>`
  );
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${parts.join("\n")}</svg>`;
}
async function roundAvatar$1(sharp, buf, size) {
  try {
    const mask = Buffer.from(
      `<svg width="${size}" height="${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="white"/></svg>`
    );
    return sharp(buf).resize(size, size, { fit: "cover" }).ensureAlpha().composite([{ input: mask, blend: "dest-in" }]).png(MK_PNG_OUT()).toBuffer();
  } catch {
    return null;
  }
}
async function fitCompositeLayer$2(sharp, input, width, height) {
  return svgCompositeLayer(sharp, input, width, height);
}
async function renderWalletWithSharpImpl(options, logger) {
  const width = options.width ?? 1080;
  const height = options.height ?? 720;
  const pluginDir = String(options.pluginDir || "").trim();
  const dataPath = String(options.dataPath || "").trim();
  const bgLocalPath = String(options.bgLocalPath || "").trim();
  try {
    const sharp = await loadSharp();
    const composites = [];
    const bgBuf = await loadWalletBackground(bgLocalPath, pluginDir, dataPath);
    if (bgBuf && bgBuf.length > 0) {
      await applySharpPhotoBackgroundLayers(sharp, composites, bgBuf, width, height, dataPath);
    } else {
      const fallback = await sharp({
        create: {
          width,
          height,
          channels: 4,
          background: { r: 22, g: 28, b: 38, alpha: 1 }
        }
      }).png(MK_PNG_OUT()).toBuffer();
      composites.push({ input: fallback, top: 0, left: 0 });
      logger?.warn?.("[Sharp渲染] 我的信息背景图不可用，已使用默认底色");
    }
    const customText = loadSharpTextColorFromDataPath(dataPath);
    const svg = buildWalletSvg(width, height, options, customText);
    const uiLayer = await fitCompositeLayer$2(sharp, Buffer.from(svg), width, height);
    composites.push({ input: uiLayer, top: 0, left: 0 });
    const avatarSize = 86;
    const avatarTop = 28 + 22;
    const avatarLeft = 28 + 22;
    const avatarUrl = `https://q4.qlogo.cn/g?b=qq&nk=${options.userId}&s=5`;
    try {
      const avatarBuf = await fetchUrlBuffer$1(avatarUrl, 1e4);
      if (avatarBuf.length > 0) {
        const rounded = await roundAvatar$1(sharp, avatarBuf, avatarSize);
        if (rounded) {
          composites.push({ input: rounded, top: avatarTop, left: avatarLeft });
        }
      }
    } catch (_e) {
    }
    const out = await sharp({
      create: {
        width,
        height,
        channels: 4,
        background: { r: 18, g: 22, b: 30, alpha: 1 }
      }
    }).composite(composites).png(MK_PNG_OUT()).toBuffer();
    return out.toString("base64");
  } catch (error) {
    error instanceof Error ? error.message : String(error);
    return null;
  }
}

function escapeXml$5(text) {
  return String(text ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
function truncateText$3(text, maxLen) {
  const s = String(text || "").trim();
  if (s.length <= maxLen) return s;
  return `${s.slice(0, maxLen - 1)}…`;
}
function buildShopSvg(width, height, opts) {
  const 货币单位 = escapeXml$5(opts.货币名 || "归笺");
  const font = "Microsoft YaHei, Noto Sans SC, sans-serif";
  const pad = 40;
  const title = escapeXml$5(opts.title || "道具商店");
  const subtitle = escapeXml$5(opts.subtitle || "");
  const hint = escapeXml$5(opts.hint || "");
  const items = Array.isArray(opts.items) ? opts.items : [];
  const parts = [];
  parts.push(`<defs>
    <linearGradient id="shopBg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#ff9a9e"/>
      <stop offset="42%" stop-color="#fad0c4"/>
      <stop offset="100%" stop-color="#a18cd1"/>
    </linearGradient>
    <linearGradient id="sheetGrad" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="rgba(255,255,255,0.94)"/>
      <stop offset="100%" stop-color="rgba(255,255,255,0.82)"/>
    </linearGradient>
    <linearGradient id="priceGrad" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#ff7043"/>
      <stop offset="100%" stop-color="#ec407a"/>
    </linearGradient>
    <linearGradient id="priceDownGrad" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#43a047"/>
      <stop offset="100%" stop-color="#2e7d32"/>
    </linearGradient>
    <filter id="softBlob" x="-40%" y="-40%" width="180%" height="180%">
      <feGaussianBlur stdDeviation="42"/>
    </filter>
  </defs>`);
  parts.push(`<rect x="0" y="0" width="${width}" height="${height}" fill="url(#shopBg)"/>`);
  parts.push(`<circle cx="${width - 70}" cy="60" r="170" fill="#fff3e0" opacity="0.35" filter="url(#softBlob)"/>`);
  parts.push(`<circle cx="50" cy="${height - 30}" r="150" fill="#e1bee7" opacity="0.32" filter="url(#softBlob)"/>`);
  const sheetX = pad;
  const sheetY = pad;
  const sheetW = width - pad * 2;
  const sheetH = height - pad * 2 - (hint ? 12 : 0);
  parts.push(
    `<rect x="${sheetX}" y="${sheetY}" width="${sheetW}" height="${sheetH}" rx="28" ry="28" fill="url(#sheetGrad)" stroke="rgba(255,255,255,0.75)" stroke-width="2"/>`
  );
  parts.push(
    `<text x="${sheetX + 36}" y="${sheetY + 56}" font-family="${font}" font-size="40" font-weight="900" fill="#2d2430">${title}</text>`
  );
  if (subtitle) {
    parts.push(
      `<text x="${sheetX + 36}" y="${sheetY + 90}" font-family="${font}" font-size="18" fill="rgba(45,36,48,0.55)">${subtitle}</text>`
    );
  }
  const headY = sheetY + 126;
  parts.push(
    `<text x="${sheetX + 36}" y="${headY}" font-family="${font}" font-size="15" font-weight="700" fill="rgba(45,36,48,0.4)" letter-spacing="1">商品</text>`
  );
  parts.push(
    `<text x="${sheetX + sheetW * 0.46}" y="${headY}" font-family="${font}" font-size="15" font-weight="700" fill="rgba(45,36,48,0.4)" letter-spacing="1">限购</text>`
  );
  parts.push(
    `<text x="${sheetX + sheetW - 36}" y="${headY}" text-anchor="end" font-family="${font}" font-size="15" font-weight="700" fill="rgba(45,36,48,0.4)" letter-spacing="1">今日价</text>`
  );
  parts.push(
    `<line x1="${sheetX + 28}" y1="${headY + 14}" x2="${sheetX + sheetW - 28}" y2="${headY + 14}" stroke="rgba(45,36,48,0.08)" stroke-width="1.5"/>`
  );
  const rowH = 108;
  const rowStart = headY + 28;
  items.forEach((item, i) => {
    const y = rowStart + i * rowH;
    const soldOut = !!item.soldOut;
    const name = escapeXml$5(truncateText$3(item.name, 8));
    const modeLabel = escapeXml$5(truncateText$3(item.modeLabel, 6));
    const priceNum = String(item.price || "-").replace(/[^\d.-]/g, "").trim();
    const price = escapeXml$5(priceNum);
    const baseNum = String(item.basePrice || "").replace(/[^\d.-]/g, "").trim();
    escapeXml$5(baseNum);
    const trend = item.trend === "down" ? "down" : item.trend === "same" ? "same" : "up";
    const limitText = escapeXml$5(item.limitText || "-");
    const remainText = escapeXml$5(item.remainText || "-");
    if (i % 2 === 0) {
      parts.push(
        `<rect x="${sheetX + 18}" y="${y}" width="${sheetW - 36}" height="${rowH - 12}" rx="18" fill="rgba(255,107,138,0.06)"/>`
      );
    }
    parts.push(
      `<text x="${sheetX + 48}" y="${y + 46}" font-family="${font}" font-size="18" font-weight="800" fill="rgba(255,107,138,0.75)">${String(i + 1).padStart(2, "0")}</text>`
    );
    parts.push(
      `<text x="${sheetX + 84}" y="${y + 40}" font-family="${font}" font-size="28" font-weight="900" fill="#2d2430">${name}</text>`
    );
    const badgeW = Math.max(72, modeLabel.length * 16 + 28);
    parts.push(
      `<rect x="${sheetX + 84}" y="${y + 54}" width="${badgeW}" height="28" rx="14" fill="rgba(139,124,246,0.14)"/>`
    );
    parts.push(
      `<text x="${sheetX + 84 + badgeW / 2}" y="${y + 74}" text-anchor="middle" font-family="${font}" font-size="14" font-weight="700" fill="#6a5acd">${modeLabel}</text>`
    );
    parts.push(
      `<text x="${sheetX + sheetW * 0.46}" y="${y + 40}" font-family="${font}" font-size="17" fill="rgba(45,36,48,0.55)">${limitText}</text>`
    );
    parts.push(
      `<text x="${sheetX + sheetW * 0.46}" y="${y + 72}" font-family="${font}" font-size="22" font-weight="800" fill="${soldOut ? "#e53935" : "#43a047"}">${remainText}</text>`
    );
    const priceRight = sheetX + sheetW - 36;
    const priceColor = trend === "down" ? "url(#priceDownGrad)" : "url(#priceGrad)";
    if (trend === "down" && baseNum && baseNum !== priceNum) {
      const strike = escapeXml$5(baseNum);
      const strikeApproxW = baseNum.length * 12 + 4;
      const strikeX = priceRight - Math.max(120, priceNum.length * 18) - 16 - strikeApproxW;
      parts.push(
        `<text x="${strikeX}" y="${y + 48}" font-family="${font}" font-size="18" font-weight="600" fill="rgba(45,36,48,0.38)">${strike}</text>`
      );
      parts.push(
        `<line x1="${strikeX - 2}" y1="${y + 42}" x2="${strikeX + strikeApproxW}" y2="${y + 42}" stroke="rgba(45,36,48,0.45)" stroke-width="2"/>`
      );
      parts.push(
        `<text x="${priceRight}" y="${y + 50}" text-anchor="end" font-family="${font}" font-size="34" font-weight="900" fill="${priceColor}">${price}</text>`
      );
      parts.push(
        `<text x="${priceRight}" y="${y + 76}" text-anchor="end" font-family="${font}" font-size="14" fill="#43a047" font-weight="700">${货币单位} · 降价</text>`
      );
    } else {
      parts.push(
        `<text x="${priceRight}" y="${y + 50}" text-anchor="end" font-family="${font}" font-size="34" font-weight="900" fill="${priceColor}">${price}</text>`
      );
      if (trend === "up") {
        const arrowX = priceRight - Math.max(70, priceNum.length * 18) - 28;
        parts.push(
          `<path d="M ${arrowX} ${y + 54} L ${arrowX + 10} ${y + 38} L ${arrowX + 20} ${y + 54} Z" fill="#ec407a"/>`
        );
        parts.push(
          `<rect x="${arrowX + 7}" y="${y + 54}" width="6" height="12" rx="1" fill="#ec407a"/>`
        );
        parts.push(
          `<text x="${priceRight}" y="${y + 76}" text-anchor="end" font-family="${font}" font-size="14" fill="rgba(45,36,48,0.4)">${货币单位}</text>`
        );
      } else {
        parts.push(
          `<text x="${priceRight}" y="${y + 76}" text-anchor="end" font-family="${font}" font-size="14" fill="rgba(45,36,48,0.4)">${货币单位}</text>`
        );
      }
    }
  });
  if (hint) {
    parts.push(
      `<text x="${width / 2}" y="${height - 18}" text-anchor="middle" font-family="${font}" font-size="15" fill="rgba(255,255,255,0.88)">${hint}</text>`
    );
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${parts.join("\n")}</svg>`;
}
async function renderShopWithSharpImpl(options, logger) {
  const items = Array.isArray(options.items) ? options.items : [];
  const width = options.width ?? 1280;
  const headerBlock = 40 + 126 + 28;
  const rowBlock = Math.max(1, items.length) * 108;
  const height = Math.max(420, headerBlock + rowBlock + 64);
  try {
    const sharp = await loadSharp();
    const svg = buildShopSvg(width, height, options);
    const out = await sharp(Buffer.from(svg)).png(MK_PNG_OUT()).toBuffer();
    return out.toString("base64");
  } catch (error) {
    error instanceof Error ? error.message : String(error);
    return null;
  }
}

const FISH_BASKET_PER_PAGE = 100;
const COLUMN_COUNT = 3;
function escapeXml$4(text) {
  return String(text ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
function truncateText$2(text, maxLen) {
  const s = String(text || "").trim();
  if (s.length <= maxLen) return s;
  return `${s.slice(0, maxLen - 1)}…`;
}
function formatWeight(w) {
  const n = Number(w);
  if (!Number.isFinite(n)) return "0kg";
  const s = n.toFixed(3).replace(/\.?0+$/, "");
  return `${s}kg`;
}
async function loadFishBasketBackground(bgLocalPath, pluginDir, dataPath) {
  const candidates = [];
  const push = (v) => {
    const s = String(v || "").trim();
    if (s && !candidates.includes(s)) candidates.push(s);
  };
  push(bgLocalPath);
  const localNames = ["运势13.png", "运势13.jpg", "运势13.jpeg", "运势13.webp"];
  const roots = [
    path.join(String(pluginDir || "").trim(), "默认资源", "image"),
    path.join(String(dataPath || "").trim(), "默认资源", "image")
  ];
  for (const root of roots) {
    if (!String(root || "").trim()) continue;
    for (const name of localNames) {
      push(path.join(root, name));
    }
  }
  for (const src of candidates) {
    try {
      if (fs.existsSync(src) && fs.statSync(src).isFile()) {
        return fs.readFileSync(src);
      }
    } catch {
    }
  }
  return null;
}
async function fitCompositeLayer$1(sharp, input, width, height) {
  return svgCompositeLayer(sharp, input, width, height);
}
function pickDensity(_recordCount) {
  return { width: 2100, rowH: 28, categoryH: 32, tierH: 36, colHeadH: 30, nameSize: 14, cellSize: 13, colGap: 18 };
}
function buildFishBasketRenderLines(items, rankOffset = 0) {
  const capped = items.slice(0, FISH_BASKET_PER_PAGE);
  const groupMap = /* @__PURE__ */ new Map();
  for (const item of capped) {
    const list = groupMap.get(item.name) || [];
    list.push(item);
    groupMap.set(item.name, list);
  }
  const groups = [...groupMap.entries()].map(([name, rows]) => {
    const sortedRows = [...rows].sort((a, b) => b.weight - a.weight || b.count - a.count);
    const subCount = sortedRows.reduce((s, r) => s + r.count, 0);
    const subTotal = sortedRows.reduce((s, r) => s + r.totalPrice, 0);
    return {
      name,
      tier: sortedRows.some((r) => r.tier === "premium") ? "premium" : "normal",
      maxWeight: Math.max(...sortedRows.map((r) => r.weight)),
      rows: sortedRows,
      subCount,
      subTotal
    };
  }).sort((a, b) => b.maxWeight - a.maxWeight || a.name.localeCompare(b.name, "zh-CN"));
  const lines = [];
  let lastTier = "";
  let rank = rankOffset;
  for (const g of groups) {
    if (g.tier !== lastTier) {
      lines.push({ type: "tier", tier: g.tier });
      lastTier = g.tier;
    }
    const rowEntries = [];
    for (const item of g.rows) {
      rank += 1;
      rowEntries.push({ item, rank });
    }
    lines.push({
      type: "category",
      name: g.name,
      tier: g.tier,
      subCount: g.subCount,
      subTotal: g.subTotal,
      rows: rowEntries
    });
  }
  return lines;
}
function estimateCategoryBlockHeight(cat, density) {
  return density.categoryH + cat.rows.length * density.rowH + 8;
}
function estimateCategoryStride(cat, density) {
  return estimateCategoryBlockHeight(cat, density) + 8;
}
function distributeCategoriesToColumns(categories, density) {
  const cols = Array.from({ length: COLUMN_COUNT }, () => []);
  const heights = new Array(COLUMN_COUNT).fill(0);
  for (const cat of categories) {
    const h = estimateCategoryStride(cat, density);
    let minIdx = 0;
    for (let i = 1; i < COLUMN_COUNT; i += 1) {
      if (heights[i] < heights[minIdx]) minIdx = i;
    }
    cols[minIdx].push(cat);
    heights[minIdx] += h;
  }
  return cols;
}
function rowHighlightKind(rank, tier) {
  if (rank === 1) return "rank1";
  if (rank === 2) return "rank2";
  if (rank === 3) return "rank3";
  return tier === "premium" ? "premium" : "normal";
}
function nameTextAttr(kind, size = 13) {
  const map = {
    rank1: { fill: "url(#rank1Grad)", filter: "url(#glowRank1)" },
    rank2: { fill: "url(#rank2Grad)", filter: "url(#glowRank2)" },
    rank3: { fill: "url(#rank3Grad)", filter: "url(#glowRank3)" },
    premium: { fill: "url(#premiumGrad)", filter: "url(#glowPremium)" },
    normal: { fill: "url(#normalGrad)", filter: "url(#glowNormal)" }
  };
  const s = map[kind] || { fill: "#ffffff", filter: "" };
  const filterAttr = s.filter ? ` filter="${s.filter}"` : "";
  return `font-size="${size}" font-weight="800" fill="${s.fill}"${filterAttr}`;
}
function renderCategoryBlock(cat, x, y, colW, density, font, mainFill) {
  const parts = [];
  const pad = 8;
  const innerW = colW - pad * 2;
  const tag = cat.tier === "premium" ? "珍" : "常";
  const tagColor = cat.tier === "premium" ? "#FFD54F" : "#80DEEA";
  const blockH = estimateCategoryBlockHeight(cat, density);
  const stride = estimateCategoryStride(cat, density);
  parts.push(
    `<rect x="${x}" y="${y}" width="${colW}" height="${blockH}" rx="10" fill="rgba(255,255,255,0.10)" stroke="rgba(255,255,255,0.28)" stroke-width="1"/>`
  );
  parts.push(
    `<rect x="${x}" y="${y}" width="4" height="${blockH}" rx="2" fill="${tagColor}" opacity="0.85"/>`
  );
  const headY = y + density.categoryH - 9;
  parts.push(
    `<text x="${x + pad + 4}" y="${headY}" font-family="${font}" font-size="${density.nameSize}" font-weight="900" fill="${mainFill}">${escapeXml$4(truncateText$2(cat.name, 8))} · ${tag} · ${cat.subCount}条 · ${cat.subTotal}</text>`
  );
  let rowY = y + density.categoryH;
  for (let i = 0; i < cat.rows.length; i += 1) {
    const { item, rank } = cat.rows[i];
    if (i % 2 === 0) {
      parts.push(
        `<rect x="${x + pad}" y="${rowY}" width="${innerW}" height="${density.rowH}" rx="4" fill="rgba(255,255,255,0.05)"/>`
      );
    }
    const ty = rowY + density.rowH - 7;
    const rankColor = rank <= 3 ? ["#FFD700", "#C0C0C0", "#CD7F32"][rank - 1] : "rgba(255,255,255,0.55)";
    const hl = rowHighlightKind(rank, item.tier);
    parts.push(
      `<text x="${x + pad + 4}" y="${ty}" font-family="${font}" font-size="${density.cellSize}" font-weight="700" fill="${rankColor}">#${rank}</text>`
    );
    parts.push(
      `<text x="${x + pad + 34}" y="${ty}" font-family="${font}" ${nameTextAttr(hl, density.cellSize + 1)}>${formatWeight(item.weight)}</text>`
    );
    parts.push(
      `<text x="${x + pad + 98}" y="${ty}" font-family="${font}" font-size="${density.cellSize}" font-weight="700" fill="${mainFill}">×${item.count}</text>`
    );
    parts.push(
      `<text x="${x + colW - pad - 4}" y="${ty}" text-anchor="end" font-family="${font}" font-size="${density.cellSize}" font-weight="700" fill="rgba(255,255,255,0.92)">${item.totalPrice}</text>`
    );
    rowY += density.rowH;
  }
  return { parts, height: stride };
}
function renderColumnCategories(categories, x, startY, colW, density, font, mainFill) {
  const parts = [];
  let y = startY;
  for (const cat of categories) {
    const block = renderCategoryBlock(cat, x, y, colW, density, font, mainFill);
    parts.push(...block.parts);
    y += block.height;
  }
  return { parts, height: y - startY };
}
function calcFishBasketCanvasHeight(lines, density) {
  const pad = 24;
  const headerH = 188;
  const footerH = 56;
  const safety = 32;
  let bodyH = 0;
  let tierCats = [];
  const flushTier = () => {
    if (!tierCats.length) return;
    bodyH += density.tierH + 8;
    const cols = distributeCategoriesToColumns(tierCats, density);
    const colHeights = cols.map(
      (cats) => cats.reduce((s, c) => s + estimateCategoryStride(c, density), 0)
    );
    bodyH += Math.max(...colHeights, 0) + 12;
    tierCats = [];
  };
  for (const line of lines) {
    if (line.type === "tier") {
      flushTier();
    } else if (line.type === "category") {
      tierCats.push(line);
    }
  }
  flushTier();
  return pad * 2 + headerH + bodyH + footerH + safety;
}
function buildFishBasketSvg(width, height, opts, lines, density, customText) {
  const 货币单位 = escapeXml$4(opts.货币名 || "归笺");
  const font = "Microsoft YaHei, Noto Sans SC, sans-serif";
  const mainFill = resolveSharpTextFill(customText, "#ffffff");
  const pad = 24;
  const headerH = 188;
  const cardX = pad;
  const cardY = pad;
  const cardW = width - pad * 2;
  const cardH = height - pad * 2;
  const innerX = cardX + 20;
  const contentW = cardW - 40;
  const userName = escapeXml$4(truncateText$2(opts.userName || "旅人", 14));
  const userId = escapeXml$4(String(opts.userId || ""));
  const time = escapeXml$4(opts.time || "");
  const totalValue = escapeXml$4(String(opts.totalValue || `0${货币单位}`));
  const colW = Math.floor((contentW - density.colGap * (COLUMN_COUNT - 1)) / COLUMN_COUNT);
  const parts = [];
  parts.push(`<defs>

    <linearGradient id="rank1Grad" x1="0%" y1="0%" x2="100%" y2="0%">

      <stop offset="0%" stop-color="#ffe082"/><stop offset="100%" stop-color="#ff6f00"/>

    </linearGradient>

    <linearGradient id="rank2Grad" x1="0%" y1="0%" x2="100%" y2="0%">

      <stop offset="0%" stop-color="#f5f5f5"/><stop offset="100%" stop-color="#90a4ae"/>

    </linearGradient>

    <linearGradient id="rank3Grad" x1="0%" y1="0%" x2="100%" y2="0%">

      <stop offset="0%" stop-color="#ffccbc"/><stop offset="100%" stop-color="#bf360c"/>

    </linearGradient>

    <linearGradient id="premiumGrad" x1="0%" y1="0%" x2="100%" y2="0%">

      <stop offset="0%" stop-color="#ffd54f"/><stop offset="100%" stop-color="#ff8f00"/>

    </linearGradient>

    <linearGradient id="normalGrad" x1="0%" y1="0%" x2="100%" y2="0%">

      <stop offset="0%" stop-color="#80deea"/><stop offset="100%" stop-color="#0097a7"/>

    </linearGradient>

    <linearGradient id="statGrad" x1="0%" y1="0%" x2="100%" y2="0%">

      <stop offset="0%" stop-color="#e8f4ff"/><stop offset="100%" stop-color="#9ec9e8"/>

    </linearGradient>

    <filter id="titleGlow" x="-30%" y="-30%" width="160%" height="160%">

      <feDropShadow dx="0" dy="0" stdDeviation="2" flood-color="#ffffff" flood-opacity="0.9"/>

      <feDropShadow dx="0" dy="2" stdDeviation="5" flood-color="#8eb8d8" flood-opacity="0.45"/>

    </filter>

    <filter id="glowRank1" x="-35%" y="-35%" width="170%" height="170%">

      <feDropShadow dx="0" dy="0" stdDeviation="3" flood-color="#ffd54f" flood-opacity="0.75"/>

    </filter>

    <filter id="glowRank2" x="-35%" y="-35%" width="170%" height="170%">

      <feDropShadow dx="0" dy="0" stdDeviation="3" flood-color="#eceff1" flood-opacity="0.7"/>

    </filter>

    <filter id="glowRank3" x="-35%" y="-35%" width="170%" height="170%">

      <feDropShadow dx="0" dy="0" stdDeviation="3" flood-color="#ffab91" flood-opacity="0.7"/>

    </filter>

    <filter id="glowPremium" x="-35%" y="-35%" width="170%" height="170%">

      <feDropShadow dx="0" dy="0" stdDeviation="3" flood-color="#ffca28" flood-opacity="0.75"/>

    </filter>

    <filter id="glowNormal" x="-35%" y="-35%" width="170%" height="170%">

      <feDropShadow dx="0" dy="0" stdDeviation="3" flood-color="#4dd0e1" flood-opacity="0.7"/>

    </filter>

  </defs>`);
  parts.push(
    `<rect x="${cardX}" y="${cardY}" width="${cardW}" height="${cardH}" rx="20" fill="rgba(255,255,255,0.12)" stroke="rgba(255,255,255,0.28)" stroke-width="1.5"/>`
  );
  let curY = cardY + 34;
  parts.push(
    `<text x="${innerX}" y="${curY}" font-family="${font}" font-size="32" font-weight="900" fill="${mainFill}" filter="url(#titleGlow)">我的鱼篓</text>`
  );
  parts.push(
    `<text x="${innerX}" y="${curY + 26}" font-family="${font}" font-size="13" fill="rgba(255,255,255,0.82)">${userName} · QQ ${userId}</text>`
  );
  if (time) {
    parts.push(
      `<text x="${cardX + cardW - 20}" y="${curY}" text-anchor="end" font-family="${font}" font-size="12" fill="rgba(255,255,255,0.65)">${time}</text>`
    );
  }
  const pageIndex = Math.max(1, Number(opts.pageIndex) || 1);
  const pageTotal = Math.max(1, Number(opts.pageTotal) || 1);
  parts.push(
    `<text x="${cardX + cardW - 20}" y="${curY + 22}" text-anchor="end" font-family="${font}" font-size="11" fill="rgba(255,255,255,0.5)">第 ${pageIndex}/${pageTotal} 页 · 三列 · 从重到轻</text>`
  );
  curY += 46;
  const statW = (contentW - 30) / 4;
  const stats = [
    { label: "总条数", value: `${opts.totalCount} 条` },
    { label: "总价值", value: totalValue },
    { label: "鱼种类", value: `${opts.categoryCount} 类` },
    { label: "规格记录", value: `${opts.recordCount} 条` }
  ];
  stats.forEach((st, i) => {
    const x = innerX + i * (statW + 10);
    parts.push(
      `<rect x="${x}" y="${curY}" width="${statW}" height="56" rx="12" fill="rgba(255,255,255,0.12)" stroke="rgba(255,255,255,0.28)" stroke-width="1"/>`
    );
    parts.push(
      `<text x="${x + 12}" y="${curY + 20}" font-family="${font}" font-size="11" fill="rgba(255,255,255,0.65)">${escapeXml$4(st.label)}</text>`
    );
    parts.push(
      `<text x="${x + 12}" y="${curY + 42}" font-family="${font}" font-size="16" font-weight="900" fill="url(#statGrad)" filter="url(#titleGlow)">${escapeXml$4(st.value)}</text>`
    );
  });
  curY = cardY + headerH;
  let tierCats = [];
  let pendingTier = null;
  const flushTierSection = () => {
    if (!tierCats.length || !pendingTier) return;
    const label = pendingTier === "premium" ? "◆ 高级渔获区" : "◇ 普通渔获区";
    const fill = pendingTier === "premium" ? "rgba(255,193,7,0.22)" : "rgba(255,255,255,0.14)";
    const stroke = pendingTier === "premium" ? "rgba(255,213,79,0.45)" : "rgba(255,255,255,0.28)";
    parts.push(`<rect x="${innerX}" y="${curY}" width="${contentW}" height="${density.tierH}" rx="8" fill="${fill}" stroke="${stroke}" stroke-width="1"/>`);
    parts.push(
      `<text x="${innerX + 14}" y="${curY + density.tierH - 11}" font-family="${font}" font-size="${density.nameSize + 1}" font-weight="900" fill="${mainFill}">${label}</text>`
    );
    curY += density.tierH + 8;
    const cols = distributeCategoriesToColumns(tierCats, density);
    const colStarts = cols.map((_, idx) => innerX + idx * (colW + density.colGap));
    const colRendered = cols.map(
      (cats, idx) => renderColumnCategories(cats, colStarts[idx], curY, colW, density, font, mainFill)
    );
    const maxColH = Math.max(...colRendered.map((c) => c.height), 0);
    for (const col of colRendered) {
      parts.push(...col.parts);
    }
    curY += maxColH + 12;
    tierCats = [];
    pendingTier = null;
  };
  for (const line of lines) {
    if (line.type === "tier") {
      flushTierSection();
      pendingTier = line.tier;
    } else if (line.type === "category") {
      tierCats.push(line);
    }
  }
  flushTierSection();
  parts.push(
    `<text x="${width / 2}" y="${cardY + cardH - 14}" text-anchor="middle" font-family="${font}" font-size="10" fill="rgba(255,255,255,0.42)">${escapeXml$4("MK-Bot · 出售: 出售 全部鱼 / 出售 鱼名(重量kg) [数量]")}</text>`
  );
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${parts.join("\n")}</svg>`;
}
async function renderFishBasketWithSharpImpl(options, logger) {
  const displayItems = (options.items || []).slice(0, FISH_BASKET_PER_PAGE);
  const density = pickDensity(displayItems.length);
  const width = options.width ?? density.width;
  const rankOffset = Math.max(0, Number(options.rankOffset) || 0);
  const lines = buildFishBasketRenderLines(displayItems, rankOffset);
  const height = calcFishBasketCanvasHeight(lines, density);
  const pluginDir = String(options.pluginDir || "").trim();
  const dataPath = String(options.dataPath || "").trim();
  const bgLocalPath = String(options.bgLocalPath || "").trim();
  try {
    const sharp = await loadSharp();
    const composites = [];
    const bgBuf = await loadFishBasketBackground(bgLocalPath, pluginDir, dataPath);
    if (bgBuf && bgBuf.length > 0) {
      await applySharpPhotoBackgroundLayers(sharp, composites, bgBuf, width, height, dataPath);
    } else {
      const fallback = await sharp({
        create: {
          width,
          height,
          channels: 4,
          background: { r: 22, g: 28, b: 38, alpha: 1 }
        }
      }).png(MK_PNG_OUT()).toBuffer();
      composites.push({ input: fallback, top: 0, left: 0 });
      logger?.warn?.("[Sharp渲染] 我的鱼篓背景图不可用，已使用默认底色");
    }
    const svg = buildFishBasketSvg(width, height, options, lines, density, loadSharpTextColorFromDataPath(dataPath));
    const uiLayer = await fitCompositeLayer$1(sharp, Buffer.from(svg), width, height);
    composites.push({ input: uiLayer, top: 0, left: 0 });
    const out = await sharp({
      create: {
        width,
        height,
        channels: 4,
        background: { r: 18, g: 22, b: 30, alpha: 1 }
      }
    }).composite(composites).png({ compressionLevel: 6 }).toBuffer();
    return out.toString("base64");
  } catch (error) {
    error instanceof Error ? error.message : String(error);
    return null;
  }
}

async function fetchQqAvatarBuffer(qq) {
  const id = String(qq ?? "").trim();
  if (!id || !/^\d{5,12}$/.test(id)) return null;
  const url = `https://q1.qlogo.cn/g?b=qq&nk=${id}&s=5`;
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(5e3),
      headers: { "User-Agent": "Mozilla/5.0" }
    });
    if (!res.ok) return null;
    const ab = await res.arrayBuffer();
    if (!ab || ab.byteLength < 32) return null;
    return Buffer.from(ab);
  } catch {
    return null;
  }
}
async function fetchUrlImageBuffer(url) {
  const u = String(url ?? "").trim();
  if (!/^https?:\/\//i.test(u)) return null;
  try {
    const res = await fetch(u, {
      signal: AbortSignal.timeout(8e3),
      headers: { "User-Agent": "Mozilla/5.0" }
    });
    if (!res.ok) return null;
    const ab = await res.arrayBuffer();
    if (!ab || ab.byteLength < 32) return null;
    return Buffer.from(ab);
  } catch {
    return null;
  }
}
async function prepareAvatarPng(sharp, avatarBuf, options = {}) {
  const circle = options.circle !== false;
  const size = Math.max(0, Math.floor(Number(options.size) || 0));
  const meta = await sharp(avatarBuf).metadata();
  const aw = Number(meta.width) || 0;
  const ah = Number(meta.height) || 0;
  let pipeline = sharp(avatarBuf).rotate().ensureAlpha();
  if (aw > 0 && ah > 0 && aw !== ah) {
    const side2 = Math.min(aw, ah);
    const left = Math.floor((aw - side2) / 2);
    const top = Math.floor((ah - side2) / 2);
    pipeline = sharp(avatarBuf).rotate().extract({ left, top, width: side2, height: side2 }).ensureAlpha();
  }
  if (size > 0) {
    pipeline = pipeline.resize(size, size, { fit: "fill", kernel: "lanczos3" });
  }
  let png = await pipeline.png(MK_PNG_OUT()).toBuffer();
  if (!circle) return png;
  const info = await sharp(png).metadata();
  const side = Math.max(1, Number(info.width) || size || 100);
  const mask = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${side}" height="${side}"><circle cx="${side / 2}" cy="${side / 2}" r="${side / 2}" fill="white"/></svg>`
  );
  return sharp(png).ensureAlpha().composite([{ input: mask, blend: "dest-in" }]).png(MK_PNG_OUT()).toBuffer();
}
async function prepareAvatarOvalFitPng(sharp, avatarBuf, maxW, maxH) {
  const png = await sharp(avatarBuf).rotate().resize(maxW, maxH, { fit: "inside", kernel: "linear" }).ensureAlpha().png(MK_PNG_OUT()).toBuffer();
  const info = await sharp(png).metadata();
  const w = Math.max(1, Number(info.width) || maxW);
  const h = Math.max(1, Number(info.height) || maxH);
  const mask = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><ellipse cx="${w / 2}" cy="${h / 2}" rx="${w / 2}" ry="${h / 2}" fill="white"/></svg>`
  );
  return sharp(png).ensureAlpha().composite([{ input: mask, blend: "dest-in" }]).png(MK_PNG_OUT()).toBuffer();
}
async function composeAvatarUnderTemplate(sharp, templatePath2, avatarPng, loc) {
  const tplMeta = await sharp(templatePath2).metadata();
  const cw = Math.max(1, Number(tplMeta.width) || 1);
  const ch = Math.max(1, Number(tplMeta.height) || 1);
  const w = Math.max(1, Math.floor(loc.w));
  const h = Math.max(1, Math.floor(loc.h));
  const x = Math.floor(loc.x);
  const y = Math.floor(loc.y);
  const avatarResized = await sharp(avatarPng).resize(w, h, { fit: "fill", kernel: "linear" }).png(MK_PNG_OUT()).toBuffer();
  const templatePng = await sharp(templatePath2).ensureAlpha().png(MK_PNG_OUT()).toBuffer();
  return sharp({
    create: {
      width: cw,
      height: ch,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    }
  }).composite([
    { input: avatarResized, left: x, top: y },
    { input: templatePng, left: 0, top: 0 }
  ]).png(MK_PNG_OUT()).toBuffer();
}
async function composeAvatarOverTemplate(sharp, templatePath2, avatarPng, loc) {
  const w = Math.max(1, Math.floor(loc.w));
  const h = Math.max(1, Math.floor(loc.h));
  const x = Math.floor(loc.x);
  const y = Math.floor(loc.y);
  const avatarResized = await sharp(avatarPng).resize(w, h, { fit: "fill", kernel: "linear" }).png(MK_PNG_OUT()).toBuffer();
  return sharp(templatePath2).ensureAlpha().composite([{ input: avatarResized, left: x, top: y }]).png(MK_PNG_OUT()).toBuffer();
}
async function composeAvatarOnWhiteWithTemplate(sharp, templatePath2, avatarPng, loc) {
  const tplMeta = await sharp(templatePath2).metadata();
  const cw = Math.max(1, Number(tplMeta.width) || 1);
  const ch = Math.max(1, Number(tplMeta.height) || 1);
  const w = Math.max(1, Math.floor(loc.w));
  const h = Math.max(1, Math.floor(loc.h));
  const x = Math.floor(loc.x);
  const y = Math.floor(loc.y);
  const avatarResized = await sharp(avatarPng).resize(w, h, { fit: "fill", kernel: "linear" }).png(MK_PNG_OUT()).toBuffer();
  const templatePng = await sharp(templatePath2).ensureAlpha().png(MK_PNG_OUT()).toBuffer();
  return sharp({
    create: {
      width: cw,
      height: ch,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 1 }
    }
  }).composite([
    { input: avatarResized, left: x, top: y },
    { input: templatePng, left: 0, top: 0 }
  ]).png(MK_PNG_OUT()).toBuffer();
}
async function composeRubFrame(sharp, templatePath2, selfAvatarPng, targetAvatarPng, targetLoc, selfLoc) {
  const targetResized = await sharp(targetAvatarPng).resize(Math.max(1, Math.floor(targetLoc.w)), Math.max(1, Math.floor(targetLoc.h)), {
    fit: "fill",
    kernel: "lanczos3"
  }).png(MK_PNG_OUT()).toBuffer();
  let selfPipeline = sharp(selfAvatarPng).resize(
    Math.max(1, Math.floor(selfLoc.w)),
    Math.max(1, Math.floor(selfLoc.h)),
    { fit: "fill", kernel: "lanczos3" }
  );
  const angle = Number(selfLoc.angle) || 0;
  if (angle !== 0) {
    selfPipeline = selfPipeline.rotate(angle, { background: { r: 0, g: 0, b: 0, alpha: 0 } });
  }
  const selfResized = await selfPipeline.png(MK_PNG_OUT()).toBuffer();
  return sharp(templatePath2).ensureAlpha().composite([
    { input: targetResized, left: Math.floor(targetLoc.x), top: Math.floor(targetLoc.y) },
    { input: selfResized, left: Math.floor(selfLoc.x), top: Math.floor(selfLoc.y) }
  ]).png(MK_PNG_OUT()).toBuffer();
}
async function encodeGifFromPngFrames(sharp, frames, delayMs) {
  if (!frames.length) throw new Error("bqb: empty gif frames");
  const firstMeta = await sharp(frames[0]).metadata();
  const fw = Math.max(1, Number(firstMeta.width) || 1);
  const fh = Math.max(1, Number(firstMeta.height) || 1);
  const normalized = [];
  for (const frame of frames) {
    normalized.push(
      await sharp(frame).ensureAlpha().resize(fw, fh, { fit: "fill" }).png(MK_PNG_OUT()).toBuffer()
    );
  }
  const delays = Array.isArray(delayMs) ? delayMs.map((d) => Math.max(20, Math.floor(d))) : Math.max(20, Math.floor(delayMs));
  return sharp({
    create: {
      width: fw,
      height: fh * normalized.length,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
      pageHeight: fh
    }
  }).composite(normalized.map((input, i) => ({ input, left: 0, top: i * fh }))).gif({
    delay: delays,
    loop: 0,
    effort: 1
  }).toBuffer();
}
async function getBqbSharp() {
  return loadSharp();
}
function resolveBqbSubdir(kind, dataPath, pluginDir) {
  const rel = path.join("默认资源", "image", "api", "bqb", kind);
  const pluginDirSafe = String(pluginDir || "").trim();
  const candidates = [
    path.join(pluginDirSafe, rel)
  ];
  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p;
  }
  return candidates[0] || "";
}
function templatePath(dir, index, ext, pad = 0) {
  const name = pad > 0 ? `${String(index).padStart(pad, "0")}.${ext}` : `${index}.${ext}`;
  return path.join(dir, name);
}

const MUSIC_LIST_MAX_ITEMS = 20;
function escapeXml$3(text) {
  return String(text ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
function truncateText$1(text, maxLen) {
  const s = String(text || "").trim();
  if (s.length <= maxLen) return s;
  return `${s.slice(0, maxLen - 1)}…`;
}
async function loadMusicListBackground(bgLocalPath, pluginDir, dataPath) {
  const candidates = [];
  const push = (v) => {
    const s = String(v || "").trim();
    if (s && !candidates.includes(s)) candidates.push(s);
  };
  push(bgLocalPath);
  const roots = [
    path.join(String(pluginDir || "").trim(), "默认资源", "image"),
    path.join(String(dataPath || "").trim(), "默认资源", "image")
  ];
  for (const root of roots) {
    if (!root.trim()) continue;
    push(path.join(root, "运势6.png"));
  }
  for (const src of candidates) {
    try {
      const abs = path.isAbsolute(src) ? src : path.resolve(src);
      if (fs.existsSync(abs)) {
        const buf = fs.readFileSync(abs);
        if (buf.length > 0) return buf;
      }
    } catch {
    }
  }
  return null;
}
async function roundCover(sharp, buf, size) {
  try {
    const mask = Buffer.from(
      `<svg width="${size}" height="${size}"><rect x="0" y="0" width="${size}" height="${size}" rx="12" ry="12" fill="white"/></svg>`
    );
    return sharp(buf).resize(size, size, { fit: "cover" }).ensureAlpha().composite([{ input: mask, blend: "dest-in" }]).png(MK_PNG_OUT()).toBuffer();
  } catch {
    return null;
  }
}
async function makeFallbackCover(sharp, size) {
  return sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: { r: 80, g: 90, b: 110, alpha: 0.85 }
    }
  }).png(MK_PNG_OUT()).toBuffer();
}
function buildMusicListSvg(width, height, opts) {
  const font = "Microsoft YaHei, Noto Sans SC, sans-serif";
  const { source, query, count, items, rowH, coverSize, padX, headerH, customText } = opts;
  const titleFill = resolveSharpTextFill(customText, "#fff6e8");
  const subFill = resolveSharpTextFill(customText, "rgba(255,255,255,0.88)");
  const idxFill = resolveSharpTextFill(customText, "#fff3dc");
  const mainFill = resolveSharpTextFill(customText, "#fff8ee");
  const parts = [];
  parts.push(
    `<text x="${width / 2}" y="48" text-anchor="middle" font-family="${font}" font-size="36" font-weight="800" fill="${titleFill}">点歌列表</text>`
  );
  parts.push(
    `<text x="${width / 2}" y="78" text-anchor="middle" font-family="${font}" font-size="16" fill="${subFill}">【${escapeXml$3(source)}】共 ${count} 首${query ? ` · ${escapeXml$3(truncateText$1(query, 18))}` : ""}</text>`
  );
  const listTop = headerH;
  const listLeft = padX;
  const listW = width - padX * 2;
  const listH = items.length * rowH + 16;
  parts.push(
    `<rect x="${listLeft}" y="${listTop}" width="${listW}" height="${listH}" rx="20" ry="20" fill="rgba(0,0,0,0.28)" stroke="rgba(255,255,255,0.22)" stroke-width="1"/>`
  );
  items.forEach((item, i) => {
    const y = listTop + 8 + i * rowH;
    const alt = i % 2 === 1;
    parts.push(
      `<rect x="${listLeft + 4}" y="${y}" width="${listW - 8}" height="${rowH - 4}" rx="12" ry="12" fill="${alt ? "rgba(255,255,255,0.08)" : "rgba(255,255,255,0.04)"}"/>`
    );
    const idxX = listLeft + 28;
    const idxY = y + rowH / 2 + 6;
    parts.push(
      `<text x="${idxX}" y="${idxY}" text-anchor="middle" font-family="${font}" font-size="22" font-weight="800" fill="${idxFill}">${escapeXml$3(String(item.index))}</text>`
    );
    const textX = listLeft + 28 + 28 + coverSize + 16;
    const title = truncateText$1(item.title || "未知歌名", 22);
    const artist = truncateText$1(item.artist || "未知歌手", 26);
    parts.push(
      `<text x="${textX}" y="${y + 34}" font-family="${font}" font-size="20" font-weight="700" fill="${mainFill}">${escapeXml$3(title)}</text>`
    );
    parts.push(
      `<text x="${textX}" y="${y + 60}" font-family="${font}" font-size="14" fill="rgba(255,255,255,0.78)">${escapeXml$3(artist)}</text>`
    );
  });
  parts.push(
    `<text x="${width / 2}" y="${height - 22}" text-anchor="middle" font-family="${font}" font-size="13" fill="rgba(255,255,255,0.55)">发送「选歌N」/「卡片选歌N」/「语音选歌N」/「链接选歌N」</text>`
  );
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${parts.join("\n")}</svg>`;
}
async function renderMusicListWithSharpImpl(options, logger) {
  const rawItems = Array.isArray(options.items) ? options.items : [];
  const items = rawItems.slice(0, MUSIC_LIST_MAX_ITEMS).map((it, i) => ({
    index: Number(it.index) || i + 1,
    title: String(it.title || "").trim(),
    artist: String(it.artist || "").trim(),
    coverUrl: String(it.coverUrl || "").trim()
  }));
  if (!items.length) return null;
  const width = options.width ?? 900;
  const rowH = 88;
  const coverSize = 64;
  const padX = 28;
  const headerH = 100;
  const footerH = 52;
  const height = Math.max(360, headerH + items.length * rowH + 24 + footerH);
  const pluginDir = String(options.pluginDir || "").trim();
  const dataPath = String(options.dataPath || "").trim();
  const bgLocalPath = String(options.bgLocalPath || "").trim();
  const source = String(options.source || "网易云").trim() || "网易云";
  const query = String(options.query || "").trim();
  const botSelfId = options.botSelfId;
  try {
    const sharp = await loadSharp();
    let botAvatarBuf = null;
    try {
      botAvatarBuf = await fetchQqAvatarBuffer(botSelfId ?? "");
    } catch {
      botAvatarBuf = null;
    }
    const coverBufs = await Promise.all(
      items.map(async (it) => {
        if (it.coverUrl) {
          const buf = await fetchUrlImageBuffer(it.coverUrl);
          if (buf && buf.length > 32) return buf;
        }
        if (botAvatarBuf && botAvatarBuf.length > 32) return botAvatarBuf;
        return null;
      })
    );
    const composites = [];
    const bgBuf = await loadMusicListBackground(bgLocalPath, pluginDir, dataPath);
    if (bgBuf && bgBuf.length > 0) {
      await applySharpPhotoBackgroundLayers(sharp, composites, bgBuf, width, height, dataPath);
    } else {
      const fallback = await sharp({
        create: {
          width,
          height,
          channels: 4,
          background: { r: 28, g: 36, b: 52, alpha: 1 }
        }
      }).png(MK_PNG_OUT()).toBuffer();
      composites.push({ input: fallback, top: 0, left: 0 });
    }
    const customText = loadSharpTextColorFromDataPath(dataPath);
    const svg = buildMusicListSvg(width, height, {
      source,
      query,
      count: items.length,
      items,
      rowH,
      coverSize,
      padX,
      headerH,
      customText
    });
    const uiLayer = await svgCompositeLayer(sharp, Buffer.from(svg), width, height);
    composites.push({ input: uiLayer, top: 0, left: 0 });
    const listTop = headerH;
    const listLeft = padX;
    const coverLeft = listLeft + 28 + 28;
    const solidFallback = await makeFallbackCover(sharp, coverSize);
    for (let i = 0; i < items.length; i++) {
      const y = listTop + 8 + i * rowH;
      const coverTop = Math.round(y + (rowH - 4 - coverSize) / 2);
      let raw = coverBufs[i];
      if (!raw || raw.length < 32) raw = botAvatarBuf;
      let rounded = null;
      if (raw && raw.length >= 32) {
        rounded = await roundCover(sharp, raw, coverSize);
      }
      composites.push({
        input: rounded || solidFallback,
        top: Math.max(0, coverTop),
        left: coverLeft
      });
    }
    const out = await sharp({
      create: {
        width,
        height,
        channels: 4,
        background: { r: 15, g: 25, b: 35, alpha: 1 }
      }
    }).composite(composites).png(MK_PNG_OUT()).toBuffer();
    return out.toString("base64");
  } catch (error) {
    error instanceof Error ? error.message : String(error);
    return null;
  }
}

function glassRect(x, y, w, h, r = 18) {
  return [
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" ry="${r}" fill="rgba(255,255,255,0.12)" stroke="rgba(255,255,255,0.28)" stroke-width="1.5"/>`,
    `<rect x="${x + 1}" y="${y + 1}" width="${w - 2}" height="${Math.max(10, Math.floor(h * 0.22))}" rx="${Math.max(8, r - 4)}" ry="${Math.max(8, r - 4)}" fill="rgba(255,255,255,0.08)"/>`
  ].join("\n");
}
function joinIdentityDefs() {
  return `<defs>
    <linearGradient id="valGrad" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="100%" stop-color="#c8e7ff"/>
    </linearGradient>
    <linearGradient id="accentGrad" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#e8f4ff"/>
      <stop offset="100%" stop-color="#9ec9e8"/>
    </linearGradient>
    <filter id="titleGlow" x="-30%" y="-30%" width="160%" height="160%">
      <feDropShadow dx="0" dy="0" stdDeviation="2" flood-color="#ffffff" flood-opacity="0.85"/>
      <feDropShadow dx="0" dy="1" stdDeviation="4" flood-color="#8eb8d8" flood-opacity="0.35"/>
    </filter>
    <filter id="valGlow" x="-35%" y="-35%" width="170%" height="170%">
      <feDropShadow dx="0" dy="0" stdDeviation="2" flood-color="#ffffff" flood-opacity="0.55"/>
      <feDropShadow dx="0" dy="1" stdDeviation="5" flood-color="#9ec9e8" flood-opacity="0.35"/>
    </filter>
  </defs>`;
}
function escapeXml$2(text) {
  return String(text ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
function truncateText(text, maxLen) {
  const s = String(text).trim();
  if (s.length <= maxLen) return s;
  return `${s.slice(0, maxLen - 1)}…`;
}
function fetchUrlBuffer(url, timeoutMs = 12e3) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(
      url,
      { timeout: timeoutMs, headers: { "User-Agent": "MKbot-JoinIdentitySharp/1.0" } },
      (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          fetchUrlBuffer(res.headers.location, timeoutMs).then(resolve).catch(reject);
          return;
        }
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}`));
          res.resume();
          return;
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        res.on("end", () => resolve(Buffer.concat(chunks)));
        res.on("error", reject);
      }
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
  });
}
async function loadJoinIdentityBackground(bgLocalPath, pluginDir, dataPath) {
  const candidates = [];
  const push = (v) => {
    const s = String(v || "").trim();
    if (s && !candidates.includes(s)) candidates.push(s);
  };
  push(bgLocalPath);
  const localNames = ["heng.jpg", "heng.jpeg", "heng.png", "heng.webp"];
  const roots = [
    path.join(String(pluginDir || "").trim(), "默认资源", "image"),
    path.join(String(dataPath || "").trim(), "默认资源", "image")
  ];
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    roots.push(path.join(here, "..", "默认资源", "image"));
  } catch {
  }
  for (const root of roots) {
    if (!String(root || "").trim()) continue;
    for (const name of localNames) {
      push(path.join(root, name));
    }
  }
  for (const src of candidates) {
    try {
      if (/^https?:\/\//i.test(src)) {
        const buf = await fetchUrlBuffer(src, 2e4);
        if (buf.length > 0) return buf;
        continue;
      }
      const abs = path.isAbsolute(src) ? src : path.resolve(src);
      if (fs.existsSync(abs)) {
        const buf = fs.readFileSync(abs);
        if (buf.length > 0) return buf;
      }
    } catch {
    }
  }
  return null;
}
async function fitCompositeLayer(sharp, input, width, height) {
  return svgCompositeLayer(sharp, input, width, height);
}
function calcJoinIdentityLayout(width, height) {
  const pad = 40;
  const headerH = 88;
  const avatarSize = 196;
  const avatarCenterY = pad + headerH + 36 + avatarSize / 2;
  return {
    avatarSize,
    avatarLeft: Math.round(width / 2 - avatarSize / 2),
    avatarTop: Math.round(avatarCenterY - avatarSize / 2)
  };
}
function buildJoinIdentitySvg(width, height, opts, layout, customText) {
  const font = "Microsoft YaHei, Noto Sans SC, sans-serif";
  const mainFill = resolveSharpTextFill(customText, "#ffffff");
  const pad = 40;
  const cardX = pad;
  const cardY = pad;
  const cardW = width - pad * 2;
  const cardH = height - pad * 2;
  const cx = width / 2;
  const qq = escapeXml$2(String(opts.qq || ""));
  const name = escapeXml$2(truncateText(opts.name || "新成员", 14));
  const sex = escapeXml$2(String(opts.sex || "未知"));
  const birthday = escapeXml$2(String(opts.birthday || "-"));
  const age = escapeXml$2(String(opts.age || "0"));
  const qqLevel = escapeXml$2(String(opts.qqLevel || "0"));
  const regTime = escapeXml$2(String(opts.regTime || "-"));
  const joinTime = escapeXml$2(String(opts.joinTime || "-"));
  const avatarCx = layout.avatarLeft + layout.avatarSize / 2;
  const avatarCy = layout.avatarTop + layout.avatarSize / 2;
  const avatarR = layout.avatarSize / 2;
  const nameY = layout.avatarTop + layout.avatarSize + 44;
  const qqY = nameY + 34;
  const badgeY = qqY + 36;
  const gridY = badgeY + 40;
  const gridPad = 36;
  const gridW = cardW - gridPad * 2;
  const colGap = 16;
  const rowGap = 16;
  const colW = (gridW - colGap * 3) / 4;
  const rowH = 108;
  const wideW = (gridW - colGap) / 2;
  const parts = [];
  parts.push(joinIdentityDefs());
  parts.push(glassRect(cardX, cardY, cardW, cardH, 32));
  const headerY = cardY + 36;
  parts.push(
    `<text x="${cardX + gridPad}" y="${headerY}" font-family="${font}" font-size="30" font-weight="900" fill="${mainFill}" filter="url(#titleGlow)">入群身份</text>`
  );
  parts.push(
    `<text x="${cardX + gridPad}" y="${headerY + 26}" font-family="${font}" font-size="13" fill="rgba(255,255,255,0.72)" letter-spacing="1.5">WELCOME CARD</text>`
  );
  parts.push(
    `<text x="${cardX + cardW - gridPad}" y="${headerY}" text-anchor="end" font-family="${font}" font-size="13" fill="rgba(255,255,255,0.82)">${joinTime}</text>`
  );
  parts.push(
    `<text x="${cardX + cardW - gridPad}" y="${headerY + 22}" text-anchor="end" font-family="${font}" font-size="11" fill="rgba(255,255,255,0.5)">加群时间</text>`
  );
  parts.push(
    `<circle cx="${avatarCx}" cy="${avatarCy}" r="${avatarR + 6}" fill="none" stroke="rgba(255,255,255,0.35)" stroke-width="2.5"/>`
  );
  parts.push(
    `<circle cx="${avatarCx}" cy="${avatarCy}" r="${avatarR}" fill="rgba(255,255,255,0.1)" stroke="rgba(255,255,255,0.45)" stroke-width="3"/>`
  );
  parts.push(
    `<text x="${cx}" y="${nameY}" text-anchor="middle" font-family="${font}" font-size="34" font-weight="900" fill="url(#valGrad)" filter="url(#valGlow)">${name}</text>`
  );
  parts.push(
    `<text x="${cx}" y="${qqY}" text-anchor="middle" font-family="${font}" font-size="16" fill="rgba(255,255,255,0.82)">QQ · ${qq}</text>`
  );
  const badges = [
    { text: sex, x: cx - 130 },
    { text: `${age}岁`, x: cx },
    { text: `Lv.${qqLevel}`, x: cx + 130 }
  ];
  badges.forEach((b) => {
    const bw = 108;
    const bh = 30;
    const bx = b.x - bw / 2;
    const by = badgeY - 22;
    parts.push(glassRect(bx, by, bw, bh, 15));
    parts.push(
      `<text x="${b.x}" y="${badgeY}" text-anchor="middle" font-family="${font}" font-size="14" font-weight="800" fill="url(#accentGrad)" filter="url(#valGlow)">${escapeXml$2(b.text)}</text>`
    );
  });
  const drawTile = (x, y, w, h, label, value, accent = false) => {
    parts.push(glassRect(x, y, w, h, 16));
    parts.push(
      `<circle cx="${x + 18}" cy="${y + 22}" r="4" fill="rgba(200,231,255,0.9)"/>`
    );
    parts.push(
      `<text x="${x + 32}" y="${y + 26}" font-family="${font}" font-size="12" font-weight="600" fill="rgba(255,255,255,0.72)">${escapeXml$2(label)}</text>`
    );
    if (accent) {
      parts.push(
        `<text x="${x + 18}" y="${y + 72}" font-family="${font}" font-size="24" font-weight="900" fill="url(#valGrad)" filter="url(#valGlow)">${escapeXml$2(value)}</text>`
      );
    } else {
      parts.push(
        `<text x="${x + 18}" y="${y + 68}" font-family="${font}" font-size="20" font-weight="700" fill="${mainFill}">${escapeXml$2(value)}</text>`
      );
    }
  };
  const gx = cardX + gridPad;
  const tiles = [
    { label: "性别", value: sex, accent: true },
    { label: "年龄", value: `${age}岁`, accent: true },
    { label: "QQ等级", value: `${qqLevel}级`, accent: true },
    { label: "生日", value: birthday, accent: true }
  ];
  tiles.forEach((tile, i) => {
    const x = gx + i * (colW + colGap);
    drawTile(x, gridY, colW, rowH, tile.label, tile.value, tile.accent);
  });
  const row2Y = gridY + rowH + rowGap;
  drawTile(gx, row2Y, wideW, rowH, "注册时间", regTime);
  drawTile(gx + wideW + colGap, row2Y, wideW, rowH, "加群时间", joinTime);
  parts.push(
    `<text x="${cx}" y="${cardY + cardH - 18}" text-anchor="middle" font-family="${font}" font-size="11" fill="rgba(255,255,255,0.38)" letter-spacing="2">MK-Bot · 入群欢迎</text>`
  );
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${parts.join("\n")}</svg>`;
}
async function roundAvatar(sharp, buf, size) {
  try {
    const mask = Buffer.from(
      `<svg width="${size}" height="${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="white"/></svg>`
    );
    return sharp(buf).resize(size, size, { fit: "cover" }).ensureAlpha().composite([{ input: mask, blend: "dest-in" }]).png(MK_PNG_OUT()).toBuffer();
  } catch {
    return null;
  }
}
async function renderJoinIdentityWithSharpImpl(options, logger) {
  const width = options.width ?? 1400;
  const height = options.height ?? 850;
  const layout = calcJoinIdentityLayout(width);
  const pluginDir = String(options.pluginDir || "").trim();
  const dataPath = String(options.dataPath || "").trim();
  const bgLocalPath = String(options.bgLocalPath || "").trim();
  try {
    const sharp = await loadSharp();
    const composites = [];
    const bgBuf = await loadJoinIdentityBackground(bgLocalPath, pluginDir, dataPath);
    if (bgBuf && bgBuf.length > 0) {
      await applySharpPhotoBackgroundLayers(sharp, composites, bgBuf, width, height, dataPath);
    } else {
      const fallback = await sharp({
        create: {
          width,
          height,
          channels: 4,
          background: { r: 22, g: 28, b: 38, alpha: 1 }
        }
      }).png(MK_PNG_OUT()).toBuffer();
      composites.push({ input: fallback, top: 0, left: 0 });
      logger?.warn?.("[Sharp渲染] 入群身份背景图不可用，已使用默认底色");
    }
    const customText = loadSharpTextColorFromDataPath(dataPath);
    const svg = buildJoinIdentitySvg(width, height, options, layout, customText);
    const uiLayer = await fitCompositeLayer(sharp, Buffer.from(svg), width, height);
    composites.push({ input: uiLayer, top: 0, left: 0 });
    const avatarUrl = `https://q4.qlogo.cn/g?b=qq&nk=${options.qq || ""}&s=5`;
    try {
      const avatarBuf = await fetchUrlBuffer(avatarUrl, 1e4);
      if (avatarBuf.length > 0) {
        const rounded = await roundAvatar(sharp, avatarBuf, layout.avatarSize);
        if (rounded) {
          composites.push({ input: rounded, top: layout.avatarTop, left: layout.avatarLeft });
        }
      }
    } catch (_e) {
    }
    const out = await sharp({
      create: {
        width,
        height,
        channels: 4,
        background: { r: 18, g: 22, b: 30, alpha: 1 }
      }
    }).composite(composites).png(MK_PNG_OUT()).toBuffer();
    return out.toString("base64");
  } catch (error) {
    error instanceof Error ? error.message : String(error);
    return null;
  }
}

async function render$j(input) {
  const dir = resolveBqbSubdir("crawl", input.dataPath, input.pluginDir);
  if (!dir || !fs.existsSync(dir)) {
    throw new Error("bqb-crawl: 素材目录不存在");
  }
  let num = Math.floor(Number(input.num) || 0);
  if (num < 1 || num > 92) {
    num = 1 + Math.floor(Math.random() * 92);
  }
  const tpl = templatePath(dir, num, "jpg", 2);
  if (!fs.existsSync(tpl)) {
    throw new Error(`bqb-crawl: 模板不存在 ${num}`);
  }
  const sharp = await getBqbSharp();
  const avatarPng = await prepareAvatarPng(sharp, input.avatar, { circle: true, size: 100 });
  const composed = await sharp(tpl).ensureAlpha().composite([{ input: avatarPng, left: 0, top: 400 }]).jpeg({ quality: 90, mozjpeg: true }).toBuffer();
  return { buffer: composed, mime: "image/jpeg", ext: "jpg" };
}

const LOCS$5 = [
  { x: 180, y: 60, w: 100, h: 100 },
  { x: 184, y: 75, w: 100, h: 100 },
  { x: 183, y: 98, w: 100, h: 100 },
  { x: 179, y: 118, w: 110, h: 100 },
  { x: 156, y: 194, w: 150, h: 48 },
  { x: 178, y: 136, w: 122, h: 69 },
  { x: 175, y: 66, w: 122, h: 85 },
  { x: 170, y: 42, w: 130, h: 96 },
  { x: 175, y: 34, w: 118, h: 95 },
  { x: 179, y: 35, w: 110, h: 93 },
  { x: 180, y: 54, w: 102, h: 93 },
  { x: 183, y: 58, w: 97, h: 92 },
  { x: 174, y: 35, w: 120, h: 94 },
  { x: 179, y: 35, w: 109, h: 93 },
  { x: 181, y: 54, w: 101, h: 92 },
  { x: 182, y: 59, w: 98, h: 92 },
  { x: 183, y: 71, w: 90, h: 96 },
  { x: 180, y: 131, w: 92, h: 101 }
];
async function render$i(input) {
  const dir = resolveBqbSubdir("play", input.dataPath, input.pluginDir);
  if (!dir || !fs.existsSync(dir)) {
    throw new Error("bqb-play: 素材目录不存在");
  }
  const sharp = await getBqbSharp();
  const avatarPng = await prepareAvatarPng(sharp, input.avatar, { circle: true });
  const imgFrames = [];
  for (let i = 0; i < 18; i++) {
    const tpl = templatePath(dir, i, "png");
    if (!fs.existsSync(tpl)) throw new Error(`bqb-play: 模板不存在 ${i}`);
    imgFrames.push(await composeAvatarUnderTemplate(sharp, tpl, avatarPng, LOCS$5[i]));
  }
  const rawFrames = [];
  for (let i = 18; i < 38; i++) {
    const tpl = templatePath(dir, i, "png");
    if (!fs.existsSync(tpl)) throw new Error(`bqb-play: 模板不存在 ${i}`);
    rawFrames.push(await sharp(tpl).ensureAlpha().png(MK_PNG_OUT()).toBuffer());
  }
  const sequence = [
    ...imgFrames.slice(0, 12),
    ...imgFrames.slice(0, 12),
    ...imgFrames.slice(0, 8),
    ...imgFrames.slice(12, 18),
    ...rawFrames
  ];
  const buffer = await encodeGifFromPngFrames(sharp, sequence, 60);
  return { buffer, mime: "image/gif", ext: "gif" };
}

const LOCS$4 = [
  { x: 90, y: 90, w: 105, h: 150 },
  { x: 90, y: 83, w: 96, h: 172 },
  { x: 90, y: 90, w: 106, h: 148 },
  { x: 88, y: 88, w: 97, h: 167 },
  { x: 90, y: 85, w: 89, h: 179 },
  { x: 90, y: 90, w: 106, h: 151 }
];
async function render$h(input) {
  const dir = resolveBqbSubdir("bite", input.dataPath, input.pluginDir);
  if (!dir || !fs.existsSync(dir)) {
    throw new Error("bqb-bite: 素材目录不存在");
  }
  const sharp = await getBqbSharp();
  const avatarPng = await prepareAvatarPng(sharp, input.avatar, { circle: true });
  const frames = [];
  for (let i = 0; i < 6; i++) {
    const tpl = templatePath(dir, i, "png");
    if (!fs.existsSync(tpl)) throw new Error(`bqb-bite: 模板不存在 ${i}`);
    frames.push(await composeAvatarUnderTemplate(sharp, tpl, avatarPng, LOCS$4[i]));
  }
  for (let i = 6; i < 16; i++) {
    const tpl = templatePath(dir, i, "png");
    if (!fs.existsSync(tpl)) throw new Error(`bqb-bite: 模板不存在 ${i}`);
    frames.push(await sharp(tpl).ensureAlpha().png(MK_PNG_OUT()).toBuffer());
  }
  const buffer = await encodeGifFromPngFrames(sharp, frames, 70);
  return { buffer, mime: "image/gif", ext: "gif" };
}

const LOCS$3 = [
  { x: 14, y: 20, w: 98, h: 98 },
  { x: 12, y: 33, w: 101, h: 85 },
  { x: 8, y: 40, w: 110, h: 76 },
  { x: 10, y: 33, w: 102, h: 84 },
  { x: 12, y: 20, w: 98, h: 98 }
];
async function render$g(input) {
  const dir = resolveBqbSubdir("petpet", input.dataPath, input.pluginDir);
  if (!dir || !fs.existsSync(dir)) {
    throw new Error("bqb-petpet: 素材目录不存在");
  }
  const sharp = await getBqbSharp();
  const avatarPng = await prepareAvatarPng(sharp, input.avatar, {
    circle: input.circle !== false
  });
  const frames = [];
  for (let i = 0; i < LOCS$3.length; i++) {
    const tpl = templatePath(dir, i, "png");
    if (!fs.existsSync(tpl)) throw new Error(`bqb-petpet: 模板不存在 ${i}`);
    frames.push(await composeAvatarUnderTemplate(sharp, tpl, avatarPng, LOCS$3[i]));
  }
  const buffer = await encodeGifFromPngFrames(sharp, frames, 60);
  return { buffer, mime: "image/gif", ext: "gif" };
}

const LOC = { x: 2, y: 38, w: 34, h: 34 };
async function render$f(input) {
  const dir = resolveBqbSubdir("eat", input.dataPath, input.pluginDir);
  if (!dir || !fs.existsSync(dir)) {
    throw new Error("bqb-eat: 素材目录不存在");
  }
  const sharp = await getBqbSharp();
  const avatarPng = await prepareAvatarPng(sharp, input.avatar, { circle: false });
  const frames = [];
  for (let i = 0; i < 3; i++) {
    const tpl = templatePath(dir, i, "png");
    if (!fs.existsSync(tpl)) throw new Error(`bqb-eat: 模板不存在 ${i}`);
    frames.push(await composeAvatarOnWhiteWithTemplate(sharp, tpl, avatarPng, LOC));
  }
  const buffer = await encodeGifFromPngFrames(sharp, frames, 50);
  return { buffer, mime: "image/gif", ext: "gif" };
}

const LOCS$2 = [
  { x: 82, y: 100, w: 130, h: 119 },
  { x: 82, y: 94, w: 126, h: 125 },
  { x: 82, y: 120, w: 128, h: 99 },
  { x: 81, y: 164, w: 132, h: 55 },
  { x: 79, y: 163, w: 132, h: 55 },
  { x: 82, y: 140, w: 127, h: 79 },
  { x: 83, y: 152, w: 125, h: 67 },
  { x: 75, y: 157, w: 140, h: 62 },
  { x: 72, y: 165, w: 144, h: 54 },
  { x: 80, y: 132, w: 128, h: 87 },
  { x: 81, y: 127, w: 127, h: 92 },
  { x: 79, y: 111, w: 132, h: 108 }
];
async function render$e(input) {
  const dir = resolveBqbSubdir("suck", input.dataPath, input.pluginDir);
  if (!dir || !fs.existsSync(dir)) {
    throw new Error("bqb-suck: 素材目录不存在");
  }
  const sharp = await getBqbSharp();
  const avatarPng = await prepareAvatarPng(sharp, input.avatar, { circle: true });
  const frames = [];
  for (let i = 0; i < LOCS$2.length; i++) {
    const tpl = templatePath(dir, i, "png");
    if (!fs.existsSync(tpl)) throw new Error(`bqb-suck: 模板不存在 ${i}`);
    frames.push(await composeAvatarOnWhiteWithTemplate(sharp, tpl, avatarPng, LOCS$2[i]));
  }
  const buffer = await encodeGifFromPngFrames(sharp, frames, 80);
  return { buffer, mime: "image/gif", ext: "gif" };
}

async function render$d(input) {
  const dir = resolveBqbSubdir("jiujiu", input.dataPath, input.pluginDir);
  if (!dir || !fs.existsSync(dir)) {
    throw new Error("bqb-jiujiu: 素材目录不存在");
  }
  const sharp = await getBqbSharp();
  const avatarPng = await prepareAvatarOvalFitPng(sharp, input.avatar, 75, 51);
  const frames = [];
  for (let i = 0; i < 8; i++) {
    const tpl = templatePath(dir, i, "png");
    if (!fs.existsSync(tpl)) throw new Error(`bqb-jiujiu: 模板不存在 ${i}`);
    const tplMeta = await sharp(tpl).metadata();
    const cw = Math.max(1, Number(tplMeta.width) || 1);
    const ch = Math.max(1, Number(tplMeta.height) || 1);
    const templatePng = await sharp(tpl).ensureAlpha().png(MK_PNG_OUT()).toBuffer();
    frames.push(
      await sharp({
        create: {
          width: cw,
          height: ch,
          channels: 4,
          background: { r: 0, g: 0, b: 0, alpha: 0 }
        }
      }).composite([
        { input: avatarPng, left: 5, top: 0 },
        { input: templatePng, left: 0, top: 0 }
      ]).png(MK_PNG_OUT()).toBuffer()
    );
  }
  const buffer = await encodeGifFromPngFrames(sharp, frames, 60);
  return { buffer, mime: "image/gif", ext: "gif" };
}

const LOCS$1 = [
  { x: 4, y: 5, w: 53, h: 46 },
  { x: 7, y: 6, w: 50, h: 45 },
  { x: 6, y: 8, w: 50, h: 42 },
  { x: 7, y: 7, w: 50, h: 44 },
  { x: 4, y: 8, w: 53, h: 42 },
  { x: 7, y: 7, w: 52, h: 45 }
];
async function render$c(input) {
  const dir = resolveBqbSubdir("scratch_head", input.dataPath, input.pluginDir);
  if (!dir || !fs.existsSync(dir)) {
    throw new Error("bqb-scratch-head: 素材目录不存在");
  }
  const sharp = await getBqbSharp();
  const avatarPng = await prepareAvatarPng(sharp, input.avatar, { circle: true, size: 68 });
  const frames = [];
  for (let i = 0; i < LOCS$1.length; i++) {
    const tpl = templatePath(dir, i, "png");
    if (!fs.existsSync(tpl)) throw new Error(`bqb-scratch-head: 模板不存在 ${i}`);
    frames.push(await composeAvatarOverTemplate(sharp, tpl, avatarPng, LOCS$1[i]));
  }
  const buffer = await encodeGifFromPngFrames(sharp, frames, 100);
  return { buffer, mime: "image/gif", ext: "gif" };
}

const TARGET_LOCS = [
  { x: 39, y: 91, w: 75, h: 75 },
  { x: 49, y: 101, w: 75, h: 75 },
  { x: 67, y: 98, w: 75, h: 75 },
  { x: 55, y: 86, w: 75, h: 75 },
  { x: 61, y: 109, w: 75, h: 75 },
  { x: 65, y: 101, w: 75, h: 75 }
];
const SELF_LOCS = [
  { x: 102, y: 95, w: 70, h: 80, angle: 0 },
  { x: 108, y: 60, w: 50, h: 100, angle: 0 },
  { x: 97, y: 18, w: 65, h: 95, angle: 0 },
  { x: 65, y: 5, w: 75, h: 75, angle: -20 },
  { x: 95, y: 57, w: 100, h: 55, angle: -70 },
  { x: 109, y: 107, w: 65, h: 75, angle: 0 }
];
async function render$b(input) {
  const dir = resolveBqbSubdir("rub", input.dataPath, input.pluginDir);
  if (!dir || !fs.existsSync(dir)) {
    throw new Error("bqb-rub: 素材目录不存在");
  }
  const sharp = await getBqbSharp();
  const selfPng = await prepareAvatarPng(sharp, input.selfAvatar, { circle: true });
  const targetPng = await prepareAvatarPng(sharp, input.targetAvatar, { circle: true });
  const frames = [];
  for (let i = 0; i < 6; i++) {
    const tpl = templatePath(dir, i, "png");
    if (!fs.existsSync(tpl)) throw new Error(`bqb-rub: 模板不存在 ${i}`);
    frames.push(
      await composeRubFrame(sharp, tpl, selfPng, targetPng, TARGET_LOCS[i], SELF_LOCS[i])
    );
  }
  const buffer = await encodeGifFromPngFrames(sharp, frames, 50);
  return { buffer, mime: "image/gif", ext: "gif" };
}

function escapeXml$1(text) {
  return String(text ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
function parseDateParts(dateStr) {
  const raw = String(dateStr ?? "").trim();
  if (raw) {
    const m = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (m) {
      return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
    }
    throw new Error("bqb-abstinence: 日期格式应为 YYYY-MM-DD");
  }
  const now = /* @__PURE__ */ new Date();
  return { y: now.getFullYear(), m: now.getMonth() + 1, d: now.getDate() };
}
function buildTextOverlaySvg(width, height, name, y, mo, d) {
  const font = "Noto Sans SC, Microsoft YaHei, PingFang SC, sans-serif";
  const safeName = escapeXml$1(name);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><text x="150" y="690" font-family="${font}" font-size="18" fill="#000">戒导人：<tspan text-decoration="underline">${safeName}</tspan></text><text x="150" y="780" font-family="${font}" font-size="20" fill="#000"><tspan text-decoration="underline">${y}</tspan>年<tspan text-decoration="underline"> ${mo} </tspan>月<tspan text-decoration="underline"> ${d} </tspan>日</text></svg>`;
  return Buffer.from(svg);
}
async function render$a(input) {
  const dir = resolveBqbSubdir("abstinence", input.dataPath, input.pluginDir);
  const basePath = path.join(dir, "base.png");
  const stampPath = path.join(dir, "stamp.png");
  if (!dir || !fs.existsSync(basePath) || !fs.existsSync(stampPath)) {
    throw new Error("bqb-abstinence: 素材不存在（需 base.png、stamp.png）");
  }
  const displayName = String(input.displayName ?? "").trim() || "戒导人";
  const { y, m, d } = parseDateParts(input.date);
  const sharp = await getBqbSharp();
  const baseMeta = await sharp(basePath).metadata();
  const cw = Math.max(1, Number(baseMeta.width) || 900);
  const ch = Math.max(1, Number(baseMeta.height) || 900);
  const avatarPng = await sharp(input.avatar).rotate().resize(270, 360, { fit: "inside", kernel: "linear" }).png(MK_PNG_OUT()).toBuffer();
  const textSvg = buildTextOverlaySvg(cw, ch, displayName, y, m, d);
  const buffer = await sharp(basePath).ensureAlpha().composite([
    { input: textSvg, left: 0, top: 0 },
    { input: avatarPng, left: 80, top: 380 },
    { input: stampPath, left: 310, top: 660 }
  ]).png(MK_PNG_OUT()).toBuffer();
  return { buffer, mime: "image/png", ext: "png" };
}

const DEFAULT_TEXT = "走，跟我去二次元吧";
function escapeXml(text) {
  return String(text ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
function buildTextSvg(width, height, text) {
  const font = "Noto Sans SC, Microsoft YaHei, PingFang SC, sans-serif";
  const safe = escapeXml(text);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><style>text{font-family:${font};fill:#fff;font-weight:600;}</style><text x="30" y="780" font-size="38">${safe}</text></svg>`;
  return Buffer.from(svg);
}
async function render$9(input) {
  const dir = resolveBqbSubdir("acg_entrance", input.dataPath, input.pluginDir);
  if (!dir) throw new Error("bqb-acg-entrance: 素材目录不存在");
  const tpl = path.join(dir, "0.png");
  if (!fs.existsSync(tpl)) throw new Error("bqb-acg-entrance: 模板不存在 0.png");
  const sharp = await getBqbSharp();
  const meta = await sharp(tpl).metadata();
  const w = Math.max(1, Number(meta.width) || 900);
  const h = Math.max(1, Number(meta.height) || 900);
  const photo = await sharp(input.avatar).rotate().resize(290, 410, { fit: "cover", position: "centre", kernel: "lanczos3" }).ensureAlpha().png(MK_PNG_OUT()).toBuffer();
  const text = String(input.text ?? "").trim() || DEFAULT_TEXT;
  const textSvg = buildTextSvg(w, h, text);
  const framePng = await sharp(tpl).ensureAlpha().composite([{ input: textSvg, left: 0, top: 0 }]).png(MK_PNG_OUT()).toBuffer();
  const buffer = await sharp({
    create: {
      width: w,
      height: h,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 1 }
    }
  }).composite([
    { input: photo, left: 190, top: 265 },
    { input: framePng, left: 0, top: 0 }
  ]).png(MK_PNG_OUT()).toBuffer();
  return { buffer, mime: "image/png", ext: "png" };
}

async function render$8(input) {
  const dir = resolveBqbSubdir("addiction", input.dataPath, input.pluginDir);
  if (!dir) throw new Error("bqb-addiction: 素材目录不存在");
  const tpl = path.join(dir, "0.png");
  if (!fs.existsSync(tpl)) throw new Error("bqb-addiction: 模板不存在 0.png");
  const sharp = await getBqbSharp();
  const photo = await sharp(input.avatar).rotate().resize(91, 91, { fit: "cover", position: "centre", kernel: "lanczos3" }).ensureAlpha().png(MK_PNG_OUT()).toBuffer();
  const buffer = await sharp(tpl).ensureAlpha().composite([{ input: photo, left: 0, top: 0 }]).png(MK_PNG_OUT()).toBuffer();
  return { buffer, mime: "image/png", ext: "png" };
}

function pickDominantColors(data) {
  const buckets = Array.from({ length: 8 }, () => ({ r: 0, g: 0, b: 0, count: 0 }));
  let sampled = 0;
  for (let i = 0; i + 3 < data.length; i += 4) {
    const a = data[i + 3];
    if (a < 16) continue;
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const idx = r >> 7 << 2 | g >> 7 << 1 | b >> 7;
    const cur = buckets[idx];
    cur.r += r;
    cur.g += g;
    cur.b += b;
    cur.count += 1;
    sampled += 1;
  }
  const colors = buckets.filter((b) => b.count > 0 && b.count / Math.max(1, sampled) > 0.01).sort((a, b) => b.count - a.count).map((b) => `rgb(${Math.round(b.r / b.count)},${Math.round(b.g / b.count)},${Math.round(b.b / b.count)})`);
  return colors.length > 0 ? colors : ["rgb(255,255,255)"];
}
function makeSeedFromBuffer(buf) {
  let seed = 0;
  const len = Math.min(buf.length, 256);
  for (let i = 0; i < len; i++) {
    seed = seed * 131 + buf[i] >>> 0;
  }
  return seed || 1;
}
function nextRand(seed) {
  return seed * 1664525 + 1013904223 >>> 0;
}
function buildBlocksSvg(maskRaw, maskW, maskH, colors, seed0) {
  let seed = seed0 >>> 0;
  const blocks = [];
  const points = [];
  const x1 = 200;
  const y1 = 300;
  const x2 = 400;
  const y2 = 650;
  for (let tries = 0; tries < 1200 && points.length < 150; tries++) {
    seed = nextRand(seed);
    const x = x1 + seed % (x2 - x1 + 1);
    seed = nextRand(seed);
    const y = y1 + seed % (y2 - y1 + 1);
    if (x < 0 || y < 0 || x >= maskW || y >= maskH) continue;
    const idx = (y * maskW + x) * 4;
    const alpha = maskRaw[idx + 3] ?? 0;
    const r = maskRaw[idx] ?? 0;
    const g = maskRaw[idx + 1] ?? 0;
    const b = maskRaw[idx + 2] ?? 0;
    if (alpha < 8 || r < 8 && g < 8 && b < 8) continue;
    if (points.some((p) => Math.abs(x - p.x) < 13 && Math.abs(y - p.y) < 13)) continue;
    points.push({ x, y });
    seed = nextRand(seed);
    const color = colors[seed % colors.length];
    blocks.push(
      `<rect x="${x}" y="${y}" width="10" height="10" fill="${color}" transform="rotate(45 ${x} ${y})"/>`
    );
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${maskW}" height="${maskH}">` + blocks.join("") + `</svg>`;
  return Buffer.from(svg);
}
async function render$7(input) {
  const dir = resolveBqbSubdir("dont_touch", input.dataPath, input.pluginDir);
  if (!dir) throw new Error("bqb-dont-touch: 素材目录不存在");
  const tpl = path.join(dir, "0.png");
  const mask = path.join(dir, "mask.png");
  if (!fs.existsSync(tpl)) throw new Error("bqb-dont-touch: 模板不存在 0.png");
  if (!fs.existsSync(mask)) throw new Error("bqb-dont-touch: 模板不存在 mask.png");
  const sharp = await getBqbSharp();
  const photo = await sharp(input.avatar).rotate().resize(250, 250, { fit: "contain", background: { r: 255, g: 255, b: 255, alpha: 0 } }).ensureAlpha().png(MK_PNG_OUT()).toBuffer();
  const colorSample = await sharp(photo).resize(200, 200, { fit: "inside" }).ensureAlpha().raw().toBuffer();
  const colors = pickDominantColors(colorSample);
  const maskMeta = await sharp(mask).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const blocksSvg = buildBlocksSvg(
    maskMeta.data,
    maskMeta.info.width,
    maskMeta.info.height,
    colors,
    makeSeedFromBuffer(input.avatar)
  );
  const buffer = await sharp(tpl).ensureAlpha().composite([
    { input: blocksSvg, left: 0, top: 0 },
    { input: photo, left: 25, top: 460 }
  ]).png(MK_PNG_OUT()).toBuffer();
  return { buffer, mime: "image/png", ext: "png" };
}

function seededNext(seed) {
  return seed * 1664525 + 1013904223 >>> 0;
}
function makeSeed(buf) {
  let seed = 0;
  const len = Math.min(buf.length, 512);
  for (let i = 0; i < len; i++) seed = seed * 131 + buf[i] >>> 0;
  return seed || 1;
}
function buildDotSvg(width, height, dusts) {
  const circles = dusts.filter((d) => !d.dead && d.radius > 0).map((d) => `<circle cx="${d.x.toFixed(2)}" cy="${d.y.toFixed(2)}" r="${d.radius.toFixed(2)}" fill="#000"/>`).join("");
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${circles}</svg>`
  );
}
async function render$6(input) {
  const sharp = await getBqbSharp();
  let image = sharp(input.avatar).rotate().ensureAlpha();
  const meta = await image.metadata();
  const maxWidth = 200;
  if ((meta.width || 0) > maxWidth) {
    image = image.resize({ width: maxWidth });
  }
  const basePng = await image.png(MK_PNG_OUT()).toBuffer();
  const info = await sharp(basePng).metadata();
  const width = Math.max(1, Number(info.width) || 1);
  const height = Math.max(1, Number(info.height) || 1);
  const raw = await sharp(basePng).ensureAlpha().raw().toBuffer();
  const centerX = width * 2 / 3;
  const centerY = height * 3 / 2;
  const radius = Math.sqrt(centerX * centerX + centerY * centerY);
  const step = radius / 24;
  const dusts = [];
  let seed = makeSeed(input.avatar);
  const frames = [];
  for (let i = 0; i < 35; i++) {
    if (i <= 9) {
      frames.push(basePng);
      continue;
    }
    if (i < 28) {
      const t = i - 9;
      const r1 = step * (t + 4);
      const r2 = step * (t + 5);
      const r3 = step * (t + 11);
      const pixelOverlays = [];
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const idx = (y * width + x) * 4;
          const a = raw[idx + 3] ?? 0;
          if (a === 0) continue;
          const dx0 = x - centerX;
          const dy0 = y - centerY;
          const dist = Math.sqrt(dx0 * dx0 + dy0 * dy0);
          if (dist <= r1) {
            continue;
          }
          if (dist <= r2) {
            pixelOverlays.push(`<rect x="${x}" y="${y}" width="1" height="1" fill="black"/>`);
            continue;
          }
          if (dist <= r3) {
            seed = seededNext(seed);
            const rand = (seed & 65535) / 65535;
            let factor = 0.5 + (dist - r2) / Math.max(1e-3, r3 - r2);
            factor = Math.max(0, Math.min(1, factor));
            factor *= 0.9 + 0.2 * rand;
            const gray = Math.max(
              0,
              Math.min(255, Math.round(((raw[idx] ?? 0) + (raw[idx + 1] ?? 0) + (raw[idx + 2] ?? 0)) / 3 * factor))
            );
            pixelOverlays.push(
              `<rect x="${x}" y="${y}" width="1" height="1" fill="rgb(${gray},${gray},${gray})" fill-opacity="${(a / 255).toFixed(3)}"/>`
            );
          } else {
            const rr = raw[idx] ?? 0;
            const gg = raw[idx + 1] ?? 0;
            const bb = raw[idx + 2] ?? 0;
            pixelOverlays.push(
              `<rect x="${x}" y="${y}" width="1" height="1" fill="rgb(${rr},${gg},${bb})" fill-opacity="${(a / 255).toFixed(3)}"/>`
            );
          }
        }
      }
      for (let r = Math.floor(r1); r < Math.floor(r2); r++) {
        for (let theta = 0; theta < 180; theta++) {
          const rad = theta * Math.PI / 180;
          const x = Math.floor(centerX + r * Math.cos(rad));
          const y = Math.floor(centerY - r * Math.sin(rad));
          if (x < 0 || x >= width || y < 0 || y >= height) continue;
          const idx = (y * width + x) * 4;
          const a = raw[idx + 3] ?? 0;
          if (a === 0) continue;
          seed = seededNext(seed);
          if ((seed & 65535) / 65535 < 0.1) {
            const rr = Math.max(1, r);
            dusts.push({
              x,
              y,
              vx: 0,
              vy: 0,
              dx: (x - centerX) / rr,
              dy: 1.5 * (y - centerY) / rr,
              radius: 1 + (seed >>> 16 & 65535) / 65535 * 2,
              dead: false
            });
          }
        }
      }
      for (const dot of dusts) {
        if (dot.dead) continue;
        const a = 0.02 * step / Math.max(1, dot.radius);
        dot.vx += a * dot.dx;
        dot.vy += a * dot.dy;
        dot.x += dot.vx;
        dot.y += dot.vy;
        seed = seededNext(seed);
        if ((seed & 65535) / 65535 < 0.25) dot.radius -= 1;
        if (dot.radius <= 0 || dot.x + dot.radius < 0 || dot.x - dot.radius > width || dot.y + dot.radius < 0 || dot.y - dot.radius > height) {
          dot.dead = true;
        }
      }
      const frameSvg = Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${pixelOverlays.join("")}</svg>`
      );
      const dustSvg = buildDotSvg(width, height, dusts);
      frames.push(
        await sharp({
          create: {
            width,
            height,
            channels: 4,
            background: { r: 0, g: 0, b: 0, alpha: 0 }
          }
        }).composite([
          { input: frameSvg, left: 0, top: 0 },
          { input: dustSvg, left: 0, top: 0 }
        ]).png(MK_PNG_OUT()).toBuffer()
      );
    } else {
      for (const dot of dusts) {
        if (dot.dead) continue;
        const a = 0.02 * step / Math.max(1, dot.radius);
        dot.vx += a * dot.dx;
        dot.vy += a * dot.dy;
        dot.x += dot.vx;
        dot.y += dot.vy;
        seed = seededNext(seed);
        if ((seed & 65535) / 65535 < 0.25) dot.radius -= 1;
        if (dot.radius <= 0 || dot.x + dot.radius < 0 || dot.x - dot.radius > width || dot.y + dot.radius < 0 || dot.y - dot.radius > height) {
          dot.dead = true;
        }
      }
      const dustSvg = buildDotSvg(width, height, dusts);
      frames.push(
        await sharp({
          create: {
            width,
            height,
            channels: 4,
            background: { r: 0, g: 0, b: 0, alpha: 0 }
          }
        }).composite([{ input: dustSvg, left: 0, top: 0 }]).png(MK_PNG_OUT()).toBuffer()
      );
    }
  }
  const buffer = await sharp({
    create: {
      width,
      height: height * frames.length,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
      pageHeight: height
    }
  }).composite(frames.map((input2, i) => ({ input: input2, left: 0, top: i * height }))).gif({ delay: 80, loop: 0, effort: 1 }).toBuffer();
  return { buffer, mime: "image/gif", ext: "gif" };
}

const LOCS = [
  { x: 135, y: 240, w: 138, h: 47 },
  { x: 135, y: 240, w: 138, h: 47 },
  { x: 150, y: 190, w: 105, h: 95 },
  { x: 150, y: 190, w: 105, h: 95 },
  { x: 148, y: 188, w: 106, h: 98 },
  { x: 146, y: 196, w: 110, h: 88 },
  { x: 145, y: 223, w: 112, h: 61 },
  { x: 145, y: 223, w: 112, h: 61 }
];
async function render$5(input) {
  const dir = resolveBqbSubdir("pound", input.dataPath, input.pluginDir);
  if (!dir || !fs.existsSync(dir)) {
    throw new Error("bqb-pound: 素材目录不存在");
  }
  const sharp = await getBqbSharp();
  const avatarPng = await prepareAvatarPng(sharp, input.avatar, { circle: false });
  const frames = [];
  let outW = 0;
  let outH = 0;
  for (let i = 0; i < 8; i++) {
    const tpl = templatePath(dir, i, "png");
    if (!fs.existsSync(tpl)) throw new Error(`bqb-pound: 模板不存在 ${i}`);
    if (!outW || !outH) {
      const meta = await sharp(tpl).metadata();
      outW = Math.max(1, Number(meta.width) || 1);
      outH = Math.max(1, Number(meta.height) || 1);
    }
    const { x, y, w, h } = LOCS[i] ?? LOCS[0];
    const avatarResized = await sharp(avatarPng).resize(Math.max(1, Math.floor(w)), Math.max(1, Math.floor(h)), {
      fit: "fill",
      kernel: "lanczos3"
    }).png(MK_PNG_OUT()).toBuffer();
    const templateBuf = await sharp(tpl).ensureAlpha().png(MK_PNG_OUT()).toBuffer();
    const frame = await sharp({
      create: {
        width: outW,
        height: outH,
        channels: 4,
        background: { r: 255, g: 255, b: 255, alpha: 1 }
      }
    }).composite([
      { input: avatarResized, left: Math.floor(x), top: Math.floor(y) },
      { input: templateBuf, left: 0, top: 0 }
    ]).png(MK_PNG_OUT()).toBuffer();
    frames.push(frame);
  }
  const buffer = await encodeGifFromPngFrames(sharp, frames, 50);
  return { buffer, mime: "image/gif", ext: "gif" };
}

async function render$4(input) {
  const kind = "sold_out";
  const dir = resolveBqbSubdir(kind, input.dataPath, input.pluginDir);
  const tpl = path.join(dir, "0.png");
  if (!dir || !fs.existsSync(tpl)) {
    throw new Error("bqb-sold_out: 素材不存在（需 sold_out/0.png）");
  }
  const sharp = await getBqbSharp();
  const rotated = sharp(input.avatar).rotate().ensureAlpha();
  const meta0 = await rotated.metadata();
  const w0 = Number(meta0.width) || 0;
  const h0 = Number(meta0.height) || 0;
  let avatarResized = rotated;
  if (w0 > h0) {
    avatarResized = rotated.resize({ height: 600, kernel: "lanczos3" });
  } else {
    avatarResized = rotated.resize({ width: 600, kernel: "lanczos3" });
  }
  const avatarPng = await avatarResized.png(MK_PNG_OUT()).toBuffer();
  const meta = await sharp(avatarPng).metadata();
  const w = Math.max(1, Number(meta.width) || 1);
  const h = Math.max(1, Number(meta.height) || 1);
  const iconPng = await sharp(tpl).ensureAlpha().png(MK_PNG_OUT()).toBuffer();
  const iconMeta = await sharp(iconPng).metadata();
  const iconW = Math.max(1, Number(iconMeta.width) || 1);
  const iconH = Math.max(1, Number(iconMeta.height) || 1);
  const overlay = await sharp({
    create: {
      width: w,
      height: h,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 80 / 255 }
    }
  }).png(MK_PNG_OUT()).toBuffer();
  const buffer = await sharp(avatarPng).ensureAlpha().composite([
    { input: overlay, left: 0, top: 0 },
    { input: iconPng, left: Math.floor((w - iconW) / 2), top: Math.floor((h - iconH) / 2) }
  ]).png(MK_PNG_OUT()).toBuffer();
  return { buffer, mime: "image/png", ext: "png" };
}

async function render$3(input) {
  const dir = resolveBqbSubdir("taunt", input.dataPath, input.pluginDir);
  const tpl = path.join(dir, "0.png");
  if (!dir || !fs.existsSync(tpl)) {
    throw new Error("bqb-taunt: 素材不存在（需 taunt/0.png）");
  }
  const sharp = await getBqbSharp();
  const avatarPng = await prepareAvatarPng(sharp, input.avatar, { circle: false, size: 230 });
  const buffer = await sharp(tpl).ensureAlpha().composite([{ input: avatarPng, left: 245, top: 245 }]).png(MK_PNG_OUT()).toBuffer();
  return { buffer, mime: "image/png", ext: "png" };
}

async function render$2(input) {
  const dir = resolveBqbSubdir("think_what", input.dataPath, input.pluginDir);
  const tpl = path.join(dir, "0.png");
  if (!dir || !fs.existsSync(tpl)) {
    throw new Error("bqb-think-what: 素材不存在（需 think_what/0.png）");
  }
  const sharp = await getBqbSharp();
  const meta = await sharp(tpl).metadata();
  const w = Math.max(1, Number(meta.width) || 1);
  const h = Math.max(1, Number(meta.height) || 1);
  const photo = await sharp(input.avatar).rotate().resize(534, 493, { fit: "cover", position: "centre", kernel: "lanczos3" }).ensureAlpha().png(MK_PNG_OUT()).toBuffer();
  const framePng = await sharp(tpl).ensureAlpha().png(MK_PNG_OUT()).toBuffer();
  const buffer = await sharp({
    create: {
      width: w,
      height: h,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 1 }
    }
  }).composite([
    { input: photo, left: 530, top: 0 },
    { input: framePng, left: 0, top: 0 }
  ]).png(MK_PNG_OUT()).toBuffer();
  return { buffer, mime: "image/png", ext: "png" };
}

async function render$1(input) {
  const dir = resolveBqbSubdir("what_i_want_to_do", input.dataPath, input.pluginDir);
  const tpl = path.join(dir, "0.png");
  if (!dir || !fs.existsSync(tpl)) {
    throw new Error("bqb-what-i-want-to-do: 素材不存在（需 what_i_want_to_do/0.png）");
  }
  const sharp = await getBqbSharp();
  const avatarPng = await prepareAvatarPng(sharp, input.avatar, { circle: true });
  const avatarFit = await sharp(avatarPng).resize(270, 270, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }).png(MK_PNG_OUT()).toBuffer();
  const buffer = await sharp(tpl).ensureAlpha().composite([{ input: avatarFit, left: 350, top: 590 }]).png(MK_PNG_OUT()).toBuffer();
  return { buffer, mime: "image/png", ext: "png" };
}

async function render(input) {
  const dir = resolveBqbSubdir("you_dont_get", input.dataPath, input.pluginDir);
  const tpl = path.join(dir, "0.png");
  if (!dir || !fs.existsSync(tpl)) {
    throw new Error("bqb-you-dont-get: 素材不存在（需 you_dont_get/0.png）");
  }
  const sharp = await getBqbSharp();
  const meta = await sharp(tpl).metadata();
  const w = Math.max(1, Number(meta.width) || 1);
  const h = Math.max(1, Number(meta.height) || 1);
  const photo = await sharp(input.avatar).rotate().resize(142, 139, { fit: "cover", position: "centre", kernel: "lanczos3" }).ensureAlpha().png(MK_PNG_OUT()).toBuffer();
  const framePng = await sharp(tpl).ensureAlpha().png(MK_PNG_OUT()).toBuffer();
  const buffer = await sharp({
    create: {
      width: w,
      height: h,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 1 }
    }
  }).composite([
    { input: photo, left: 217, top: 181 },
    { input: framePng, left: 0, top: 0 }
  ]).png(MK_PNG_OUT()).toBuffer();
  return { buffer, mime: "image/png", ext: "png" };
}

function applyRuntimeOptions(msg) {
  if (msg.concurrency !== void 0) configureSharpConcurrency(msg.concurrency);
  if (msg.pngLevel !== void 0) configureSharpPngCompressionLevel(msg.pngLevel);
  if (msg.bgCache !== void 0) applySharpBgCacheConfig(msg.bgCache);
  if (msg.svgDirect !== void 0) configureSharpSvgDirect(msg.svgDirect ? "开" : "关闭");
}
function abToBuffer(v) {
  if (Buffer.isBuffer(v)) return v;
  if (v instanceof ArrayBuffer) return Buffer.from(v);
  if (ArrayBuffer.isView(v)) {
    const view = v;
    return Buffer.from(view.buffer, view.byteOffset, view.byteLength);
  }
  throw new Error("无效的图片 Buffer");
}
function toTransferable(buf) {
  const ab = new ArrayBuffer(buf.byteLength);
  new Uint8Array(ab).set(buf);
  return ab;
}
async function dispatchCard(kind, payload) {
  const logger = void 0;
  let b64 = null;
  switch (kind) {
    case "menu":
      b64 = await renderMenuWithSharpImpl(
        String(payload.pluginDir || ""),
        String(payload.dataPath || ""),
        payload.options || {});
      break;
    case "api-menu":
      b64 = await renderApiInterfaceMenuWithSharpImpl(payload.options || {});
      break;
    case "fortune":
      b64 = await renderFortuneWithSharpImpl(payload.options || {}, logger);
      break;
    case "status":
      b64 = await renderStatusWithSharpImpl(payload.options || {}, logger);
      break;
    case "signin":
      b64 = await renderSignInWithSharpImpl(payload.options || {}, logger);
      break;
    case "wallet":
      b64 = await renderWalletWithSharpImpl(payload.options || {}, logger);
      break;
    case "shop":
      b64 = await renderShopWithSharpImpl(payload.options || {});
      break;
    case "fish-basket":
      b64 = await renderFishBasketWithSharpImpl(payload.options || {}, logger);
      break;
    case "music-list":
      b64 = await renderMusicListWithSharpImpl(payload.options || {});
      break;
    case "join-identity":
      b64 = await renderJoinIdentityWithSharpImpl(payload.options || {}, logger);
      break;
    default:
      throw new Error(`未知卡片 kind=${kind}`);
  }
  if (!b64) throw new Error(`渲染失败 kind=${kind}`);
  return Buffer.from(b64, "base64");
}
async function dispatchBqb(payload) {
  const subKind = String(payload.subKind || "").trim();
  const dataPath = String(payload.dataPath || "");
  const pluginDir = String(payload.pluginDir || "");
  const commonBase = { dataPath, pluginDir };
  let result;
  if (subKind === "rub") {
    result = await render$b({
      selfAvatar: abToBuffer(payload.selfAvatar),
      targetAvatar: abToBuffer(payload.targetAvatar),
      ...commonBase
    });
  } else if (subKind === "abstinence") {
    result = await render$a({
      avatar: abToBuffer(payload.avatar),
      displayName: String(payload.displayName || ""),
      date: payload.date != null ? String(payload.date) : void 0,
      ...commonBase
    });
  } else {
    const avatar = abToBuffer(payload.avatar);
    const common = { avatar, ...commonBase };
    if (subKind === "crawl") result = await render$j(common);
    else if (subKind === "play") result = await render$i(common);
    else if (subKind === "bite") result = await render$h(common);
    else if (subKind === "petpet") result = await render$g(common);
    else if (subKind === "eat") result = await render$f(common);
    else if (subKind === "suck") result = await render$e(common);
    else if (subKind === "jiujiu") result = await render$d(common);
    else if (subKind === "scratch_head") result = await render$c(common);
    else if (subKind === "acg_entrance") result = await render$9(common);
    else if (subKind === "addiction") result = await render$8(common);
    else if (subKind === "dont_touch") result = await render$7(common);
    else if (subKind === "fade_away") result = await render$6(common);
    else if (subKind === "pound") result = await render$5(common);
    else if (subKind === "sold_out") result = await render$4(common);
    else if (subKind === "taunt") result = await render$3(common);
    else if (subKind === "think_what") result = await render$2(common);
    else if (subKind === "what_i_want_to_do") result = await render$1(common);
    else if (subKind === "you_dont_get") result = await render(common);
    else throw new Error(`未知 bqb subKind=${subKind}`);
  }
  return result;
}
async function handleJob(msg) {
  const id = Number(msg?.id);
  try {
    if (msg.paths) configureSharpRuntimePaths(msg.paths);
    applyRuntimeOptions(msg);
    const kind = String(msg.kind || "");
    const payload = msg.payload && typeof msg.payload === "object" ? msg.payload : {};
    if (kind === "bqb") {
      const result = await dispatchBqb(payload);
      const buffer2 = toTransferable(result.buffer);
      parentPort.postMessage(
        { id, ok: true, buffer: buffer2, mime: result.mime, ext: result.ext },
        [buffer2]
      );
      return;
    }
    const png = await dispatchCard(kind, payload);
    const buffer = toTransferable(png);
    parentPort.postMessage(
      { id, ok: true, buffer, mime: "image/png", ext: "png" },
      [buffer]
    );
  } catch (e) {
    parentPort.postMessage({
      id,
      ok: false,
      error: String(e?.message || e || "Sharp Worker 渲染失败")
    });
  }
}
if (!parentPort) {
  throw new Error("sharp-worker 须由 worker_threads 启动");
}
parentPort.on("message", (msg) => {
  void handleJob(msg);
});
