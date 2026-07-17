const FIELD_METADATA = Object.freeze({
  keyword: ["关键词", "触发当前搜索任务的关键词。"],
  pageOrder: ["页面顺序", "结果在当前页面中的原始展示顺序。"],
  title: ["标题", "新闻、笔记或内容卡片显示的标题。"],
  noteTitle: ["笔记标题", "小红书笔记卡片显示的标题。"],
  description: ["描述", "新闻摘要或笔记正文描述。"],
  noteContent: ["笔记内容", "小红书搜索卡片可读取的正文摘要。"],
  text: ["正文 / 内容描述", "微博正文或抖音作品的可见文字内容。"],
  source: ["来源", "内容页面显示的来源站点或发布来源。"],
  url: ["内容链接", "当前新闻、笔记、博文或作品的公开链接。"],
  noteUrl: ["笔记链接", "小红书笔记的公开链接。"],
  postUrl: ["正文 / 作品链接", "微博正文、小红书笔记详情或抖音作品的公开链接。"],
  profileUrl: ["博主主页链接", "内容所属或当前采集的博主公开主页。"],
  publishedAt: ["发布时间", "页面可读取并已标准化的发布时间。"],
  publishedAtRaw: ["发布时间原文", "平台页面原始时间文本，用于时间解析回溯。"],
  collectedAt: ["采集时间", "扩展实际读取并保存数据的时间。"],
  capturedAt: ["采集时间", "扩展实际读取页面的时间戳。"],
  cover: ["封面", "内容或作品展示封面的图片链接。"],
  noteCover: ["笔记封面", "小红书笔记卡片展示的封面图链接。"],
  imageUrls: ["图片链接", "正文可见图片媒体链接集合。"],
  videoUrls: ["视频链接", "正文可见视频媒体链接集合。"],
  mediaUrls: ["媒体链接", "微博或抖音页面可读取的媒体链接集合。"],
  contentLinks: ["关联链接", "正文中可读取的关联网页链接集合。"],
  author: ["作者", "内容发布者的显示名称。"],
  noteAuthor: ["笔记作者", "小红书笔记卡片显示的作者名称。"],
  authorId: ["作者 ID", "页面可读取的作者平台标识。"],
  authorUrl: ["作者主页", "作者公开主页链接。"],
  authorAvatar: ["作者头像", "作者头像图片链接。"],
  postId: ["博文 ID", "微博正文的页面标识。"],
  noteId: ["笔记 ID", "小红书笔记的页面标识。"],
  videoId: ["作品 ID", "抖音作品的页面标识。"],
  noteType: ["笔记类型", "小红书页面识别出的图文或视频类型。"],
  visibility: ["可见范围", "微博正文页面显示的可见范围文本。"],
  likes: ["点赞", "页面显示的点赞数；未显示数值时保存为 0。"],
  noteLikes: ["笔记点赞", "小红书笔记卡片显示的点赞数。"],
  favorites: ["收藏", "页面显示的收藏数。"],
  comments: ["评论", "页面显示的评论数。"],
  shares: ["分享", "页面显示的分享数。"],
  reposts: ["转发", "微博正文或卡片显示的转发数。"],
  topics: ["话题", "正文中可读取的话题集合。"],
  mentions: ["提及", "微博正文中可读取的 @ 提及集合。"],
  ipLocation: ["IP 属地", "页面公开展示的 IP 属地。"],
  profileId: ["主页 ID", "博主主页的平台标识。"],
  xiaohongshuId: ["小红书号", "小红书资料页公开展示的小红书号。"],
  douyinId: ["抖音号", "抖音资料页公开展示的抖音号。"],
  avatar: ["头像", "博主公开头像图片链接。"],
  nickname: ["昵称", "博主公开显示名称。"],
  gender: ["性别", "微博资料卡公开展示的性别标识。"],
  membershipBadges: ["会员 / 标识", "微博资料卡公开展示的会员或认证标识。"],
  bio: ["简介 / 认证说明", "博主页面公开展示的简介或认证说明。"],
  profileDescription: ["主页简介", "微博资料卡中补充展示的主页介绍。"],
  tags: ["标签", "小红书资料页公开展示的标签集合。"],
  profileTags: ["标签", "抖音资料页公开展示的标签集合。"],
  following: ["关注", "博主公开展示的关注数量。"],
  followers: ["粉丝", "博主公开展示的粉丝数量。"],
  likedAndCollected: ["获赞与收藏", "小红书资料页公开展示的获赞与收藏数量。"],
  engagement: ["转评赞", "微博主页公开展示的转发、评论、点赞汇总。"],
  yesterdayPosts: ["昨日发博", "微博主页展示的昨日发博数量。"],
  yesterdayReads: ["昨日阅读数", "微博主页展示的昨日阅读数。"],
  yesterdayInteractions: ["昨日互动数", "微博主页展示的昨日互动数。"],
  videoTotalViews: ["视频累计播放量", "微博主页展示的视频累计播放量。"],
  influenceRanks: ["影响力标签", "微博主页公开展示的影响力榜单或标签。"],
  serviceUnit: ["服务单位", "微博机构主页公开展示的服务单位。"],
  newsServiceLicense: ["新闻服务许可证", "微博资料卡公开展示的互联网新闻服务许可信息。"],
  serviceCategory: ["服务类别", "微博资料卡公开展示的服务类别。"],
  friendCount: ["好友数", "微博主页公开展示的好友数量。"],
  profileDetailLines: ["扩展资料原文", "微博资料卡中逐行读取的公开扩展资料。"],
  profileCardText: ["主页公开信息", "微博公开资料卡的完整可见文本。"],
  profileRawText: ["公开资料原文", "抖音资料区域读取到的公开文本。"],
  detailRawText: ["详情原文", "抖音作品详情区域读取到的公开文本。"],
  age: ["年龄", "抖音资料页公开展示的年龄。"],
  location: ["地区", "抖音资料页公开展示的地区。"]
});

