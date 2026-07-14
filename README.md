# BrowserCoreClaw

BrowserCoreClaw 是一个以 Chrome 浏览器为运行环境的数据采集工具箱。项目使用 Manifest V3，主界面由 JSON 配置生成，功能代码按“分组/具体功能”独立存放。

当前版本完成了项目骨架和 3 个平台分组：

- Google：Google 新闻监控、Google 网页搜索
- 微博：微博主页博文、微博正文详情
- 小红书：关键词搜索、用户主页笔记

其中 Google 新闻监控已经接入真实浏览器采集链路：运行时复用当前活动标签页，依次打开 Google 新闻搜索结果并采集最近一小时的数据。其余功能目前仍是可进入的独立占位页面。

## 目录结构

```text
BrowserCoreClaw/
  manifest.json
  sidepanel.html
  src/
    config/
      groups.json                 # 主界面的分组与功能配置
    app/
      app.js                      # 配置加载、列表渲染与功能路由
      app.css
    background/
      debugger-client.js          # Chrome Debugger API 封装
      service-worker.js
    shared/
      feature-placeholder.js
    groups/
      google/
        google-news/
          background.js           # 标签页导航、等待和页面采集
          constants.js
          index.js
          monitor.js              # 功能状态、模板与交互逻辑
          page-extract.js         # Google 新闻结果解析
          search-url.js           # 搜索 URL 构建
          styles.css
        web-search/
      weibo/
        profile-posts/
        post-detail/
      xiaohongshu/
        keyword-search/
        profile-notes/
  scripts/
    validate.mjs
    package-extension.sh
```

## 增加分组或功能

1. 在 `src/groups/<platform-id>/<feature-id>/` 新建独立功能目录。
2. 目录至少提供一个导出 `mount(container, context)` 的 `index.js`。
3. 在 `src/config/groups.json` 中增加分组或功能项。
4. 执行 `npm run check` 验证配置、入口文件和 JavaScript 语法。

一级分组统一表示数据来源平台，不使用“搜索”“媒体”等能力类型作为分组。主页不包含具体平台的硬编码逻辑；只要配置里的 `entry` 和 `style` 指向对应的平台功能目录，主页就会自动显示并加载该功能。

## Google 新闻监控

- 默认提供 `OpenAI`、`人工智能` 两个示例关键词。
- 支持逐条输入、添加、删除，以及通过弹窗批量编辑关键词。
- 支持表单和 JSON 两种参数编辑方式，并进行基础格式校验。
- 使用说明从工作区页签移到功能标题右侧，通过紧凑的问号入口打开弹窗，不离开当前参数或数据页面。
- 运行选项包含每词结果数、关键词随机间隔区间（毫秒）、最近一小时时间范围、语言和轮询周期；例如 `100 - 1000 ms` 会在每个关键词完成后重新随机取值，并提示本次实际等待时间和下一个关键词。
- 每次关键词采集都会生成一条独立运行记录，包含关键词、轮次、状态、数据量和耗时。
- 运行记录支持按关键词和状态筛选；运行中、完成、部分完成、失败、已停止和网页预览等每一种状态分别最多保留 200 条。
- 采集结果显示在独立的可滚动“数据”表格中，包含关键词、标题、描述、来源、发布时间和链接。
- “运行参数”“运行记录”和“数据”页的操作按钮固定在工作区底部，内容会根据侧边栏可用高度自动伸缩并在内部滚动。
- 返回功能列表时不会卸载当前功能，采集和循环监控会继续执行；重新进入 Google 新闻监控时恢复原界面与运行状态。
- 点击运行会优先复用 Google 标签页；没有 Google 页面时自动创建，再依次导航到 `Google 搜索 + 新闻模式 + 最近一小时` 并读取结果。
- 数据支持导出为 JSON 和带 UTF-8 BOM 的 CSV 表格文件。
- 循环监控会在每轮结束后等待设定周期，再自动开始下一轮，直到点击停止、切换到其他功能或关闭侧边栏。
- 配置、每种状态最多 200 条运行记录和最多 3000 条采集结果保存在 `chrome.storage.local`。
- 运行期间参数与运行入口会锁定，按钮切换为“停止”；停止会终止后续关键词并释放当前浏览器调试连接。

> `http://127.0.0.1:4173` 网页预览只能检查界面和搜索 URL。真实页面采集依赖扩展的 `tabs`、`debugger` 和 Google 主机权限，必须在 Chrome 扩展环境中运行。

## 本地运行

1. 打开 `chrome://extensions/`。
2. 开启“开发者模式”。
3. 点击“加载已解压的扩展程序”。
4. 选择本项目根目录。
5. 点击扩展图标打开 Chrome 右侧面板。
6. 打开一个普通网页标签页，在 Google 新闻监控中输入关键词并点击“运行”。

版本升级后如果 `manifest.json` 增加了权限，需要在 `chrome://extensions/` 中重新加载扩展并确认权限。

## 校验与打包

```bash
npm run check
npm run package
```

打包结果输出到 `dist/BrowserCoreClaw-<version>.zip`。
