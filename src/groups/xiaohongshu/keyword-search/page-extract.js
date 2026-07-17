export async function runXiaohongshuSearchPageCommand(command, options = {}) {
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
  const isNoteHref = (value) => {
    try {
      const url = new URL(value, location.href);
      return /(^|\.)xiaohongshu\.com$/i.test(url.hostname)
        && /^\/search_result\/[a-z0-9]+$/i.test(url.pathname);
    } catch {
      return false;
    }
  };
  const noteLinksWithin = (element) => [...element.querySelectorAll("a[href]")].filter((link) => isNoteHref(link.href));
  const findCardRoot = (link) => {
    const noteCard = link.closest("section.note-item");
    if (noteCard) return noteCard;
    let root = link;
    let parent = link.parentElement;
    for (let depth = 0; parent && depth < 6; depth += 1, parent = parent.parentElement) {
      if (noteLinksWithin(parent).length !== 1) break;
      root = parent;
    }
    return root;
  };
  const findTextByClass = (root, matcher) => {
    const element = [...root.querySelectorAll("[class]")]
      .find((item) => matcher.test(String(item.className)) && normalText(item.innerText));
    return normalText(element?.innerText);
  };
  const firstMatchingLine = (lines, pattern) => lines.find((line) => pattern.test(line)) || "";
  const getResultLinks = () => [...document.querySelectorAll("a[href]")]
    .filter((link) => isVisible(link) && isNoteHref(link.href));
  const getResultSignature = () => getResultLinks()
    .slice(0, 16)
    .map((link) => new URL(link.href, location.href).pathname)
    .join("|");
  const hasVisibleLoading = () => [...document.querySelectorAll("[aria-busy='true'], [class*='loading' i], [class*='skeleton' i], [class*='spinner' i]")]
    .some((element) => isVisible(element) && /loading|skeleton|spinner|加载中|加载更多/i.test(`${element.className || ""} ${element.getAttribute("aria-label") || ""} ${element.innerText || ""}`));
  const inspect = () => {
    const text = normalText(document.body?.innerText);
    const controls = [...document.querySelectorAll("a, button, [role='button']")]
      .filter(isVisible)
      .map((element) => normalText(element.innerText || element.getAttribute("aria-label") || element.getAttribute("title")))
      .filter(Boolean);
    return {
      href: location.href,
      readyState: document.readyState,
      isSearchPage: /search/i.test(location.pathname),
      resultCount: getResultLinks().length,
      resultSignature: getResultSignature(),
      loading: hasVisibleLoading(),
      hasLoginEntry: controls.some((label) => /登录|登入/.test(label)),
      captcha: /验证码|安全验证|人机验证|访问过于频繁/.test(text),
      noResults: /暂无搜索结果|没有找到相关|未找到相关/.test(text)
    };
  };
  const extract = (limit) => {
    const maximum = Math.max(1, Math.min(100, Number(limit) || 20));
    const seen = new Set();
    const results = [];
    const links = getResultLinks();
    for (const link of links) {
      const url = new URL(link.href, location.href).href;
      if (seen.has(url)) continue;
      seen.add(url);
      const root = findCardRoot(link);
      const lines = String(root.innerText || "").split(/\n+/).map(normalText).filter(Boolean);
      const image = root.querySelector("img");
      const timePattern = /(刚刚|\d+\s*分钟前|\d+\s*小时前|\d+\s*天前|昨天|前天|\d{1,2}[-\/.]\d{1,2}|\d{4}[-\/.]\d{1,2}[-\/.]\d{1,2})/;
      const textFrom = (selector) => normalText(root.querySelector(selector)?.innerText);
      const time = textFrom(".time") || firstMatchingLine(lines, timePattern);
      const likes = normalizeLikes(textFrom(".count") || firstMatchingLine(lines, /^(点赞\s*)?\d+(?:\.\d+)?(?:万|w|W)?$/));
      const author = textFrom(".name") || (time && lines.indexOf(time) > 0 ? lines[lines.indexOf(time) - 1] : "");
      const title = textFrom(".title");
      const description = textFrom(".desc, .description, [class*='note-content']");
      results.push({
        order: results.length + 1,
        title,
        description,
        author,
        likes,
        time,
        cover: image?.currentSrc || image?.src || image?.getAttribute("data-src") || "",
        url
      });
      if (results.length >= maximum) break;
    }
    return { results, capturedAt: new Date().toISOString(), pageUrl: location.href };
  };
  const applyFilters = async (filters) => {
    const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
    const groups = [
      ["排序依据", filters.sortLabel || "综合"],
      ["笔记类型", filters.noteTypeLabel || "不限"],
      ["发布时间", filters.publishTimeLabel || "不限"],
      ["搜索范围", filters.searchScopeLabel || "不限"],
      ["位置距离", filters.locationLabel || "不限"]
    ];
    const isInteractive = (element) => element.matches("button, a, input, select, textarea, [role='button']")
      || typeof element.onclick === "function" || getComputedStyle(element).cursor === "pointer";
    const visibleElements = (root = document) => [...root.querySelectorAll("button, a, [role='button'], div, span")]
      .filter(isVisible);
    const exactText = (root, label) => visibleElements(root).find((element) => normalText(element.innerText) === label);
    const clickableTarget = (element) => {
      if (!element) return null;
      return element.closest("button, a, [role='button']")
        || element.closest(".tags")
        || (isInteractive(element) ? element : null)
        || [...(element.parentElement?.querySelectorAll("button, a, [role='button']") || [])].find(isVisible)
        || element;
    };
    const click = (element) => {
      const target = clickableTarget(element);
      if (!target) return false;
      target.scrollIntoView({ block: "center", inline: "nearest" });
      target.click();
      return true;
    };
    const isSelected = (element) => {
      const target = clickableTarget(element);
      const candidates = [element, target, target?.parentElement, target?.parentElement?.parentElement].filter(Boolean);
      return candidates.some((item) => {
        const attributes = ["aria-pressed", "aria-selected", "data-selected", "data-active", "data-state"]
          .map((name) => String(item.getAttribute(name) || "").toLowerCase());
        const className = String(item.className || "");
        const style = getComputedStyle(item);
        const isRedText = /^rgb\(255,\s*(?:36|37|38|39|40),/i.test(style.color);
        return attributes.some((value) => ["true", "selected", "active", "checked", "on"].includes(value))
          || /(^|[\s_-])(active|selected|checked|current)(?=$|[\s_-])/i.test(className)
          || isRedText;
      });
    };
    const findOption = (sectionLabel, optionLabel) => {
      const heading = exactText(document, sectionLabel);
      if (!heading) return { error: `筛选面板中未找到“${sectionLabel}”。` };
      const headingTop = heading.getBoundingClientRect().top;
      const nextHeadingTop = groups
        .map(([label]) => exactText(document, label))
        .filter((item) => item && item !== heading)
        .map((item) => item.getBoundingClientRect().top)
        .filter((top) => top > headingTop + 2)
        .sort((first, second) => first - second)[0] ?? Number.POSITIVE_INFINITY;
      const option = visibleElements()
        .filter((element) => normalText(element.innerText) === optionLabel)
        .filter((element) => {
          const top = element.getBoundingClientRect().top;
          return top >= headingTop - 2 && top < nextHeadingTop - 2;
        })[0];
      return option ? { option } : { error: `“${sectionLabel}”中未找到“${optionLabel}”。` };
    };
    const waitForSelection = async (sectionLabel, optionLabel) => {
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline) {
        const current = findOption(sectionLabel, optionLabel);
        if (current.option && isSelected(current.option)) return current.option;
        await wait(120);
      }
      return null;
    };
    const waitForFilterPanel = async () => {
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline) {
        if (exactText(document, "排序依据")) return true;
        await wait(120);
      }
      return false;
    };
    if (!exactText(document, "排序依据")) {
      const trigger = document.querySelector("div.filter.active, div.filter")
        || visibleElements().find((element) => /^(已)?筛选/.test(normalText(element.innerText)) && isInteractive(element));
      if (!click(trigger)) return { ok: false, error: "未找到小红书搜索页的“筛选”入口。" };
      if (!await waitForFilterPanel()) return { ok: false, error: "小红书筛选面板打开超时。" };
    }
    const applied = [];
    for (const [sectionLabel, optionLabel] of groups) {
      const found = findOption(sectionLabel, optionLabel);
      if (!found.option) return { ok: false, error: found.error };
      if (!isSelected(found.option) && !click(found.option)) {
        return { ok: false, error: `“${sectionLabel}”中未找到可点击的“${optionLabel}”。` };
      }
      if (!await waitForSelection(sectionLabel, optionLabel)) {
        return { ok: false, error: `“${sectionLabel}”的“${optionLabel}”未能确认已生效。` };
      }
      applied.push({ sectionLabel, optionLabel });
      await wait(180);
    }
    const closeButton = visibleElements().find((element) => normalText(element.innerText) === "收起" && isInteractive(element));
    click(closeButton);
    return { ok: true, applied, appliedAt: new Date().toISOString() };
  };

  if (command === "inspect") return inspect();
  if (command === "extract") return extract(options.limit);
  if (command === "apply_filters") return applyFilters(options.filters || {});
  throw new Error(`未知的小红书页面命令：${command}`);
}

export function extractXiaohongshuSearchResults(limit = 20) {
  return runXiaohongshuSearchPageCommand("extract", { limit });
}

export function inspectXiaohongshuSearchPage() {
  return runXiaohongshuSearchPageCommand("inspect");
}

export function applyXiaohongshuSearchFilters(filters = {}) {
  return runXiaohongshuSearchPageCommand("apply_filters", { filters });
}
