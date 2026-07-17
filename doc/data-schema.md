# 统一传输数据模型

BrowserCoreClaw 的功能页面继续保留各自最适合阅读与导出的原始字段；从本版本起，每条新采集结果还会写入 `canonical`。数据传输页面读取此字段，将 Google 新闻、微博、抖音和小红书的结果统一成两类实体，方便后续远程归档、检索和跨平台分析。

## 实体类型

| `entityType` | 含义 | 来源功能 |
| --- | --- | --- |
| `content` | 可发布、可阅读或可播放的内容 | Google 新闻、微博/抖音/小红书的列表与正文采集 |
| `profile` | 博主或账号公开资料 | 微博、抖音、小红书的博主信息采集 |

Google 新闻使用 `entityType: "content"`、`contentType: "news"`，与博文、笔记和视频共用内容模型。

## 通用字段

| 字段 | 中文说明 |
| --- | --- |
| `schemaVersion` | 统一模型版本，当前为 `1`。 |
| `id` | 跨传输使用的稳定实体标识，由平台、实体类型和平台实体 ID 组成。 |
| `entityType` | 实体类别：`content` 或 `profile`。 |
| `platform` | 数据来源平台：`google`、`xiaohongshu`、`weibo`、`douyin`。 |
| `featureId` | 采集功能唯一标识，例如 `weibo/post-detail`。 |
| `platformEntityId` | 平台原始内容 ID、笔记 ID、视频 ID 或主页 ID。 |
| `canonicalUrl` | 该实体的标准公开链接。 |
| `title` | 标题；无独立标题的博文或视频使用正文摘要。 |
| `text` / `summary` | 正文与摘要；缺失时为空字符串。 |
| `publishedAt` | 页面可读取的发布时间；格式由各平台功能统一处理。 |
| `collectedAt` | 扩展实际采集时间。 |

## 内容实体扩展

内容记录含有以下字段：

| 字段 | 中文说明 |
| --- | --- |
| `contentType` | 内容类型：`news`、`note`、`post` 或 `video`。 |
| `author` | 作者对象，包含 `id`、`name`、`url`、`avatarUrl`。 |
| `media` | 媒体数组，每项为 `{ type, url }`；可能是封面、图片、视频或媒体链接。 |
| `topics` / `mentions` | 话题与提及列表。 |
| `metrics` | 标准互动指标。`0` 表示页面明确显示为零，`null` 表示页面未提供或不适用。 |

`metrics` 目前按适用情况使用 `likeCount`、`commentCount`、`favoriteCount`、`shareCount`、`repostCount` 等字段。

## 博主资料实体扩展

资料记录包含 `profile` 对象和资料指标：

| 字段 | 中文说明 |
| --- | --- |
| `profile.id` / `profile.url` | 平台主页标识与主页链接。 |
| `profile.avatarUrl` / `profile.coverUrl` | 头像与主页封面。 |
| `profile.displayName` / `profile.handle` | 昵称与平台号（如有）。 |
| `profile.bio` / `profile.location` / `profile.tags` | 公开简介、地区与标签。 |
| `metrics.followingCount` / `metrics.followerCount` | 关注数与粉丝数。 |
| `metrics.likedReceivedCount` | 获赞或获赞与收藏数。 |

微博主页的昨日发博、阅读、互动、视频播放等平台专有指标也会保留在 `metrics` 或 `platformExtra` 中。

## 来源和平台扩展字段

| 字段 | 中文说明 |
| --- | --- |
| `sourceContext.entryType` | 采集入口，例如 `keyword-search`、`profile-list`、`post-detail`、`profile-info`。 |
| `sourceContext.query` | 关键词搜索的关键词；非关键词任务为空。 |
| `sourceContext.sourceProfileUrl` | 从博主列表采集内容时的来源主页。 |
| `sourceContext.pageOrder` | 页面当前顺序；没有时为 `null`。 |
| `platformExtra` | 无法可靠横向抽象的原生字段容器。 |
| `platformExtra.rawPageText` | 采集当刻页面完整可见文本；保留用于审计、回溯和平台页面变更排查。 |
| `platformExtra.rawFields` | 功能的结构化原始字段快照；超长页面原文字段统一由 `rawPageText` 保存，避免重复占用存储。 |

## 示例：Google 新闻

```json
{
  "entityType": "content",
  "platform": "google",
  "featureId": "google/google-news",
  "contentType": "news",
  "title": "新闻标题",
  "summary": "新闻摘要",
  "publishedAt": "2026-07-17 16:02:37",
  "sourceContext": { "entryType": "keyword-search", "query": "OpenAI" },
  "platformExtra": {
    "source": "新闻来源",
    "rawPageText": "Google 新闻页面完整可见文本"
  }
}
```
