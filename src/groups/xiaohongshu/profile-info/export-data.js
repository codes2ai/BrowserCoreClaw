export function buildXiaohongshuProfileInfoExportRows(dataRows) {
  return (Array.isArray(dataRows) ? dataRows : []).map((row) => ({
    profileUrl: row.profileUrl || "",
    profileId: row.profileId || "",
    avatar: row.avatar || "",
    nickname: row.nickname || "",
    xiaohongshuId: row.xiaohongshuId || "",
    ipLocation: row.ipLocation || "",
    bio: row.bio || "",
    tags: row.tags || "",
    following: row.following || "",
    followers: row.followers || "",
    likedAndCollected: row.likedAndCollected || "",
    collectedAt: row.capturedAt || ""
  }));
}

function csvCell(value) {
  let text = String(value ?? "");
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export function serializeXiaohongshuProfileInfoJson(dataRows) {
  return JSON.stringify(buildXiaohongshuProfileInfoExportRows(dataRows), null, 2);
}

export function serializeXiaohongshuProfileInfoCsv(dataRows) {
  const columns = ["profileUrl", "profileId", "avatar", "nickname", "xiaohongshuId", "ipLocation", "bio", "tags", "following", "followers", "likedAndCollected", "collectedAt"];
  const rows = buildXiaohongshuProfileInfoExportRows(dataRows);
  return `\uFEFF${[columns.map(csvCell).join(","), ...rows.map((row) => columns.map((column) => csvCell(row[column])).join(","))].join("\r\n")}`;
}

function downloadFile(filename, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function exportTimestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

export function downloadXiaohongshuProfileInfoData(dataRows, format) {
  const timestamp = exportTimestamp();
  if (format === "json") {
    downloadFile(`xiaohongshu-profile-info-${timestamp}.json`, serializeXiaohongshuProfileInfoJson(dataRows), "application/json;charset=utf-8");
    return;
  }
  if (format === "csv") {
    downloadFile(`xiaohongshu-profile-info-${timestamp}.csv`, serializeXiaohongshuProfileInfoCsv(dataRows), "text/csv;charset=utf-8");
    return;
  }
  throw new Error(`不支持的导出格式：${format}`);
}
