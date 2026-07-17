# 微博博主信息采集

## 功能目的

按微博公开主页采集博主资料和主页可见互动统计，不读取博文列表。

## 输入与运行选项

- 输入格式：`https://weibo.com/u/数字ID`。
- 支持多主页和批量编辑。
- 支持默认 `1000 - 6000 ms` 随机主页间隔与循环监控。
- 不进行微博登录状态前置检查；仅采集当前页面公开可见的信息。

## 执行流程

1. 打开目标主页，等待资料卡连续稳定。
2. 若资料卡处于折叠状态，自动展开公开资料区后再次确认稳定。
3. 保存该主页最新的一条资料数据。

## 数据字段

`cover`、`avatar`、`nickname`、`profileId`、`gender`、`membershipBadges`、`bio`、`profileDescription`、`following`、`followers`、`engagement`、`yesterdayPosts`、`yesterdayReads`、`yesterdayInteractions`、`videoTotalViews`、`influenceRanks`、`serviceUnit`、`newsServiceLicense`、`serviceCategory`、`friendCount`、`profileDetailLines`、`profileCardText`。

`profileCardText` 保留公开资料卡原文，作为平台样式变化时的兜底字段。

## 数据与记录

- 每个主页只保留最新资料；总数据最多 3000 条。
- 运行记录按主页与状态筛选，每种状态最多 200 条。
- 支持任务错误明细、数据筛选、复制筛选后的 JSON 和导出 CSV。

## 注意事项

不检查登录状态不代表可以绕过安全验证。页面出现验证码或安全提示时，请在微博标签页完成处理后重试。

## 统一传输字段

每条新主页资料还会写入 `canonical`：`entityType` 为 `profile`。`profile` 中统一保存主页 ID、昵称、头像、封面、简介、地区和标签；`metrics` 保存关注、粉丝、转评赞及可用的活跃度指标。微博资料卡专有字段、原始字段和完整页面文本保留在 `platformExtra`。字段中文说明与示例见[统一传输数据模型](../data-schema.md)。
