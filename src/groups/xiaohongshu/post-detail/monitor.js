import { createWeiboProfileMonitor } from "../../weibo/profile-monitor.js";
import { normalizeXiaohongshuPublishedDate } from "../date-normalizer.js";
import {
  mergeXiaohongshuPostDetailDataRow,
  normalizeXiaohongshuPostDetailDataRow
} from "./data-row.js";
import { isXiaohongshuPostUrl } from "./background.js";
import {
  MESSAGE_CAPTURE_XIAOHONGSHU_POST_DETAIL,
  MESSAGE_STOP_XIAOHONGSHU_POST_DETAIL
} from "./constants.js";
import {
  buildXiaohongshuPostDetailExportRows,
  downloadXiaohongshuPostDetailData
} from "./export-data.js";

export const mountXiaohongshuPostDetailMonitor = createWeiboProfileMonitor({
  kind: "post-detail",
  platformId: "xiaohongshu",
  platformName: "小红书",
  featureId: "post-detail",
  runPrefix: "XHS",
  runScope: "xiaohongshu-post-detail",
  storageKey: "browserCoreClawXiaohongshuPostDetailV1",
  defaultUrls: [""],
  captureMessage: MESSAGE_CAPTURE_XIAOHONGSHU_POST_DETAIL,
  stopMessage: MESSAGE_STOP_XIAOHONGSHU_POST_DETAIL,
  targetOptionKey: "postUrl",
  validateTargetUrl: isXiaohongshuPostUrl,
  subjectLabel: "小红书正文",
  inputLabel: "小红书正文链接",
  inputPlaceholder: "https://www.xiaohongshu.com/explore/笔记ID",
  inputDescription: "每个正文链接独立采集笔记详情；支持 search_result、explore、discovery/item 和博主主页中的笔记链接。",
  batchDescription: "每行一个小红书正文链接；应用后会替换当前列表。请保留链接中的 xsec_token 等查询参数。",
  singleResultLabel: "每正文数据数",
  optionsNote: "每个正文链接只读取一条详情；并发任务使用独立标签页，运行前需要通过小红书登录检测。",
  initialNotice: "填写小红书正文链接后即可采集标题、描述、作者、媒体和互动数据。",
  idleActionText: "运行会打开小红书正文页，等待作者、正文、媒体和互动数据稳定后采集。",
  pipelineText: "通过登录检测后，程序逐条打开正文链接，连续确认正文、媒体与互动数据稳定后再读取。",
  guideIntro: "功能按输入链接批量读取小红书正文详情，不修改笔记内容或互动状态。",
  guideInputText: "输入一个或多个小红书笔记正文链接；支持 search_result、explore、discovery/item 和博主主页中的笔记链接。",
  guideWaitText: "程序会连续确认目标笔记 ID、正文、作者、媒体和互动数据稳定后才开始读取。",
  fieldList: "noteId · noteType · title · description · author · publishedAt · ipLocation · likes · favorites · comments · shares · topics · imageUrls · videoUrls",
  featureName: "小红书正文采集",
  rowLabel: "正文",
  hasLimit: false,
  supportsPolling: false,
  dataSummary: "每条正文链接只保留最新一条详情数据。",
  emptyDataText: "运行后，小红书正文详情会显示在这里",
  dataFilters: [
    { key: "noteId", label: "笔记 ID" },
    { key: "noteType", label: "笔记类型", type: "select" },
    { key: "title", label: "标题" },
    { key: "description", label: "正文描述" },
    { key: "author", label: "作者", type: "select" },
    { key: "publishedAt", label: "发布时间", placeholder: "例如 2026-07-16" },
    { key: "ipLocation", label: "IP 属地", type: "select" },
    { key: "likes", label: "点赞" },
    { key: "favorites", label: "收藏" },
    { key: "comments", label: "评论" },
    { key: "shares", label: "分享" },
    { key: "topics", label: "话题" },
    { key: "postUrl", label: "正文链接" },
    { key: "capturedAt", label: "采集时间", placeholder: "例如 2026-07-16" }
  ],
  dataColumns: [
    { key: "noteId", label: "笔记 ID" },
    { key: "noteType", label: "类型" },
    { key: "title", label: "标题", type: "long" },
    { key: "description", label: "正文描述", type: "long" },
    { key: "author", label: "作者" },
    { key: "authorId", label: "作者 ID" },
    { key: "authorUrl", label: "作者主页", type: "link" },
    { key: "authorAvatar", label: "作者头像", type: "image" },
    { key: "publishedAt", label: "发布时间" },
    { key: "ipLocation", label: "IP 属地" },
    { key: "likes", label: "点赞" },
    { key: "favorites", label: "收藏" },
    { key: "comments", label: "评论" },
    { key: "shares", label: "分享" },
    { key: "topics", label: "话题", type: "long" },
    { key: "cover", label: "封面", type: "image" },
    { key: "imageUrls", label: "图片链接", type: "long" },
    { key: "videoUrls", label: "视频链接", type: "long" },
    { key: "postUrl", label: "正文链接", type: "link" },
    { key: "collectedAt", label: "采集时间" }
  ],
  normalizeDataRow(row) {
    return {
      ...normalizeXiaohongshuPostDetailDataRow(row),
      publishedAt: normalizeXiaohongshuPublishedDate(row?.publishedAt || row?.publishedAtRaw, {
        referenceDate: row?.capturedAt
      })
    };
  },
  mergeDataRow: mergeXiaohongshuPostDetailDataRow,
  toRows(data, postUrl) {
    const detail = data?.detail || {};
    const id = String(detail.noteId || "").trim();
    return id ? [{
      id,
      ...detail,
      postUrl: detail.postUrl || postUrl,
      capturedAt: data?.capturedAt || new Date().toISOString()
    }] : [];
  },
  downloadData: downloadXiaohongshuPostDetailData,
  buildExportRows: buildXiaohongshuPostDetailExportRows
});
