import { MESSAGE_CAPTURE_DOUYIN_PROFILE_POSTS, MESSAGE_STOP_DOUYIN_PROFILE_POSTS } from "./constants.js";
import { buildDouyinProfilePostsExportRows, downloadDouyinProfilePostsData } from "./export-data.js";
import { isDouyinProfileUrl } from "../capture.js";
import { createWeiboProfileMonitor } from "../../weibo/profile-monitor.js";

export const mountDouyinProfilePostsMonitor = createWeiboProfileMonitor({
  kind: "posts",
  platformId: "douyin",
  platformName: "抖音",
  runPrefix: "DY",
  runScope: "douyin-profile-posts",
  storageKey: "browserCoreClawDouyinProfilePostsV1",
  captureMessage: MESSAGE_CAPTURE_DOUYIN_PROFILE_POSTS,
  stopMessage: MESSAGE_STOP_DOUYIN_PROFILE_POSTS,
  validateTargetUrl: isDouyinProfileUrl,
  featureName: "抖音博主博文采集",
  subjectLabel: "抖音博主主页",
  inputLabel: "抖音博主主页链接",
  inputPlaceholder: "https://www.douyin.com/user/用户ID",
  inputDescription: "每个主页链接独立采集公开作品；没有额外筛选条件，作品不足设定数量时以页面实际数量为准。",
  batchDescription: "每行一个抖音博主主页链接（例如 <code>https://www.douyin.com/user/用户ID</code>）；应用后会替换当前列表。",
  initialNotice: "填写抖音博主主页链接后即可采集公开作品。",
  idleActionText: "运行会打开抖音博主主页，等待作品列表稳定后按页面原始顺序采集。",
  pipelineText: "程序打开公开主页，连续确认用户资料与作品列表稳定后，再滚动补齐作品卡片；不改变原页面排序。",
  guideIntro: "功能按抖音博主主页“作品”列表的原始顺序采集公开作品，不改变页面排序或互动状态。",
  guideInputText: "输入一个或多个抖音博主主页链接，格式为 <code>https://www.douyin.com/user/用户ID</code>。",
  guideWaitText: "程序会确认主页资料和作品列表连续稳定后，再开始读取并在需要时滚动加载。",
  fieldList: "videoId · text · likes · cover · url",
  fieldKeys: ["profileUrl", "pageOrder", "videoId", "text", "likes", "cover", "url", "capturedAt"],
  entityType: "content",
  contentType: "video",
  dataSummary: "作品按抖音主页卡片原始顺序保存。",
  emptyDataText: "运行后，抖音主页作品会显示在这里",
  dataFilters: [
    { key: "profileUrl", label: "博主主页", type: "select" },
    { key: "pageOrder", label: "顺序" },
    { key: "videoId", label: "作品 ID" },
    { key: "text", label: "作品描述" },
    { key: "likes", label: "点赞" },
    { key: "url", label: "作品链接" },
    { key: "capturedAt", label: "采集时间", placeholder: "例如 2026-07-16" }
  ],
  dataColumns: [
    { key: "profileUrl", label: "博主主页", type: "link" },
    { key: "order", label: "顺序" },
    { key: "videoId", label: "作品 ID" },
    { key: "text", label: "作品描述", type: "long" },
    { key: "likes", label: "点赞" },
    { key: "cover", label: "封面", type: "image" },
    { key: "postUrl", label: "作品链接", type: "link" },
    { key: "collectedAt", label: "采集时间" }
  ],
  toRows(data, profileUrl) {
    return (data?.posts || []).map((post) => ({ id: `${profileUrl}|${post.videoId || post.url}`, profileUrl, pageOrder: post.order, ...post, capturedAt: data?.capturedAt || new Date().toISOString() }));
  },
  downloadData: downloadDouyinProfilePostsData,
  buildExportRows: buildDouyinProfilePostsExportRows,
  renderDataTable(rows, escapeHtml, { emptyText } = {}) {
    return `<thead><tr><th>顺序</th><th>作品 ID</th><th>作品描述</th><th>点赞</th><th>封面</th><th>作品链接</th><th>采集时间</th></tr></thead><tbody>${rows.length ? rows.map((row) => `<tr><td>${row.pageOrder || "-"}</td><td>${escapeHtml(row.videoId || "-")}</td><td class="xhs-description-cell" title="${escapeHtml(row.text || "")}">${escapeHtml(row.text || "-")}</td><td>${escapeHtml(row.likes || "-")}</td><td>${row.cover ? `<img class="xhs-cover-thumb" src="${escapeHtml(row.cover)}" alt="" loading="lazy">` : "-"}</td><td>${row.url ? `<a href="${escapeHtml(row.url)}" target="_blank" rel="noreferrer">打开</a>` : "-"}</td><td>${escapeHtml(row.capturedAt || "-")}</td></tr>`).join("") : `<tr><td class="xhs-table-empty" colspan="7">${escapeHtml(emptyText || "运行后，抖音主页作品会显示在这里")}</td></tr>`}</tbody>`;
  }
});
