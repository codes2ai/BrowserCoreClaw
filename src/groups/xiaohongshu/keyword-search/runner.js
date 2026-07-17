import { createBatchFeatureRunner } from "../../../shared/feature-runner.js";
import { normalizeXiaohongshuPublishedDate } from "../date-normalizer.js";
import { normalizeXiaohongshuLikes } from "../likes-normalizer.js";
import { captureXiaohongshuKeyword, stopXiaohongshuKeywordCapture } from "./background.js";
import {
  XIAOHONGSHU_FILTER_GROUPS,
  getXiaohongshuFilterLabel,
  normalizeXiaohongshuFilters
} from "./filter-options.js";

export const xiaohongshuKeywordSearchRunner = createBatchFeatureRunner({
  featureId: "xiaohongshu/keyword-search",
  name: "小红书关键词搜索",
  storageKey: "browserCoreClawXiaohongshuKeywordV1",
  inputKey: "keywords",
  inputLabel: "关键词",
  defaultLimit: 20,
  validateInput: (value) => Boolean(String(value || "").trim()),
  normalizeExtraParameters(input) {
    return normalizeXiaohongshuFilters(input);
  },
  executeItem({ input, runId, parameters }) {
    const filters = Object.fromEntries(XIAOHONGSHU_FILTER_GROUPS.map((group) => [
      `${group.key}Label`,
      getXiaohongshuFilterLabel(group.key, parameters[group.key])
    ]));
    return captureXiaohongshuKeyword({
      runId,
      tabId: null,
      isolated: true,
      query: input,
      limit: parameters.limit,
      filters
    });
  },
  stopItem: ({ runId }) => stopXiaohongshuKeywordCapture({ runId }),
  toRows(data, keyword) {
    const capturedAt = data?.capturedAt || new Date().toISOString();
    return (data?.results || []).map((result, index) => {
      const publishedAtRaw = result.publishedAtRaw || result.publishedAt || result.time || "";
      const publishedAt = normalizeXiaohongshuPublishedDate(publishedAtRaw, { referenceDate: capturedAt });
      return {
        id: `${keyword}|${result.url || result.title}`,
        keyword,
        pageOrder: Number(result.order) || index + 1,
        title: result.title || "",
        description: result.description || result.desc || "",
        author: result.author || result.source || "",
        likes: normalizeXiaohongshuLikes(result.likes),
        time: publishedAt,
        publishedAt,
        publishedAtRaw,
        cover: result.cover || "",
        url: result.url || "",
        capturedAt
      };
    });
  }
});

export default xiaohongshuKeywordSearchRunner;
