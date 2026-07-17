export async function runXiaohongshuProfilePageCommand(command, options = {}) {
  const normalText = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const normalizeLikes = (value) => {
    const text = normalText(value);
    if (!text || /^(?:赞|点赞|喜欢|likes?)$/i.test(text)) return "0";
    return text.replace(/^(?:点赞|喜欢)\s*/i, "").trim() || "0";
  };
  const isVisible = (element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || 1) > 0
      && rect.width > 0 && rect.height > 0;
  };
  const asUrl = (value) => {
    try {
      return new URL(value, location.href).href;
    } catch {
      return "";
    }
  };
  const isProfilePath = (path = location.pathname) => /^\/user\/profile\/[^/?#]+/i.test(path);
  const isProfileNoteHref = (value) => {
    try {
      const url = new URL(value, location.href);
      return /(^|\.)xiaohongshu\.com$/i.test(url.hostname)
        && /^\/user\/profile\/[^/]+\/[^/?#]+/i.test(url.pathname);
    } catch {
      return false;
    }
  };
  const noteIdFromUrl = (value) => {
    try {
      const parts = new URL(value, location.href).pathname.split("/").filter(Boolean);
      return parts.length > 3 ? parts.at(-1) || "" : "";
    } catch {
      return "";
    }
  };
  const hasVisibleLoading = () => [...document.querySelectorAll("[aria-busy='true'], [class*='loading' i], [class*='skeleton' i], [class*='spinner' i]")]
    .some((element) => isVisible(element) && /loading|skeleton|spinner|加载中|加载更多/i.test(`${element.className || ""} ${element.getAttribute("aria-label") || ""} ${element.innerText || ""}`));
  const getNoteCards = () => [...document.querySelectorAll("section.note-item")]
    .filter((card) => isVisible(card) && card.querySelector("a.title, a.cover"));
  // 只利用资料区存在与否判断主页已加载，不读取或输出博主资料字段。
  const profileReady = () => Boolean(document.querySelector(".info-part"));
  const getNoteSignature = () => getNoteCards().slice(0, 24).map((card) => {
    const href = card.querySelector("a.title, a.cover")?.href || "";
    return noteIdFromUrl(href) || href;
  }).filter(Boolean).join("|");
  const inspect = () => {
    const text = normalText(document.body?.innerText);
    const controls = [...document.querySelectorAll("a, button, [role='button']")]
      .filter(isVisible)
      .map((element) => normalText(element.innerText || element.getAttribute("aria-label") || element.getAttribute("title")))
      .filter(Boolean);
    const cards = getNoteCards();
    return {
      href: location.href,
      readyState: document.readyState,
      isProfilePage: isProfilePath(),
      profileReady: profileReady(),
      noteCount: cards.length,
      noteSignature: getNoteSignature(),
      // 小红书主页会长期保留“加载更多”的动画节点，即使笔记卡片已经
      // 完整可见。将该节点视为持续加载会导致稳定等待永远超时；已有
      // 卡片时改由卡片签名连续稳定来判断页面是否可采集。
      loading: cards.length === 0 && hasVisibleLoading(),
      hasLoginEntry: controls.some((label) => /登录|登入/.test(label)),
      captcha: /验证码|安全验证|人机验证|访问过于频繁/.test(text),
      noNotes: /暂无笔记|还没有发布笔记|暂无内容/.test(text)
    };
  };
  const extract = (limit) => {
    const maximum = Math.max(1, Math.min(100, Number(limit) || 20));
    const seen = new Set();
    const notes = [];
    for (const card of getNoteCards()) {
      const noteLink = card.querySelector("a.title") || card.querySelector("a.cover");
      const noteUrl = asUrl(noteLink?.href || "");
      const noteId = noteIdFromUrl(noteUrl);
      const key = noteId || noteUrl;
      if (!key || seen.has(key) || !isProfileNoteHref(noteUrl)) continue;
      seen.add(key);
      const coverImage = card.querySelector("a.cover img, .cover img, img");
      notes.push({
        order: notes.length + 1,
        noteId,
        title: normalText(card.querySelector("a.title")?.innerText),
        author: normalText(card.querySelector(".author .name")?.innerText),
        likes: normalizeLikes(card.querySelector(".like-wrapper .count")?.innerText),
        cover: coverImage?.currentSrc || coverImage?.src || "",
        url: noteUrl
      });
      if (notes.length >= maximum) break;
    }
    return {
      notes,
      noteCardCount: getNoteCards().length,
      capturedAt: new Date().toISOString(),
      pageUrl: location.href,
      rawPageText: String(document.body?.innerText || "").trim()
    };
  };

  if (command === "inspect") return inspect();
  if (command === "extract") return extract(options.limit);
  throw new Error(`未知的小红书博主页命令：${command}`);
}
