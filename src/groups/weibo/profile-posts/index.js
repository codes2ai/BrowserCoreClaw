import { mountFeaturePlaceholder } from "../../../shared/feature-placeholder.js";

export function mount(container, context) {
  return mountFeaturePlaceholder(container, context, {
    highlights: [
      "按微博主页地址采集公开博文",
      "整理正文、发布时间、图片和互动数据",
      "支持时间范围、节流和表格导出"
    ],
    nextSteps: [
      "确认 PC 与移动端目标页面",
      "定义博文标准数据结构",
      "实现滚动分页和风控策略"
    ]
  });
}
