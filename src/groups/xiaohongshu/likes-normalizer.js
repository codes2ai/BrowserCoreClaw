export function normalizeXiaohongshuLikes(value) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text || /^(?:赞|点赞|喜欢|likes?)$/i.test(text)) return "0";
  const count = text.replace(/^(?:点赞|喜欢)\s*/i, "").trim();
  return count || "0";
}
