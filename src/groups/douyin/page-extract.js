// This function is serialized and executed in the target Douyin page through
// the Chrome DevTools protocol. Keep it self-contained: no imported helpers.
export async function runDouyinPageCommand(command, options = {}) {
  const text = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const lineList = (value) => String(value || "").split(/\n+/).map(text).filter(Boolean);
  const visible = (element) => {
    if (!element) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || 1) > 0 && rect.width > 0 && rect.height > 0;
  };
  const absoluteUrl = (value) => {
    try { return new URL(value, location.href).href; } catch { return ""; }
  };
  const uniq = (values) => [...new Set(values.filter(Boolean))];
  const isProfilePage = () => /^\/user\/[^/]+\/?$/i.test(location.pathname);
  const videoIdFromUrl = (value) => {
    try { return new URL(value, location.href).pathname.match(/\/video\/(\d+)/)?.[1] || ""; } catch { return ""; }
  };
  const activeModalId = () => new URL(location.href).searchParams.get("modal_id") || "";
  const visibleUserInfo = () => document.querySelector('[data-e2e="user-info"]');
  const userDetail = () => document.querySelector('[data-e2e="user-detail"]');
  const metric = (selector, label) => text(document.querySelector(selector)?.innerText).replace(label, "").trim();
  const textAfter = (source, label) => {
    const match = String(source || "").match(new RegExp(`${label}[：:]\\s*([^\\s，,]+)`));
    return match?.[1] || "";
  };
  const getProfile = () => {
    const info = visibleUserInfo();
    const detail = userDetail() || info;
    const rawLines = lineList(info?.innerText || detail?.innerText);
    const rawText = text((info?.innerText || detail?.innerText));
    const nickname = text(info?.querySelector("h1")?.innerText || info?.querySelector('[data-e2e="user-info-nickname"]')?.innerText || rawLines[0]);
    const profileUrl = location.href;
    const profileId = location.pathname.match(/^\/user\/([^/]+)/)?.[1] || "";
    // user-info 内的第一张图片是认证/勋章图，不是博主头像。头像位于
    // user-detail 顶部的 live-avatar 容器，优先按 “昵称头像” 的 alt 读取。
    const avatarImage = [...(detail?.querySelectorAll('img[alt$="头像"]') || [])][0]
      || detail?.querySelector('[data-e2e="live-avatar"] img')
      || null;
    const avatar = avatarImage?.currentSrc || avatarImage?.src || "";
    const profileNumber = textAfter(rawText, "抖音号");
    const ipLocation = textAfter(rawText, "IP属地");
    const age = rawLines.find((value) => /^\d{1,3}岁$/.test(value))?.replace("岁", "") || "";
    const locationLine = rawLines.find((value) => /[·]/.test(value) && !/^\d/.test(value) && !/^抖音号/.test(value)) || "";
    const shortRaw = rawLines.filter((value) => value !== nickname && !/^(关注|粉丝|获赞|分享主页|私信|更多|下载)$/.test(value));
    const bio = shortRaw.find((value) => value.length > 4 && value.length < 180 && !/(抖音号|IP属地|岁$|作品|推荐|喜欢|合集|短剧|搜索 Ta 的作品|日期筛选|精选作者|认证)/.test(value)) || "";
    const tags = uniq([...info?.querySelectorAll("a, span, p, div") || []]
      .filter((node) => node.children.length <= 1)
      .map((node) => text(node.innerText))
      .filter((value) => value && value.length < 48 && !/^(关注|粉丝|获赞|分享主页|私信|更多|下载|作品|推荐|喜欢|合集|短剧)$/.test(value) && !/^\d/.test(value) && !value.includes("抖音号") && !value.includes("IP属地")));
    return {
      profileUrl,
      profileId,
      avatar,
      nickname,
      douyinId: profileNumber,
      following: metric('[data-e2e="user-info-follow"]', "关注"),
      followers: metric('[data-e2e="user-info-fans"]', "粉丝"),
      likes: metric('[data-e2e="user-info-like"]', "获赞"),
      ipLocation,
      age,
      location: locationLine,
      bio,
      profileTags: tags.join(" · "),
      profileRawText: rawText
    };
  };
  const postLinks = () => [...document.querySelectorAll('[data-e2e="user-post-list"] a[href*="/video/"]')]
    .filter((link) => visible(link) && videoIdFromUrl(link.href));
  const postSignature = () => postLinks().slice(0, 40).map((link) => videoIdFromUrl(link.href)).join("|");
  const postFromLink = (link, order) => {
    const url = absoluteUrl(link.href);
    const videoId = videoIdFromUrl(url);
    const postText = text(link.querySelector("p")?.innerText || link.querySelector("img")?.alt || link.innerText)
      .replace(/^[^：:]{1,64}[：:]/, "");
    const lines = lineList(link.innerText);
    const likes = lines.find((value) => /^(?:\d+(?:\.\d+)?(?:万|亿)?|\d{1,3}(?:,\d{3})+)$/.test(value)) || "";
    const cover = link.querySelector("img")?.currentSrc || link.querySelector("img")?.src || "";
    return { order, videoId, url, text: postText, likes, cover };
  };
  const detailRoot = () => document.querySelector('[data-e2e="video-detail"]');
  const feedRoot = () => document.querySelector('[data-e2e="feed-active-video"]') || document.querySelector('[data-e2e="modal-video-container"] [data-e2e="feed-video"]') || document.querySelector('[data-e2e="feed-video"]');
  const videoIdFromFeed = (feed) => String(feed?.className || "").match(/video_(\d+)/)?.[1] || activeModalId() || videoIdFromUrl(location.href);
  const getDetail = () => {
    const root = detailRoot();
    const feed = feedRoot();
    const infoRoot = root?.querySelector('[data-e2e="detail-video-info"]') || feed?.querySelector('[data-e2e="video-info"]') || null;
    const descriptionNode = root?.querySelector('[data-e2e="detail-video-info"] h1') || feed?.querySelector('[data-e2e="video-desc"]') || null;
    const authorInfo = root?.querySelector('[data-e2e="user-info"]') || null;
    const authorLinks = [...(authorInfo?.querySelectorAll('a[href*="/user/"]') || [])];
    const authorLink = root ? authorLinks.find((link) => link.querySelector("img")) || authorLinks[0] || null : feed?.querySelector('[data-e2e="video-avatar"]') || null;
    const authorNode = root ? authorLinks.find((link) => text(link.innerText)) || null : feed?.querySelector('[data-e2e="feed-video-nickname"]') || null;
    const description = text(descriptionNode?.innerText);
    const info = text(infoRoot?.innerText);
    const video = (root || feed)?.querySelector("video");
    const contentLinks = [...(descriptionNode?.querySelectorAll("a[href]") || [])]
      .map((link) => ({ text: text(link.innerText), href: absoluteUrl(link.href) }));
    const videoId = infoRoot?.getAttribute("data-e2e-aweme-id") || videoIdFromFeed(feed) || videoIdFromUrl(location.href);
    const postUrl = videoId ? `https://www.douyin.com/video/${videoId}` : location.href;
    return {
      videoId,
      postUrl,
      author: text(authorNode?.innerText).replace(/^@/, ""),
      authorUrl: absoluteUrl(authorLink?.href || ""),
      authorAvatar: authorLink?.querySelector("img")?.currentSrc || authorLink?.querySelector("img")?.src || "",
      text: description,
      publishedAt: text(root?.querySelector('[data-e2e="detail-video-publish-time"]')?.innerText).replace(/^发布时间[：:]\s*/, "") || info.match(/·\s*([^\n]+)/)?.[1]?.trim() || "",
      likes: text((root || feed)?.querySelector('[data-e2e="video-player-digg"]')?.innerText),
      comments: text((root || feed)?.querySelector('[data-e2e="feed-comment-icon"]')?.innerText),
      favorites: text((root || feed)?.querySelector('[data-e2e="video-player-collect"]')?.innerText),
      shares: text((root || feed)?.querySelector('[data-e2e="video-player-share"]')?.innerText),
      topics: contentLinks.filter((item) => item.text.startsWith("#")).map((item) => item.text).join(" | "),
      contentLinks: contentLinks.map((item) => item.href).filter(Boolean).join(" | "),
      cover: video?.poster || "",
      mediaUrls: uniq([video?.currentSrc || video?.src || "", video?.poster || ""]).join(" | "),
      detailRawText: info
    };
  };
  const inspectProfile = () => {
    const profile = getProfile();
    const pageText = text(document.body?.innerText);
    return {
      href: location.href,
      readyState: document.readyState,
      isProfilePage: isProfilePage(),
      hasProfile: Boolean(profile.profileId && (profile.nickname || visibleUserInfo())),
      postCount: postLinks().length,
      noPosts: /暂无作品|还没有作品|暂无内容/.test(pageText),
      profileSignature: [profile.profileId, profile.nickname, profile.followers, profile.likes, profile.bio, profile.profileTags].join("|"),
      postSignature: postSignature(),
      captcha: /安全验证|验证码|访问频繁|请完成验证|网络环境异常/.test(pageText)
    };
  };
  const inspectDetail = () => {
    const detail = getDetail();
    const pageText = text(document.body?.innerText);
    return {
      href: location.href,
      readyState: document.readyState,
      hasDetail: Boolean(detail.videoId && detail.text),
      detailSignature: [detail.videoId, detail.author, detail.text, detail.likes, detail.comments, detail.favorites, detail.shares].join("|"),
      captcha: /安全验证|验证码|访问频繁|请完成验证|网络环境异常/.test(pageText)
    };
  };

  if (command === "inspect-profile") return inspectProfile();
  if (command === "extract-profile") return { profile: getProfile(), capturedAt: new Date().toISOString(), pageUrl: location.href };
  if (command === "extract-posts") {
    const maximum = Math.max(1, Math.min(100, Number(options.limit) || 20));
    const seen = new Set();
    const posts = [];
    for (const link of postLinks()) {
      const post = postFromLink(link, posts.length + 1);
      if (!post.videoId || seen.has(post.videoId)) continue;
      seen.add(post.videoId);
      posts.push(post);
      if (posts.length >= maximum) break;
    }
    return { posts, postCardCount: postLinks().length, capturedAt: new Date().toISOString(), pageUrl: location.href };
  }
  if (command === "inspect-detail") return inspectDetail();
  if (command === "extract-detail") return { detail: getDetail(), capturedAt: new Date().toISOString(), pageUrl: location.href };
  if (command === "scroll") {
    const list = document.querySelector('[data-e2e="user-post-list"]');
    window.scrollTo({ top: Math.max(document.documentElement.scrollHeight, list?.scrollHeight || 0), behavior: "smooth" });
    return true;
  }
  throw new Error(`未知的抖音页面命令：${command}`);
}
