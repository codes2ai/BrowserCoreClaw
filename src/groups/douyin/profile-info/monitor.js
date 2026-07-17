import { MESSAGE_CAPTURE_DOUYIN_PROFILE_INFO, MESSAGE_STOP_DOUYIN_PROFILE_INFO } from "./constants.js";
import { buildDouyinProfileInfoExportRows, downloadDouyinProfileInfoData } from "./export-data.js";
import { isDouyinProfileUrl } from "../capture.js";
import { createWeiboProfileMonitor } from "../../weibo/profile-monitor.js";

export const mountDouyinProfileInfoMonitor = createWeiboProfileMonitor({
  kind: "info",
  platformId: "douyin",
  platformName: "抖音",
  runPrefix: "DY",
  runScope: "douyin-profile-info",
  storageKey: "browserCoreClawDouyinProfileInfoV1",
  captureMessage: MESSAGE_CAPTURE_DOUYIN_PROFILE_INFO,
  stopMessage: MESSAGE_STOP_DOUYIN_PROFILE_INFO,
  validateTargetUrl: isDouyinProfileUrl,
  featureName: "抖音博主信息采集",
  subjectLabel: "抖音博主主页",
  inputLabel: "抖音博主主页链接",
  inputPlaceholder: "https://www.douyin.com/user/用户ID",
  inputDescription: "每个主页链接独立采集公开资料与互动统计；此功能不进行抖音登录状态检测。",
  batchDescription: "每行一个抖音博主主页链接（例如 <code>https://www.douyin.com/user/用户ID</code>）；应用后会替换当前列表。",
  initialNotice: "填写抖音博主主页链接后即可采集公开资料；此功能不进行登录状态检测。",
  idleActionText: "运行会打开抖音博主主页并采集公开资料，无需登录前置检查。",
  pipelineText: "不进行登录状态检测。程序打开抖音公开主页，等待资料区稳定后读取头像、昵称、简介、ID 与互动统计。",
  guideIntro: "此功能只读取抖音公开展示的博主信息和互动统计，不读取私密资料，也不执行登录状态检测。",
  guideInputText: "输入一个或多个抖音博主主页链接，格式为 <code>https://www.douyin.com/user/用户ID</code>。",
  guideWaitText: "程序会等待资料区连续稳定后再读取；遇到平台安全验证时会提示你在当前标签页完成。",
  fieldList: "profileId · douyinId · avatar · nickname · following · followers · likes · ipLocation · age · location · bio · profileTags · profileRawText",
  dataSummary: "每个主页只保留最新一条博主资料。",
  emptyDataText: "运行后，抖音博主公开资料会显示在这里",
  dataFilters: [
    { key: "nickname", label: "昵称" },
    { key: "profileId", label: "主页 ID" },
    { key: "douyinId", label: "抖音号" },
    { key: "following", label: "关注" },
    { key: "followers", label: "粉丝" },
    { key: "likes", label: "获赞" },
    { key: "ipLocation", label: "IP 属地", type: "select" },
    { key: "age", label: "年龄" },
    { key: "location", label: "地区", type: "select" },
    { key: "bio", label: "简介" },
    { key: "profileTags", label: "标签" },
    { key: "profileUrl", label: "主页链接" },
    { key: "capturedAt", label: "采集时间", placeholder: "例如 2026-07-16" }
  ],
  dataColumns: [
    { key: "avatar", label: "头像", type: "image" },
    { key: "nickname", label: "昵称" },
    { key: "profileId", label: "主页 ID" },
    { key: "douyinId", label: "抖音号" },
    { key: "following", label: "关注" },
    { key: "followers", label: "粉丝" },
    { key: "likes", label: "获赞" },
    { key: "ipLocation", label: "IP 属地" },
    { key: "age", label: "年龄" },
    { key: "location", label: "地区" },
    { key: "bio", label: "简介", type: "long" },
    { key: "profileTags", label: "标签", type: "long" },
    { key: "profileRawText", label: "公开资料原文", type: "long" },
    { key: "profileUrl", label: "主页链接", type: "link" },
    { key: "collectedAt", label: "采集时间" }
  ],
  toRows(data, profileUrl) {
    const profile = data?.profile || {};
    const id = String(profile.profileId || profileUrl || "").trim();
    return id ? [{ id, ...profile, profileUrl: profile.profileUrl || profileUrl, capturedAt: data?.capturedAt || new Date().toISOString() }] : [];
  },
  downloadData: downloadDouyinProfileInfoData,
  buildExportRows: buildDouyinProfileInfoExportRows,
  renderDataTable(rows, escapeHtml, { emptyText } = {}) {
    return `<thead><tr><th>头像</th><th>昵称</th><th>主页 ID</th><th>抖音号</th><th>关注</th><th>粉丝</th><th>获赞</th><th>IP 属地</th><th>年龄</th><th>地区</th><th>简介</th><th>标签</th><th>公开资料原文</th><th>主页链接</th><th>采集时间</th></tr></thead><tbody>${rows.length ? rows.map((row) => `<tr><td>${row.avatar ? `<img class="xhs-cover-thumb" src="${escapeHtml(row.avatar)}" alt="" loading="lazy">` : "-"}</td><td>${escapeHtml(row.nickname || "-")}</td><td>${escapeHtml(row.profileId || "-")}</td><td>${escapeHtml(row.douyinId || "-")}</td><td>${escapeHtml(row.following || "-")}</td><td>${escapeHtml(row.followers || "-")}</td><td>${escapeHtml(row.likes || "-")}</td><td>${escapeHtml(row.ipLocation || "-")}</td><td>${escapeHtml(row.age || "-")}</td><td>${escapeHtml(row.location || "-")}</td><td class="xhs-description-cell" title="${escapeHtml(row.bio || "")}">${escapeHtml(row.bio || "-")}</td><td class="xhs-description-cell" title="${escapeHtml(row.profileTags || "")}">${escapeHtml(row.profileTags || "-")}</td><td class="xhs-description-cell" title="${escapeHtml(row.profileRawText || "")}">${escapeHtml(row.profileRawText || "-")}</td><td>${row.profileUrl ? `<a href="${escapeHtml(row.profileUrl)}" target="_blank" rel="noreferrer">打开</a>` : "-"}</td><td>${escapeHtml(row.capturedAt || "-")}</td></tr>`).join("") : `<tr><td class="xhs-table-empty" colspan="15">${escapeHtml(emptyText || "运行后，抖音博主公开资料会显示在这里")}</td></tr>`}</tbody>`;
  }
});
