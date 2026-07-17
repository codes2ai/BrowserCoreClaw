export function runXiaohongshuPostDetailPageCommand(command) {
  const normalText = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const asUrl = (value) => {
    try {
      return new URL(value, location.href).href;
    } catch {
      return "";
    }
  };
  const unique = (values) => [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
  const isVisible = (element) => {
    if (!element) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none"
      && style.visibility !== "hidden"
      && Number(style.opacity || 1) > 0
      && rect.width > 0
      && rect.height > 0;
  };
  const firstVisible = (selectors, root = document) => {
    for (const selector of selectors) {
      const element = [...root.querySelectorAll(selector)].find(isVisible);
      if (element) return element;
    }
    return null;
  };
  const isCountLabel = (value) => /^(?:赞|点赞|喜欢|收藏|评论|分享|转发)$/i.test(normalText(value));
  const countText = (value) => {
    const text = normalText(value);
    if (!text || isCountLabel(text)) return "0";
    return text.replace(/^(?:赞|点赞|喜欢|收藏|评论|分享|转发)\s*/i, "").trim() || "0";
  };
  const noteIdFromUrl = (value = location.href) => {
    try {
      const parts = new URL(value, location.href).pathname.split("/").filter(Boolean);
      if (["search_result", "explore"].includes(parts[0])) return parts[1] || "";
      if (parts[0] === "discovery" && parts[1] === "item") return parts[2] || "";
      if (parts[0] === "user" && parts[1] === "profile") return parts[3] || "";
      return "";
    } catch {
      return "";
    }
  };
  const isNotePath = (value = location.href) => Boolean(noteIdFromUrl(value));
  const splitPublishedText = (value) => {
    const text = normalText(value).replace(/^(?:编辑于|发布于)\s*/i, "");
    const match = text.match(/^(刚刚|今天|昨天|前天|\d+\s*(?:秒|分钟|小时|天|周|星期|个月|年)前|\d{4}\s*(?:[-/.]|年)\s*\d{1,2}\s*(?:[-/.]|月)\s*\d{1,2}(?:\s*日)?|\d{1,2}\s*(?:[-/.]|月)\s*\d{1,2}(?:\s*日)?)(?:\s+(.*))?$/i);
    return {
      publishedAtRaw: normalText(match?.[1] || text),
      ipLocation: normalText(match?.[2] || "").replace(/^IP属地[:：]?\s*/i, "")
    };
  };
  const hasVisibleLoading = () => [...document.querySelectorAll("[aria-busy='true'], [class*='loading' i], [class*='skeleton' i], [class*='spinner' i]")]
    .some((element) => isVisible(element) && /loading|skeleton|spinner|加载中/i.test(`${element.className || ""} ${element.getAttribute("aria-label") || ""} ${element.innerText || ""}`));
  const getRoot = () => firstVisible([
    "#noteContainer",
    ".note-container",
    "[class*='note-container']",
    "[data-testid='note-detail']"
  ]);
  const getDetail = () => {
    const root = getRoot();
    const noteId = noteIdFromUrl();
    const title = normalText(firstVisible(["#detail-title", ".note-content .title", "[data-testid='note-title']"], root || document)?.innerText);
    const descriptionElement = firstVisible(["#detail-desc", ".note-content .desc", "[data-testid='note-desc']"], root || document);
    const description = normalText(descriptionElement?.innerText);
    const authorLink = firstVisible([".author-wrapper a.name", ".author a.name", "a[href*='/user/profile/']"], root || document);
    const author = normalText(authorLink?.innerText || firstVisible([".author-wrapper .info", ".author .name"], root || document)?.innerText);
    const authorUrl = asUrl(authorLink?.getAttribute("href") || "");
    const authorId = (() => {
      try {
        const parts = new URL(authorUrl).pathname.split("/").filter(Boolean);
        return parts[0] === "user" && parts[1] === "profile" ? parts[2] || "" : "";
      } catch {
        return "";
      }
    })();
    const authorAvatarElement = firstVisible([".author-wrapper img", ".author img"], root || document);
    const authorAvatar = asUrl(authorAvatarElement?.currentSrc || authorAvatarElement?.src || "");
    const publishedText = normalText(firstVisible([".note-content .bottom-container", ".bottom-container", "[class*='publish-time']"], root || document)?.innerText);
    const { publishedAtRaw, ipLocation } = splitPublishedText(publishedText);
    // 互动数必须从正文底部的互动栏读取。评论区也会存在 .like-wrapper，
    // 直接取第一个可见节点会把评论的“赞”按钮误当成正文点赞数。
    const interactionBar = firstVisible([
      ".interactions.engage-bar",
      ".engage-bar-container",
      ".interact-container"
    ], root || document);
    const interactionMetric = (selector) => {
      const element = firstVisible([selector], interactionBar || root || document);
      const countElement = element ? firstVisible([".count"], element) : null;
      const rawValue = normalText(countElement?.innerText || element?.innerText);
      return {
        value: countText(rawValue),
        captured: Boolean(rawValue && !isCountLabel(rawValue))
      };
    };
    const likes = interactionMetric(".like-wrapper");
    const favorites = interactionMetric(".collect-wrapper");
    const comments = interactionMetric(".chat-wrapper");
    const shares = interactionMetric(".share-wrapper");
    const capturedInteractionFields = [
      ["likes", likes],
      ["favorites", favorites],
      ["comments", comments],
      ["shares", shares]
    ].filter(([, metric]) => metric.captured).map(([field]) => field);
    const topics = unique([...descriptionElement?.querySelectorAll("a[href*='/search_result']") || []]
      .map((element) => normalText(element.innerText))
      .filter((text) => text.startsWith("#")));
    const imageUrls = unique([...root?.querySelectorAll(".media-container img, .swiper-slide img") || []]
      .filter(isVisible)
      .map((element) => asUrl(element.currentSrc || element.src || ""))
      .filter((url) => /^https?:\/\//i.test(url) && !/avatar|icon/i.test(url)));
    const videoElements = [...root?.querySelectorAll(".media-container video, video") || []].filter(isVisible);
    const videoUrls = unique(videoElements.flatMap((element) => [
      asUrl(element.currentSrc || element.src || ""),
      ...[...element.querySelectorAll("source")].map((source) => asUrl(source.src || source.getAttribute("src") || ""))
    ]));
    const videoCover = asUrl(videoElements.find((element) => element.poster)?.poster || "");
    return {
      noteId,
      noteType: videoUrls.length ? "视频" : imageUrls.length ? "图文" : "",
      title,
      description,
      author,
      authorId,
      authorUrl,
      authorAvatar,
      publishedAtRaw,
      ipLocation,
      likes: likes.value,
      favorites: favorites.value,
      comments: comments.value,
      shares: shares.value,
      capturedInteractionFields,
      topics: topics.join(" | "),
      cover: imageUrls[0] || videoCover,
      imageUrls: imageUrls.join(" | "),
      videoUrls: videoUrls.join(" | "),
      postUrl: location.href
    };
  };
  const inspect = () => {
    const bodyText = normalText(document.body?.innerText);
    const controls = [...document.querySelectorAll("a, button, [role='button']")]
      .filter(isVisible)
      .map((element) => normalText(element.innerText || element.getAttribute("aria-label") || element.getAttribute("title")))
      .filter(Boolean);
    const detail = getDetail();
    const notFound = /当前笔记暂时无法浏览|笔记不存在|该笔记已删除|当前内容已删除|内容不存在|暂时无法查看该笔记/.test(bodyText);
    return {
      href: location.href,
      readyState: document.readyState,
      isDetailPage: isNotePath(),
      noteId: detail.noteId,
      hasDetail: Boolean(getRoot() && detail.noteId && (detail.title || detail.description) && detail.author),
      detailSignature: [
        detail.noteId,
        detail.title,
        detail.description.length,
        detail.author,
        detail.likes,
        detail.favorites,
        detail.comments,
        detail.shares,
        detail.capturedInteractionFields.join(","),
        detail.imageUrls.split(" | ").filter(Boolean).length,
        detail.videoUrls.split(" | ").filter(Boolean).length
      ].join(":"),
      loading: hasVisibleLoading(),
      hasLoginEntry: controls.some((label) => /^(?:登录|登入)$/.test(label)),
      captcha: /验证码|安全验证|人机验证|访问过于频繁|账号存在异常/.test(bodyText),
      notFound
    };
  };

  if (command === "inspect-detail") return inspect();
  if (command === "extract-detail") {
    return {
      detail: getDetail(),
      capturedAt: new Date().toISOString(),
      pageUrl: location.href,
      rawPageText: String(document.body?.innerText || "").trim()
    };
  }
  throw new Error(`未知的小红书正文页命令：${command}`);
}
