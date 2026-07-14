import { downloadDouyinRows } from "../export-utils.js";

const columns = ["profileUrl", "profileId", "douyinId", "avatar", "nickname", "following", "followers", "likes", "ipLocation", "age", "location", "bio", "profileTags", "profileRawText", "collectedAt"];

export function buildDouyinProfileInfoExportRows(dataRows) {
  return (Array.isArray(dataRows) ? dataRows : []).map((row) => ({
    profileUrl: row.profileUrl || "",
    profileId: row.profileId || "",
    douyinId: row.douyinId || "",
    avatar: row.avatar || "",
    nickname: row.nickname || "",
    following: row.following || "",
    followers: row.followers || "",
    likes: row.likes || "",
    ipLocation: row.ipLocation || "",
    age: row.age || "",
    location: row.location || "",
    bio: row.bio || "",
    profileTags: row.profileTags || "",
    profileRawText: row.profileRawText || "",
    collectedAt: row.capturedAt || ""
  }));
}

export function downloadDouyinProfileInfoData(dataRows, format) {
  return downloadDouyinRows(buildDouyinProfileInfoExportRows(dataRows), { filenamePrefix: "douyin-profile-info", columns }, format);
}
