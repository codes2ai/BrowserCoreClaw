import { MESSAGE_CAPTURE_WEIBO_PROFILE_POSTS, MESSAGE_STOP_WEIBO_PROFILE_POSTS } from "./constants.js";
import { downloadWeiboProfilePostsData } from "./export-data.js";
import { createWeiboProfileMonitor } from "../profile-monitor.js";

export const mountWeiboProfilePostsMonitor = createWeiboProfileMonitor({
  kind: "posts",
  storageKey: "browserCoreClawWeiboProfilePostsV1",
  captureMessage: MESSAGE_CAPTURE_WEIBO_PROFILE_POSTS,
  stopMessage: MESSAGE_STOP_WEIBO_PROFILE_POSTS,
  featureName: "微博博主博文采集",
  initialNotice: "填写微博博主主页链接后即可采集公开博文。",
  idleActionText: "运行会打开微博博主主页，等待博文列表稳定后按页面顺序采集。",
  pipelineText: "使用当前 Chrome 标签页打开微博主页，确认资料区和博文列表连续稳定后，再滚动补齐公开博文卡片。",
  guideIntro: "功能按微博公开主页的原始卡片顺序采集博文，不修改页面筛选条件。",
  fieldList: "postId · author · text · publishedAt · source · reposts · comments · likes · mediaUrls · url",
  dataSummary: "博文按微博主页卡片原始顺序保存。",
  toRows(data, profileUrl) {
    return (data?.posts || []).map((post) => ({ id: `${profileUrl}|${post.postId || post.url}`, profileUrl, pageOrder: post.order, ...post, capturedAt: data?.capturedAt || new Date().toISOString() }));
  },
  downloadData: downloadWeiboProfilePostsData,
  renderDataTable(rows, escapeHtml) {
    return `<thead><tr><th>顺序</th><th>博文 ID</th><th>正文</th><th>作者</th><th>发布时间</th><th>转发</th><th>评论</th><th>点赞</th><th>媒体</th><th>博文链接</th><th>采集时间</th></tr></thead><tbody>${rows.length ? rows.map((row) => `<tr><td>${row.pageOrder || "-"}</td><td>${escapeHtml(row.postId || "-")}</td><td class="xhs-description-cell" title="${escapeHtml(row.text || "")}">${escapeHtml(row.text || "-")}</td><td>${escapeHtml(row.author || "-")}</td><td>${escapeHtml(row.publishedAt || "-")}</td><td>${escapeHtml(row.reposts || "0")}</td><td>${escapeHtml(row.comments || "0")}</td><td>${escapeHtml(row.likes || "0")}</td><td class="xhs-description-cell" title="${escapeHtml(row.mediaUrls || "")}">${escapeHtml(row.mediaUrls || "-")}</td><td>${row.url ? `<a href="${escapeHtml(row.url)}" target="_blank" rel="noreferrer">打开</a>` : "-"}</td><td>${escapeHtml(row.capturedAt || "-")}</td></tr>`).join("") : `<tr><td class="xhs-table-empty" colspan="11">运行后，微博主页博文会显示在这里</td></tr>`}</tbody>`;
  }
});
