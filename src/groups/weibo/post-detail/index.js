import { mountFeaturePlaceholder } from "../../../shared/feature-placeholder.js";

export function mount(container, context) {
  return mountFeaturePlaceholder(container, context, {
    highlights: [
      "根据微博正文链接读取公开详情",
      "采集作者、正文、时间、图片和视频",
      "整理转发、评论、点赞等互动数据"
    ],
    nextSteps: [
      "确定支持的微博正文链接格式",
      "实现详情页加载和状态检测",
      "增加数据预览、复制和导出"
    ]
  });
}
