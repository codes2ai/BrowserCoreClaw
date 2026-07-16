export const DEFAULT_INPUT_LIST_PAGE_SIZE = 10;

function asPositiveInteger(value, fallback = 1) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function paginateInputList(items, requestedPage = 1, pageSize = DEFAULT_INPUT_LIST_PAGE_SIZE) {
  const source = Array.isArray(items) ? items : [];
  const normalizedPageSize = asPositiveInteger(pageSize, DEFAULT_INPUT_LIST_PAGE_SIZE);
  const pageCount = Math.max(1, Math.ceil(source.length / normalizedPageSize));
  const page = Math.min(pageCount, asPositiveInteger(requestedPage));
  const startIndex = (page - 1) * normalizedPageSize;
  const endIndex = Math.min(source.length, startIndex + normalizedPageSize);

  return {
    page,
    pageCount,
    pageSize: normalizedPageSize,
    totalItems: source.length,
    startIndex,
    endIndex,
    items: source.slice(startIndex, endIndex).map((value, offset) => ({
      value,
      index: startIndex + offset
    }))
  };
}

export function pageForInputIndex(index, pageSize = DEFAULT_INPUT_LIST_PAGE_SIZE) {
  const normalizedPageSize = asPositiveInteger(pageSize, DEFAULT_INPUT_LIST_PAGE_SIZE);
  const normalizedIndex = Math.max(0, Number.parseInt(index, 10) || 0);
  return Math.floor(normalizedIndex / normalizedPageSize) + 1;
}

export function clampInputListPage(page, items, pageSize = DEFAULT_INPUT_LIST_PAGE_SIZE) {
  return paginateInputList(items, page, pageSize).page;
}

function visiblePageTokens(currentPage, pageCount) {
  if (pageCount <= 7) {
    return Array.from({ length: pageCount }, (_, index) => index + 1);
  }

  const pages = new Set([1, pageCount, currentPage - 1, currentPage, currentPage + 1]);
  const normalized = [...pages]
    .filter((page) => page >= 1 && page <= pageCount)
    .sort((left, right) => left - right);
  const tokens = [];
  normalized.forEach((page, index) => {
    if (index > 0 && page - normalized[index - 1] > 1) tokens.push("ellipsis");
    tokens.push(page);
  });
  return tokens;
}

export function renderInputListPagination(pagination, options = {}) {
  if (!pagination || pagination.pageCount <= 1) return "";
  const itemLabel = String(options.itemLabel || "条");
  const pageButtons = visiblePageTokens(pagination.page, pagination.pageCount).map((token) => (
    token === "ellipsis"
      ? '<span class="input-list-pagination-ellipsis" aria-hidden="true">…</span>'
      : `<button class="input-list-pagination-page ${token === pagination.page ? "active" : ""}" type="button" data-action="set-input-list-page" data-page="${token}" aria-label="第 ${token} 页" ${token === pagination.page ? 'aria-current="page"' : ""}>${token}</button>`
  )).join("");

  return `
    <nav class="input-list-pagination" aria-label="输入列表分页">
      <span class="input-list-pagination-summary">显示 ${pagination.startIndex + 1}-${pagination.endIndex} / ${pagination.totalItems} ${itemLabel}</span>
      <div class="input-list-pagination-controls">
        <button class="input-list-pagination-nav" type="button" data-action="set-input-list-page" data-page="${pagination.page - 1}" ${pagination.page <= 1 ? "disabled" : ""}>上一页</button>
        <span class="input-list-pagination-pages">${pageButtons}</span>
        <button class="input-list-pagination-nav" type="button" data-action="set-input-list-page" data-page="${pagination.page + 1}" ${pagination.page >= pagination.pageCount ? "disabled" : ""}>下一页</button>
      </div>
    </nav>
  `;
}
