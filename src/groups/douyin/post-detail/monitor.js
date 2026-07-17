import { MESSAGE_CAPTURE_DOUYIN_POST_DETAIL, MESSAGE_STOP_DOUYIN_POST_DETAIL } from "./constants.js";
import { buildDouyinPostDetailExportRows, downloadDouyinPostDetailData } from "./export-data.js";
import { isDouyinPostUrl } from "../capture.js";
import { createWeiboProfileMonitor } from "../../weibo/profile-monitor.js";

export const mountDouyinPostDetailMonitor = createWeiboProfileMonitor({
  kind: "post-detail",
  platformId: "douyin",
  platformName: "抖音",
  runPrefix: "DY",
  runScope: "douyin-post-detail",
  storageKey: "browserCoreClawDouyinPostDetailV1",
  captureMessage: MESSAGE_CAPTURE_DOUYIN_POST_DETAIL,
  stopMessage: MESSAGE_STOP_DOUYIN_POST_DETAIL,
  targetOptionKey: "postUrl",
  validateTargetUrl: isDouyinPostUrl,
  subjectLabel: "抖音作品",
  inputLabel: "抖音作品链接",
  inputPlaceholder: "https://www.douyin.com/video/数字ID",
  inputDescription: "每个抖音作品链接独立采集公开详情；支持标准链接或 v.douyin.com 短链，可批量粘贴，不进行登录状态检测。",
  batchDescription: "每行一个抖音作品链接（例如 <code>https://www.douyin.com/video/数字ID</code> 或 <code>https://v.douyin.com/短码/</code>）；应用后会替换当前列表。",
  singleResultLabel: "每作品数据数",
  optionsNote: "每个作品链接只读取一条公开详情；不进行抖音登录状态检测。",
  initialNotice: "填写抖音作品链接后即可采集公开详情；此功能不进行登录状态检测。",
  idleActionText: "运行会打开抖音作品页，等待作者、描述和互动数据稳定后采集。",
  pipelineText: "程序逐条打开抖音作品链接，连续确认作品描述与互动数据稳定后再读取。",
  guideIntro: "功能按输入链接批量读取抖音公开作品详情，不改变作品内容或互动状态。",
  guideInputText: "输入一个或多个抖音作品链接，支持 <code>https://www.douyin.com/video/数字ID</code> 和 <code>https://v.douyin.com/短码/</code>。",
  guideWaitText: "程序会连续确认作者、描述与互动数据稳定后才开始读取。",
  fieldList: "videoId · author · text · publishedAt · likes · comments · favorites · shares · topics · contentLinks · cover · mediaUrls",
  fieldKeys: ["postUrl", "videoId", "author", "authorUrl", "authorAvatar", "text", "publishedAt", "likes", "comments", "favorites", "shares", "topics", "contentLinks", "cover", "mediaUrls", "detailRawText", "capturedAt"],
  entityType: "content",
  contentType: "video",
  featureName: "抖音博文采集",
  rowLabel: "作品",
  hasLimit: false,
  supportsPolling: false,
  dataSummary: "每条作品链接只保留最新一条详情数据。",
  emptyDataText: "运行后，抖音作品详情会显示在这里",
  dataFilters: [
    { key: "videoId", label: "作品 ID" },
    { key: "author", label: "作者", type: "select" },
    { key: "text", label: "作品描述" },
    { key: "publishedAt", label: "发布时间", placeholder: "例如 2026-07-15" },
    { key: "likes", label: "点赞" },
    { key: "comments", label: "评论" },
    { key: "favorites", label: "收藏" },
    { key: "shares", label: "分享" },
    { key: "topics", label: "话题" },
    { key: "postUrl", label: "作品链接" },
    { key: "capturedAt", label: "采集时间", placeholder: "例如 2026-07-16" }
  ],
  dataColumns: [
    { key: "videoId", label: "作品 ID" },
    { key: "author", label: "作者" },
    { key: "authorUrl", label: "作者主页", type: "link" },
    { key: "authorAvatar", label: "作者头像", type: "image" },
    { key: "text", label: "作品描述", type: "long" },
    { key: "publishedAt", label: "发布时间" },
    { key: "likes", label: "点赞" },
    { key: "comments", label: "评论" },
    { key: "favorites", label: "收藏" },
    { key: "shares", label: "分享" },
    { key: "topics", label: "话题", type: "long" },
    { key: "contentLinks", label: "关联链接", type: "long" },
    { key: "cover", label: "封面", type: "image" },
    { key: "mediaUrls", label: "媒体链接", type: "long" },
    { key: "detailRawText", label: "详情原文", type: "long" },
    { key: "postUrl", label: "作品链接", type: "link" },
    { key: "collectedAt", label: "采集时间" }
  ],
  toRows(data, postUrl) {
    const detail = data?.detail || {};
    const id = String(detail.videoId || detail.postUrl || postUrl || "").trim();
    return id ? [{ id, ...detail, postUrl: detail.postUrl || postUrl, capturedAt: data?.capturedAt || new Date().toISOString() }] : [];
  },
  downloadData: downloadDouyinPostDetailData,
  buildExportRows: buildDouyinPostDetailExportRows,
  renderDataTable(rows, escapeHtml, { emptyText } = {}) {
    return `<thead><tr><th>作品 ID</th><th>作者</th><th>作品描述</th><th>发布时间</th><th>点赞</th><th>评论</th><th>收藏</th><th>分享</th><th>话题</th><th>封面</th><th>媒体链接</th><th>作品链接</th><th>采集时间</th></tr></thead><tbody>${rows.length ? rows.map((row) => `<tr><td>${escapeHtml(row.videoId || "-")}</td><td>${row.authorUrl ? `<a href="${escapeHtml(row.authorUrl)}" target="_blank" rel="noreferrer">${escapeHtml(row.author || "-")}</a>` : escapeHtml(row.author || "-")}</td><td class="xhs-description-cell" title="${escapeHtml(row.text || "")}">${escapeHtml(row.text || "-")}</td><td>${escapeHtml(row.publishedAt || "-")}</td><td>${escapeHtml(row.likes || "-")}</td><td>${escapeHtml(row.comments || "-")}</td><td>${escapeHtml(row.favorites || "-")}</td><td>${escapeHtml(row.shares || "-")}</td><td class="xhs-description-cell" title="${escapeHtml(row.topics || "")}">${escapeHtml(row.topics || "-")}</td><td>${row.cover ? `<img class="xhs-cover-thumb" src="${escapeHtml(row.cover)}" alt="" loading="lazy">` : "-"}</td><td class="xhs-description-cell" title="${escapeHtml(row.mediaUrls || "")}">${escapeHtml(row.mediaUrls || "-")}</td><td>${row.postUrl ? `<a href="${escapeHtml(row.postUrl)}" target="_blank" rel="noreferrer">打开</a>` : "-"}</td><td>${escapeHtml(row.capturedAt || "-")}</td></tr>`).join("") : `<tr><td class="xhs-table-empty" colspan="13">${escapeHtml(emptyText || "运行后，抖音作品详情会显示在这里")}</td></tr>`}</tbody>`;
  }
});
