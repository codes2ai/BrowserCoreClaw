export function buildWeiboProfileInfoExportRows(dataRows) {
  return (Array.isArray(dataRows) ? dataRows : []).map((row) => ({
    profileUrl: row.profileUrl || "",
    profileId: row.profileId || "",
    cover: row.cover || "",
    avatar: row.avatar || "",
    nickname: row.nickname || "",
    gender: row.gender || "",
    membershipBadges: row.membershipBadges || "",
    bio: row.bio || "",
    profileDescription: row.profileDescription || "",
    following: row.following || "",
    followers: row.followers || "",
    engagement: row.engagement || "",
    yesterdayPosts: row.yesterdayPosts || "",
    yesterdayReads: row.yesterdayReads || "",
    yesterdayInteractions: row.yesterdayInteractions || "",
    videoTotalViews: row.videoTotalViews || "",
    influenceRanks: row.influenceRanks || "",
    serviceUnit: row.serviceUnit || "",
    newsServiceLicense: row.newsServiceLicense || "",
    serviceCategory: row.serviceCategory || "",
    friendCount: row.friendCount || "",
    profileDetailLines: row.profileDetailLines || "",
    profileCardText: row.profileCardText || "",
    collectedAt: row.capturedAt || ""
  }));
}

function csvCell(value) {
  let text = String(value ?? "");
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function download(filename, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement("a");
  anchor.href = url; anchor.download = filename; document.body.append(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function timestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

export function downloadWeiboProfileInfoData(dataRows, format) {
  const rows = buildWeiboProfileInfoExportRows(dataRows);
  if (format === "json") return download(`weibo-profile-info-${timestamp()}.json`, JSON.stringify(rows, null, 2), "application/json;charset=utf-8");
  if (format === "csv") {
    const columns = ["profileUrl", "profileId", "cover", "avatar", "nickname", "gender", "membershipBadges", "bio", "profileDescription", "following", "followers", "engagement", "yesterdayPosts", "yesterdayReads", "yesterdayInteractions", "videoTotalViews", "influenceRanks", "serviceUnit", "newsServiceLicense", "serviceCategory", "friendCount", "profileDetailLines", "profileCardText", "collectedAt"];
    return download(`weibo-profile-info-${timestamp()}.csv`, `\uFEFF${[columns.map(csvCell).join(","), ...rows.map((row) => columns.map((column) => csvCell(row[column])).join(","))].join("\r\n")}`, "text/csv;charset=utf-8");
  }
  throw new Error(`不支持的导出格式：${format}`);
}
