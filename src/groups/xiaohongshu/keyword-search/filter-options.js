export const XIAOHONGSHU_FILTER_GROUPS = Object.freeze([
  {
    key: "sort",
    label: "排序依据",
    defaultValue: "general",
    options: [
      ["general", "综合"],
      ["latest", "最新"],
      ["most_likes", "最多点赞"],
      ["most_comments", "最多评论"],
      ["most_collects", "最多收藏"]
    ]
  },
  {
    key: "noteType",
    label: "笔记类型",
    defaultValue: "all",
    options: [["all", "不限"], ["video", "视频"], ["image_text", "图文"]]
  },
  {
    key: "publishTime",
    label: "发布时间",
    defaultValue: "all",
    options: [["all", "不限"], ["day", "一天内"], ["week", "一周内"], ["half_year", "半年内"]]
  },
  {
    key: "searchScope",
    label: "搜索范围",
    defaultValue: "all",
    options: [["all", "不限"], ["viewed", "已看过"], ["unviewed", "未看过"], ["followed", "已关注"]]
  },
  {
    key: "location",
    label: "位置距离",
    defaultValue: "all",
    options: [["all", "不限"], ["same_city", "同城"], ["nearby", "附近"]]
  }
]);

export function normalizeXiaohongshuFilters(input = {}) {
  return Object.fromEntries(XIAOHONGSHU_FILTER_GROUPS.map((group) => {
    const allowedValues = new Set(group.options.map(([value]) => value));
    const selectedValue = String(input[group.key] || "");
    return [group.key, allowedValues.has(selectedValue) ? selectedValue : group.defaultValue];
  }));
}

export function getXiaohongshuFilterLabel(key, value) {
  const group = XIAOHONGSHU_FILTER_GROUPS.find((item) => item.key === key);
  return group?.options.find(([optionValue]) => optionValue === value)?.[1] || "不限";
}

export function getXiaohongshuFilterSummary(config) {
  return XIAOHONGSHU_FILTER_GROUPS
    .map((group) => `${group.label}：${getXiaohongshuFilterLabel(group.key, config?.[group.key])}`)
    .join(" · ");
}
