export const ALL_DATA_FILTER = "__all__";
let activeJsonPreviewClose = null;

function asRows(rows) {
  return Array.isArray(rows) ? rows : [];
}

function normalizeFilterValue(value) {
  return String(value ?? "").trim();
}

function readRowValue(row, definition) {
  if (typeof definition.getValue === "function") {
    return definition.getValue(row);
  }
  const keys = Array.isArray(definition.keys) && definition.keys.length
    ? definition.keys
    : [definition.key];
  const values = keys.map((key) => row?.[key]).filter((value) => normalizeFilterValue(value));
  return definition.type === "select" ? values[0] || "" : values.join(" ");
}

function normalizedComparable(value) {
  return normalizeFilterValue(value).toLocaleLowerCase("zh-CN");
}

export function createDataFilterValues(definitions = []) {
  return Object.fromEntries(definitions.map((definition) => [
    definition.key,
    definition.type === "select" ? ALL_DATA_FILTER : ""
  ]));
}

export function countActiveDataFilters(definitions = [], values = {}) {
  return definitions.reduce((count, definition) => {
    const value = normalizeFilterValue(values?.[definition.key]);
    const active = definition.type === "select"
      ? Boolean(value && value !== ALL_DATA_FILTER)
      : Boolean(value);
    return count + (active ? 1 : 0);
  }, 0);
}

export function filterDataRows(rows, definitions = [], values = {}) {
  return asRows(rows).filter((row) => definitions.every((definition) => {
    const filterValue = normalizeFilterValue(values?.[definition.key]);
    if (!filterValue || (definition.type === "select" && filterValue === ALL_DATA_FILTER)) {
      return true;
    }
    const rowValue = normalizedComparable(readRowValue(row, definition));
    const expected = normalizedComparable(filterValue);
    return definition.type === "select" ? rowValue === expected : rowValue.includes(expected);
  }));
}

function getSelectOptions(rows, definition) {
  const configured = Array.isArray(definition.options) ? definition.options : null;
  const values = configured || asRows(rows).map((row) => readRowValue(row, definition));
  const unique = new Map();
  values.forEach((option) => {
    const value = normalizeFilterValue(typeof option === "object" ? option.value : option);
    if (!value) return;
    const label = normalizeFilterValue(typeof option === "object" ? option.label : option) || value;
    if (!unique.has(value)) unique.set(value, label);
  });
  return [...unique.entries()]
    .map(([value, label]) => ({ value, label }))
    .sort((left, right) => left.label.localeCompare(right.label, "zh-CN", { numeric: true }));
}

export function renderDataFilterPanel({
  rows,
  definitions = [],
  values = {},
  expanded = true,
  escapeHtml = (value) => String(value ?? "")
} = {}) {
  if (!definitions.length) return "";
  const sourceRows = asRows(rows);
  const filteredRows = filterDataRows(sourceRows, definitions, values);
  const activeCount = countActiveDataFilters(definitions, values);
  const fields = definitions.map((definition) => {
    const selectedValue = normalizeFilterValue(values?.[definition.key])
      || (definition.type === "select" ? ALL_DATA_FILTER : "");
    if (definition.type === "select") {
      const options = getSelectOptions(sourceRows, definition);
      return `<label class="data-filter-control"><span>${escapeHtml(definition.label)}</span><select data-data-filter="${escapeHtml(definition.key)}"><option value="${ALL_DATA_FILTER}">${escapeHtml(definition.allLabel || `全部${definition.label}`)}</option>${options.map((option) => `<option value="${escapeHtml(option.value)}" ${selectedValue === option.value ? "selected" : ""}>${escapeHtml(option.label)}</option>`).join("")}</select></label>`;
    }
    return `<label class="data-filter-control"><span>${escapeHtml(definition.label)}</span><input type="search" value="${escapeHtml(selectedValue)}" placeholder="${escapeHtml(definition.placeholder || `筛选${definition.label}`)}" data-data-filter="${escapeHtml(definition.key)}" autocomplete="off"></label>`;
  }).join("");
  return `<section class="data-filter-panel ${expanded ? "is-expanded" : "is-collapsed"}" aria-label="数据筛选"><div class="data-filter-header"><div><strong>数据筛选</strong><span>显示 ${filteredRows.length} / ${sourceRows.length} 条${activeCount ? ` · 已启用 ${activeCount} 项` : ""}</span></div><div class="data-filter-actions"><button type="button" data-action="clear-data-filters" ${activeCount ? "" : "disabled"}>清空筛选</button><button class="data-filter-toggle" type="button" data-action="toggle-data-filters" aria-expanded="${expanded}">${expanded ? "收起筛选" : "展开筛选"}<span aria-hidden="true">${expanded ? "⌃" : "⌄"}</span></button></div></div>${expanded ? `<div class="data-filter-fields">${fields}</div>` : ""}</section>`;
}

