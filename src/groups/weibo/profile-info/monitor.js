import { MESSAGE_CAPTURE_WEIBO_PROFILE_INFO, MESSAGE_STOP_WEIBO_PROFILE_INFO } from "./constants.js";
import { downloadWeiboProfileInfoData } from "./export-data.js";
import { createWeiboProfileMonitor } from "../profile-monitor.js";

export const mountWeiboProfileInfoMonitor = createWeiboProfileMonitor({
  kind: "info",
  storageKey: "browserCoreClawWeiboProfileInfoV1",
  captureMessage: MESSAGE_CAPTURE_WEIBO_PROFILE_INFO,
  stopMessage: MESSAGE_STOP_WEIBO_PROFILE_INFO,
  featureName: "微博博主信息采集",
  initialNotice: "填写微博博主主页链接后即可采集公开资料；此功能不要求登录状态。",
  idleActionText: "运行会打开微博博主主页并采集公开资料，无需登录前置检查。",
  pipelineText: "无需登录前置检查。程序打开微博公开主页，等待资料区稳定后读取头像、昵称、简介及互动统计。",
  guideIntro: "此功能仅采集微博公开资料，不依赖登录状态，也不会读取该博主的博文。",
  fieldList: "cover · avatar · nickname · gender · membershipBadges · bio · profileDescription · following · followers · engagement · yesterdayPosts · yesterdayReads · yesterdayInteractions · videoTotalViews · influenceRanks · serviceUnit · newsServiceLicense · serviceCategory · friendCount · profileDetailLines · profileCardText",
  dataSummary: "每个主页只保留最新一条博主资料。",
  toRows(data, profileUrl) {
    const profile = data?.profile || {};
    const id = String(profile.profileId || profileUrl || "").trim();
    return id ? [{ id, ...profile, profileUrl: profile.profileUrl || profileUrl, capturedAt: data?.capturedAt || new Date().toISOString() }] : [];
  },
  downloadData: downloadWeiboProfileInfoData,
  renderDataTable(rows, escapeHtml) {
    return `<thead><tr><th>主页封面</th><th>头像</th><th>昵称</th><th>微博 ID</th><th>性别</th><th>会员/标识</th><th>认证说明</th><th>主页简介</th><th>关注</th><th>粉丝</th><th>转评赞</th><th>昨日发博</th><th>昨日阅读数</th><th>昨日互动数</th><th>视频累计播放量</th><th>影响力标签</th><th>服务单位</th><th>新闻服务许可证</th><th>服务类别</th><th>好友数</th><th>扩展资料原文</th><th>主页公开信息</th><th>主页链接</th><th>采集时间</th></tr></thead><tbody>${rows.length ? rows.map((row) => `<tr><td>${row.cover ? `<img class="xhs-cover-thumb" src="${escapeHtml(row.cover)}" alt="" loading="lazy">` : "-"}</td><td>${row.avatar ? `<img class="xhs-cover-thumb" src="${escapeHtml(row.avatar)}" alt="" loading="lazy">` : "-"}</td><td>${escapeHtml(row.nickname || "-")}</td><td>${escapeHtml(row.profileId || "-")}</td><td>${escapeHtml(row.gender || "-")}</td><td class="xhs-description-cell" title="${escapeHtml(row.membershipBadges || "")}">${escapeHtml(row.membershipBadges || "-")}</td><td class="xhs-description-cell" title="${escapeHtml(row.bio || "")}">${escapeHtml(row.bio || "-")}</td><td class="xhs-description-cell" title="${escapeHtml(row.profileDescription || "")}">${escapeHtml(row.profileDescription || "-")}</td><td>${escapeHtml(row.following || "-")}</td><td>${escapeHtml(row.followers || "-")}</td><td>${escapeHtml(row.engagement || "-")}</td><td>${escapeHtml(row.yesterdayPosts || "-")}</td><td>${escapeHtml(row.yesterdayReads || "-")}</td><td>${escapeHtml(row.yesterdayInteractions || "-")}</td><td>${escapeHtml(row.videoTotalViews || "-")}</td><td class="xhs-description-cell" title="${escapeHtml(row.influenceRanks || "")}">${escapeHtml(row.influenceRanks || "-")}</td><td class="xhs-description-cell" title="${escapeHtml(row.serviceUnit || "")}">${escapeHtml(row.serviceUnit || "-")}</td><td class="xhs-description-cell" title="${escapeHtml(row.newsServiceLicense || "")}">${escapeHtml(row.newsServiceLicense || "-")}</td><td>${escapeHtml(row.serviceCategory || "-")}</td><td>${escapeHtml(row.friendCount || "-")}</td><td class="xhs-description-cell" title="${escapeHtml(row.profileDetailLines || "")}">${escapeHtml(row.profileDetailLines || "-")}</td><td class="xhs-description-cell" title="${escapeHtml(row.profileCardText || "")}">${escapeHtml(row.profileCardText || "-")}</td><td>${row.profileUrl ? `<a href="${escapeHtml(row.profileUrl)}" target="_blank" rel="noreferrer">打开</a>` : "-"}</td><td>${escapeHtml(row.capturedAt || "-")}</td></tr>`).join("") : `<tr><td class="xhs-table-empty" colspan="24">运行后，微博博主公开资料会显示在这里</td></tr>`}</tbody>`;
  }
});
