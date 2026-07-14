# BrowserCoreClaw

BrowserCoreClaw 是一个运行在 Chrome 侧边栏中的浏览器数据采集工具箱。项目采用 Manifest V3，首页由 JSON 配置生成，并以“平台分组 / 独立功能目录”组织代码与文档。

当前提供 4 个平台分组、10 个功能：Google 新闻监控；微博博主博文、博主信息、正文采集；抖音博主博文、博主信息、博文采集；小红书关键词搜索、博主博文、博主信息采集。

## 架构

- `src/config/groups.json` 是功能列表唯一配置源：定义分组、功能名称、入口和样式。
- `src/groups/<platform>/<feature>/` 是功能的独立实现目录：入口、监控界面、后台采集、导出和样式彼此隔离。
- `src/background/service-worker.js` 负责将侧边栏消息路由至各功能后台采集器。
- `src/background/debugger-client.js` 封装 Chrome Debugger API，用于导航、等待页面稳定并读取公开页面内容。
- `src/shared/` 放置跨平台可复用的任务明细能力；运行记录、数据表和导出状态保存在 `chrome.storage.local`。

## 目录结构

```text
BrowserCoreClaw/
├── doc/                                      # 功能说明文档
│   ├── google/
│   │   └── google-news.md                     # Google 新闻监控
│   ├── weibo/
│   │   ├── profile-posts.md                   # 微博博主博文采集
│   │   ├── profile-info.md                    # 微博博主信息采集
│   │   └── post-detail.md                     # 微博正文采集
│   ├── douyin/
│   │   ├── profile-posts.md                   # 抖音博主博文采集
│   │   ├── profile-info.md                    # 抖音博主信息采集
│   │   └── post-detail.md                     # 抖音博文采集
│   └── xiaohongshu/
│       ├── keyword-search.md                  # 小红书关键词搜索
│       ├── profile-notes.md                   # 小红书博主博文采集
│       └── profile-info.md                    # 小红书博主信息采集
├── manifest.json                              # Chrome 扩展清单与站点权限
├── sidepanel.html                             # 侧边栏页面
├── src/
│   ├── app/                                   # 首页配置加载、路由与通用界面
│   ├── background/                            # Debugger 封装与消息路由
│   ├── config/groups.json                     # 分组与功能配置
│   ├── groups/<platform>/<feature>/           # 平台 / 功能独立代码
│   └── shared/                                # 跨功能任务明细等共享能力
└── scripts/                                   # 配置校验与打包脚本
```

## 功能文档

| 平台 | 功能 | 文档 |
| --- | --- | --- |
| Google | Google 新闻监控 | [查看说明](doc/google/google-news.md) |
| 微博 | 微博博主博文采集 | [查看说明](doc/weibo/profile-posts.md) |
| 微博 | 微博博主信息采集 | [查看说明](doc/weibo/profile-info.md) |
| 微博 | 微博正文采集 | [查看说明](doc/weibo/post-detail.md) |
| 抖音 | 抖音博主博文采集 | [查看说明](doc/douyin/profile-posts.md) |
| 抖音 | 抖音博主信息采集 | [查看说明](doc/douyin/profile-info.md) |
| 抖音 | 抖音博文采集 | [查看说明](doc/douyin/post-detail.md) |
| 小红书 | 关键词搜索 | [查看说明](doc/xiaohongshu/keyword-search.md) |
| 小红书 | 小红书博主博文采集 | [查看说明](doc/xiaohongshu/profile-notes.md) |
| 小红书 | 小红书博主信息采集 | [查看说明](doc/xiaohongshu/profile-info.md) |

## 增加功能

1. 在 `src/groups/<platform-id>/<feature-id>/` 建立独立功能目录，并导出 `mount(container, context)`。
2. 按需提供 `background.js`、`constants.js`、`monitor.js`、`export-data.js` 和 `styles.css`。
3. 在 `src/config/groups.json` 中注册功能的 `entry` 与 `style`。
4. 在 `src/background/service-worker.js` 注册采集与停止消息。
5. 在 `doc/<platform-id>/<feature-id>.md` 新建功能说明，并同步更新本 README 的目录与文档表。
6. 执行 `npm run check` 验证配置和入口，执行 `npm run package` 生成扩展包。

一级分组只代表数据来源平台，不按“搜索”“媒体”等能力类型分组。新增站点权限时，需要在 `chrome://extensions/` 重新加载扩展并确认权限。

## 本地加载与打包

1. 打开 `chrome://extensions/` 并开启“开发者模式”。
2. 选择“加载已解压的扩展程序”，指定本项目根目录。
3. 点击扩展图标，打开 Chrome 右侧面板。

```bash
npm run check
npm run package
```

打包结果输出至 `dist/BrowserCoreClaw-<version>.zip`。
