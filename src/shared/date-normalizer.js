function asValidReferenceDate(value) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value || Date.now());
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function createLocalDate(year, month, day) {
  const date = new Date(year, month - 1, day, 12, 0, 0, 0);
  if (
    date.getFullYear() !== year
    || date.getMonth() !== month - 1
    || date.getDate() !== day
  ) {
    return null;
  }
  return date;
}

function formatLocalDate(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function formatLocalDateAndTime(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${formatLocalDate(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function formatLocalCalendarDate(value = new Date()) {
  const date = asValidReferenceDate(value);
  return formatLocalDate(date);
}

export function formatLocalDateTime(value = new Date()) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isNaN(date.getTime()) ? "" : formatLocalDateAndTime(date);
}

function atReferenceTime(referenceDate) {
  return new Date(referenceDate.getTime());
}

function shiftMilliseconds(referenceDate, milliseconds) {
  const date = atReferenceTime(referenceDate);
  date.setTime(date.getTime() - milliseconds);
  return formatLocalDate(date);
}

function shiftLocalDays(referenceDate, days) {
  const date = new Date(
    referenceDate.getFullYear(),
    referenceDate.getMonth(),
    referenceDate.getDate(),
    12,
    0,
    0,
    0
  );
  date.setDate(date.getDate() - days);
  return formatLocalDate(date);
}

function shiftLocalMonths(referenceDate, months) {
  const date = new Date(
    referenceDate.getFullYear(),
    referenceDate.getMonth(),
    1,
    12,
    0,
    0,
    0
  );
  const targetDay = referenceDate.getDate();
  date.setMonth(date.getMonth() - months);
  const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  date.setDate(Math.min(targetDay, lastDay));
  return formatLocalDate(date);
}

function shiftLocalYears(referenceDate, years) {
  const targetYear = referenceDate.getFullYear() - years;
  const targetMonth = referenceDate.getMonth() + 1;
  const targetDay = Math.min(
    referenceDate.getDate(),
    new Date(targetYear, targetMonth, 0).getDate()
  );
  return formatLocalDate(createLocalDate(targetYear, targetMonth, targetDay));
}

/**
 * 将页面上的完整日期、无年份日期和中英文相对时间统一为 YYYY-MM-DD。
 * referenceDate 使用该条数据的实际采集时间，确保跨日相对时间和年份推断正确。
 */
export function normalizePublishedDate(value, options = {}) {
  const raw = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!raw) return "";

  const referenceDate = asValidReferenceDate(options.referenceDate);
  const explicitDate = raw.match(/(\d{4})\s*(?:[-/.]|年)\s*(\d{1,2})\s*(?:[-/.]|月)\s*(\d{1,2})(?:\s*日)?/);
  if (explicitDate) {
    const date = createLocalDate(
      Number(explicitDate[1]),
      Number(explicitDate[2]),
      Number(explicitDate[3])
    );
    return date ? formatLocalDate(date) : "";
  }

  if (/刚刚|just now|today|今天/i.test(raw)) {
    return formatLocalDate(referenceDate);
  }
  if (/less than an hour/i.test(raw)) {
    return shiftMilliseconds(referenceDate, 30 * 60 * 1000);
  }

  const seconds = raw.match(/(\d+)\s*(?:秒|seconds?|secs?)\s*(?:前|ago)?/i);
  if (seconds) {
    return shiftMilliseconds(referenceDate, Number(seconds[1]) * 1000);
  }
  const minutes = raw.match(/(\d+)\s*(?:分钟|minutes?|mins?)\s*(?:前|ago)?/i);
  if (minutes) {
    return shiftMilliseconds(referenceDate, Number(minutes[1]) * 60 * 1000);
  }
  const hours = raw.match(/(\d+)\s*(?:小时|hours?|hrs?)\s*(?:前|ago)?/i);
  if (hours) {
    return shiftMilliseconds(referenceDate, Number(hours[1]) * 60 * 60 * 1000);
  }
  if (/\b(?:an?|one)\s+hour\s+ago\b/i.test(raw)) {
    return shiftMilliseconds(referenceDate, 60 * 60 * 1000);
  }

  if (/前天/.test(raw)) return shiftLocalDays(referenceDate, 2);
  if (/昨天|yesterday/i.test(raw)) return shiftLocalDays(referenceDate, 1);

  const relativeDays = raw.match(/(\d+)\s*(?:天|days?)\s*(?:前|ago)/i);
  if (relativeDays) return shiftLocalDays(referenceDate, Number(relativeDays[1]));

  const relativeWeeks = raw.match(/(\d+)\s*(?:周|星期|weeks?)\s*(?:前|ago)/i);
  if (relativeWeeks) return shiftLocalDays(referenceDate, Number(relativeWeeks[1]) * 7);

  const relativeMonths = raw.match(/(\d+)\s*(?:个月|months?)\s*(?:前|ago)/i);
  if (relativeMonths) return shiftLocalMonths(referenceDate, Number(relativeMonths[1]));

  const relativeYears = raw.match(/(\d+)\s*(?:年|years?)\s*(?:前|ago)/i);
  if (relativeYears) return shiftLocalYears(referenceDate, Number(relativeYears[1]));

  const monthAndDay = raw.match(/(?:^|\D)(\d{1,2})\s*[-/.月]\s*(\d{1,2})(?:\s*日)?(?:\D|$)/);
  if (monthAndDay) {
    const month = Number(monthAndDay[1]);
    const day = Number(monthAndDay[2]);
    let date = createLocalDate(referenceDate.getFullYear(), month, day);
    if (!date) return "";

    const referenceDay = new Date(
      referenceDate.getFullYear(),
      referenceDate.getMonth(),
      referenceDate.getDate(),
      12,
      0,
      0,
      0
    );
    if (date > referenceDay) {
      date = createLocalDate(referenceDate.getFullYear() - 1, month, day);
    }
    return date ? formatLocalDate(date) : "";
  }

  return "";
}

/**
 * 将精确时间戳和相对时间统一为本地 YYYY-MM-DD HH:mm:ss。
 * 如果来源只提供日期而没有时刻，则保留 YYYY-MM-DD，避免虚构时间。
 */
export function normalizePublishedDateTime(value, options = {}) {
  const raw = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!raw) return "";

  const referenceDate = asValidReferenceDate(options.referenceDate);
  if (/^\d{10,13}$/.test(raw)) {
    const timestamp = Number(raw) * (raw.length === 10 ? 1000 : 1);
    return formatLocalDateTime(timestamp);
  }

  if (/^\d{4}-\d{2}-\d{2}T/i.test(raw)) {
    const machineDate = new Date(raw);
    if (!Number.isNaN(machineDate.getTime())) {
      return formatLocalDateAndTime(machineDate);
    }
  }

  const shiftTime = (milliseconds) => {
    const shifted = new Date(referenceDate.getTime() - milliseconds);
    return formatLocalDateAndTime(shifted);
  };

  if (/刚刚|just now|today|今天/i.test(raw)) {
    return formatLocalDateAndTime(referenceDate);
  }
  if (/less than an hour/i.test(raw)) {
    return shiftTime(30 * 60 * 1000);
  }

  const seconds = raw.match(/(\d+)\s*(?:秒|seconds?|secs?)\s*(?:前|ago)?/i);
  if (seconds) return shiftTime(Number(seconds[1]) * 1000);

  const minutes = raw.match(/(\d+)\s*(?:分钟|minutes?|mins?)\s*(?:前|ago)?/i);
  if (minutes) return shiftTime(Number(minutes[1]) * 60 * 1000);

  const hours = raw.match(/(\d+)\s*(?:小时|hours?|hrs?)\s*(?:前|ago)?/i);
  if (hours) return shiftTime(Number(hours[1]) * 60 * 60 * 1000);
  if (/\b(?:an?|one)\s+hour\s+ago\b/i.test(raw)) {
    return shiftTime(60 * 60 * 1000);
  }

  const relativeDayCount = /前天/.test(raw)
    ? 2
    : /昨天|yesterday/i.test(raw)
      ? 1
      : Number(raw.match(/(\d+)\s*(?:天|days?)\s*(?:前|ago)/i)?.[1] || NaN);
  if (Number.isFinite(relativeDayCount)) {
    const shifted = new Date(referenceDate.getTime());
    shifted.setDate(shifted.getDate() - relativeDayCount);
    return formatLocalDateAndTime(shifted);
  }

  const relativeWeeks = raw.match(/(\d+)\s*(?:周|星期|weeks?)\s*(?:前|ago)/i);
  if (relativeWeeks) {
    const shifted = new Date(referenceDate.getTime());
    shifted.setDate(shifted.getDate() - Number(relativeWeeks[1]) * 7);
    return formatLocalDateAndTime(shifted);
  }

  const relativeMonths = raw.match(/(\d+)\s*(?:个月|months?)\s*(?:前|ago)/i);
  if (relativeMonths) {
    const shifted = new Date(referenceDate.getTime());
    shifted.setMonth(shifted.getMonth() - Number(relativeMonths[1]));
    return formatLocalDateAndTime(shifted);
  }

  const relativeYears = raw.match(/(\d+)\s*(?:年|years?)\s*(?:前|ago)/i);
  if (relativeYears) {
    const shifted = new Date(referenceDate.getTime());
    shifted.setFullYear(shifted.getFullYear() - Number(relativeYears[1]));
    return formatLocalDateAndTime(shifted);
  }

  return normalizePublishedDate(raw, { referenceDate });
}
