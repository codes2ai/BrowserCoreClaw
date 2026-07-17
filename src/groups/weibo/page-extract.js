// This function is serialized and executed in the target Weibo page through
// chrome.scripting. Keep it self-contained: no imported helpers.
export async function runWeiboPageCommand(command, options = {}) {
  const normalText = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const isVisible = (element) => {
    if (!element) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || 1) > 0
      && rect.width > 0 && rect.height > 0;
  };
  const asUrl = (value) => {
    try { return new URL(value, location.href).href; } catch { return ""; }
  };
  const profileIdFromPath = () => String(location.pathname).match(/^\/u\/(\d+)/)?.[1] || "";
  const isProfilePage = () => /^\/u\/\d+\/?$/i.test(location.pathname);
  const isDetailPage = () => /^\/\d+\/[A-Za-z0-9]+\/?$/i.test(location.pathname);
  const postIdFromUrl = (value) => {
    try {
      const parts = new URL(value, location.href).pathname.split("/").filter(Boolean);
      return parts.length >= 2 && /^\d+$/.test(parts.at(-2) || "") ? parts.at(-1) || "" : "";
    } catch { return ""; }
  };
  const isPostUrl = (value) => {
    try {
      const url = new URL(value, location.href);
      const parts = url.pathname.split("/").filter(Boolean);
      return /(^|\.)weibo\.com$/i.test(url.hostname) && parts.length >= 2 && /^\d+$/.test(parts.at(-2) || "");
    } catch { return false; }
  };
  const isPublishedAtText = (value) => /^(?:(?:\d{2}|\d{4})\s*[-/.年]\s*\d{1,2}\s*[-/.月]\s*\d{1,2}\s*日?\s+\d{1,2}:\d{2}(?::\d{2})?|\d{1,2}\s*(?:[-/.]|月)\s*\d{1,2}\s*日?\s+\d{1,2}:\d{2}|(?:今天|昨天|前天)\s+\d{1,2}:\d{2}|\d+\s*(?:分钟|小时)前)$/.test(normalText(value));
  const normalizePublishedAt = (value) => normalText(value).replace(/^(\d{2})(?=-\d{1,2}-\d{1,2}\s)/, "20$1");
  const publishedAtFromCard = (card) => {
    const candidates = [...(card?.querySelectorAll("a[href]") || [])]
      .filter((link) => isPostUrl(link.href))
      .flatMap((link) => [link.getAttribute("title"), link.innerText])
      .map(normalText)
      .filter(Boolean);
    return normalizePublishedAt(candidates.find(isPublishedAtText) || "");
  };
  const postLink = (card) => [...card.querySelectorAll("a[href]")].find((link) => isPostUrl(link.href)) || null;
  const getPostCards = () => [...document.querySelectorAll("article.woo-panel-main")]
    .filter((card) => isVisible(card) && card.querySelector(".wbpro-feed-content") && postLink(card));
  const getDetailCard = () => {
    const currentPath = location.pathname.replace(/\/$/, "");
    return getPostCards().find((card) => {
      try { return new URL(postLink(card)?.href || "", location.href).pathname.replace(/\/$/, "") === currentPath; } catch { return false; }
    }) || getPostCards()[0] || null;
  };
  const countFromFooter = (card) => {
    const values = String(card.querySelector("footer[aria-label]")?.getAttribute("aria-label") || "")
      .split(",").map((value) => normalText(value));
    return { reposts: values[0] || "0", comments: values[1] || "0", likes: values[2] || "0" };
  };
  const getPostSignature = () => getPostCards().slice(0, 30).map((card) => postIdFromUrl(postLink(card)?.href || "") || postLink(card)?.href || "").filter(Boolean).join("|");
  const getProfilePanel = () => {
    const profileId = profileIdFromPath();
    const fansLink = profileId ? document.querySelector(`a[href*="/u/page/follow/${profileId}?relate=fans"]`) : null;
    return fansLink?.closest(".woo-panel-main") || null;
  };
  const getProfile = () => {
    const profileId = profileIdFromPath();
    const panel = getProfilePanel();
    const fansLink = profileId ? panel?.querySelector(`a[href*="/u/page/follow/${profileId}?relate=fans"]`) : null;
    const profileBox = fansLink?.parentElement?.parentElement || null;
    const headerBox = profileBox?.parentElement || null;
    const stats = [...(profileBox?.querySelectorAll("a") || [])].map((link) => normalText(link.innerText));
    const following = stats.find((value) => /关注$/.test(value)) || "";
    const followers = stats.find((value) => /粉丝$/.test(value)) || "";
    const engagement = stats.find((value) => /转评赞$/.test(value)) || "";
    const uniqueText = (values) => Array.from(new Set(values.filter(Boolean)));
    const detailRoot = panel?.querySelector("[class*='_box3_']");
    // 不同账号类型的资料行会使用不同 CSS 模块名。优先取行容器，
    // 同时读取最末级正文节点，确保机构资料也能进入结果。
    const detailRows = uniqueText([
      ...(panel?.querySelectorAll("[class*='item3'], [class*='_con3_']") || []),
      ...(detailRoot?.children || [])
    ].map((element) => normalText(element.innerText)).filter((value) => value && value.length < 500));
    const profileTags = [...(panel?.querySelectorAll("[class*='_tag_']") || [])]
      .map((element) => normalText(element.innerText))
      .filter(Boolean);
    const influenceRanks = uniqueText([
      ...profileTags,
      ...Array.from(panel?.querySelectorAll("span, div") || [])
        .filter((element) => element.children.length <= 1)
        .map((element) => normalText(element.innerText))
        .filter((value) => /影响力榜|榜第\s*\d+\s*名/.test(value))
    ].filter((value) => !/昨日发博|视频累计播放量/.test(value)));
    const badgeTitles = [...(panel?.querySelectorAll("[title]") || [])]
      .map((element) => normalText(element.getAttribute("title")))
      .filter(Boolean);
    const findDetail = (pattern) => detailRows.find((value) => pattern.test(value)) || "";
    const valueAfterLabel = (value, pattern) => String(value || "").replace(pattern, "").trim();
    // 微博资料卡将活跃度以两个独立标签显示，并将认证说明放在
    // descText 节点。使用文本前缀做兜底，避免 CSS 模块类名变更时丢失。
    const metricText = [...(panel?.querySelectorAll("span, div") || [])]
      .map((element) => normalText(element.innerText))
      .find((value) => /昨日发博\s*[^，,\s]+[，,]\s*阅读数\s*[^，,\s]+[，,]\s*互动数\s*[^，,\s]+/.test(value)) || "";
    const videoMetricText = [...(panel?.querySelectorAll("span, div") || [])]
      .map((element) => normalText(element.innerText))
      .find((value) => /^视频累计播放量\s*\S+/.test(value)) || "";
    const metricValue = (label, text) => text.match(new RegExp(`${label}\\s*([^，,\\s]+)`))?.[1] || "";
    const verificationDescription = normalText(panel?.querySelector("[class*='descText']")?.innerText)
      || [...(panel?.querySelectorAll("div") || [])]
        .map((element) => normalText(element.innerText))
        .find((value) => value && value.length > 2 && value.length < 240 && !/粉丝|关注|转评赞|昨日发博|视频累计播放/.test(value)) || "";
    return {
      profileUrl: location.href,
      profileId,
      avatar: headerBox?.querySelector(".woo-avatar-main img")?.currentSrc || headerBox?.querySelector("img")?.currentSrc || "",
      nickname: normalText(profileBox?.querySelector("[class*='_name_']")?.innerText),
      following: following.replace(/关注$/, ""),
      followers: followers.replace(/粉丝$/, ""),
      engagement: engagement.replace(/转评赞$/, ""),
      cover: panel?.querySelector(".woo-picture-img, .woo-picture-main img, [class*='cover'] img")?.currentSrc || panel?.querySelector(".woo-picture-img, .woo-picture-main img, [class*='cover'] img")?.src || "",
      gender: badgeTitles.find((value) => /^(男|女)$/.test(value)) || "",
      membershipBadges: badgeTitles.filter((value) => !/^(男|女)$/.test(value)).join(" · "),
      yesterdayPosts: metricValue("昨日发博", metricText),
      yesterdayReads: metricValue("阅读数", metricText),
      yesterdayInteractions: metricValue("互动数", metricText),
      videoTotalViews: metricValue("视频累计播放量", videoMetricText),
      influenceRanks: influenceRanks.join(" · "),
      bio: verificationDescription,
      profileDescription: detailRows.find((value) => !/服务单位|许可证|服务类别|他有\s*\d+\s*个好友/.test(value)) || "",
      serviceUnit: valueAfterLabel(findDetail(/服务单位[：:]/), /^.*?服务单位[：:]\s*/),
      newsServiceLicense: findDetail(/许可证/),
      serviceCategory: valueAfterLabel(findDetail(/服务类别[：:]/), /^.*?服务类别[：:]\s*/),
      friendCount: findDetail(/他有\s*\d+\s*个好友/).match(/(\d+)\s*个好友/)?.[1] || "",
      profileDetailLines: detailRows.join(" | "),
      // 作为通用兜底，完整保存当前资料卡已公开展示的文本；即使微博
      // 新增字段或调整样式，用户仍可在导出数据中拿到原始资料信息。
      profileCardText: normalText(panel?.innerText)
    };
  };
  const expandProfileDetails = () => {
    const panel = getProfilePanel();
    // 资料卡折叠时使用 angleDown；展开后会变为 angleUp。只点击
    // angleDown，避免重复轮询时意外将已经展开的资料重新收起。
    const downIcon = [...(panel?.querySelectorAll("i") || [])]
      .find((element) => String(element.className || "").includes("woo-font--angleDown"));
    const control = downIcon?.closest("[class*='_opt_']") || downIcon?.parentElement;
    if (!control || !isVisible(control)) return { clicked: false, collapsed: false };
    control.click();
    return { clicked: true, collapsed: true };
  };
  const inspect = () => {
    const pageText = normalText(document.body?.innerText);
    const cards = getPostCards();
    const profile = getProfile();
    const hasLoginEntry = [...document.querySelectorAll("a, button, [role='button']")]
      .filter(isVisible)
      .map((element) => normalText(element.innerText || element.getAttribute("aria-label") || element.getAttribute("title")))
      .some((label) => /^(?:登录|注册|登录\/注册|立即登录|账号登录)$/.test(label));
    return {
      href: location.href,
      readyState: document.readyState,
      isProfilePage: isProfilePage(),
      hasProfile: Boolean(profile.profileId && (profile.nickname || getProfilePanel())),
      profileDetailsCollapsed: Boolean(getProfilePanel()?.querySelector("i.woo-font--angleDown")),
      profileSignature: [profile.profileId, profile.nickname, profile.followers, profile.engagement, profile.cover, profile.bio, profile.profileDetailLines, profile.influenceRanks, profile.profileCardText].join("|"),
      postCount: cards.length,
      postSignature: getPostSignature(),
      noPosts: /暂无微博|还没有微博|暂无内容/.test(pageText),
      captcha: /安全验证|验证码|访问频繁|操作频繁|请完成验证/.test(pageText),
      requiresLogin: hasLoginEntry || /登录后即可查看|请登录后查看|登录后查看更多/.test(pageText)
    };
  };
  const extractPosts = (limit) => {
    const maximum = Math.max(1, Math.min(100, Number(limit) || 20));
    const seen = new Set();
    const posts = [];
    for (const card of getPostCards()) {
      const link = postLink(card);
      const url = asUrl(link?.href || "");
      const postId = postIdFromUrl(url);
      const key = postId || url;
      if (!key || !url || seen.has(key)) continue;
      seen.add(key);
      const media = [...card.querySelectorAll(".wbpro-feed-content img, .wbpro-feed-content video[poster]")]
        .map((element) => element.currentSrc || element.src || element.getAttribute("poster") || "")
        .filter((value) => value && !/icon-link|icon_default/i.test(value));
      const counts = countFromFooter(card);
      posts.push({
        order: posts.length + 1,
        postId,
        author: normalText(card.querySelector("a[usercard] span[title]")?.getAttribute("title") || card.querySelector("a[usercard]")?.innerText),
        text: normalText(card.querySelector("[class*='wbtext']")?.innerText),
        publishedAt: publishedAtFromCard(card),
        source: normalText(card.querySelector("[class*='source']")?.innerText),
        reposts: counts.reposts,
        comments: counts.comments,
        likes: counts.likes,
        mediaUrls: Array.from(new Set(media)).join(" | "),
        url
      });
      if (posts.length >= maximum) break;
    }
    return { posts, postCardCount: getPostCards().length, capturedAt: new Date().toISOString(), pageUrl: location.href };
  };
  const inspectDetail = () => {
    const card = getDetailCard();
    const link = postLink(card);
    return {
      href: location.href,
      readyState: document.readyState,
      isDetailPage: isDetailPage(),
      hasDetail: Boolean(card && link && card.querySelector("footer[aria-label]")),
      detailSignature: [postIdFromUrl(link?.href || ""), normalText(card?.querySelector("[class*='wbtext']")?.innerText), card?.querySelector("footer[aria-label]")?.getAttribute("aria-label")].join("|"),
      captcha: /安全验证|验证码|访问频繁|操作频繁|请完成验证/.test(normalText(document.body?.innerText))
    };
  };
  const extractDetail = () => {
    const card = getDetailCard();
    if (!card) return { detail: null, capturedAt: new Date().toISOString(), pageUrl: location.href };
    const canonicalLink = postLink(card);
    const url = asUrl(canonicalLink?.href || location.href);
    const content = card.querySelector(".wbpro-feed-content");
    const authorLink = [...card.querySelectorAll("header a[href]")].find((link) => /^\/u\/\d+\/?$/i.test(new URL(link.href, location.href).pathname));
    const authorImage = card.querySelector("header img.woo-avatar-img, header img");
    const media = [...card.querySelectorAll(".wbpro-feed-content img, .wbpro-feed-content video[poster]")]
      .map((element) => element.currentSrc || element.src || element.getAttribute("poster") || "")
      .filter((value) => value && !/icon-link|icon_default|feed_icon|vip_/i.test(value));
    const contentLinks = [...(content?.querySelectorAll("a[href]") || [])].map((link) => ({ text: normalText(link.innerText), href: asUrl(link.href) }));
    const counts = countFromFooter(card);
    return {
      detail: {
        postId: postIdFromUrl(url),
        postUrl: url,
        visibility: normalText(card.querySelector("[class*='_title_']")?.innerText),
        author: normalText(authorLink?.getAttribute("aria-label") || authorLink?.querySelector("[title]")?.getAttribute("title") || authorLink?.innerText),
        authorUrl: asUrl(authorLink?.href || ""),
        authorAvatar: authorImage?.currentSrc || authorImage?.src || "",
        text: normalText(content?.querySelector("[class*='wbtext']")?.innerText || content?.innerText),
        publishedAt: publishedAtFromCard(card),
        source: normalText(card.querySelector("[class*='source']")?.innerText),
        reposts: counts.reposts,
        comments: counts.comments,
        likes: counts.likes,
        topics: contentLinks.filter((item) => /^#.+#$/.test(item.text)).map((item) => item.text).join(" | "),
        mentions: contentLinks.filter((item) => /^@/.test(item.text)).map((item) => item.text).join(" | "),
        contentLinks: contentLinks.map((item) => item.href).filter(Boolean).join(" | "),
        mediaUrls: Array.from(new Set(media)).join(" | ")
      },
      capturedAt: new Date().toISOString(),
      pageUrl: location.href
    };
  };

  if (command === "inspect") return inspect();
  if (command === "expand-profile-details") return expandProfileDetails();
  if (command === "extract-posts") return extractPosts(options.limit);
  if (command === "extract-profile") return { profile: getProfile(), capturedAt: new Date().toISOString(), pageUrl: location.href };
  if (command === "inspect-detail") return inspectDetail();
  if (command === "extract-detail") return extractDetail();
  if (command === "scroll") {
    const viewportHeight = Math.max(480, Number(window.innerHeight) || 720);
    const minimumRatio = Math.max(0.35, Math.min(0.85, Number(options.minimumRatio) || 0.55));
    const maximumRatio = Math.max(minimumRatio, Math.min(1.1, Number(options.maximumRatio) || 0.9));
    const distance = Math.round(viewportHeight * (minimumRatio + Math.random() * (maximumRatio - minimumRatio)));
    const from = Math.max(0, Number(window.scrollY) || 0);
    const maximumTop = Math.max(0, document.documentElement.scrollHeight - viewportHeight);
    const to = Math.min(maximumTop, from + distance);
    window.scrollTo({ top: to, behavior: "smooth" });
    return { from, to, distance: Math.max(0, to - from), maximumTop, reachedEnd: to >= maximumTop };
  }
  throw new Error(`未知的微博页面命令：${command}`);
}
