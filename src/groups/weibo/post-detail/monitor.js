import { MESSAGE_CAPTURE_WEIBO_POST_DETAIL, MESSAGE_STOP_WEIBO_POST_DETAIL } from "./constants.js";
import { buildWeiboPostDetailExportRows, downloadWeiboPostDetailData } from "./export-data.js";
import { createWeiboProfileMonitor } from "../profile-monitor.js";
import { normalizeWeiboPublishedAt } from "../date-normalizer.js";

function isWeiboPostUrl(value) {
  try {
    const url = new URL(value);
    return /(^|\.)weibo\.com$/i.test(url.hostname) && /^\/\d+\/[A-Za-z0-9]+\/?$/i.test(url.pathname);
  } catch { return false; }
}

export const mountWeiboPostDetailMonitor = createWeiboProfileMonitor({
  kind: "post-detail",
  storageKey: "browserCoreClawWeiboPostDetailV1",
  defaultUrls: ["https://weibo.com/2656274875/R8TUWtvwU"],
  captureMessage: MESSAGE_CAPTURE_WEIBO_POST_DETAIL,
  stopMessage: MESSAGE_STOP_WEIBO_POST_DETAIL,
  targetOptionKey: "postUrl",
  validateTargetUrl: isWeiboPostUrl,
  subjectLabel: "微博正文",
  inputLabel: "微博正文链接",
  inputPlaceholder: "https://weibo.com/数字用户ID/博文ID",
  inputDescription: "每个微博正文链接独立采集公开详情；可批量粘贴，不检测微博登录状态。",
  batchDescription: "每行一个微博正文链接（例如 <code>https://weibo.com/数字用户ID/博文ID</code>）；应用后会替换当前列表。",
  singleResultLabel: "每正文数据数",
  optionsNote: "每个正文链接只读取一条公开详情；不需要微博登录前置检查。",
  initialNotice: "填写微博正文链接后即可采集公开详情；此功能不要求登录状态。",
  idleActionText: "运行会打开微博正文页，等待内容、媒体和互动数据稳定后采集。",
  pipelineText: "无需登录前置检查。程序逐条打开微博正文链接，连续确认正文、媒体与互动数据稳定后再读取。",
  guideIntro: "功能按输入链接批量读取微博公开正文详情，不修改页面内容或互动状态。",
  guideInputText: "输入一个或多个微博正文链接，格式为 <code>https://weibo.com/数字用户ID/博文ID</code>。",
  guideWaitText: "程序会打开链接，连续确认正文、媒体和互动数稳定后才开始读取。",
  fieldList: "postId · author · text · publishedAt · source · topics · mentions · reposts · comments · likes · mediaUrls · contentLinks",
  fieldKeys: ["postUrl", "postId", "visibility", "author", "authorUrl", "authorAvatar", "text", "publishedAt", "source", "topics", "mentions", "reposts", "comments", "likes", "mediaUrls", "contentLinks", "capturedAt"],
  entityType: "content",
  contentType: "post",
  featureName: "微博正文采集",
  rowLabel: "正文",
  hasLimit: false,
  supportsPolling: false,
  dataSummary: "每条正文链接只保留最新一条详情数据。",
  emptyDataText: "运行后，微博正文详情会显示在这里",
  dataFilters: [
    { key: "postId", label: "博文 ID" },
    { key: "visibility", label: "可见范围", type: "select" },
    { key: "author", label: "作者", type: "select" },
    { key: "text", label: "正文" },
    { key: "publishedAt", label: "发布时间", placeholder: "例如 2026-07-15" },
    { key: "source", label: "来源", type: "select" },
    { key: "topics", label: "话题" },
    { key: "mentions", label: "提及" },
    { key: "reposts", label: "转发" },
    { key: "comments", label: "评论" },
    { key: "likes", label: "点赞" },
    { key: "postUrl", label: "正文链接" },
    { key: "capturedAt", label: "采集时间", placeholder: "例如 2026-07-16" }
  ],
  dataColumns: [
    { key: "postId", label: "博文 ID" },
    { key: "visibility", label: "可见范围" },
    { key: "author", label: "作者" },
    { key: "authorUrl", label: "作者主页", type: "link" },
    { key: "authorAvatar", label: "作者头像", type: "image" },
    { key: "text", label: "正文", type: "long" },
    { key: "publishedAt", label: "发布时间" },
    { key: "source", label: "来源" },
    { key: "reposts", label: "转发" },
    { key: "comments", label: "评论" },
    { key: "likes", label: "点赞" },
    { key: "topics", label: "话题", type: "long" },
    { key: "mentions", label: "提及", type: "long" },
    { key: "contentLinks", label: "关联链接", type: "long" },
    { key: "mediaUrls", label: "媒体链接", type: "long" },
    { key: "postUrl", label: "正文链接", type: "link" },
    { key: "collectedAt", label: "采集时间" }
  ],
  normalizeDataRow(row) {
    return {
      ...row,
      publishedAt: normalizeWeiboPublishedAt(row?.publishedAt, { referenceDate: row?.capturedAt })
    };
  },
  toRows(data, postUrl) {
    const detail = data?.detail || {};
    const id = String(detail.postId || detail.postUrl || postUrl || "").trim();
    return id ? [{ id, ...detail, postUrl: detail.postUrl || postUrl, capturedAt: data?.capturedAt || new Date().toISOString() }] : [];
  },
  downloadData: downloadWeiboPostDetailData,
  buildExportRows: buildWeiboPostDetailExportRows,
  renderDataTable(rows, escapeHtml, { emptyText } = {}) {
    return `<thead><tr><th>博文 ID</th><th>可见范围</th><th>作者</th><th>正文</th><th>发布时间</th><th>来源</th><th>话题</th><th>提及</th><th>转发</th><th>评论</th><th>点赞</th><th>媒体链接</th><th>关联链接</th><th>正文链接</th><th>采集时间</th></tr></thead><tbody>${rows.length ? rows.map((row) => `<tr><td>${escapeHtml(row.postId || "-")}</td><td>${escapeHtml(row.visibility || "-")}</td><td>${row.authorUrl ? `<a href="${escapeHtml(row.authorUrl)}" target="_blank" rel="noreferrer">${escapeHtml(row.author || "-")}</a>` : escapeHtml(row.author || "-")}</td><td class="xhs-description-cell" title="${escapeHtml(row.text || "")}">${escapeHtml(row.text || "-")}</td><td>${escapeHtml(row.publishedAt || "-")}</td><td>${escapeHtml(row.source || "-")}</td><td class="xhs-description-cell" title="${escapeHtml(row.topics || "")}">${escapeHtml(row.topics || "-")}</td><td class="xhs-description-cell" title="${escapeHtml(row.mentions || "")}">${escapeHtml(row.mentions || "-")}</td><td>${escapeHtml(row.reposts || "0")}</td><td>${escapeHtml(row.comments || "0")}</td><td>${escapeHtml(row.likes || "0")}</td><td class="xhs-description-cell" title="${escapeHtml(row.mediaUrls || "")}">${escapeHtml(row.mediaUrls || "-")}</td><td class="xhs-description-cell" title="${escapeHtml(row.contentLinks || "")}">${escapeHtml(row.contentLinks || "-")}</td><td>${row.postUrl ? `<a href="${escapeHtml(row.postUrl)}" target="_blank" rel="noreferrer">打开</a>` : "-"}</td><td>${escapeHtml(row.capturedAt || "-")}</td></tr>`).join("") : `<tr><td class="xhs-table-empty" colspan="15">${escapeHtml(emptyText || "运行后，微博正文详情会显示在这里")}</td></tr>`}</tbody>`;
  }
});
