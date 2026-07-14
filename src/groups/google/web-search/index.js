import { mountFeaturePlaceholder } from "../../../shared/feature-placeholder.js";

export function mount(container, context) {
  return mountFeaturePlaceholder(container, context, {
    highlights: [
      "关键词批量搜索和分页采集",
      "整理标题、摘要、排名和目标链接",
      "搜索结果去重与结构化导出"
    ],
    nextSteps: [
      "定义网页搜索结果字段",
      "接入 Google 搜索页面解析",
      "增加批量队列和采集间隔"
    ]
  });
}
