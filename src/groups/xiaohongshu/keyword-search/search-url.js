import { XIAOHONGSHU_HOME_URL } from "./constants.js";

export function buildXiaohongshuSearchUrl(keyword) {
  const url = new URL("search_result_ai", XIAOHONGSHU_HOME_URL);
  url.searchParams.set("keyword", String(keyword || "").trim());
  url.searchParams.set("source", "web_explore_feed");
  return url.href;
}
