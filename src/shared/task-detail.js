import {
  getTaskExecutionTypeLabel,
  normalizeTaskExecutionType
} from "./task-record-type.js";

function asUniqueStrings(values) {
  return Array.from(new Set(
    (Array.isArray(values) ? values : [values])
      .flat(Infinity)
      .map((value) => String(value || "").trim())
      .filter(Boolean)
  ));
}

export function getTaskId(record) {
  return String(record?.runId || record?.id || "").trim();
}

export function tagTaskDataRow(row, task = {}) {
  const runId = String(task.runId || "").trim();
  const recordId = String(task.recordId || "").trim();
  return {
    ...row,
    taskRunIds: asUniqueStrings([row?.taskRunIds, runId]),
    taskRecordIds: asUniqueStrings([row?.taskRecordIds, recordId])
  };
}

export function getTaskRecordDetails(records, recordId) {
  const normalizedRecordId = String(recordId || "").trim();
  const record = (Array.isArray(records) ? records : [])
    .find((item) => String(item?.id || "") === normalizedRecordId);
  if (!record) return null;
  return {
    record,
    recordId: normalizedRecordId,
    taskId: getTaskId(record)
  };
}

export function renderTaskDetailModal({
  detail,
  prefix,
  featureName,
  escapeHtml,
  renderStatus,
  subjectLabel = "关键词",
  detailTitle = `${featureName}关键词任务明细`
}) {
  if (!detail?.record) return "";
  const titleId = `${prefix}TaskDetailTitle`;
  const record = detail.record;

  return `
    <div class="${prefix}-modal-backdrop ${prefix}-task-detail-backdrop" data-modal="task-detail">
      <section class="${prefix}-batch-modal ${prefix}-task-detail-modal" role="dialog" aria-modal="true" aria-labelledby="${titleId}">
        <header>
          <div>
            <span>TASK DETAIL</span>
            <h2 id="${titleId}">${escapeHtml(detailTitle)}</h2>
            <code>${escapeHtml(detail.taskId)}</code>
          </div>
          <button class="${prefix}-modal-close" type="button" data-action="close-task-detail" data-task-detail-close aria-label="关闭任务明细">X</button>
        </header>
        <div class="${prefix}-task-detail-body">
          <dl class="${prefix}-task-summary">
            <div><dt>${escapeHtml(subjectLabel)}</dt><dd>${escapeHtml(record.keyword || "-")}</dd></div>
            <div><dt>运行类型</dt><dd><span class="task-execution-type ${escapeHtml(normalizeTaskExecutionType(record))}">${escapeHtml(getTaskExecutionTypeLabel(record))}</span></dd></div>
            ${record.runnerTaskId ? `<div><dt>父 Runner 任务</dt><dd><code>${escapeHtml(record.runnerTaskId)}</code></dd></div>` : ""}
            <div><dt>执行轮次</dt><dd>第 ${escapeHtml(record.round || "-")} 轮</dd></div>
            <div><dt>开始时间</dt><dd>${escapeHtml(record.startedAt || "-")}</dd></div>
            <div><dt>任务状态</dt><dd>${renderStatus(record)}</dd></div>
            <div><dt>结果数量</dt><dd>${Number(record.resultCount) || 0} 条</dd></div>
            <div><dt>新增数量</dt><dd>${Number(record.addedCount) || 0} 条</dd></div>
            <div><dt>耗时</dt><dd>${escapeHtml(record.duration || "-")}</dd></div>
          </dl>

          ${record.error ? `
            <section class="${prefix}-task-errors" aria-label="错误信息">
              <h3>错误信息</h3>
              <article>
                <strong>${escapeHtml(record.keyword || "-")} · 第 ${escapeHtml(record.round || "-")} 轮</strong>
                <pre>${escapeHtml(record.error)}</pre>
              </article>
            </section>
          ` : ""}
        </div>
        <footer><button class="${prefix}-primary-button" type="button" data-action="close-task-detail">关闭</button></footer>
      </section>
    </div>
  `;
}
