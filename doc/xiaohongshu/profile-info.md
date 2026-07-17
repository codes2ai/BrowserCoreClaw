# 小红书博主信息采集

## 功能目的

按小红书公开主页采集博主资料和互动统计，不读取笔记卡片。

## 登录要求

运行前需要通过小红书登录检测；登录失效、安全验证或公开资料不可访问时，任务会保留失败原因。

## 输入与运行选项

- 输入格式：小红书 `/user/profile/<id>` 主页链接。
- 支持多个主页、批量编辑、默认 `1000 - 6000 ms` 随机主页间隔和循环监控。

## 执行流程

1. 打开主页并等待资料区稳定。
2. 读取公开头像、昵称、账号标识、简介、IP 属地、标签和互动统计。
3. 每个主页只保留最新一条资料数据。

## 数据字段

`profileUrl`、`profileId`、`avatar`、`nickname`、`xiaohongshuId`、`ipLocation`、`bio`、`tags`、`following`、`followers`、`likedAndCollected`、`capturedAt`。

## 数据与记录

- 支持主页、状态筛选及任务错误明细。
- 数据最多保留 3000 条，每种状态最多 200 条记录。
- 支持数据筛选、复制筛选后的 JSON 与导出 CSV。

## 统一传输字段

每条新主页资料还会写入 `canonical`：`entityType` 为 `profile`。`profile` 保存主页 ID、昵称、小红书号、头像、简介、IP 属地和标签，`metrics` 保存关注、粉丝、获赞与收藏；原始字段与完整可见页面文本保留在 `platformExtra`。字段中文说明与示例见[统一传输数据模型](../data-schema.md)。
