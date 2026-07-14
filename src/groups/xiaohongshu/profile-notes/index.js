import { mountFeaturePlaceholder } from "../../../shared/feature-placeholder.js";

export function mount(container, context) {
  return mountFeaturePlaceholder(container, context, {
    highlights: [
      "根据小红书用户主页地址采集公开笔记",
      "整理作者信息、笔记链接和媒体封面",
      "支持滚动分页、去重和表格导出"
    ],
    nextSteps: [
      "确定用户主页地址和数据字段",
      "实现主页加载、滚动和笔记解析",
      "增加采集进度与结果持久化"
    ]
  });
}
