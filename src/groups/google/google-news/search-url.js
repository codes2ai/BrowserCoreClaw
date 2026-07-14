export function buildGoogleNewsSearchUrl(query, options = {}) {
  const limit = Math.min(100, Math.max(1, Number(options.limit) || 20));
  const url = new URL("https://www.google.com/search");
  url.searchParams.set("q", String(query || "").trim());
  url.searchParams.set("hl", options.language || "zh-CN");
  url.searchParams.set("tbm", "nws");
  url.searchParams.set("tbs", "qdr:h");
  url.searchParams.set("num", String(Math.min(100, Math.max(10, limit))));
  return url.href;
}