export function serializeRowsAsJson(rows, transformRows = (value) => value) {
  const transformed = transformRows(asRows(rows));
  return JSON.stringify(Array.isArray(transformed) ? transformed : [], null, 2);
}

async function copyText(text) {
  if (globalThis.navigator?.clipboard?.writeText) {
    try {
      await globalThis.navigator.clipboard.writeText(text);
      return;
    } catch {
      // 部分网页预览环境会拒绝 Clipboard API，继续使用兼容复制方案。
    }
  }
  if (!globalThis.document?.body) {
    throw new Error("当前环境不支持写入剪贴板。");
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand?.("copy");
  textarea.remove();
  if (!copied) throw new Error("复制失败，请检查浏览器剪贴板权限。");
}

export async function copyRowsAsJson(rows, transformRows) {
  const json = serializeRowsAsJson(rows, transformRows);
  await copyText(json);
  return json;
}

export function openRowsJsonPreview(rows, transformRows) {
  if (!globalThis.document?.body) {
    throw new Error("当前环境不支持打开 JSON 预览。");
  }

  activeJsonPreviewClose?.();
  const sourceRows = asRows(rows);
  const json = serializeRowsAsJson(sourceRows, transformRows);
  const previousFocus = document.activeElement;
  const titleId = `jsonPreviewTitle-${globalThis.crypto?.randomUUID?.() || Date.now()}`;
  const backdrop = document.createElement("div");
  backdrop.className = "json-preview-backdrop";
  backdrop.dataset.jsonPreview = "";
  backdrop.innerHTML = `
    <section class="json-preview-dialog" role="dialog" aria-modal="true" aria-labelledby="${titleId}">
      <header class="json-preview-header">
        <div>
          <span>JSON PREVIEW</span>
          <h2 id="${titleId}">JSON 数据</h2>
          <p>当前筛选结果共 ${sourceRows.length} 条</p>
        </div>
        <button class="json-preview-close" type="button" data-json-preview-close aria-label="关闭 JSON 数据弹窗">X</button>
      </header>
      <div class="json-preview-content">
        <textarea readonly spellcheck="false" aria-label="筛选后的 JSON 数据"></textarea>
      </div>
      <footer class="json-preview-footer">
        <span class="json-preview-status" data-json-copy-status aria-live="polite">可查看后复制全部 JSON 数据</span>
        <div>
          <button class="json-preview-secondary" type="button" data-json-preview-close>关闭</button>
          <button class="json-preview-primary" type="button" data-json-copy>一键复制</button>
        </div>
      </footer>
    </section>`;

  const textarea = backdrop.querySelector("textarea");
  const copyButton = backdrop.querySelector("[data-json-copy]");
  const status = backdrop.querySelector("[data-json-copy-status]");
  textarea.value = json;

  const close = () => {
    document.removeEventListener("keydown", handleKeydown, true);
    backdrop.remove();
    if (activeJsonPreviewClose === close) activeJsonPreviewClose = null;
    if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
  };
  const handleKeydown = (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    close();
  };

  backdrop.addEventListener("click", async (event) => {
    if (event.target === backdrop || event.target.closest("[data-json-preview-close]")) {
      close();
      return;
    }
    if (!event.target.closest("[data-json-copy]")) return;
    copyButton.disabled = true;
    try {
      await copyText(json);
      copyButton.textContent = "已复制";
      status.textContent = `已复制 ${sourceRows.length} 条 JSON 数据。`;
      status.classList.remove("is-error");
      status.classList.add("is-success");
    } catch (error) {
      copyButton.textContent = "复制失败";
      status.textContent = error?.message || String(error);
      status.classList.remove("is-success");
      status.classList.add("is-error");
    } finally {
      globalThis.setTimeout(() => {
        if (!copyButton.isConnected) return;
        copyButton.disabled = false;
        copyButton.textContent = "一键复制";
      }, 1600);
    }
  });
  document.addEventListener("keydown", handleKeydown, true);
  document.body.append(backdrop);
  activeJsonPreviewClose = close;
  globalThis.requestAnimationFrame?.(() => copyButton.focus());
  return { json, close };
}
