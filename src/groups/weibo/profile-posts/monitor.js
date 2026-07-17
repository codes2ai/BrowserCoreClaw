import { MESSAGE_CAPTURE_WEIBO_PROFILE_POSTS, MESSAGE_STOP_WEIBO_PROFILE_POSTS } from "./constants.js";
import { buildWeiboProfilePostsExportRows, downloadWeiboProfilePostsData } from "./export-data.js";
import { createWeiboProfileMonitor } from "../profile-monitor.js";

export const mountWeiboProfilePostsMonitor = createWeiboProfileMonitor({
  kind: "posts",
  storageKey: "browserCoreClawWeiboProfilePostsV1",
  captureMessage: MESSAGE_CAPTURE_WEIBO_PROFILE_POSTS,
  stopMessage: MESSAGE_STOP_WEIBO_PROFILE_POSTS,
  featureName: "微博博主博文采集",
  defaultLimit: 10,
  defaultLimitVersion: 1,
  limitLabel: "每主页结果数",
  limitHelp: "默认 10 条；博文不足时按页面实际数量保存。",
  optionsNote: "每个主页链接都是独立任务；并发任务使用独立标签页。主页内采用短距离分段滚动和随机停顿，降低连续快速加载。",
  initialNotice: "已确认微博登录状态。填写微博博主主页链接后即可采集公开博文。",
  idleActionText: "运行会打开微博博主主页，等待博文列表稳定后按页面顺序采集。",
  pipelineText: "程序使用独立标签页打开微博主页，确认资料区和博文列表稳定后，以短距离分段滚动并在每次滚动后随机停顿，再补齐公开博文卡片。",
  guideIntro: "确认当前 Chrome Profile 已登录微博后，按公开主页的原始卡片顺序采集博文，不修改页面筛选条件。",
  guideWaitText: "程序先确认页面稳定，再进行短距离分段滚动；每次滚动随机等待 2.2–4.5 秒后才继续读取。",
  fieldList: "postId · author · text · publishedAt · source · reposts · comments · likes · mediaUrls · url",
  dataSummary: "博文按微博主页卡片原始顺序保存。",
  emptyDataText: "运行后，微博主页博文会显示在这里",
  dataFilters: [
    { key: "profileUrl", label: "博主主页", type: "select" },
    { key: "pageOrder", label: "顺序" },
    { key: "postId", label: "博文 ID" },
    { key: "text", label: "正文" },
    { key: "author", label: "作者", type: "select" },
    { key: "publishedAt", label: "发布时间", placeholder: "例如 2026-07-15" },
    { key: "reposts", label: "转发" },
    { key: "comments", label: "评论" },
    { key: "likes", label: "点赞" },
    { key: "url", label: "博文链接" },
    { key: "capturedAt", label: "采集时间", placeholder: "例如 2026-07-16" }
  ],
  dataColumns: [
    { key: "profileUrl", label: "博主主页", type: "link" },
    { key: "order", label: "顺序" },
    { key: "postId", label: "博文 ID" },
    { key: "author", label: "作者" },
    { key: "text", label: "正文", type: "long" },
    { key: "publishedAt", label: "发布时间" },
    { key: "source", label: "来源" },
    { key: "reposts", label: "转发" },
    { key: "comments", label: "评论" },
    { key: "likes", label: "点赞" },
    { key: "mediaUrls", label: "媒体链接", type: "long" },
    { key: "postUrl", label: "博文链接", type: "link" },
    { key: "collectedAt", label: "采集时间" }
  ],
  toRows(data, profileUrl) {
    return (data?.posts || []).map((post) => ({ id: `${profileUrl}|${post.postId || post.url}`, profileUrl, pageOrder: post.order, ...post, capturedAt: data?.capturedAt || new Date().toISOString() }));
  },
  downloadData: downloadWeiboProfilePostsData,
  buildExportRows: buildWeiboProfilePostsExportRows,
  renderDataTable(rows, escapeHtml, { emptyText } = {}) {
    return `<thead><tr><th>顺序</th><th>博文 ID</th><th>正文</th><th>作者</th><th>发布时间</th><th>转发</th><th>评论</th><th>点赞</th><th>媒体</th><th>博文链接</th><th>采集时间</th></tr></thead><tbody>${rows.length ? rows.map((row) => `<tr><td>${row.pageOrder || "-"}</td><td>${escapeHtml(row.postId || "-")}</td><td class="xhs-description-cell" title="${escapeHtml(row.text || "")}">${escapeHtml(row.text || "-")}</td><td>${escapeHtml(row.author || "-")}</td><td>${escapeHtml(row.publishedAt || "-")}</td><td>${escapeHtml(row.reposts || "0")}</td><td>${escapeHtml(row.comments || "0")}</td><td>${escapeHtml(row.likes || "0")}</td><td class="xhs-description-cell" title="${escapeHtml(row.mediaUrls || "")}">${escapeHtml(row.mediaUrls || "-")}</td><td>${row.url ? `<a href="${escapeHtml(row.url)}" target="_blank" rel="noreferrer">打开</a>` : "-"}</td><td>${escapeHtml(row.capturedAt || "-")}</td></tr>`).join("") : `<tr><td class="xhs-table-empty" colspan="11">${escapeHtml(emptyText || "运行后，微博主页博文会显示在这里")}</td></tr>`}</tbody>`;
  }
});
