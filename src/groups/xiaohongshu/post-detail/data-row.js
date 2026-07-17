import { normalizeXiaohongshuLikes } from "../likes-normalizer.js";

export const XIAOHONGSHU_INTERACTION_FIELDS = Object.freeze([
  "likes",
  "favorites",
  "comments",
  "shares"
]);

function asCapturedInteractionFields(value) {
  if (!Array.isArray(value)) return null;
  return new Set(value.map((field) => String(field || "").trim()));
}

/**
 * 将正文详情的互动字段统一为表格可展示的值。
 * 页面未公开某个互动数时，首次采集仍展示为 0；更新旧数据时由合并策略保留旧值。
 */
export function normalizeXiaohongshuPostDetailDataRow(row = {}) {
  return {
    ...row,
    likes: normalizeXiaohongshuLikes(row?.likes),
    favorites: row?.favorites || "0",
    comments: row?.comments || "0",
    shares: row?.shares || "0"
  };
}

/**
 * 仅覆盖本轮页面明确公开的互动字段。小红书正文页可能只显示按钮文案（如“收藏”），
 * 这不代表互动数为 0，不能在强制更新时误覆盖已有的真实数值。
 */
export function mergeXiaohongshuPostDetailDataRow(previous, incoming) {
  const merged = { ...(previous || {}), ...(incoming || {}) };
  const capturedFields = asCapturedInteractionFields(incoming?.capturedInteractionFields);
  if (!previous || !capturedFields) return merged;

  for (const field of XIAOHONGSHU_INTERACTION_FIELDS) {
    if (!capturedFields.has(field) && previous[field] !== undefined) {
      merged[field] = previous[field];
    }
  }
  return merged;
}
