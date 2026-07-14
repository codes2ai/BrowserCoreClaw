import { mountFeaturePlaceholder } from "../../../shared/feature-placeholder.js";

export function mount(container, context) {
  return mountFeaturePlaceholder(container, context, {
    highlights: [
      "关键词批量搜索和自动滚动",
      "采集笔记、作者、封面与互动数据",
      "按笔记 ID 去重并保留增量结果"
    ],
    nextSteps: [
      "确定搜索结果字段和限制",
      "实现当前登录会话内的页面采集",
      "增加批量队列和数据导出"
    ]
  });
}
