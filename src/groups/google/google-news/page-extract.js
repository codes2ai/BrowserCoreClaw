export function extractGoogleNewsResults(options) {
  const limit = options.limit;

  function clean(value) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function lines(value) {
    return String(value || "")
      .split(/\n+/)
      .map(clean)
      .filter(Boolean);
  }

  function normalizeResultUrl(rawUrl) {
    try {
      const url = new URL(rawUrl, location.href);
      const host = url.hostname.toLowerCase();
      if (/(^|\.)google\./.test(host) && url.pathname === "/url") {
        const target = url.searchParams.get("q") || url.searchParams.get("url");
        if (target && /^https?:\/\//i.test(target)) {
          return target;
        }
      }
      return url.href;
    } catch {
      return "";
    }
  }

  function isGoogleInternalUrl(rawUrl) {
    try {
      const url = new URL(rawUrl);
      return /(^|\.)google\./.test(url.hostname.toLowerCase()) &&
        ["/search", "/preferences", "/setprefs", "/advanced_search", "/url"].includes(url.pathname);
    } catch {
      return true;
    }
  }

  function timeLabelFrom(textLines) {
    return textLines.find((line) => (
      /(\d+\s*(秒|分钟|小时|天|周|个月|年|seconds?|minutes?|hours?|days?|weeks?|months?|years?)\s*(前|ago)|刚刚|今天|昨天|前天|just now|today|yesterday|less than an hour|\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}|\d{1,2}[-/.月]\d{1,2})/i.test(line)
    )) || "";
  }

  function machineTimeFrom(node) {
    if (!node) return "";
    const value = clean(
      node.getAttribute("data-ts")
      || node.getAttribute("data-timestamp")
      || node.getAttribute("datetime")
      || node.getAttribute("data-time")
    );
    if (!/^\d{10,13}$/.test(value)) return value;
    const timestamp = Number(value) * (value.length === 10 ? 1000 : 1);
    const date = new Date(timestamp);
    return Number.isNaN(date.getTime()) ? "" : date.toISOString();
  }

  function findPublication(container, textLines) {
    // Google 新闻当前把精确 Unix 秒时间戳放在可见相对时间节点的 data-ts 上。
    // 必须优先选择该节点，避免被卡片中其他 datetime/data-time 属性干扰。
    const timeNode = container.querySelector("[data-ts], [data-timestamp]")
      || container.querySelector("time, [datetime], [data-time]");
    const label = clean(timeNode?.innerText || timeNode?.textContent) || timeLabelFrom(textLines);
    const machineTime = machineTimeFrom(timeNode);
    return {
      label,
      machineTime,
      raw: machineTime || label
    };
  }

  function findNewsContainer(anchor) {
    // 新版 Google 新闻以 a.aJWbwf / div.SoAPf 作为单条新闻边界。
    // MjjYud 可能同时包住多条结果，必须优先使用离链接最近的单卡片节点。
    const explicit = anchor.closest("a.aJWbwf, div.SoAPf, div.SoaBEf, div.MjjYud");
    if (explicit) {
      return explicit;
    }

    let current = anchor;
    for (let depth = 0; current && current !== document.body && depth < 8; depth += 1) {
      const text = clean(current.innerText);
      if (text.length >= clean(anchor.innerText).length + 35 && timeLabelFrom(lines(text))) {
        return current;
      }
      current = current.parentElement;
    }
    return anchor.parentElement || anchor;
  }

  function findTitle(anchor, container) {
    const node = anchor.querySelector("h3, [role='heading'], [aria-level='3']") ||
      container.querySelector("h3, [role='heading'], [aria-level='3']");
    const title = clean(node?.innerText || node?.textContent);
    if (title) {
      return title;
    }
    return lines(anchor.innerText).find((line) => line.length >= 8 && !timeLabelFrom([line])) || "";
  }

  function findSource(textLines, title, timeLabel) {
    return textLines
      .filter((line) => line !== title && line !== timeLabel)
      .filter((line) => !/^https?:\/\//i.test(line))
      .filter((line) => !/^[\w.-]+\.[a-z]{2,}/i.test(line))
      .filter((line) => line.length <= 60)
      .find((line) => !/[。.!?？]$/.test(line)) || "";
  }

  function findSnippet(textLines, title, source, timeLabel) {
    return textLines
      .filter((line) => line !== title && line !== source && line !== timeLabel)
      .filter((line) => !/^https?:\/\//i.test(line))
      .filter((line) => line.length > 24)
      .find((line) => /[。.!?？,，]/.test(line) || line.length > 45) || "";
  }

  const results = [];
  const seen = new Set();
  const anchors = Array.from(document.querySelectorAll("#rso a[href], #search a[href]"));

  for (const anchor of anchors) {
    if (results.length >= limit) {
      break;
    }
    const url = normalizeResultUrl(anchor.href);
    if (!url || seen.has(url) || isGoogleInternalUrl(url)) {
      continue;
    }

    const container = findNewsContainer(anchor);
    const title = findTitle(anchor, container);
    if (!title || title.length < 6) {
      continue;
    }

    const textLines = lines(container.innerText);
    const publication = findPublication(container, textLines);
    const timeLabel = publication.label;
    const source = findSource(textLines, title, timeLabel);
    seen.add(url);
    results.push({
      title,
      description: findSnippet(textLines, title, source, timeLabel),
      url,
      publishedAtRaw: publication.raw,
      publishedAtLabel: timeLabel,
      publishedAtTimestamp: publication.machineTime,
      source
    });
  }

  const url = new URL(location.href);
  const queryInput = document.querySelector("textarea[name='q'], input[name='q']");
  return {
    query: url.searchParams.get("q") || queryInput?.value || "",
    href: location.href,
    capturedAt: new Date().toISOString(),
    resultCount: results.length,
    results
  };
}
