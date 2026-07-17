/**
 * 数据表默认以唯一键去重并保留首次入库的内容；只有显式开启强制更新时，
 * 才用本次采集到的同键数据覆盖旧行。
 */
export function normalizeForceUpdateData(value) {
  return value === true;
}

function asRows(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function normalizeKey(value) {
  return String(value ?? "").trim();
}

/**
 * 合并由同一功能存储的数据行，并返回真正新增的唯一键，供任务记录统计。
 */
export function mergeDataRowsByKey({
  currentRows,
  incomingRows,
  getKey,
  forceUpdateData = false,
  mergeRow = (previous, incoming) => ({ ...previous, ...incoming })
}) {
  const existingRows = asRows(currentRows);
  const incoming = asRows(incomingRows);
  const getRowKey = typeof getKey === "function" ? getKey : (row) => row?.id;
  const existingByKey = new Map(existingRows
    .map((row) => [normalizeKey(getRowKey(row)), row])
    .filter(([key]) => Boolean(key)));
  const replacementsByKey = new Map();
  const unkeyedRows = [];
  const addedKeys = new Set();
  let unkeyedAddedCount = 0;
  const shouldUpdate = normalizeForceUpdateData(forceUpdateData);

  for (const row of incoming) {
    const key = normalizeKey(getRowKey(row));
    if (!key) {
      unkeyedRows.push(mergeRow(undefined, row));
      unkeyedAddedCount += 1;
      continue;
    }

    const previous = replacementsByKey.get(key) || existingByKey.get(key);
    if (previous && !shouldUpdate) continue;
    if (!existingByKey.has(key)) addedKeys.add(key);
    replacementsByKey.set(key, mergeRow(previous, row));
  }

  return {
    rows: [
      ...replacementsByKey.values(),
      ...unkeyedRows,
      ...existingRows.filter((row) => !replacementsByKey.has(normalizeKey(getRowKey(row))))
    ],
    addedCount: addedKeys.size + unkeyedAddedCount,
    addedKeys,
    unkeyedAddedCount
  };
}
