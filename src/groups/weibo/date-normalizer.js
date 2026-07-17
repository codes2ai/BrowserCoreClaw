function asReferenceDate(value) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value || Date.now());
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function validDateParts(year, month, day, hour, minute, second = 0) {
  const date = new Date(year, month - 1, day, hour, minute, second);
  return date.getFullYear() === year
    && date.getMonth() === month - 1
    && date.getDate() === day
    && date.getHours() === hour
    && date.getMinutes() === minute
    && date.getSeconds() === second;
}

function formatParts(year, month, day, hour, minute, second = null) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${year}-${month}-${day} ${pad(hour)}:${pad(minute)}${second === null ? "" : `:${pad(second)}`}`;
}

export function normalizeWeiboPublishedAt(value, options = {}) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  const reference = asReferenceDate(options.referenceDate);

  const full = text.match(/^(\d{2}|\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (full) {
    const shortYear = Number(full[1]);
    const year = full[1].length === 2 ? (shortYear < 70 ? 2000 + shortYear : 1900 + shortYear) : shortYear;
    const month = Number(full[2]);
    const day = Number(full[3]);
    const hour = Number(full[4]);
    const minute = Number(full[5]);
    const second = full[6] === undefined ? null : Number(full[6]);
    if (!validDateParts(year, month, day, hour, minute, second ?? 0)) return "";
    return formatParts(year, month, day, hour, minute, second);
  }

  const monthDay = text.match(/^(\d{1,2})\s*(?:[-/.]|月)\s*(\d{1,2})\s*日?\s+(\d{1,2}):(\d{2})$/);
  if (monthDay) {
    const month = Number(monthDay[1]);
    const day = Number(monthDay[2]);
    const hour = Number(monthDay[3]);
    const minute = Number(monthDay[4]);
    if (!validDateParts(reference.getFullYear(), month, day, hour, minute)) return "";
    return formatParts(reference.getFullYear(), month, day, hour, minute);
  }

  const relativeDay = text.match(/^(今天|昨天|前天)\s+(\d{1,2}):(\d{2})$/);
  if (relativeDay) {
    const date = new Date(reference.getTime());
    date.setDate(date.getDate() - ({ 今天: 0, 昨天: 1, 前天: 2 }[relativeDay[1]] || 0));
    const hour = Number(relativeDay[2]);
    const minute = Number(relativeDay[3]);
    if (hour > 23 || minute > 59) return "";
    return formatParts(date.getFullYear(), date.getMonth() + 1, date.getDate(), hour, minute);
  }

  const relativeAmount = text.match(/^(\d+)\s*(分钟|小时)前$/);
  if (relativeAmount) {
    const milliseconds = Number(relativeAmount[1]) * (relativeAmount[2] === "小时" ? 60 : 1) * 60 * 1000;
    const date = new Date(reference.getTime() - milliseconds);
    return formatParts(date.getFullYear(), date.getMonth() + 1, date.getDate(), date.getHours(), date.getMinutes());
  }

  return "";
}
