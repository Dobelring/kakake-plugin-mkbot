const CZ_API = "https://api.czcn.xyz/api/qqyykp";
const UPSTREAM_TIMEOUT_MS = 15e3;
function scalar(value, fallback = "") {
  if (value == null) return fallback;
  if (Array.isArray(value)) return scalar(value[0], fallback);
  if (typeof value === "object") return fallback;
  return String(value).trim();
}
function isMusicPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const obj = payload;
  const meta = obj.meta;
  const music = meta && typeof meta === "object" && !Array.isArray(meta) ? meta.music : null;
  return String(obj.view ?? "").toLowerCase() === "music" && !!music && typeof music === "object";
}
async function fetchJson(url, init) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      ...init,
      signal: ctrl.signal,
      headers: {
        Accept: "application/json",
        "User-Agent": "MKbot-MusicSign/1.0",
        ...init?.headers || {}
      }
    });
    const text = (await res.text()).replace(/^\uFEFF/, "").trim();
    if (!text) throw new Error(`上游空响应 HTTP ${res.status}`);
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`上游非 JSON HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    if (!res.ok) {
      throw new Error(`上游 HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    return parsed;
  } finally {
    clearTimeout(timer);
  }
}
async function sign(input) {
  const title = scalar(input.title);
  const singer = scalar(input.singer);
  const image = scalar(input.image);
  const jump = scalar(input.url);
  const audio = scalar(input.audio);
  const type = scalar(input.type, "qq") || "qq";
  const missing = [];
  if (!title) missing.push("title");
  if (!image) missing.push("image");
  if (!jump) missing.push("url");
  if (!audio) missing.push("audio");
  if (missing.length) {
    return { ok: false, error: `缺少参数: ${missing.join(", ")}` };
  }
  const params = new URLSearchParams({
    type,
    url: jump,
    audio,
    title,
    desc: singer,
    image
  });
  const errors = [];
  try {
    const payload = await fetchJson(`${CZ_API}?${params.toString()}`, { method: "GET" });
    if (isMusicPayload(payload)) {
      return {
        ok: true,
        payload,
        ark: JSON.stringify(payload)
      };
    }
    errors.push(`GET 返回非音乐 Ark: ${JSON.stringify(payload).slice(0, 200)}`);
  } catch (e) {
    errors.push(`GET: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    const payload = await fetchJson(CZ_API, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded; charset=utf-8" },
      body: params.toString()
    });
    if (isMusicPayload(payload)) {
      return {
        ok: true,
        payload,
        ark: JSON.stringify(payload)
      };
    }
    errors.push(`POST 返回非音乐 Ark: ${JSON.stringify(payload).slice(0, 200)}`);
  } catch (e) {
    errors.push(`POST: ${e instanceof Error ? e.message : String(e)}`);
  }
  return { ok: false, error: errors.join("；") || "CZ 签名失败" };
}

export { sign };
