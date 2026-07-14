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
      /(\d+\s*(秒|分钟|小时|minute|minutes|hour|hours)\s*(前|ago)?|刚刚|just now|less than an hour)/i.test(line)
    )) || "";
  }

  function pad(number) {
    return String(number).padStart(2, "0");
  }

  function formatDateTime(date) {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function absoluteTimeFromLabel(label) {
    const text = clean(label).toLowerCase();
    if (!text) {
      return "";
    }

    const date = new Date();
    if (/刚刚|just now/.test(text)) {
      return formatDateTime(date);
    }
    if (/less than an hour/.test(text)) {
      date.setMinutes(date.getMinutes() - 30);
      return formatDateTime(date);
    }

    const seconds = text.match(/(\d+)\s*(秒|second|seconds)/i);
    const minutes = text.match(/(\d+)\s*(分钟|minute|minutes|min|mins)/i);
    const hours = text.match(/(\d+)\s*(小时|hour|hours|hr|hrs)/i);
    if (seconds) {
      date.setSeconds(date.getSeconds() - Number(seconds[1]));
      return formatDateTime(date);
    }
    if (minutes) {
      date.setMinutes(date.getMinutes() - Number(minutes[1]));
      return formatDateTime(date);
    }
    if (hours) {
      date.setHours(date.getHours() - Number(hours[1]));
      return formatDateTime(date);
    }

    const numericDate = text.match(/(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})[日\s]*(?:(\d{1,2})[:：](\d{1,2}))?/);
    if (!numericDate) {
      return "";
    }

    return formatDateTime(new Date(
      Number(numericDate[1]),
      Number(numericDate[2]) - 1,
      Number(numericDate[3]),
      Number(numericDate[4] || 0),
      Number(numericDate[5] || 0)
    ));
  }

  function findNewsContainer(anchor) {
    const explicit = anchor.closest("div.SoaBEf, div.MjjYud");
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
    const timeLabel = timeLabelFrom(textLines);
    const source = findSource(textLines, title, timeLabel);
    seen.add(url);
    results.push({
      title,
      description: findSnippet(textLines, title, source, timeLabel),
      url,
      time: absoluteTimeFromLabel(timeLabel),
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
