# 抖音博文采集

## 功能目的

按抖音作品链接批量采集单个作品的公开详情、作者信息、互动统计与话题。

## 输入与运行选项

- 支持标准作品链接：`https://www.douyin.com/video/数字ID`。
- 支持 `https://v.douyin.com/短码/` 短链，页面跳转后自动识别作品。
- 支持逐条输入、批量编辑和默认 `1000 - 6000 ms` 随机链接间隔。
- 不提供循环监控；每个链接只保留一条最新详情。
- 不进行抖音登录状态检测。

## 执行流程

1. 在独立任务标签页打开作品页。
2. 等待 `video-detail` 区域的正文、互动数和发布时间连续稳定。
3. 使用页面脚本等待详情稳定并读取作品数据；短链跳转后会在最终作品页继续检测。

## 数据字段

`videoId`、`postUrl`、`author`、`authorUrl`、`authorAvatar`、`text`、`publishedAt`、`likes`、`comments`、`favorites`、`shares`、`topics`、`contentLinks`、`cover`、`mediaUrls`、`detailRawText`、`capturedAt`。

## 数据与记录

- 每个作品链接单独生成运行记录，支持链接和状态筛选。
- 数据最多保留 3000 条，每种状态最多保留 200 条。
- 支持任务明细、数据筛选、复制筛选后的 JSON 和导出 CSV。

## 注意事项

作品视频通常由网页以浏览器媒体流播放，`mediaUrls` 可能是页面会话内的 `blob:` 地址；用于识别当前媒体，不保证可作为永久下载地址。

## 统一传输字段

每条新作品详情还会写入 `canonical`：`entityType` 为 `content`，`contentType` 为 `video`。统一字段保存作者、描述、发布时间、封面、媒体、话题和互动指标；抖音专有详情字段、原始字段和完整页面文本保留在 `platformExtra`。字段中文说明与示例见[统一传输数据模型](../data-schema.md)。