const ENTITY_COPY = Object.freeze({
  content: "内容",
  profile: "博主资料"
});

const CONTENT_TYPE_COPY = Object.freeze({
  news: "新闻",
  note: "笔记",
  post: "博文",
  video: "视频"
});

function text(value) {
  return String(value ?? "").trim();
}

function normalizeFields(fields) {
  const source = Array.isArray(fields) ? fields : text(fields).split(/\s*·\s*/);
  return [...new Set(source.map((field) => text(field)).filter(Boolean))];
}

export function renderFieldGuide({ fields, entityType = "content", contentType = "", escapeHtml }) {
  const escape = typeof escapeHtml === "function" ? escapeHtml : (value) => text(value);
  const normalizedFields = normalizeFields(fields);
  const entityLabel = ENTITY_COPY[entityType] || "数据";
  const contentLabel = CONTENT_TYPE_COPY[contentType] || "";
  return `
    <section class="feature-field-guide" aria-label="采集字段说明">
      <header>
        <div>
          <strong>采集字段与说明</strong>
          <p>下列字段会显示在当前功能的数据中；同时写入统一传输记录。</p>
        </div>
        <span>${escape(entityLabel)}${contentLabel ? ` / ${escape(contentLabel)}` : ""}</span>
      </header>
      <div class="feature-field-guide-unified">
        <code>canonical.entityType</code><span>${escape(entityLabel)}实体</span>
        ${contentLabel ? `<code>canonical.contentType</code><span>${escape(contentLabel)}类型</span>` : ""}
        <code>canonical.platformExtra.rawPageText</code><span>采集当刻的完整可见页面文本</span>
      </div>
      <dl>
        ${normalizedFields.map((field) => {
          const [label, description] = FIELD_METADATA[field] || [field, `页面采集到的 ${field} 原始字段。`];
          return `<div><dt><code>${escape(field)}</code><strong>${escape(label)}</strong></dt><dd>${escape(description)}</dd></div>`;
        }).join("")}
      </dl>
    </section>
  `;
}
