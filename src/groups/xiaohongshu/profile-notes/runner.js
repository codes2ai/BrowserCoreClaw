import { createBatchFeatureRunner } from "../../../shared/feature-runner.js";
import { normalizeXiaohongshuLikes } from "../likes-normalizer.js";
import { captureXiaohongshuProfile, stopXiaohongshuProfileCapture } from "./background.js";

function isProfileUrl(value) {
  try {
    const url = new URL(value);
    return /(^|\.)xiaohongshu\.com$/i.test(url.hostname)
      && /^\/user\/profile\/[^/]+\/?$/i.test(url.pathname);
  } catch {
    return false;
  }
}

export const xiaohongshuProfileNotesRunner = createBatchFeatureRunner({
  featureId: "xiaohongshu/profile-notes",
  name: "小红书博主博文采集",
  storageKey: "browserCoreClawXiaohongshuProfileV1",
  inputKey: "profileUrls",
  inputLabel: "小红书博主主页链接",
  defaultLimit: 20,
  validateInput: isProfileUrl,
  executeItem({ input, runId, parameters }) {
    return captureXiaohongshuProfile({
      runId,
      tabId: null,
      isolated: true,
      profileUrl: input,
      limit: parameters.limit
    });
  },
  stopItem: ({ runId }) => stopXiaohongshuProfileCapture({ runId }),
  toRows(data, profileUrl) {
    return (data?.notes || []).map((note, index) => ({
      id: String(note.noteId || note.url || `${profileUrl}|${index}`),
      profileUrl,
      pageOrder: Number(note.order) || index + 1,
      noteId: note.noteId || "",
      noteTitle: note.title || "",
      noteAuthor: note.author || "",
      noteLikes: normalizeXiaohongshuLikes(note.likes),
      noteCover: note.cover || "",
      noteUrl: note.url || "",
      capturedAt: data?.capturedAt || new Date().toISOString()
    }));
  }
});

export default xiaohongshuProfileNotesRunner;
