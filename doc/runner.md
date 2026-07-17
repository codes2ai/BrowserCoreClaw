# 功能 Runner 架构

BrowserCoreClaw 使用 `groupId/featureId` 作为全局唯一功能标识，例如：

```text
google/google-news
weibo/profile-info
douyin/post-detail
xiaohongshu/keyword-search
```

每项功能目录中的 `runner.js` 将已有的单项 `background.js` 采集函数适配为标准批量运行器。Runner 统一负责参数校验、并发、随机间隔、单项超时、停止、循环监控、进度与标准结果；`background.js` 继续负责一个关键词或一个链接的页面采集。

## 调用配置

```json
{
  "schemaVersion": 1,
  "featureId": "google/google-news",
  "parameters": {
    "keywords": ["OpenAI", "人工智能"],
    "limit": 20,
    "concurrency": 1,
    "intervalMinMs": 1000,
    "intervalMaxMs": 6000,
    "forceUpdateData": false,
    "polling": false,
    "pollingMinutes": 10
  },
  "execution": {
    "persistData": true,
    "sourceFeatureId": ""
  }
}
```

`persistData` 为 `true` 时，Runner 返回的数据会按功能数据唯一键去重，并写回该功能原有的 `chrome.storage.local` 数据空间。`forceUpdateData` 默认为 `false`：同一唯一键已存在时保留本地旧数据；设为 `true` 时以本轮采集结果覆盖旧数据，覆盖不计入“新增数量”。`sourceFeatureId` 用于记录 A 功能调用 B 功能时的来源功能。

## 固定调用关系

在 **设置 → 运行器** 中可以配置固定的调用白名单，支持一个来源功能绑定多个目标 Runner。配置保存在全局设置的 `runners.callableByFeature` 中，例如：

```json
{
  "runners": {
    "callableByFeature": {
      "xiaohongshu/keyword-search": [
        "xiaohongshu/profile-notes",
        "xiaohongshu/post-detail"
      ]
    }
  }
}
```

上例表示“小红书 / 关键词搜索”以后可以调用“小红书博主博文采集”和“小红书正文采集”的 Runner。该设置当前只保存可调用关系，不会自动创建下游任务；实际编排时可通过 `getCallableRunnerFeatureIds(settings, sourceFeatureId)` 或 `isRunnerCallableByFeature(...)` 校验权限后，再向统一 Runner 消息入口发起任务。

## 功能页面中的运行器

每个功能的运行参数区域都有“表单 / JSON / 运行器”三个页签。运行器页签固定当前功能的 `featureId`，避免在某个功能页面误执行其他功能。

1. **载入当前参数**：把当前表单值生成完整 Runner 配置。
2. **校验配置**：调用后台注册表校验功能标识、输入链接或关键词、数量、并发、间隔与轮询参数，并把规范化结果写回编辑器。
3. **创建任务**：生成任务编号并在 Service Worker 中运行；面板持续显示状态、进度、结果数量、新增数量、失败输入和耗时。
4. **停止 Runner**：按任务编号停止该 Runner 及其正在执行的输入项。

运行器状态保存在共享页面状态和 `chrome.storage.local` 任务快照中。切换到功能列表或其他功能不会主动终止任务；重新进入正在运行的功能时会自动回到运行器页签。`persistData` 开启时，任务完成后功能数据页会重新读取本地数据。

## 与运行记录合并

Runner 不再维护一套独立的用户可见任务列表。每个关键词、博主主页或正文链接开始执行时，都会立即写入目标功能原有的“运行记录”；完成后在同一条记录上更新状态、结果数量、新增数量、耗时与错误信息。

- `executionType: "manual"`：通过功能表单或 JSON 页签直接启动。
- `executionType: "runner"`：通过运行器页签或功能间调用启动。
- `runnerTaskId`：Runner 父任务编号，用于把多个输入项关联回同一次批量执行。
- `sourceFeatureId`：功能间调用时的来源功能；手动 Runner 可为空。

旧版本记录没有 `executionType` 时会自动按“普通运行”展示。记录表可以按类型筛选；“无数据”作为正常终态写入，不计为失败。记录数量继续遵循设置页的“每个独立功能、每种状态”上限。Runner 的内部任务快照仍用于后台停止、进度通知和页面重连，但不会作为另一套运行记录重复展示。

## 后台消息

| 消息 | 作用 |
| --- | --- |
| `BROWSER_CORE_CLAW_RUNNER_LIST` | 列出已注册 Runner |
| `BROWSER_CORE_CLAW_RUNNER_VALIDATE` | 校验并规范化配置 |
| `BROWSER_CORE_CLAW_RUNNER_EXECUTE` | 执行配置并返回标准结果 |
| `BROWSER_CORE_CLAW_RUNNER_STOP` | 按任务编号停止 Runner |
| `BROWSER_CORE_CLAW_RUNNER_TASK_GET` | 查询运行中或已落盘的任务快照 |
| `BROWSER_CORE_CLAW_RUNNER_TASK_STATUS` | Runner 进度状态通知 |

## 调用示例

```js
const result = await chrome.runtime.sendMessage({
  type: "BROWSER_CORE_CLAW_RUNNER_EXECUTE",
  options: {
    schemaVersion: 1,
    featureId: "weibo/profile-info",
    parameters: {
      profileUrls: ["https://weibo.com/u/2656274875"],
      concurrency: 1,
      intervalMinMs: 1000,
      intervalMaxMs: 6000,
      forceUpdateData: false
    },
    execution: {
      persistData: true,
      sourceFeatureId: "google/google-news"
    }
  }
});
```

同一套消息入口供功能页面的手动 Runner 页签和 A 功能调用 B 功能共同使用；二者的参数校验、任务执行、停止与状态模型保持一致。
