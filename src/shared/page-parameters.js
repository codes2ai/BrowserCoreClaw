function asText(value) {
  return String(value ?? "").trim();
}

/**
 * 统一渲染功能页中的“页面参数”折叠区。
 * 运行选项只保留任务调度与存储行为；会影响目标网站页面的筛选、语言等参数放在此处。
 */
export function renderPageParametersCard({
  prefix,
  open = false,
  action = "toggle-page-parameters",
  description = "配置采集页面本身的筛选条件与展示参数。",
  body = "",
  configuredCount = 0,
  emptyMessage = "当前功能没有可配置的页面参数，采集时将使用页面默认状态。"
} = {}) {
  const classPrefix = asText(prefix) || "xhs";
  const content = asText(body);
  const count = Math.max(0, Number(configuredCount) || 0);
  const hasParameters = Boolean(content);
  const summary = hasParameters
    ? `<span><small>可配置项</small><strong>${count}</strong></span>`
    : "<span><small>配置状态</small><strong>无</strong></span>";
  const panelContent = hasParameters
    ? `<div class="${classPrefix}-options-grid">${content}</div>`
    : `<div class="${classPrefix}-page-parameters-empty"><strong>暂无页面参数</strong><span>${emptyMessage}</span></div>`;

  return `
    <section class="${classPrefix}-options-card ${classPrefix}-page-parameters-card">
      <button class="${classPrefix}-options-header" type="button" data-action="${action}" aria-expanded="${Boolean(open)}">
        <span class="${classPrefix}-page-parameters-indicator" aria-hidden="true">⌄</span>
        <span class="${classPrefix}-options-title"><strong>页面参数</strong><small>${hasParameters ? "配置目标页面的筛选或展示条件" : "当前功能没有额外页面参数"}</small></span>
        <span class="${classPrefix}-option-summary" aria-label="当前页面参数摘要">${summary}</span>
        <span class="${classPrefix}-options-toggle-label">${open ? "收起参数" : "展开参数"}</span>
      </button>
      ${open ? `<div class="${classPrefix}-options-body ${classPrefix}-page-parameters-body"><p class="${classPrefix}-options-note">${description}</p>${panelContent}</div>` : ""}
    </section>
  `;
}
