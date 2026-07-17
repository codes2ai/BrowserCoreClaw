function asColumns(columns) {
  return (Array.isArray(columns) ? columns : [])
    .filter((column) => column?.key && column?.label)
    .map((column) => ({ ...column, key: String(column.key), label: String(column.label) }));
}

function asRows(rows) {
  return Array.isArray(rows) ? rows : [];
}

export function createDataColumnVisibility(columns, savedVisibility = {}) {
  const definitions = asColumns(columns);
  const visibility = Object.fromEntries(definitions.map((column) => [
    column.key,
    typeof savedVisibility?.[column.key] === "boolean" ? savedVisibility[column.key] : true
  ]));
  if (definitions.length && !definitions.some((column) => visibility[column.key])) {
    visibility[definitions[0].key] = true;
  }
  return visibility;
}

export function getVisibleDataColumns(columns, visibility = {}) {
  const definitions = asColumns(columns);
  const visibleColumns = definitions.filter((column) => visibility?.[column.key] !== false);
  return visibleColumns.length ? visibleColumns : definitions.slice(0, 1);
}

export function showAllDataColumns(columns) {
  return Object.fromEntries(asColumns(columns).map((column) => [column.key, true]));
}

export function scheduleDataColumnRender(render) {
  if (typeof render !== "function") return null;
  const schedule = typeof globalThis.requestAnimationFrame === "function"
    ? globalThis.requestAnimationFrame.bind(globalThis)
    : (callback) => globalThis.setTimeout(callback, 0);
  return schedule(() => render());
}

export function projectDataRowsByColumns(rows, columns, visibility = {}) {
  const visibleColumns = getVisibleDataColumns(columns, visibility);
  return asRows(rows).map((row) => Object.fromEntries(
    visibleColumns.map((column) => [column.key, row?.[column.key] ?? ""])
  ));
}

export function renderDataColumnSettingsPanel({
  columns,
  visibility = {},
  expanded = false,
  escapeHtml = (value) => String(value ?? "")
} = {}) {
  const definitions = asColumns(columns);
  if (!definitions.length) return "";
  const visibleColumns = getVisibleDataColumns(definitions, visibility);
  const allVisible = visibleColumns.length === definitions.length;
  const fields = definitions.map((column) => {
    const checked = visibility?.[column.key] !== false;
    const disableLast = checked && visibleColumns.length === 1;
    return `<label class="data-column-option ${checked ? "is-visible" : "is-hidden"}"><input type="checkbox" data-data-column="${escapeHtml(column.key)}" ${checked ? "checked" : ""} ${disableLast ? "disabled" : ""}><span>${escapeHtml(column.label)}</span></label>`;
  }).join("");
  return `<div class="data-column-control ${expanded ? "is-expanded" : ""}"><button class="data-column-trigger" type="button" data-action="toggle-data-columns" aria-haspopup="dialog" aria-expanded="${expanded}"><span>列设置</span><small>${visibleColumns.length}/${definitions.length}</small></button>${expanded ? `<section class="data-column-popover" role="dialog" aria-label="表头设置"><header><div><strong>显示字段</strong><span>已选 ${visibleColumns.length} / ${definitions.length}</span></div><button type="button" data-action="toggle-data-columns" aria-label="关闭列设置">关闭</button></header><div class="data-column-fields">${fields}</div><footer><button type="button" data-action="show-all-data-columns" ${allVisible ? "disabled" : ""}>重置为全部显示</button></footer></section>` : ""}</div>`;
}

function inferColumnType(column) {
  if (column.type) return column.type;
  if (/^(?:cover|avatar|authorAvatar|noteCover)$/i.test(column.key)) return "image";
  if (/(?:Url|URL)$/.test(column.key) || /^(?:url|postUrl|profileUrl|noteUrl)$/i.test(column.key)) return "link";
  if (/(?:text|description|content|bio|topics|mentions|mediaUrls|contentLinks|tags|badges|ranks|license|detailLines|cardText|rawText)$/i.test(column.key)) return "long";
  return "text";
}

export function renderConfiguredDataTable({
  rows,
  columns,
  visibility = {},
  escapeHtml = (value) => String(value ?? ""),
  emptyText = "暂无数据",
  emptyClass = "xhs-table-empty",
  longCellClass = "xhs-description-cell"
} = {}) {
  const visibleColumns = getVisibleDataColumns(columns, visibility);
  const normalizedRows = asRows(rows);
  const header = `<thead><tr>${visibleColumns.map((column) => `<th>${escapeHtml(column.label)}</th>`).join("")}</tr></thead>`;
  if (!normalizedRows.length) {
    return `${header}<tbody><tr><td class="${escapeHtml(emptyClass)}" colspan="${Math.max(1, visibleColumns.length)}">${escapeHtml(emptyText)}</td></tr></tbody>`;
  }
  const body = normalizedRows.map((row) => `<tr>${visibleColumns.map((column) => {
    const rawValue = row?.[column.key] ?? "";
    const value = String(rawValue ?? "").trim();
    const type = inferColumnType(column);
    if (type === "image") {
      return `<td>${value ? `<img class="xhs-cover-thumb" src="${escapeHtml(value)}" alt="" loading="lazy">` : "-"}</td>`;
    }
    if (type === "link") {
      return `<td>${value ? `<a href="${escapeHtml(value)}" target="_blank" rel="noreferrer">打开</a>` : "-"}</td>`;
    }
    if (type === "long") {
      return `<td class="${escapeHtml(longCellClass)}" title="${escapeHtml(value)}">${escapeHtml(value || "-")}</td>`;
    }
    return `<td>${escapeHtml(value || "-")}</td>`;
  }).join("")}</tr>`).join("");
  return `${header}<tbody>${body}</tbody>`;
}

function csvCell(value) {
  let text = String(value ?? "");
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function exportTimestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

export function serializeDataRowsCsv(rows, columns, visibility) {
  const visibleColumns = getVisibleDataColumns(columns, visibility);
  const projectedRows = projectDataRowsByColumns(rows, visibleColumns, showAllDataColumns(visibleColumns));
  const keys = visibleColumns.map((column) => column.key);
  return `\uFEFF${[
    keys.map(csvCell).join(","),
    ...projectedRows.map((row) => keys.map((key) => csvCell(row[key])).join(","))
  ].join("\r\n")}`;
}

export function downloadDataRowsCsv(rows, columns, visibility, filenamePrefix = "data") {
  const content = serializeDataRowsCsv(rows, columns, visibility);
  const url = URL.createObjectURL(new Blob([content], { type: "text/csv;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${filenamePrefix}-${exportTimestamp()}.csv`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  globalThis.setTimeout(() => URL.revokeObjectURL(url), 0);
}
