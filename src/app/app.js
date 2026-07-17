import {
  buildFeatureKey,
  clearRunningFeatureKeys,
  FEATURE_RUN_STATUS_EVENT,
  loadRunningFeatureKeys
} from "../shared/feature-run-status.js";
import {
  getDefaultGlobalSettings,
  getCallableRunnerFeatureIds,
  getRunnerBindingConfiguration,
  GLOBAL_SETTINGS_CHANGED_EVENT,
  loadGlobalSettings,
  normalizeGlobalSettings,
  saveGlobalSettings
} from "../shared/global-settings.js";
import {
  getRunnerCapabilitySchema,
  normalizeRunnerBindingConfiguration
} from "../shared/runner-capability-schema.js";
import { getFeatureRunner } from "../runners/registry.js";
import {
  applyTransferStrategiesToRows,
  TRANSFER_STATUS,
  filterTransferDataRows,
  getTransferFilterOptions,
  loadTransferWorkspace,
  paginateTransferRows,
  requestTransferDataReconcile
} from "../shared/transfer-workspace.js";
import {
  compareTransferStrategies,
  createTransferChannelDraft,
  createTransferStrategyDraft,
  DEFAULT_TRANSFER_BATCH_SIZE,
  DEFAULT_TRANSFER_RETRY_COUNT,
  getDefaultTransferSettings,
  getTransferChannelTypeLabel,
  getTransferStrategyPriority,
  getTransferStrategyPriorityLabel,
  getTransferStrategyTypeLabel,
  isTransferChannelTypeAvailable,
  isBuiltInTransferStrategy,
  loadTransferSettings,
  MAX_TRANSFER_BATCH_SIZE,
  MAX_TRANSFER_RETRY_COUNT,
  MAX_TRANSFER_STRATEGY_PRIORITY,
  MIN_TRANSFER_BATCH_SIZE,
  MIN_TRANSFER_RETRY_COUNT,
  normalizeTransferSettings,
  normalizeTransferStrategyPriority,
  resolveTransferStrategyChannelIds,
  saveTransferSettings,
  TRANSFER_ACTIONS,
  TRANSFER_CHANNEL_TYPES,
  TRANSFER_STRATEGY_TYPES
} from "../shared/transfer-settings.js";

const CONFIG_PATH = "src/config/groups.json";
const FEATURE_STYLE_ID = "active-feature-style";
let activeTransferDataDetailClose = null;
let transferSettingsSaveQueue = Promise.resolve();
let transferSettingsSaveRevision = 0;
let lastPersistedTransferSettings = null;

const state = {
  config: null,
  activePage: "catalog",
  activeFeature: null,
  activeGroup: null,
  unmountFeature: null,
  runningFeatures: new Set(),
  globalSettings: null,
  settingsDraft: null,
  settingsTab: "basic",
  settingsDirty: false,
  settingsNotice: null,
  runnerEditor: null,
  featureRefreshing: false,
  query: "",
  transferWorkspace: null,
  transferLoading: false,
  transferNotice: null,
  transferTab: "data",
  transferDataFiltersOpen: false,
  transferDataPage: 1,
  transferSettings: null,
  transferSettingsNotice: null,
  transferChannelEditor: null,
  transferStrategyEditor: null,
  transferDataFilters: {
    query: "",
    platform: "__all__",
    feature: "__all__",
    entityType: "__all__",
    contentType: "__all__",
    localStatus: "__all__",
    transferStatus: "__all__",
    dateStart: "",
    dateEnd: ""
  }
};

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function extensionUrl(path) {
  if (globalThis.chrome?.runtime?.getURL && globalThis.location?.protocol === "chrome-extension:") {
    return chrome.runtime.getURL(path);
  }
  return new URL(`../../${path}`, import.meta.url).href;
}

function callExtensionApi(callbackApi) {
  return new Promise((resolve, reject) => callbackApi((result) => {
    const error = globalThis.chrome?.runtime?.lastError;
    if (error) reject(new Error(error.message));
    else resolve(result);
  }));
}

function getTransferApiOriginPattern(endpoint) {
  let url;
  try {
    url = new URL(String(endpoint || "").trim());
  } catch {
    throw new Error("API POST 地址无效。");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("API POST 地址仅支持 HTTP 或 HTTPS。");
  }
  return `${url.origin}/*`;
}

function validateTransferApiHeaders(value) {
  const source = String(value || "").trim();
  if (!source) return;
  let headers;
  try {
    headers = JSON.parse(source);
  } catch {
    throw new Error("API 请求头必须是有效的 JSON 对象。");
  }
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) {
    throw new Error("API 请求头必须是 JSON 对象。");
  }
}

async function requestTransferApiOriginPermission(endpoint) {
  const origin = getTransferApiOriginPattern(endpoint);
  if (!globalThis.chrome?.runtime?.id || globalThis.location?.protocol !== "chrome-extension:") return true;
  if (!chrome.permissions?.request) return false;
  return Boolean(await callExtensionApi((done) => chrome.permissions.request({ origins: [origin] }, done)));
}

function validateConfig(config) {
  if (!config?.app || !Array.isArray(config.groups)) {
    throw new Error("分组配置缺少 app 或 groups。 ");
  }

  const ids = new Set();
  for (const group of config.groups) {
    if (!group.id || !group.name || !Array.isArray(group.features)) {
      throw new Error("分组必须包含 id、name 和 features。 ");
    }
    for (const feature of group.features) {
      const key = `${group.id}/${feature.id}`;
      if (!feature.id || !feature.name || !feature.entry || ids.has(key)) {
        throw new Error(`功能配置无效或重复：${key}`);
      }
      ids.add(key);
    }
  }
}

async function loadConfig() {
  const response = await fetch(extensionUrl(CONFIG_PATH));
  if (!response.ok) {
    throw new Error(`加载分组配置失败：HTTP ${response.status}`);
  }
  const config = await response.json();
  validateConfig(config);
  return config;
}

function countFeatures(groups) {
  return groups.reduce((total, group) => total + group.features.length, 0);
}

function cloneSettings(settings) {
  return normalizeGlobalSettings(JSON.parse(JSON.stringify(settings || {})));
}

function getRunnerFeatures() {
  return state.config?.groups.flatMap((group) => group.features
    .filter((feature) => feature.runner)
    .map((feature) => ({
      id: buildFeatureKey(group.id, feature.id),
      name: feature.name,
      groupId: group.id,
      groupName: group.name
    }))) || [];
}

function getDraftRunnerBindingConfiguration(sourceFeatureId, targetFeatureId) {
  const stored = state.settingsDraft?.runners?.configurationByBinding?.[sourceFeatureId]?.[targetFeatureId];
  return normalizeRunnerBindingConfiguration(targetFeatureId, stored);
}

function setDraftRunnerBindingConfiguration(sourceFeatureId, targetFeatureId, configuration) {
  if (!sourceFeatureId || !targetFeatureId) return;
  const runners = state.settingsDraft.runners;
  runners.configurationByBinding ||= {};
  runners.configurationByBinding[sourceFeatureId] ||= {};
  runners.configurationByBinding[sourceFeatureId][targetFeatureId] = normalizeRunnerBindingConfiguration(
    targetFeatureId,
    configuration
  );
}

function getRunnerFeature(featureId, features = getRunnerFeatures()) {
  return features.find((feature) => feature.id === featureId) || null;
}

function getRunnerBindings(features = getRunnerFeatures()) {
  const sourceMap = state.settingsDraft?.runners?.callableByFeature || {};
  const bindings = [];
  Object.entries(sourceMap).forEach(([sourceFeatureId, targetFeatureIds]) => {
    const source = getRunnerFeature(sourceFeatureId, features);
    if (!source || !Array.isArray(targetFeatureIds)) return;
    [...new Set(targetFeatureIds)].forEach((targetFeatureId) => {
      const target = getRunnerFeature(targetFeatureId, features);
      if (!target || source.id === target.id) return;
      bindings.push({
        source,
        target,
        configuration: getDraftRunnerBindingConfiguration(source.id, target.id)
      });
    });
  });
  return bindings.sort((left, right) => `${left.source.groupName}/${left.source.name}/${left.target.name}`
    .localeCompare(`${right.source.groupName}/${right.source.name}/${right.target.name}`, "zh-CN"));
}

function getRunnerInputFields(featureId) {
  const schema = getRunnerCapabilitySchema(featureId);
  return [{ key: schema.inputKey, label: schema.inputLabel }];
}

function createRunnerEditor(binding = null) {
  const source = binding?.source || null;
  const target = binding?.target || null;
  const sourceSchema = source ? getRunnerCapabilitySchema(source.id) : null;
  const configuration = binding?.configuration || null;
  const sourceOutputFields = configuration?.sourceOutputFields?.length
    ? configuration.sourceOutputFields
    : (sourceSchema?.outputFields || []).map((item) => item.key);
  const targetInputFields = configuration?.inputFields?.length
    ? configuration.inputFields
    : (target ? getRunnerInputFields(target.id).map((item) => item.key) : []);
  return {
    mode: binding ? "edit" : "new",
    step: 1,
    originalSourceFeatureId: source?.id || "",
    originalTargetFeatureId: target?.id || "",
    sourceGroupId: source?.groupId || "",
    sourceFeatureId: source?.id || "",
    sourceOutputFields: [...sourceOutputFields],
    targetGroupId: target?.groupId || "",
    targetFeatureId: target?.id || "",
    targetInputFields: [...targetInputFields]
  };
}

function removeDraftRunnerBinding(sourceFeatureId, targetFeatureId) {
  const runners = state.settingsDraft.runners;
  const targets = Array.isArray(runners.callableByFeature?.[sourceFeatureId])
    ? runners.callableByFeature[sourceFeatureId].filter((id) => id !== targetFeatureId)
    : [];
  if (targets.length) runners.callableByFeature[sourceFeatureId] = targets;
  else delete runners.callableByFeature[sourceFeatureId];

  if (runners.configurationByBinding?.[sourceFeatureId]) {
    delete runners.configurationByBinding[sourceFeatureId][targetFeatureId];
    if (!Object.keys(runners.configurationByBinding[sourceFeatureId]).length) {
      delete runners.configurationByBinding[sourceFeatureId];
    }
  }
}

function saveDraftRunnerBinding(editor) {
  const sourceId = String(editor?.sourceFeatureId || "").trim();
  const targetId = String(editor?.targetFeatureId || "").trim();
  if (!sourceId || !targetId || sourceId === targetId) {
    throw new Error("请选择不同的来源功能和目标运行器。");
  }
  if (!editor.sourceOutputFields?.length) throw new Error("请至少选择一个来源输出字段。");
  if (!editor.targetInputFields?.length) throw new Error("请至少选择一个运行器输入字段。");

  const source = getRunnerFeature(sourceId);
  const target = getRunnerFeature(targetId);
  if (!source || !target) throw new Error("所选功能或运行器已不存在。");

  if (editor.originalSourceFeatureId && editor.originalTargetFeatureId
    && (editor.originalSourceFeatureId !== sourceId || editor.originalTargetFeatureId !== targetId)) {
    removeDraftRunnerBinding(editor.originalSourceFeatureId, editor.originalTargetFeatureId);
  }

  const targetIds = new Set(state.settingsDraft.runners.callableByFeature[sourceId] || []);
  targetIds.add(targetId);
  state.settingsDraft.runners.callableByFeature[sourceId] = [...targetIds];

  const configuration = getDraftRunnerBindingConfiguration(sourceId, targetId);
  configuration.sourceOutputFields = [...editor.sourceOutputFields];
  configuration.inputFields = [...editor.targetInputFields];
  setDraftRunnerBindingConfiguration(sourceId, targetId, configuration);
}

function getAppName() {
  return state.globalSettings?.interface?.appName || state.config?.app?.name || "BrowserCoreClaw";
}

function brandMarkContent(settings, className = "") {
  const logo = settings?.interface?.logoDataUrl;
  return logo
    ? `<img class="${escapeHtml(className)}" src="${escapeHtml(logo)}" alt="">`
    : "BC";
}

function appTemplate(config, globalSettings) {
  const featureCount = countFeatures(config.groups);
  const appName = globalSettings.interface.appName;
  return `
    <div class="app-shell">
      <header id="appHeader" class="app-header">
        <button id="brandHome" class="brand-home" type="button" aria-label="返回功能列表">
          <span class="brand-mark" aria-hidden="true">${brandMarkContent(globalSettings, "brand-logo-image")}</span>
          <span class="brand-name">${escapeHtml(appName)}</span>
        </button>

        <nav class="app-nav" aria-label="主导航">
          <button class="app-nav-item active" type="button" data-app-page="catalog" aria-current="page">功能列表</button>
          <button class="app-nav-item" type="button" data-app-page="transfer">数据传输</button>
          <button class="app-nav-item" type="button" data-app-page="settings">设置</button>
        </nav>
      </header>

      <main>
        <section id="catalogView" class="catalog-view">
          <div class="catalog-toolbar">
            <div class="catalog-summary">
              <strong>${config.groups.length}</strong> 个分组
              <span aria-hidden="true">·</span>
              <strong>${featureCount}</strong> 个功能
            </div>
            <label class="search-box">
              <span class="sr-only">搜索功能</span>
              <input id="featureSearch" type="search" placeholder="搜索分组或功能">
            </label>
          </div>
          <div id="groupList" class="group-list"></div>
          <div id="emptySearch" class="empty-search" hidden>没有找到匹配的功能。</div>
        </section>

        <section id="settingsView" class="settings-view" hidden>
          <header class="settings-header">
            <span class="page-kicker">SETTINGS</span>
            <h1>设置</h1>
            <p>统一管理界面、任务限制与数据存储，保存后应用到全部功能。</p>
          </header>
          <div id="settingsRoot"></div>
        </section>

        <section id="transferView" class="transfer-view" hidden aria-labelledby="transferTitle">
          <header class="transfer-header">
            <span class="page-kicker">DATA TRANSFER</span>
            <h1 id="transferTitle">数据传输</h1>
            <p>聚合全部本地采集数据，统一配置传输开关、通道与数据传输策略。</p>
          </header>
          <div id="transferRoot"></div>
        </section>

        <section id="featureView" class="feature-view" hidden>
          <button id="refreshActiveFeature" class="feature-force-refresh" type="button" title="强制刷新功能页面" aria-label="强制刷新功能页面" hidden>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 1 0 2 5.3M20 4v7h-7" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"></path></svg>
          </button>
          <div id="featureRoot"></div>
        </section>
      </main>
    </div>
  `;
}

function runnerGroupOptions(features, selectedGroupId, emptyLabel) {
  const groups = [...new Map(features.map((feature) => [feature.groupId, feature.groupName])).entries()];
  return `<option value="">${escapeHtml(emptyLabel)}</option>${groups.map(([id, name]) => `
    <option value="${escapeHtml(id)}" ${id === selectedGroupId ? "selected" : ""}>${escapeHtml(name)}</option>
  `).join("")}`;
}

function runnerFeatureOptions(features, groupId, selectedFeatureId, emptyLabel, excludeFeatureId = "") {
  const available = features.filter((feature) => feature.groupId === groupId && feature.id !== excludeFeatureId);
  return `<option value="">${escapeHtml(emptyLabel)}</option>${available.map((feature) => `
    <option value="${escapeHtml(feature.id)}" ${feature.id === selectedFeatureId ? "selected" : ""}>${escapeHtml(feature.name)}</option>
  `).join("")}`;
}

function runnerFieldChoices(fields, selectedValues, dataAttribute, emptyText) {
  const selected = new Set(selectedValues || []);
  if (!fields.length) return `<p class="settings-runner-wizard-empty">${escapeHtml(emptyText)}</p>`;
  return `<div class="settings-runner-wizard-fields">
    ${fields.map((field) => `
      <label>
        <input type="checkbox" value="${escapeHtml(field.key)}" ${dataAttribute} ${selected.has(field.key) ? "checked" : ""}>
        <span aria-hidden="true">✓</span>
        <span><strong>${escapeHtml(field.label)}</strong><small>${escapeHtml(field.key)}</small></span>
      </label>
    `).join("")}
  </div>`;
}

function effectiveRunnerSourceOutputFields(binding) {
  return binding.configuration.sourceOutputFields?.length
    ? binding.configuration.sourceOutputFields
    : getRunnerCapabilitySchema(binding.source.id).outputFields.map((field) => field.key);
}

function runnerFieldNames(featureId, keys) {
  const labels = new Map(getRunnerCapabilitySchema(featureId).outputFields.map((field) => [field.key, field.label]));
  getRunnerInputFields(featureId).forEach((field) => labels.set(field.key, field.label));
  return (keys || []).map((key) => labels.get(key) || key);
}

function runnerBindingListTemplate(bindings) {
  const rows = bindings.length ? bindings.map((binding) => {
    const sourceFields = effectiveRunnerSourceOutputFields(binding);
    const targetInputs = binding.configuration.inputFields?.length
      ? binding.configuration.inputFields
      : getRunnerInputFields(binding.target.id).map((field) => field.key);
    return `
      <tr>
        <td><strong>${escapeHtml(binding.source.groupName)} / ${escapeHtml(binding.source.name)}</strong><small>${escapeHtml(binding.source.id)}</small></td>
        <td><span class="settings-runner-field-count">${sourceFields.length} 个字段</span><small>${escapeHtml(runnerFieldNames(binding.source.id, sourceFields).join("、"))}</small></td>
        <td><strong>${escapeHtml(binding.target.groupName)} / ${escapeHtml(binding.target.name)}</strong><small>${escapeHtml(binding.target.id)}</small></td>
        <td><span class="settings-runner-field-count input">${targetInputs.length} 个输入</span><small>${escapeHtml(runnerFieldNames(binding.target.id, targetInputs).join("、"))}</small></td>
        <td class="settings-runner-list-actions"><button type="button" data-settings-action="edit-runner-binding" data-runner-source-id="${escapeHtml(binding.source.id)}" data-runner-target-id="${escapeHtml(binding.target.id)}">编辑</button><button type="button" class="danger" data-settings-action="remove-runner-binding" data-runner-source-id="${escapeHtml(binding.source.id)}" data-runner-target-id="${escapeHtml(binding.target.id)}">删除</button></td>
      </tr>
    `;
  }).join("") : `<tr><td class="settings-runner-list-empty" colspan="5">尚未添加运行器。新增后可建立“来源功能 → 目标 Runner”的调用关系。</td></tr>`;
  return `
    <div class="settings-runner-list-table-shell" tabindex="0">
      <table class="settings-runner-list-table">
        <thead><tr><th>来源功能</th><th>输出字段</th><th>运行器</th><th>Runner 输入字段</th><th>操作</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

function runnerWizardTemplate(editor, features) {
  const source = getRunnerFeature(editor.sourceFeatureId, features);
  const target = getRunnerFeature(editor.targetFeatureId, features);
  const sourceFields = source ? getRunnerCapabilitySchema(source.id).outputFields : [];
  const targetInputs = target ? getRunnerInputFields(target.id) : [];
  const stepOne = editor.step === 1;
  return `
    <section class="settings-runner-wizard" aria-label="${editor.mode === "edit" ? "编辑运行器" : "新增运行器"}">
      <header>
        <div><span>${editor.mode === "edit" ? "EDIT RUNNER" : "NEW RUNNER"}</span><h3 id="settingsRunnerEditorTitle">${editor.mode === "edit" ? "编辑运行器" : "新增运行器"}</h3><p>按顺序选择来源能力和目标 Runner，页面参数与运行选项不会出现在字段选择中。</p></div>
        <button class="settings-secondary-button" type="button" data-settings-action="cancel-runner-editor">取消</button>
      </header>
      <ol class="settings-runner-wizard-steps" aria-label="配置步骤">
        <li class="${stepOne ? "active" : "complete"}"><strong>1</strong><span>选择功能与输出字段</span></li>
        <li class="${stepOne ? "" : "active"}"><strong>2</strong><span>选择运行器与输入字段</span></li>
      </ol>
      ${stepOne ? `
        <section class="settings-runner-wizard-step">
          <header><h4>第一步：选择功能</h4><p>先选择来源分组和功能，再选择本轮采集结果中允许传递给 Runner 的输出字段。</p></header>
          <div class="settings-runner-wizard-selects">
            <label><span>来源分组</span><select data-runner-editor-field="sourceGroupId">${runnerGroupOptions(features, editor.sourceGroupId, "请选择分组")}</select></label>
            <label><span>来源功能</span><select data-runner-editor-field="sourceFeatureId" ${editor.sourceGroupId ? "" : "disabled"}>${runnerFeatureOptions(features, editor.sourceGroupId, editor.sourceFeatureId, "请选择功能")}</select></label>
          </div>
          <div class="settings-runner-wizard-field-section">
            <div><strong>输出字段</strong><small>${source ? `${source.groupName} / ${source.name} 的采集结果字段` : "请先选择来源功能"}</small></div>
            ${runnerFieldChoices(sourceFields, editor.sourceOutputFields, "data-runner-editor-output", "来源功能暂未定义可选择的输出字段。")}
          </div>
        </section>
        <footer><span>已选 ${editor.sourceOutputFields.length} 个来源输出字段。</span><button class="settings-primary-button" type="button" data-settings-action="runner-editor-next">下一步</button></footer>
      ` : `
        <section class="settings-runner-wizard-step">
          <header><h4>第二步：选择运行器</h4><p>只列出 Runner 本体接收的数据输入字段；页面参数、运行选项和调用参数不在此处配置。</p></header>
          <div class="settings-runner-wizard-selects">
            <label><span>运行器分组</span><select data-runner-editor-field="targetGroupId">${runnerGroupOptions(features.filter((feature) => feature.id !== editor.sourceFeatureId), editor.targetGroupId, "请选择分组")}</select></label>
            <label><span>运行器功能</span><select data-runner-editor-field="targetFeatureId" ${editor.targetGroupId ? "" : "disabled"}>${runnerFeatureOptions(features, editor.targetGroupId, editor.targetFeatureId, "请选择运行器", editor.sourceFeatureId)}</select></label>
          </div>
          <div class="settings-runner-wizard-field-section">
            <div><strong>运行器输入字段</strong><small>${target ? `${target.groupName} / ${target.name} 的 Runner 输入` : "请先选择运行器功能"}</small></div>
            ${runnerFieldChoices(targetInputs, editor.targetInputFields, "data-runner-editor-input", "请先选择一个运行器功能。")}
          </div>
        </section>
        <footer><button class="settings-secondary-button" type="button" data-settings-action="runner-editor-back">上一步</button><span>已选 ${editor.targetInputFields.length} 个 Runner 输入字段。</span><button class="settings-primary-button" type="button" data-settings-action="save-runner-binding">${editor.mode === "edit" ? "更新运行器" : "添加运行器"}</button></footer>
      `}
    </section>
  `;
}

function runnerWizardModalTemplate(editor, features) {
  return `
    <div class="settings-runner-modal-backdrop" data-runner-editor-modal>
      <section class="settings-runner-modal" role="dialog" aria-modal="true" aria-labelledby="settingsRunnerEditorTitle">
        ${runnerWizardTemplate(editor, features)}
      </section>
    </div>
  `;
}

function settingsPanelTemplate() {
  const draft = state.settingsDraft;
  const activeTab = state.settingsTab;
  const logo = draft.interface.logoDataUrl;
  const notice = state.settingsNotice
    ? `<div class="settings-notice ${escapeHtml(state.settingsNotice.tone)}" role="status">${escapeHtml(state.settingsNotice.text)}</div>`
    : "";
  const runnerFeatures = getRunnerFeatures();
  const runnerBindings = getRunnerBindings(runnerFeatures);
  const runnerEditorModal = state.runnerEditor ? runnerWizardModalTemplate(state.runnerEditor, runnerFeatures) : "";
  const panels = {
    basic: `
      <section class="settings-panel" aria-labelledby="settings-basic-title">
        <header class="settings-panel-header">
          <div><h2 id="settings-basic-title">基础设置</h2><p>设置控制台对外显示的名称与 Logo。</p></div>
          <span class="settings-scope-badge">全局应用</span>
        </header>
        <div class="settings-form-section">
          <div class="settings-field-copy">
            <label for="appNameSetting">名称</label>
            <p>显示在控制台左上角、浏览器标题和功能页面标题中。</p>
          </div>
          <div class="settings-field-control">
            <input id="appNameSetting" type="text" maxlength="40" value="${escapeHtml(draft.interface.appName)}" data-setting-field="appName" autocomplete="off">
            <small>默认：BrowserCoreClaw，最多 40 个字符。</small>
          </div>
        </div>
        <div class="settings-form-section logo-setting-row">
          <div class="settings-field-copy">
            <label for="logoSettingInput">Logo</label>
            <p>上传后替换左上角默认 BC 标识，推荐使用正方形图片。</p>
          </div>
          <div class="settings-field-control settings-logo-control">
            <div class="settings-logo-preview" aria-label="当前 Logo 预览">
              ${logo ? `<img src="${escapeHtml(logo)}" alt="当前 Logo">` : "<span>BC</span>"}
            </div>
            <div class="settings-logo-actions">
              <label class="settings-secondary-button" for="logoSettingInput">选择图片</label>
              <input id="logoSettingInput" class="sr-only" type="file" accept="image/png,image/jpeg,image/webp,image/gif" data-setting-logo>
              <button class="settings-text-button" type="button" data-settings-action="reset-logo" ${logo ? "" : "disabled"}>恢复默认</button>
            </div>
            <small>支持 PNG、JPG、WebP、GIF，文件不超过 1 MB。</small>
          </div>
        </div>
      </section>
    `,
    limits: `
      <section class="settings-panel" aria-labelledby="settings-limit-title">
        <header class="settings-panel-header">
          <div><h2 id="settings-limit-title">Limit</h2><p>统一限制单个采集任务的运行边界。</p></div>
          <span class="settings-scope-badge">全部功能</span>
        </header>
        <div class="settings-form-section">
          <div class="settings-field-copy">
            <label for="taskTimeoutSetting">任务超时时间</label>
            <p>每个任务运行的最大时长，超出后自动结束该任务并记录为失败。</p>
          </div>
          <div class="settings-field-control compact-control">
            <div class="settings-input-with-unit">
              <input id="taskTimeoutSetting" type="number" min="10" max="86400" step="1" value="${draft.limits.taskTimeoutSeconds}" data-setting-field="taskTimeoutSeconds">
              <span>秒 / S</span>
            </div>
            <small>默认 120 秒；取值范围 10–86400 秒。</small>
          </div>
        </div>
        <div class="settings-form-section">
          <div class="settings-field-copy">
            <label for="dataStorageLimitSetting">数据存储条数</label>
            <p>本地存储中，每个独立功能能够保留的数据条数上限；0 代表无限。</p>
          </div>
          <div class="settings-field-control compact-control">
            <input id="dataStorageLimitSetting" type="number" min="0" max="10000000" step="1" value="${draft.limits.dataStorageLimit}" data-setting-field="dataStorageLimit">
            <small>默认 3000 条；设置为 0 时不限制数据条数。</small>
          </div>
        </div>
        <div class="settings-form-section">
          <div class="settings-field-copy">
            <label for="taskRecordsPerStatusLimitSetting">任务记录条数</label>
            <p>每个独立功能中，各个任务状态分别保留的记录条数上限，例如成功、失败等状态；0 代表无限。</p>
          </div>
          <div class="settings-field-control compact-control">
            <input id="taskRecordsPerStatusLimitSetting" type="number" min="0" max="1000000" step="1" value="${draft.limits.taskRecordsPerStatusLimit}" data-setting-field="taskRecordsPerStatusLimit">
            <small>默认每种状态 200 条；设置为 0 时各状态均不限制。</small>
          </div>
        </div>
      </section>
    `,
    storage: `
      <section class="settings-panel" aria-labelledby="settings-storage-title">
        <header class="settings-panel-header">
          <div><h2 id="settings-storage-title">存储</h2><p>选择运行记录、参数和采集数据的保存位置。</p></div>
          <span class="settings-scope-badge">全部功能</span>
        </header>
        <div class="settings-form-section">
          <div class="settings-field-copy">
            <label for="storageTypeSetting">存储类型</label>
            <p>当前使用浏览器本地存储，数据不会自动上传至外部服务。</p>
          </div>
          <div class="settings-field-control">
            <select id="storageTypeSetting" data-setting-field="storageType">
              <option value="local" selected>本地（当前使用）</option>
              <option value="other" disabled>其他（即将支持）</option>
            </select>
            <small>“其他”仅作能力占位，当前不可选择。</small>
          </div>
        </div>
      </section>
    `,
    runner: `
      <section class="settings-panel settings-runner-panel" aria-labelledby="settings-runner-title">
        <header class="settings-panel-header">
          <div><h2 id="settings-runner-title">运行器列表</h2><p>管理功能与目标 Runner 的调用映射；每一条记录都定义来源输出与 Runner 输入。</p></div>
          <span class="settings-scope-badge">固定配置</span>
        </header>
        <div class="settings-runner-list-intro">
          <div><strong>${runnerBindings.length} 条运行器配置</strong><span>新建采用两步选择：先选来源功能及输出字段，再选目标 Runner 及其输入字段。</span></div>
          <button class="settings-primary-button" type="button" data-settings-action="new-runner-binding">新增运行器</button>
        </div>
        ${runnerBindingListTemplate(runnerBindings)}
      </section>
    `
  };

  return `
    <nav class="settings-tabs" aria-label="设置分类">
      <button class="${activeTab === "basic" ? "active" : ""}" type="button" data-settings-tab="basic" aria-current="${activeTab === "basic" ? "page" : "false"}">基础</button>
      <button class="${activeTab === "limits" ? "active" : ""}" type="button" data-settings-tab="limits" aria-current="${activeTab === "limits" ? "page" : "false"}">Limit</button>
      <button class="${activeTab === "storage" ? "active" : ""}" type="button" data-settings-tab="storage" aria-current="${activeTab === "storage" ? "page" : "false"}">存储</button>
      <button class="${activeTab === "runner" ? "active" : ""}" type="button" data-settings-tab="runner" aria-current="${activeTab === "runner" ? "page" : "false"}">运行器</button>
    </nav>
    ${notice}
    ${panels[activeTab] || panels.basic}
    <footer class="settings-actions">
      <span class="settings-save-state" data-settings-save-state>${state.settingsDirty ? "有尚未保存的修改" : "所有设置已保存"}</span>
      <div>
        <button class="settings-secondary-button" type="button" data-settings-action="reset-all">恢复全部默认值</button>
        <button class="settings-primary-button" type="button" data-settings-action="save" ${state.settingsDirty ? "" : "disabled"}>保存设置</button>
      </div>
    </footer>
    ${runnerEditorModal}
  `;
}

function renderSettings() {
  const root = document.getElementById("settingsRoot");
  if (root && state.settingsDraft) root.innerHTML = settingsPanelTemplate();
  document.body.classList.toggle("has-settings-runner-modal", Boolean(state.runnerEditor));
}

function getTransferFeatureDescriptors() {
  return state.config?.groups.flatMap((group) => group.features.map((feature) => {
    const featureId = buildFeatureKey(group.id, feature.id);
    const runner = getFeatureRunner(featureId);
    return {
      featureId,
      featureName: feature.name,
      platformId: group.id,
      platformName: group.name,
      storageKey: runner?.storageKey || ""
    };
  })).filter((item) => item.storageKey) || [];
}

function getResolvedTransferDataRows() {
  const workspace = state.transferWorkspace || { isPreview: false, dataRows: [] };
  const rows = workspace.dataRows || [];
  const settings = state.transferSettings || getDefaultTransferSettings();
  return applyTransferStrategiesToRows(rows, settings, {
    preferPersisted: !workspace.isPreview,
    preview: workspace.isPreview
  });
}

function getTransferStatusMeta(status) {
  const statusMap = {
    [TRANSFER_STATUS.PENDING]: { label: "待传输", tone: "pending" },
    [TRANSFER_STATUS.TRANSFERRING]: { label: "传输中", tone: "processing" },
    [TRANSFER_STATUS.SUCCESS]: { label: "成功", tone: "success" },
    [TRANSFER_STATUS.FAILED]: { label: "失败", tone: "error" },
    [TRANSFER_STATUS.NOT_REQUIRED]: { label: "无需传输", tone: "muted" }
  };
  return statusMap[status] || statusMap[TRANSFER_STATUS.PENDING];
}

function transferStatusPill(status) {
  const meta = getTransferStatusMeta(status);
  return `<span class="transfer-status-pill ${meta.tone}">${meta.label}</span>`;
}

function transferStatusControl(row) {
  const status = row?.transferStatus || TRANSFER_STATUS.PENDING;
  if (status !== TRANSFER_STATUS.FAILED) return transferStatusPill(status);
  const meta = getTransferStatusMeta(status);
  return `<button class="transfer-status-pill ${meta.tone} transfer-status-button" type="button" data-transfer-action="open-transfer-failure" data-transfer-row-id="${escapeHtml(row.id)}" aria-haspopup="dialog" aria-label="查看传输失败原因：${escapeHtml(row.title)}" title="查看完整失败原因">${meta.label}</button>`;
}

function transferDecisionSummary(row) {
  const decision = row?.transferDecision;
  if (!decision) {
    if (row?.transferStatus === TRANSFER_STATUS.SUCCESS) return "历史传输成功 · 无动作快照";
    if (row?.transferStatus === TRANSFER_STATUS.FAILED) return row.transferErrorText || "历史传输失败 · 无动作快照";
    if (row?.transferStatus === TRANSFER_STATUS.NOT_REQUIRED) return "无需传输 · 等待持久化动作快照";
    return row?.transferDecisionSource === "unresolved" ? "等待后台策略判定" : "等待策略判定";
  }
  const prefix = row?.transferDecisionSource === "preview" ? "策略预览：" : "";
  if (decision.action === TRANSFER_ACTIONS.CHANNEL) {
    const channelNames = Array.isArray(decision.channelNames) ? decision.channelNames : [];
    return `${prefix}${decision.strategyName || "默认策略"} → ${channelNames.join("、") || "待选择通道"}`;
  }
  const reasonLabels = {
    transfer_disabled: "总开关关闭",
    legacy_baseline: "历史数据兜底 · 无需传输",
    strategy_no_channel: decision.strategyName || "无通道策略",
    strategy_channel_unavailable: `${decision.strategyName || "指定通道策略"} · 无可用通道`,
    default_channel_unavailable: "默认策略 · 无可用默认通道",
    no_matching_strategy: "没有可用策略"
  };
  return `${prefix}${reasonLabels[decision.reason] || decision.strategyName || "无需传输"}`;
}

function formatTransferTime(value) {
  const text = String(value || "").trim();
  if (!text) return "-";
  return text.replace("T", " ").replace(/\.\d{3}Z$/, "");
}

function transferOptionMarkup(options, value, emptyLabel) {
  return `<option value="__all__">${escapeHtml(emptyLabel)}</option>${options.map((option) => `
    <option value="${escapeHtml(option.value)}" ${option.value === value ? "selected" : ""}>${escapeHtml(option.label)}</option>
  `).join("")}`;
}

function transferDataFilterFields(rows) {
  const filters = state.transferDataFilters;
  const featureOptions = getTransferFilterOptions(rows, "featureId", "featureName");
  const platformOptions = getTransferFilterOptions(rows, "platformId", "platformName");
  const entityTypeOptions = getTransferFilterOptions(rows, "entityType", "entityTypeLabel");
  const contentTypeOptions = getTransferFilterOptions(rows, "contentType", "contentTypeLabel");
  const isOpen = state.transferDataFiltersOpen;

  return `
    <div class="transfer-toolbar">
      <label class="transfer-search-field">
        <span class="sr-only">搜索数据</span>
        <input type="search" placeholder="搜索标题、链接或功能" value="${escapeHtml(filters.query)}" data-transfer-filter="query" data-transfer-kind="data">
      </label>
      <div class="transfer-toolbar-actions">
        <button class="transfer-secondary-button" type="button" data-transfer-action="toggle-data-filters" aria-expanded="${isOpen}">${isOpen ? "收起筛选" : "展开筛选"}</button>
        <button class="transfer-icon-button" type="button" data-transfer-action="refresh-transfer" aria-label="刷新本地数据" title="刷新本地数据">刷新</button>
      </div>
    </div>
    <section class="transfer-filter-panel" ${isOpen ? "" : "hidden"} aria-label="数据筛选条件">
      <div class="transfer-filter-grid">
        <label><span>平台</span><select data-transfer-filter="platform" data-transfer-kind="data">${transferOptionMarkup(platformOptions, filters.platform, "全部平台")}</select></label>
        <label><span>功能</span><select data-transfer-filter="feature" data-transfer-kind="data">${transferOptionMarkup(featureOptions, filters.feature, "全部功能")}</select></label>
        <label><span>数据类型</span><select data-transfer-filter="entityType" data-transfer-kind="data">${transferOptionMarkup(entityTypeOptions, filters.entityType, "全部类型")}</select></label>
        <label><span>内容类型</span><select data-transfer-filter="contentType" data-transfer-kind="data">${transferOptionMarkup(contentTypeOptions, filters.contentType, "全部内容类型")}</select></label>
        <label><span>本地状态</span><select data-transfer-filter="localStatus" data-transfer-kind="data"><option value="__all__">全部本地状态</option><option value="stored" ${filters.localStatus === "stored" ? "selected" : ""}>本地已保存</option></select></label>
        <label><span>采集开始日期</span><input type="date" value="${escapeHtml(filters.dateStart)}" data-transfer-filter="dateStart" data-transfer-kind="data"></label>
        <label><span>采集结束日期</span><input type="date" value="${escapeHtml(filters.dateEnd)}" data-transfer-filter="dateEnd" data-transfer-kind="data"></label>
      </div>
      <footer class="transfer-filter-footer"><span>筛选仅影响当前数据列表；传输状态由上方状态页签切换。</span><button type="button" data-transfer-action="clear-data-filters">清空条件</button></footer>
    </section>
  `;
}

function transferDataStatusTabs(dataRows) {
  const countFilters = { ...state.transferDataFilters, transferStatus: "__all__" };
  const scopedRows = filterTransferDataRows(dataRows, countFilters);
  const activeStatus = state.transferDataFilters.transferStatus || "__all__";
  const tabs = [
    { value: "__all__", label: "全部" },
    { value: TRANSFER_STATUS.PENDING, label: "待传输" },
    { value: TRANSFER_STATUS.TRANSFERRING, label: "传输中" },
    { value: TRANSFER_STATUS.SUCCESS, label: "成功" },
    { value: TRANSFER_STATUS.FAILED, label: "失败" },
    { value: TRANSFER_STATUS.NOT_REQUIRED, label: "无需传输" }
  ];
  return `<nav class="transfer-status-tabs" aria-label="数据传输状态">
    ${tabs.map((tab) => {
      const count = tab.value === "__all__"
        ? scopedRows.length
        : scopedRows.filter((row) => row.transferStatus === tab.value).length;
      const isActive = activeStatus === tab.value;
      return `<button type="button" class="${isActive ? "active" : ""}" data-transfer-data-status="${tab.value}" aria-pressed="${isActive}">${tab.label}<span>${count}</span></button>`;
    }).join("")}
  </nav>`;
}

function transferPagination(kind, pageState) {
  if (pageState.total <= 0) return "";
  return `<footer class="transfer-pagination">
    <span>显示 ${pageState.start + 1}–${pageState.end} / ${pageState.total} 条</span>
    <div>
      <button type="button" data-transfer-action="${kind}-prev" ${pageState.currentPage <= 1 ? "disabled" : ""}>上一页</button>
      <span>${pageState.currentPage} / ${pageState.pageCount}</span>
      <button type="button" data-transfer-action="${kind}-next" ${pageState.currentPage >= pageState.pageCount ? "disabled" : ""}>下一页</button>
    </div>
  </footer>`;
}

function getSafeTransferDetailUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    return ["http:", "https:"].includes(url.protocol) ? url.href : "";
  } catch {
    return "";
  }
}

function renderTransferDetailValue(value) {
  if (value === null) return '<span class="transfer-data-detail-empty">null</span>';
  if (value === undefined || value === "") return '<span class="transfer-data-detail-empty">空值</span>';
  if (typeof value === "object") {
    let serialized = "";
    try {
      serialized = JSON.stringify(value, null, 2);
    } catch {
      serialized = String(value);
    }
    return `<pre>${escapeHtml(serialized)}</pre>`;
  }

  const text = String(value);
  const url = getSafeTransferDetailUrl(text);
  if (url) {
    return `<a href="${escapeHtml(url)}" target="_blank" rel="noreferrer">${escapeHtml(text)}</a>`;
  }
  if (text.includes("\n") || text.length > 180) return `<pre>${escapeHtml(text)}</pre>`;
  return `<span>${escapeHtml(text)}</span>`;
}

function mountTransferDetailDialog(backdrop, previousFocus) {
  const previousBodyOverflow = document.body.style.overflow;
  const close = () => {
    document.removeEventListener("keydown", handleKeydown, true);
    backdrop.remove();
    document.body.style.overflow = previousBodyOverflow;
    if (activeTransferDataDetailClose === close) activeTransferDataDetailClose = null;
    if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
  };
  const handleKeydown = (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [...backdrop.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
      .filter((element) => !element.hidden && element.getClientRects().length);
    if (!focusable.length) {
      event.preventDefault();
      backdrop.querySelector('[role="dialog"]')?.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop || event.target.closest("[data-transfer-detail-close]")) close();
  });
  document.addEventListener("keydown", handleKeydown, true);
  document.body.style.overflow = "hidden";
  document.body.append(backdrop);
  activeTransferDataDetailClose = close;
  globalThis.requestAnimationFrame?.(() => backdrop.querySelector("[data-transfer-detail-close]")?.focus());
}

function openTransferDataDetail(row) {
  if (!row || !globalThis.document?.body) return;
  activeTransferDataDetailClose?.();

  const canonical = row.canonical && typeof row.canonical === "object" && !Array.isArray(row.canonical) ? row.canonical : {};
  const raw = row.raw && typeof row.raw === "object" && !Array.isArray(row.raw) ? row.raw : {};
  const canonicalFields = Object.entries(canonical);
  const rawFields = Object.entries(raw).filter(([key]) => key !== "canonical");
  const transferFields = [
    ["totalAttemptCount", Number.isFinite(row.transferAttemptCount) ? row.transferAttemptCount : 0],
    ...(row.transferArchiveState && typeof row.transferArchiveState === "object"
      ? Object.entries(row.transferArchiveState).filter(([key]) => !["attemptCount", "totalAttemptCount", "attempts"].includes(key))
      : [
        ["status", row.transferStatus],
        ["action", transferDecisionSummary(row)],
        ["attemptAt", row.transferAttemptAt],
        ["completedAt", row.transferCompletedAt],
        ["updatedAt", row.transferUpdatedAt],
        ["error", row.transferError],
        ["deliveryUncertain", row.transferDeliveryUncertain],
        ["decision", row.transferDecision],
        ["channelResults", row.transferChannelResults]
      ])
  ];
  const previousFocus = document.activeElement;
  const titleId = `transferDataDetailTitle-${globalThis.crypto?.randomUUID?.() || Date.now()}`;
  const descriptionId = `transferDataDetailDescription-${globalThis.crypto?.randomUUID?.() || Date.now()}`;
  const backdrop = document.createElement("div");
  backdrop.className = "transfer-data-detail-backdrop";
  backdrop.dataset.transferDataDetail = "";
  backdrop.innerHTML = `
    <section class="transfer-data-detail-dialog" role="dialog" aria-modal="true" aria-labelledby="${titleId}" aria-describedby="${descriptionId}" tabindex="-1">
      <header class="transfer-data-detail-header">
        <div>
          <span>DATA DETAIL</span>
          <h2 id="${titleId}">数据详情</h2>
          <p id="${descriptionId}">${escapeHtml(row.platformName)} / ${escapeHtml(row.featureName)}</p>
        </div>
        <button type="button" data-transfer-detail-close>关闭</button>
      </header>
      <div class="transfer-data-detail-content">
        <section class="transfer-data-detail-summary" aria-label="数据标识">
          <strong>${escapeHtml(row.title)}</strong>
          ${getSafeTransferDetailUrl(row.identifier)
            ? `<a href="${escapeHtml(getSafeTransferDetailUrl(row.identifier))}" target="_blank" rel="noreferrer">${escapeHtml(row.identifier)}</a>`
            : `<code>${escapeHtml(row.identifier)}</code>`}
        </section>
        <section class="transfer-data-detail-section">
          <h3>${row.transferStatePersisted ? "传输执行快照" : "传输策略预览"}</h3>
          <p>${row.transferStatePersisted ? "展示后台持久化的实际动作、通道执行结果与时间；成功或失败状态不会套用当前的新策略。" : "网页预览环境按当前策略即时演示，不代表已经执行远程传输。"}</p>
          <dl class="transfer-data-detail-fields">
            ${transferFields.map(([key, value]) => `
              <div><dt><code>${escapeHtml(key)}</code></dt><dd>${renderTransferDetailValue(value)}</dd></div>
            `).join("")}
          </dl>
        </section>
        ${canonicalFields.length ? `
          <section class="transfer-data-detail-section">
            <h3>统一传输字段</h3>
            <p>包含标准实体字段、平台扩展字段和完整页面原文。</p>
            <dl class="transfer-data-detail-fields">
              ${canonicalFields.map(([key, value]) => `
                <div><dt><code>${escapeHtml(key)}</code></dt><dd>${renderTransferDetailValue(value)}</dd></div>
              `).join("")}
            </dl>
          </section>
        ` : ""}
        ${rawFields.length ? `
          <section class="transfer-data-detail-section">
            <h3>功能原始字段</h3>
            <p>保留功能页面当前使用的原始字段，便于兼容既有表格与导出。</p>
          <dl class="transfer-data-detail-fields">
            ${rawFields.map(([key, value]) => `
              <div>
                <dt><code>${escapeHtml(key)}</code></dt>
                <dd>${renderTransferDetailValue(value)}</dd>
              </div>
            `).join("")}
          </dl>
          </section>
        ` : '<div class="transfer-data-detail-no-fields">这条数据没有可展示的字段。</div>'}
      </div>
      <footer class="transfer-data-detail-footer">
        <span>统一字段 ${canonicalFields.length} 个 · 原始字段 ${rawFields.length} 个</span>
        <button type="button" data-transfer-detail-close>关闭详情</button>
      </footer>
    </section>
  `;
  mountTransferDetailDialog(backdrop, previousFocus);
}

function getTransferFailureChannelEntries(value) {
  if (Array.isArray(value)) {
    return value.map((result, index) => [result?.channelId || `channel-${index + 1}`, result]);
  }
  if (!value || typeof value !== "object") return [];
  return Object.entries(value);
}

function getTransferFailureSnapshot(row) {
  if (row?.transferArchiveState && typeof row.transferArchiveState === "object" && !Array.isArray(row.transferArchiveState)) {
    return row.transferArchiveState;
  }
  return {
    status: row?.transferStatus,
    action: row?.transferDecision?.action || "",
    reason: row?.transferDecision?.reason || "",
    featureId: row?.featureId || "",
    platformId: row?.platformId || "",
    decision: row?.transferDecision || null,
    channelResults: row?.transferChannelResults || {},
    attemptCount: Number.isFinite(row?.transferAttemptCount) ? row.transferAttemptCount : 0,
    error: row?.transferError || row?.transferErrorText || "",
    deliveryUncertain: row?.transferDeliveryUncertain === true,
    attemptedAt: row?.transferAttemptAt || "",
    completedAt: row?.transferCompletedAt || "",
    updatedAt: row?.transferUpdatedAt || ""
  };
}

function openTransferFailureDetail(row) {
  if (!row || row.transferStatus !== TRANSFER_STATUS.FAILED || !globalThis.document?.body) return;
  activeTransferDataDetailClose?.();

  const previousFocus = document.activeElement;
  const snapshot = getTransferFailureSnapshot(row);
  const rowChannelEntries = getTransferFailureChannelEntries(row.transferChannelResults);
  const channelEntries = rowChannelEntries.length
    ? rowChannelEntries
    : getTransferFailureChannelEntries(snapshot.channelResults);
  const primaryError = row.transferError || snapshot.error || row.transferErrorText || "未记录失败原因";
  const overviewFields = [
    ["recordKey", row.id],
    ["status", row.transferStatus],
    ["totalAttemptCount", Number.isFinite(row.transferAttemptCount) ? row.transferAttemptCount : 0],
    ["deliveryUncertain", row.transferDeliveryUncertain === true],
    ["firstAttemptAt", snapshot.attemptedAt || ""],
    ["lastAttemptAt", row.transferAttemptAt || snapshot.lastAttemptAt || ""],
    ["completedAt", row.transferCompletedAt || snapshot.completedAt || ""],
    ["updatedAt", row.transferUpdatedAt || snapshot.updatedAt || ""],
    ["decision", row.transferDecision || snapshot.decision || null]
  ];
  const titleId = `transferFailureDetailTitle-${globalThis.crypto?.randomUUID?.() || Date.now()}`;
  const descriptionId = `transferFailureDetailDescription-${globalThis.crypto?.randomUUID?.() || Date.now()}`;
  const backdrop = document.createElement("div");
  backdrop.className = "transfer-data-detail-backdrop transfer-failure-detail-backdrop";
  backdrop.dataset.transferFailureDetail = "";
  backdrop.innerHTML = `
    <section class="transfer-data-detail-dialog transfer-failure-detail-dialog" role="dialog" aria-modal="true" aria-labelledby="${titleId}" aria-describedby="${descriptionId}" tabindex="-1">
      <header class="transfer-data-detail-header transfer-failure-detail-header">
        <div>
          <span>TRANSFER FAILURE</span>
          <h2 id="${titleId}">传输失败详情</h2>
          <p id="${descriptionId}">${escapeHtml(row.platformName)} / ${escapeHtml(row.featureName)} · 展示当前本地已保存的完整失败快照</p>
        </div>
        <button type="button" data-transfer-detail-close>关闭</button>
      </header>
      <div class="transfer-data-detail-content">
        <section class="transfer-data-detail-summary transfer-failure-record-summary" aria-label="失败数据标识">
          <strong>${escapeHtml(row.title)}</strong>
          ${getSafeTransferDetailUrl(row.identifier)
            ? `<a href="${escapeHtml(getSafeTransferDetailUrl(row.identifier))}" target="_blank" rel="noreferrer">${escapeHtml(row.identifier)}</a>`
            : `<code>${escapeHtml(row.identifier)}</code>`}
        </section>
        <section class="transfer-failure-summary" aria-label="主要失败原因">
          <header><span class="transfer-status-pill error">失败</span><strong>主要失败原因</strong></header>
          <div class="transfer-failure-error">${renderTransferDetailValue(primaryError)}</div>
        </section>
        <section class="transfer-data-detail-section">
          <h3>失败概览</h3>
          <p>汇总这条数据的实际尝试次数、投递确定性、执行时间和命中策略。</p>
          <dl class="transfer-data-detail-fields">
            ${overviewFields.map(([key, value]) => `
              <div><dt><code>${escapeHtml(key)}</code></dt><dd>${renderTransferDetailValue(value)}</dd></div>
            `).join("")}
          </dl>
        </section>
        <section class="transfer-data-detail-section">
          <h3>通道执行结果</h3>
          <p>展示所有通道的完整执行字段；顶层错误仅为汇总，具体失败原因以各通道记录为准。</p>
          ${channelEntries.length ? `<div class="transfer-failure-channel-list">
            ${channelEntries.map(([channelKey, result], index) => {
              const detail = result && typeof result === "object" && !Array.isArray(result) ? result : { value: result };
              const label = detail.channelName || detail.channelId || channelKey || `通道 ${index + 1}`;
              return `<article class="transfer-failure-channel-card">
                <header>
                  <div><span>通道 ${index + 1}</span><strong>${escapeHtml(label)}</strong><code>${escapeHtml(channelKey)}</code></div>
                  ${transferStatusPill(detail.status || TRANSFER_STATUS.FAILED)}
                </header>
                <dl class="transfer-data-detail-fields">
                  ${Object.entries(detail).map(([key, value]) => `
                    <div><dt><code>${escapeHtml(key)}</code></dt><dd>${renderTransferDetailValue(value)}</dd></div>
                  `).join("")}
                </dl>
              </article>`;
            }).join("")}
          </div>` : '<div class="transfer-data-detail-no-fields">这条失败记录没有保存通道执行结果。</div>'}
        </section>
        <section class="transfer-data-detail-section">
          <h3>完整失败快照</h3>
          <p>按原始字段展示本地归档内容，不再应用列表中的单行省略。</p>
          <div class="transfer-failure-raw">${renderTransferDetailValue(snapshot)}</div>
        </section>
      </div>
      <footer class="transfer-data-detail-footer">
        <span>通道 ${channelEntries.length} 个 · 实际尝试 ${Number.isFinite(row.transferAttemptCount) ? row.transferAttemptCount : 0} 次</span>
        <button type="button" data-transfer-detail-close>关闭详情</button>
      </footer>
    </section>
  `;
  mountTransferDetailDialog(backdrop, previousFocus);
}

function transferDataTable(rows, pageState) {
  const body = rows.length ? rows.map((row) => `
    <tr>
      <td><span class="transfer-platform-name">${escapeHtml(row.platformName)}</span></td>
      <td>${escapeHtml(row.featureName)}</td>
      <td>${escapeHtml(row.entityTypeLabel || row.entityType || "-")}${row.contentTypeLabel ? `<small class="transfer-content-type">${escapeHtml(row.contentTypeLabel)}</small>` : ""}</td>
      <td class="transfer-primary-cell"><button class="transfer-data-identifier" type="button" data-transfer-action="open-data-detail" data-transfer-row-id="${escapeHtml(row.id)}" aria-haspopup="dialog" aria-label="查看数据详情：${escapeHtml(row.title)}"><strong>${escapeHtml(row.title)}</strong><small>${escapeHtml(row.identifier)}</small></button></td>
      <td><time>${escapeHtml(formatTransferTime(row.collectedAt))}</time></td>
      <td><span class="transfer-local-status">本地已保存</span></td>
      <td class="transfer-attempt-count" title="${row.transferAttemptAt ? `最近尝试 ${escapeHtml(formatTransferTime(row.transferAttemptAt))}` : "尚未尝试"}"><strong>${escapeHtml(Number.isFinite(row.transferAttemptCount) ? row.transferAttemptCount : 0)}</strong><small>各通道合计</small></td>
      <td class="transfer-action-cell">${transferStatusControl(row)}<small title="${escapeHtml([transferDecisionSummary(row), row.transferErrorText, row.transferAttemptAt ? `最近尝试 ${formatTransferTime(row.transferAttemptAt)}` : ""].filter(Boolean).join(" · "))}">${escapeHtml(transferDecisionSummary(row))}${row.transferErrorText ? ` · ${escapeHtml(row.transferErrorText)}` : ""}</small></td>
    </tr>
  `).join("") : `<tr><td class="transfer-empty-cell" colspan="8">没有符合当前条件的数据。</td></tr>`;
  return `
    <div class="transfer-table-shell" tabindex="0">
      <table class="transfer-table transfer-data-table">
        <thead><tr><th>平台</th><th>功能</th><th>类型</th><th>标题 / 唯一标识</th><th>采集时间</th><th>本地状态</th><th title="各通道实际尝试次数之和">传输次数</th><th>传输状态 / 动作</th></tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>
    ${transferPagination("data", pageState)}
  `;
}

function transferSummaryLabel(rows) {
  const total = rows.length;
  const counts = rows.reduce((result, row) => {
    const status = row.transferStatus || TRANSFER_STATUS.PENDING;
    result[status] = (result[status] || 0) + 1;
    return result;
  }, {});
  const orderedStatuses = [TRANSFER_STATUS.PENDING, TRANSFER_STATUS.TRANSFERRING, TRANSFER_STATUS.SUCCESS, TRANSFER_STATUS.FAILED, TRANSFER_STATUS.NOT_REQUIRED]
    .filter((status) => counts[status]);
  return `<div class="transfer-list-summary"><strong>数据 ${total} 条</strong>${orderedStatuses.map((status) => {
    const meta = getTransferStatusMeta(status);
    return `<span class="${meta.tone}">${meta.label} ${counts[status]}</span>`;
  }).join("")}</div>`;
}

function transferSettingsNotice() {
  if (!state.transferSettingsNotice) return "";
  return `<div class="transfer-settings-notice ${escapeHtml(state.transferSettingsNotice.tone)}" role="status">${escapeHtml(state.transferSettingsNotice.text)}</div>`;
}

function transferSettingsTemplate(settings) {
  const defaults = getDefaultTransferSettings();
  const enabled = settings.enabled === true;
  const retryCount = Number.isInteger(Number(settings.retryCount)) ? Number(settings.retryCount) : Number(defaults.retryCount ?? DEFAULT_TRANSFER_RETRY_COUNT);
  const batchSize = Number.isInteger(Number(settings.batchSize)) ? Number(settings.batchSize) : Number(defaults.batchSize ?? DEFAULT_TRANSFER_BATCH_SIZE);
  const channels = Array.isArray(settings.channels) ? settings.channels : [];
  const readyChannels = channels.filter((channel) => channel.enabled).length;
  const strategies = Array.isArray(settings.strategies) ? settings.strategies : getDefaultTransferSettings().strategies;
  const readyStrategies = strategies.filter((strategy) => strategy.enabled).length;
  return `
    <section class="transfer-config-page" aria-label="传输设置">
      ${transferSettingsNotice()}
      <header class="transfer-config-header">
        <div>
          <span>TRANSFER SETTINGS</span>
          <h2>传输设置</h2>
          <p>统一控制所有功能的数据传输动作。关闭时全部标记为无需传输；开启后按策略匹配并绑定目标通道。</p>
        </div>
        <span class="transfer-config-state ${enabled ? "enabled" : "disabled"}">${enabled ? "已开启" : "默认关闭"}</span>
      </header>
      <article class="transfer-setting-card">
        <div class="transfer-setting-card-copy">
          <strong>开启数据传输</strong>
          <p>开启后仅对新采集数据按策略执行；启用前已有的数据保守归入无需传输。关闭时停止后续路由，并统一显示为无需传输。</p>
        </div>
        <label class="transfer-switch">
          <input type="checkbox" data-transfer-setting="enabled" ${enabled ? "checked" : ""}>
          <span aria-hidden="true"></span>
          <b>${enabled ? "开启" : "关闭"}</b>
        </label>
      </article>
      ${enabled ? `
        <section class="transfer-execution-settings" aria-labelledby="transferExecutionSettingsTitle">
          <header>
            <div>
              <strong id="transferExecutionSettingsTitle">执行参数</strong>
              <p>仅在数据传输开启时生效；修改后会重新同步后台传输控制器。</p>
            </div>
          </header>
          <div class="transfer-execution-setting-grid">
            <label>
              <span>重试次数</span>
              <input type="number" min="${MIN_TRANSFER_RETRY_COUNT}" max="${MAX_TRANSFER_RETRY_COUNT}" step="1" required inputmode="numeric" value="${escapeHtml(retryCount)}" data-transfer-setting="retryCount">
              <small>首次失败后的额外重试次数，范围 ${MIN_TRANSFER_RETRY_COUNT}–${MAX_TRANSFER_RETRY_COUNT}；默认 ${DEFAULT_TRANSFER_RETRY_COUNT}，即单通道最多尝试 ${DEFAULT_TRANSFER_RETRY_COUNT + 1} 次。</small>
            </label>
            <label>
              <span>批量条数</span>
              <input type="number" min="${MIN_TRANSFER_BATCH_SIZE}" max="${MAX_TRANSFER_BATCH_SIZE}" step="1" required inputmode="numeric" value="${escapeHtml(batchSize)}" data-transfer-setting="batchSize">
              <small>单次请求最多包含的数据条数，范围 ${MIN_TRANSFER_BATCH_SIZE}–${MAX_TRANSFER_BATCH_SIZE}，默认 ${DEFAULT_TRANSFER_BATCH_SIZE}；不足一批会立即发送，不等待凑满。</small>
            </label>
          </div>
        </section>
      ` : ""}
      <section class="transfer-setting-overview">
        <article>
          <span>通道</span>
          <strong>${channels.length}</strong>
          <small>已保存的传输通道</small>
        </article>
        <article>
          <span>可用通道</span>
          <strong>${readyChannels}</strong>
          <small>通道自身处于启用状态</small>
        </article>
        <article>
          <span>策略</span>
          <strong>${strategies.length}</strong>
          <small>${readyStrategies} 条已开启，包含默认策略</small>
        </article>
      </section>
    </section>
  `;
}

function getChannelConfigurationSummary(channel) {
  if (channel.type === TRANSFER_CHANNEL_TYPES.MONGODB) {
    const database = channel.config?.database || "未填写数据库";
    const collection = channel.config?.collection || "未填写集合";
    return `<strong>${escapeHtml(database)} / ${escapeHtml(collection)}</strong><small>${channel.config?.connectionString ? "已填写连接串" : "未填写连接串"}</small>`;
  }
  const endpoint = channel.config?.endpoint || "未填写 POST 地址";
  return `<strong>POST</strong><small>${escapeHtml(endpoint)}</small>`;
}

function transferChannelEditorTemplate(editor) {
  const channel = editor.channel;
  const isMongo = channel.type === TRANSFER_CHANNEL_TYPES.MONGODB;
  const titleId = "transferChannelEditorTitle";
  const descriptionId = "transferChannelEditorDescription";
  const channelTypes = [
    TRANSFER_CHANNEL_TYPES.API,
    TRANSFER_CHANNEL_TYPES.MONGODB,
    TRANSFER_CHANNEL_TYPES.DINGTALK_WEBHOOK,
    TRANSFER_CHANNEL_TYPES.FEISHU_WEBHOOK,
    TRANSFER_CHANNEL_TYPES.WECHAT_WORK_WEBHOOK
  ];
  return `
    <div class="transfer-channel-modal-backdrop" data-transfer-channel-modal>
      <section class="transfer-channel-editor transfer-channel-dialog" role="dialog" aria-modal="true" aria-labelledby="${titleId}" aria-describedby="${descriptionId}">
        <header>
          <div>
            <span>${editor.mode === "edit" ? "EDIT CHANNEL" : "NEW CHANNEL"}</span>
            <h3 id="${titleId}">${editor.mode === "edit" ? "编辑通道" : "新增通道"}</h3>
            <p id="${descriptionId}">${isMongo ? "MongoDB 配置仅作服务端适配预留，浏览器扩展不会直接连接数据库。" : "保存时会申请该 API 域名的访问权限；只对保存后新增并命中策略的数据执行 POST。"}</p>
          </div>
          <button type="button" class="transfer-secondary-button" data-transfer-action="cancel-channel-editor">取消</button>
        </header>
        <div class="transfer-channel-editor-body">
          ${transferSettingsNotice()}
          <div class="transfer-channel-type-picker" aria-label="通道类型">
            ${channelTypes.map((type) => {
              const available = isTransferChannelTypeAvailable(type);
              const selected = channel.type === type;
              return `<button type="button" class="${selected ? "active" : ""}" data-transfer-channel-type="${type}" ${available ? "" : "disabled"}>${escapeHtml(getTransferChannelTypeLabel(type))}${available ? "" : "<small>即将支持</small>"}</button>`;
            }).join("")}
          </div>
          <div class="transfer-channel-form-grid">
            <label><span>通道名称</span><input type="text" maxlength="80" placeholder="例如：生产归档 API" value="${escapeHtml(channel.name)}" data-transfer-channel-field="name"></label>
            <label class="transfer-channel-enabled"><span>通道状态</span><select data-transfer-channel-field="enabled"><option value="true" ${channel.enabled ? "selected" : ""}>启用</option><option value="false" ${!channel.enabled ? "selected" : ""}>停用</option></select></label>
            ${isMongo ? `
              <label class="transfer-channel-span-2"><span>MongoDB 连接串</span><input type="password" autocomplete="off" placeholder="mongodb+srv://user:password@cluster.example.com" value="${escapeHtml(channel.config?.connectionString)}" data-transfer-channel-field="config.connectionString"></label>
              <label><span>数据库</span><input type="text" placeholder="browser_core_claw" value="${escapeHtml(channel.config?.database)}" data-transfer-channel-field="config.database"></label>
              <label><span>集合</span><input type="text" placeholder="records" value="${escapeHtml(channel.config?.collection)}" data-transfer-channel-field="config.collection"></label>
            ` : `
              <label class="transfer-channel-span-2"><span>POST 请求地址</span><input type="url" placeholder="https://api.example.com/v1/archive" value="${escapeHtml(channel.config?.endpoint)}" data-transfer-channel-field="config.endpoint"></label>
              <label class="transfer-channel-span-2"><span>请求头（JSON，可选）</span><textarea rows="4" placeholder='{"Authorization":"Bearer &lt;token&gt;"}' data-transfer-channel-field="config.headers">${escapeHtml(channel.config?.headers)}</textarea></label>
              <aside class="transfer-api-example"><strong>POST 示例</strong><code>POST https://api.example.com/v1/archive</code><pre>{ "records": [/* 统一数据字段 */] }</pre></aside>
            `}
          </div>
        </div>
        <footer>
          <span>${isMongo ? "当前执行器不支持直连 MongoDB，请使用 HTTPS API 中转。" : "将以 application/json 发送统一数据字段。"}</span>
          <button type="button" class="transfer-primary-button" data-transfer-action="save-channel">保存通道</button>
        </footer>
      </section>
    </div>
  `;
}

function transferChannelsTemplate(settings) {
  const channels = Array.isArray(settings.channels) ? settings.channels : [];
  const rows = channels.length ? channels.map((channel) => `
    <tr>
      <td class="transfer-channel-name"><span><strong>${escapeHtml(channel.name)}</strong>${channel.isDefault ? '<b class="transfer-channel-default">默认</b>' : ""}</span><small>${escapeHtml(channel.id)}</small></td>
      <td><span class="transfer-channel-type">${escapeHtml(getTransferChannelTypeLabel(channel.type))}</span></td>
      <td class="transfer-channel-summary">${getChannelConfigurationSummary(channel)}</td>
      <td><span class="transfer-channel-state ${channel.enabled ? "enabled" : "disabled"}">${channel.enabled ? "已启用" : "已停用"}</span></td>
      <td><time>${escapeHtml(formatTransferTime(channel.updatedAt))}</time></td>
      <td class="transfer-channel-actions"><button type="button" data-transfer-action="edit-channel" data-transfer-channel-id="${escapeHtml(channel.id)}">编辑</button>${channel.isDefault ? "" : `<button type="button" data-transfer-action="set-default-channel" data-transfer-channel-id="${escapeHtml(channel.id)}">设为默认</button>`}<button type="button" data-transfer-action="toggle-channel" data-transfer-channel-id="${escapeHtml(channel.id)}">${channel.enabled ? "停用" : "启用"}</button><button type="button" class="danger" data-transfer-action="remove-channel" data-transfer-channel-id="${escapeHtml(channel.id)}">删除</button></td>
    </tr>
  `).join("") : `<tr><td class="transfer-empty-cell" colspan="6">暂未配置通道。API 通道可执行传输；MongoDB 配置需由服务端适配器接入。</td></tr>`;
  return `
    <section class="transfer-config-page" aria-label="传输通道">
      ${state.transferChannelEditor ? "" : transferSettingsNotice()}
      <header class="transfer-config-header transfer-channel-page-header">
        <div>
          <span>TRANSFER CHANNELS</span>
          <h2>通道</h2>
          <p>API 通道会接收命中策略的新数据；MongoDB 连接串仅保存为适配器配置，浏览器端不会直接连接。钉钉、飞书、企微 Webhook 先保留扩展位。</p>
        </div>
        <button type="button" class="transfer-primary-button" data-transfer-action="new-channel">新增通道</button>
      </header>
      ${state.transferChannelEditor ? transferChannelEditorTemplate(state.transferChannelEditor) : ""}
      <div class="transfer-table-shell" tabindex="0">
        <table class="transfer-table transfer-channel-table">
          <thead><tr><th>通道名称</th><th>类型</th><th>配置摘要</th><th>状态</th><th>更新时间</th><th>操作</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </section>
  `;
}

function getTransferStrategyDataOptions() {
  const features = getTransferFeatureDescriptors();
  const platformMap = new Map();
  features.forEach((feature) => {
    if (!platformMap.has(feature.platformId)) {
      platformMap.set(feature.platformId, {
        id: feature.platformId,
        name: feature.platformName,
        featureCount: 0
      });
    }
    platformMap.get(feature.platformId).featureCount += 1;
  });
  return {
    platforms: [...platformMap.values()],
    features: features.map((feature) => ({
      id: feature.featureId,
      name: feature.featureName,
      platformId: feature.platformId,
      platformName: feature.platformName
    }))
  };
}

function transferStrategyDataSummary(strategy, dataOptions) {
  if (isBuiltInTransferStrategy(strategy)) {
    return "<strong>全部未匹配数据</strong><small>未命中其他启用策略时兜底</small>";
  }
  const platformNames = strategy.platformIds.map((platformId) => (
    dataOptions.platforms.find((platform) => platform.id === platformId)?.name || platformId
  ));
  const featureNames = strategy.featureIds.map((featureId) => (
    dataOptions.features.find((feature) => feature.id === featureId)?.name || featureId
  ));
  return `<strong>${platformNames.length} 个平台 / ${featureNames.length} 个功能</strong><small>${escapeHtml(platformNames.join("、") || "未选择平台")} · ${escapeHtml(featureNames.join("、") || "未选择功能")}</small>`;
}

function transferStrategyChannelSummary(strategy, channels) {
  if (isBuiltInTransferStrategy(strategy)) {
    const defaultChannel = channels.find((channel) => channel.isDefault);
    return defaultChannel
      ? `<strong>${escapeHtml(defaultChannel.name)}</strong><small>动态绑定当前默认通道</small>`
      : "<strong>默认通道未配置</strong><small>新增首个通道后自动绑定</small>";
  }
  if (strategy.type === TRANSFER_STRATEGY_TYPES.NO_CHANNEL) {
    return "<strong>不进入通道</strong><small>匹配数据将停止传输</small>";
  }
  const channelIds = resolveTransferStrategyChannelIds(strategy, channels);
  const channelNames = channelIds.map((channelId) => (
    channels.find((channel) => channel.id === channelId)?.name || channelId
  ));
  return `<strong>${channelNames.length ? `${channelNames.length} 个指定通道` : "未绑定通道"}</strong><small>${escapeHtml(channelNames.join("、") || "请编辑策略后选择通道")}</small>`;
}

function transferStrategyMultiSelect({ kind, label, options, selectedIds, emptyText, disabled, openPicker }) {
  const selected = new Set(selectedIds || []);
  const selectedOptions = options.filter((option) => selected.has(option.id));
  const summary = selectedOptions.length
    ? `已选择 ${selectedOptions.length} 项`
    : emptyText;
  return `
    <div class="transfer-strategy-field">
      <span>${escapeHtml(label)}</span>
      <details class="transfer-strategy-multiselect ${disabled ? "is-disabled" : ""}" name="transfer-strategy-picker" ${openPicker === kind && !disabled ? "open" : ""} ${disabled ? 'aria-disabled="true"' : ""}>
        <summary><span>${escapeHtml(summary)}</span><b aria-hidden="true">⌄</b></summary>
        <div class="transfer-strategy-options">
          ${options.length ? options.map((option) => `
            <label>
              <input type="checkbox" value="${escapeHtml(option.id)}" data-transfer-strategy-choice="${escapeHtml(kind)}" ${selected.has(option.id) ? "checked" : ""}>
              <span><strong>${escapeHtml(option.name)}</strong>${option.meta ? `<small>${escapeHtml(option.meta)}</small>` : ""}</span>
            </label>
          `).join("") : `<p>${escapeHtml(disabled ? emptyText : "暂无可选项")}</p>`}
        </div>
      </details>
      ${selectedOptions.length ? `<small>${escapeHtml(selectedOptions.map((option) => option.name).join("、"))}</small>` : ""}
    </div>
  `;
}

function transferStrategyEditorTemplate(editor, settings) {
  const strategy = editor.strategy;
  const dataOptions = getTransferStrategyDataOptions();
  const selectedPlatforms = new Set(strategy.platformIds);
  const featureOptions = dataOptions.features
    .filter((feature) => selectedPlatforms.has(feature.platformId))
    .map((feature) => ({ id: feature.id, name: feature.name, meta: feature.platformName }));
  const channelOptions = settings.channels.map((channel) => ({
    id: channel.id,
    name: channel.name,
    meta: `${getTransferChannelTypeLabel(channel.type)} · ${channel.enabled ? "已启用" : "已停用"}${channel.isDefault ? " · 当前默认" : ""}`
  }));
  const isChannelStrategy = strategy.type === TRANSFER_STRATEGY_TYPES.CHANNEL;
  const titleId = "transferStrategyEditorTitle";
  const descriptionId = "transferStrategyEditorDescription";
  return `
    <div class="transfer-channel-modal-backdrop" data-transfer-strategy-modal>
      <section class="transfer-channel-editor transfer-channel-dialog transfer-strategy-dialog" role="dialog" aria-modal="true" aria-labelledby="${titleId}" aria-describedby="${descriptionId}">
        <header>
          <div>
            <span>${editor.mode === "edit" ? "EDIT STRATEGY" : "NEW STRATEGY"}</span>
            <h3 id="${titleId}">${editor.mode === "edit" ? "编辑策略" : "新增策略"}</h3>
            <p id="${descriptionId}">先按策略类型层级匹配；同类型内按数值优先级从大到小命中。</p>
          </div>
          <button type="button" class="transfer-secondary-button" data-transfer-action="cancel-strategy-editor">取消</button>
        </header>
        <div class="transfer-channel-editor-body transfer-strategy-editor-body">
          ${transferSettingsNotice()}
          <div class="transfer-strategy-form-grid">
            <label class="transfer-strategy-name-field"><span>策略名称</span><input type="text" maxlength="80" placeholder="例如：重点数据不传输" value="${escapeHtml(strategy.name)}" data-transfer-strategy-field="name"></label>
            <label class="transfer-strategy-priority-field"><span>优先级</span><input type="number" min="0" max="${MAX_TRANSFER_STRATEGY_PRIORITY}" step="1" inputmode="numeric" value="${escapeHtml(strategy.priority ?? 0)}" data-transfer-strategy-field="priority"><small>同类型内数值越大越先命中</small></label>
            <div class="transfer-strategy-status-field">
              <span>状态</span>
              <label class="transfer-switch"><input type="checkbox" data-transfer-strategy-field="enabled" ${strategy.enabled ? "checked" : ""}><span aria-hidden="true"></span><b>${strategy.enabled ? "开启" : "关闭"}</b></label>
            </div>
            <section class="transfer-strategy-form-section" aria-labelledby="strategy-data-title">
              <header><strong id="strategy-data-title">选择数据</strong><small>平台与功能支持多选；功能选项会随平台联动。</small></header>
              <div class="transfer-strategy-linked-fields">
                ${transferStrategyMultiSelect({
                  kind: "platform",
                  label: "平台",
                  options: dataOptions.platforms.map((platform) => ({ id: platform.id, name: platform.name, meta: `${platform.featureCount} 个功能` })),
                  selectedIds: strategy.platformIds,
                  emptyText: "请选择平台",
                  disabled: false,
                  openPicker: editor.openPicker
                })}
                ${transferStrategyMultiSelect({
                  kind: "feature",
                  label: "功能",
                  options: featureOptions,
                  selectedIds: strategy.featureIds,
                  emptyText: selectedPlatforms.size ? "请选择功能" : "请先选择平台",
                  disabled: !selectedPlatforms.size,
                  openPicker: editor.openPicker
                })}
              </div>
            </section>
            <section class="transfer-strategy-form-section" aria-labelledby="strategy-type-title">
              <header><strong id="strategy-type-title">策略类型</strong><small>类型决定命中数据后的处理方式与优先级。</small></header>
              <div class="transfer-strategy-type-options">
                <label class="${strategy.type === TRANSFER_STRATEGY_TYPES.NO_CHANNEL ? "is-selected" : ""}">
                  <input type="radio" name="transfer-strategy-type" value="${TRANSFER_STRATEGY_TYPES.NO_CHANNEL}" data-transfer-strategy-field="type" ${strategy.type === TRANSFER_STRATEGY_TYPES.NO_CHANNEL ? "checked" : ""}>
                  <span><strong>无通道</strong><small>命中后不传输，优先级最高</small></span>
                </label>
                <label class="${isChannelStrategy ? "is-selected" : ""}">
                  <input type="radio" name="transfer-strategy-type" value="${TRANSFER_STRATEGY_TYPES.CHANNEL}" data-transfer-strategy-field="type" ${isChannelStrategy ? "checked" : ""}>
                  <span><strong>通道</strong><small>发送到指定通道，优先级第二</small></span>
                </label>
              </div>
            </section>
            ${isChannelStrategy ? `<section class="transfer-strategy-form-section" aria-labelledby="strategy-channel-title">
              <header><strong id="strategy-channel-title">通道选择</strong><small>支持多选；停用通道仍可配置，但执行前需要先启用。</small></header>
              ${transferStrategyMultiSelect({
                kind: "channel",
                label: "指定通道",
                options: channelOptions,
                selectedIds: strategy.channelIds,
                emptyText: channelOptions.length ? "请选择通道" : "请先新增通道",
                disabled: !channelOptions.length,
                openPicker: editor.openPicker
              })}
            </section>` : ""}
          </div>
        </div>
        <footer>
          <span>类型层级：<strong>${escapeHtml(getTransferStrategyPriorityLabel(strategy))}</strong> · 同级优先级：<strong>${escapeHtml(normalizeTransferStrategyPriority(strategy.priority))}</strong></span>
          <button type="button" class="transfer-primary-button" data-transfer-action="save-strategy">保存策略</button>
        </footer>
      </section>
    </div>
  `;
}

function transferStrategiesTemplate(settings) {
  const strategies = [...(settings.strategies?.length ? settings.strategies : getDefaultTransferSettings().strategies)]
    .sort(compareTransferStrategies);
  const dataOptions = getTransferStrategyDataOptions();
  const rows = strategies.map((strategy) => {
    const builtIn = isBuiltInTransferStrategy(strategy);
    const priority = getTransferStrategyPriority(strategy);
    return `
      <tr class="${builtIn ? "is-built-in" : ""}">
        <td class="transfer-strategy-name"><span><strong>${escapeHtml(strategy.name)}</strong>${builtIn ? '<b class="transfer-strategy-built-in">系统内置</b>' : ""}</span><small>${escapeHtml(strategy.id)}</small></td>
        <td class="transfer-strategy-data">${transferStrategyDataSummary(strategy, dataOptions)}</td>
        <td><span class="transfer-strategy-type ${strategy.type === TRANSFER_STRATEGY_TYPES.NO_CHANNEL ? "no-channel" : "channel"}">${escapeHtml(getTransferStrategyTypeLabel(strategy))}</span></td>
        <td class="transfer-strategy-channel">${transferStrategyChannelSummary(strategy, settings.channels)}</td>
        <td><span class="transfer-strategy-priority priority-${priority}">${escapeHtml(getTransferStrategyPriorityLabel(strategy))}</span></td>
        <td class="transfer-strategy-manual-priority"><strong>${escapeHtml(normalizeTransferStrategyPriority(strategy.priority))}</strong><small>${builtIn ? "系统固定" : "数值越大越优先"}</small></td>
        <td><span class="transfer-channel-state ${strategy.enabled ? "enabled" : "disabled"}">${strategy.enabled ? "已开启" : "已关闭"}</span></td>
        <td class="transfer-channel-actions">${builtIn
          ? '<span class="transfer-strategy-locked">不可编辑 · 不可删除</span>'
          : `<button type="button" data-transfer-action="edit-strategy" data-transfer-strategy-id="${escapeHtml(strategy.id)}">编辑</button><button type="button" data-transfer-action="toggle-strategy" data-transfer-strategy-id="${escapeHtml(strategy.id)}">${strategy.enabled ? "停用" : "启用"}</button><button type="button" class="danger" data-transfer-action="remove-strategy" data-transfer-strategy-id="${escapeHtml(strategy.id)}">删除</button>`}</td>
      </tr>
    `;
  }).join("");
  return `
    <section class="transfer-config-page transfer-strategy-page" aria-label="传输策略">
      ${state.transferStrategyEditor ? "" : transferSettingsNotice()}
      <header class="transfer-config-header transfer-channel-page-header">
        <div>
          <span>TRANSFER STRATEGIES</span>
          <h2>策略列表</h2>
          <p>先按无通道、指定通道、默认通道的类型层级匹配；同类型内再按数值优先级从大到小命中。</p>
        </div>
        <button type="button" class="transfer-primary-button" data-transfer-action="new-strategy">新增策略</button>
      </header>
      <div class="transfer-strategy-priority-guide" aria-label="策略优先级说明">
        <span>类型层级</span>
        <div><strong>1</strong><b>无通道</b><small>最高 · 命中后不传输</small></div>
        <i aria-hidden="true">→</i>
        <div><strong>2</strong><b>指定通道</b><small>第二 · 发送到所选通道</small></div>
        <i aria-hidden="true">→</i>
        <div><strong>3</strong><b>默认通道</b><small>最低 · 系统兜底策略</small></div>
      </div>
      ${state.transferStrategyEditor ? transferStrategyEditorTemplate(state.transferStrategyEditor, settings) : ""}
      <div class="transfer-table-shell" tabindex="0">
        <table class="transfer-table transfer-strategy-table">
          <thead><tr><th>策略名称</th><th>选择数据</th><th>策略类型</th><th>通道绑定</th><th>类型层级</th><th>优先级</th><th>状态</th><th>操作</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </section>
  `;
}

function transferWorkspaceTemplate() {
  if (state.transferLoading && !state.transferWorkspace) {
    return '<section class="transfer-loading" aria-live="polite">正在读取各功能的本地存储…</section>';
  }

  const workspace = state.transferWorkspace || { isPreview: false, dataRows: [], taskRows: [] };
  const settings = state.transferSettings || getDefaultTransferSettings();
  const dataRows = applyTransferStrategiesToRows(workspace.dataRows, settings, {
    preferPersisted: !workspace.isPreview,
    preview: workspace.isPreview
  });
  const filteredDataRows = filterTransferDataRows(dataRows, state.transferDataFilters);
  const dataPage = paginateTransferRows(filteredDataRows, state.transferDataPage, 20);
  state.transferDataPage = dataPage.currentPage;
  const activeTab = ["data", "settings", "channels", "strategies"].includes(state.transferTab) ? state.transferTab : "data";
  const notice = state.transferNotice
    ? `<div class="transfer-notice ${escapeHtml(state.transferNotice.tone)}" role="status">${escapeHtml(state.transferNotice.text)}</div>`
    : `<div class="transfer-notice ${workspace.isPreview ? "info" : "neutral"}" role="status">${workspace.isPreview ? "网页预览展示示例数据，并按当前策略实时演示传输动作。" : "已读取后台持久化的传输状态与动作快照；刷新会读取最新执行结果，并为尚无快照的历史数据建立无需传输基线。"}</div>`;
  const content = activeTab === "data" ? `
    ${transferDataStatusTabs(dataRows)}
    <section class="transfer-content" role="tabpanel">
      <header class="transfer-content-header">
        <div>
          <h2>所有本地数据</h2>
          <p>按平台、功能、数据类型和采集时间筛选；传输状态通过上方页签切换。</p>
        </div>
        <span class="transfer-readonly-note">${settings.enabled ? "策略路由已开启" : "总开关关闭 · 全部无需传输"}</span>
      </header>
      ${transferDataFilterFields(dataRows)}
      ${transferSummaryLabel(filteredDataRows)}
      ${transferDataTable(dataPage.items, dataPage)}
    </section>
  ` : activeTab === "settings"
    ? transferSettingsTemplate(settings)
    : activeTab === "channels"
      ? transferChannelsTemplate(settings)
      : transferStrategiesTemplate(settings);

  return `
    <section class="transfer-workspace" aria-label="数据传输工作台">
      ${notice}
      <div class="transfer-tabs" role="tablist" aria-label="数据传输内容">
        <button type="button" role="tab" aria-selected="${activeTab === "data"}" class="${activeTab === "data" ? "active" : ""}" data-transfer-tab="data">数据 <span>${dataRows.length}</span></button>
        <button type="button" role="tab" aria-selected="${activeTab === "settings"}" class="${activeTab === "settings" ? "active" : ""}" data-transfer-tab="settings">设置</button>
        <button type="button" role="tab" aria-selected="${activeTab === "channels"}" class="${activeTab === "channels" ? "active" : ""}" data-transfer-tab="channels">通道 <span>${settings.channels.length}</span></button>
        <button type="button" role="tab" aria-selected="${activeTab === "strategies"}" class="${activeTab === "strategies" ? "active" : ""}" data-transfer-tab="strategies">策略 <span>${settings.strategies?.length || getDefaultTransferSettings().strategies.length}</span></button>
      </div>
      ${content}
    </section>
  `;
}

function renderTransfer() {
  const root = document.getElementById("transferRoot");
  if (root) root.innerHTML = transferWorkspaceTemplate();
  document.body.classList.toggle("has-transfer-channel-modal", Boolean(state.transferChannelEditor));
  document.body.classList.toggle("has-transfer-strategy-modal", Boolean(state.transferStrategyEditor));
}

async function refreshTransferWorkspace({ reconcile = true } = {}) {
  state.transferLoading = true;
  state.transferNotice = null;
  if (state.activePage === "transfer") renderTransfer();
  let reconcileError = null;
  try {
    if (reconcile) {
      try {
        await requestTransferDataReconcile();
      } catch (error) {
        reconcileError = error;
      }
    }
    const [workspace, transferSettings] = await Promise.all([
      loadTransferWorkspace(getTransferFeatureDescriptors()),
      loadTransferSettings()
    ]);
    state.transferWorkspace = workspace;
    state.transferSettings = transferSettings;
    lastPersistedTransferSettings = transferSettings;
    if (reconcileError) {
      state.transferNotice = { tone: "error", text: `已读取本地传输快照，但后台策略同步失败：${reconcileError.message || String(reconcileError)}` };
    }
  } catch (error) {
    state.transferWorkspace = { isPreview: false, dataRows: [], taskRows: [], loadedAt: "" };
    state.transferNotice = { tone: "error", text: `读取本地数据失败：${error.message || String(error)}` };
  } finally {
    state.transferLoading = false;
    if (state.activePage === "transfer") renderTransfer();
  }
}

function cloneTransferChannel(channel) {
  return {
    ...channel,
    config: { ...(channel?.config || {}) }
  };
}

function focusTransferChannelEditor(selector = "[data-transfer-channel-field='name']") {
  const focus = () => document.querySelector(selector)?.focus();
  focus();
  globalThis.requestAnimationFrame?.(focus);
}

function focusTransferChannelTrigger(editor) {
  const focus = () => {
    const selector = editor?.mode === "edit" ? "[data-transfer-action='edit-channel']" : "[data-transfer-action='new-channel']";
    const trigger = [...document.querySelectorAll(selector)].find((button) => (
      editor?.mode !== "edit" || button.dataset.transferChannelId === editor.channel?.id
    ));
    trigger?.focus();
  };
  focus();
  globalThis.requestAnimationFrame?.(focus);
}

function openTransferChannelEditor(editor) {
  state.transferChannelEditor = editor;
  state.transferSettingsNotice = null;
  renderTransfer();
  focusTransferChannelEditor();
}

function closeTransferChannelEditor() {
  const editor = state.transferChannelEditor;
  state.transferChannelEditor = null;
  state.transferSettingsNotice = null;
  renderTransfer();
  focusTransferChannelTrigger(editor);
}

async function persistTransferSettings(nextSettings, noticeText = "传输配置已保存。") {
  if (!lastPersistedTransferSettings) {
    lastPersistedTransferSettings = normalizeTransferSettings(state.transferSettings || getDefaultTransferSettings());
  }
  const optimisticSettings = normalizeTransferSettings(nextSettings);
  const revision = ++transferSettingsSaveRevision;
  state.transferSettings = optimisticSettings;
  state.transferSettingsNotice = null;
  renderTransfer();

  const saveRequest = transferSettingsSaveQueue.then(() => saveTransferSettings(optimisticSettings));
  transferSettingsSaveQueue = saveRequest.catch(() => undefined);
  try {
    const savedSettings = await saveRequest;
    lastPersistedTransferSettings = savedSettings;
    const isLatestSave = revision === transferSettingsSaveRevision;
    if (isLatestSave) {
      state.transferSettings = savedSettings;
      state.transferSettingsNotice = { tone: "success", text: noticeText };
      renderTransfer();
      await refreshTransferWorkspace();
    }
    return isLatestSave;
  } catch (error) {
    if (revision === transferSettingsSaveRevision) {
      state.transferSettings = lastPersistedTransferSettings || getDefaultTransferSettings();
      state.transferSettingsNotice = { tone: "error", text: `传输配置保存失败：${error.message || String(error)}` };
      renderTransfer();
    }
    return false;
  }
}

async function saveTransferChannelEditor() {
  const editor = state.transferChannelEditor;
  if (!editor?.channel) return;
  const channel = cloneTransferChannel(editor.channel);
  const isMongo = channel.type === TRANSFER_CHANNEL_TYPES.MONGODB;
  if (!String(channel.name || "").trim()) {
    state.transferSettingsNotice = { tone: "error", text: "请填写通道名称。" };
    renderTransfer();
    focusTransferChannelEditor();
    return;
  }
  if (!isMongo && !String(channel.config?.endpoint || "").trim()) {
    state.transferSettingsNotice = { tone: "error", text: "请填写 API 的 POST 请求地址。" };
    renderTransfer();
    focusTransferChannelEditor("[data-transfer-channel-field='config.endpoint']");
    return;
  }
  if (isMongo && (!String(channel.config?.connectionString || "").trim() || !String(channel.config?.database || "").trim() || !String(channel.config?.collection || "").trim())) {
    state.transferSettingsNotice = { tone: "error", text: "请完整填写 MongoDB 连接串、数据库和集合。" };
    renderTransfer();
    focusTransferChannelEditor("[data-transfer-channel-field='config.connectionString']");
    return;
  }
  if (!isMongo) {
    try {
      getTransferApiOriginPattern(channel.config?.endpoint);
      validateTransferApiHeaders(channel.config?.headers);
      const granted = await requestTransferApiOriginPermission(channel.config?.endpoint);
      if (!granted) throw new Error("未授予该 API 地址的访问权限，通道未保存。");
    } catch (error) {
      state.transferSettingsNotice = { tone: "error", text: error.message || String(error) };
      renderTransfer();
      focusTransferChannelEditor("[data-transfer-channel-field='config.endpoint']");
      return;
    }
  }

  const current = state.transferSettings || getDefaultTransferSettings();
  const now = new Date().toISOString();
  channel.updatedAt = now;
  if (!channel.createdAt) channel.createdAt = now;
  const existingIndex = current.channels.findIndex((item) => item.id === channel.id);
  const channels = [...current.channels];
  if (existingIndex >= 0) channels.splice(existingIndex, 1, channel);
  else channels.unshift(channel);
  const completedEditor = state.transferChannelEditor;
  const saved = await persistTransferSettings(
    { ...current, channels },
    existingIndex >= 0 ? "通道配置已更新。" : "通道已添加，当前不会发起网络请求。"
  );
  if (!saved) return;
  state.transferChannelEditor = null;
  renderTransfer();
  focusTransferChannelTrigger(completedEditor);
}

function updateTransferChannelEditor(event) {
  const field = event.target.dataset.transferChannelField;
  const editor = state.transferChannelEditor;
  if (!field || !editor?.channel) return false;
  const channel = editor.channel;
  const value = field === "enabled" ? event.target.value === "true" : event.target.value;
  if (field.startsWith("config.")) {
    channel.config = { ...(channel.config || {}), [field.slice("config.".length)]: value };
  } else {
    channel[field] = value;
  }
  return true;
}

function cloneTransferStrategy(strategy) {
  return {
    ...strategy,
    platformIds: [...(strategy?.platformIds || [])],
    featureIds: [...(strategy?.featureIds || [])],
    channelIds: [...(strategy?.channelIds || [])]
  };
}

function focusTransferStrategyEditor(selector = "[data-transfer-strategy-field='name']") {
  const focus = () => document.querySelector(selector)?.focus();
  focus();
  globalThis.requestAnimationFrame?.(focus);
}

function focusTransferStrategyTrigger(editor) {
  const focus = () => {
    const selector = editor?.mode === "edit" ? "[data-transfer-action='edit-strategy']" : "[data-transfer-action='new-strategy']";
    const trigger = [...document.querySelectorAll(selector)].find((button) => (
      editor?.mode !== "edit" || button.dataset.transferStrategyId === editor.strategy?.id
    ));
    trigger?.focus();
  };
  focus();
  globalThis.requestAnimationFrame?.(focus);
}

function openTransferStrategyEditor(editor) {
  state.transferStrategyEditor = { ...editor, openPicker: null };
  state.transferSettingsNotice = null;
  renderTransfer();
  focusTransferStrategyEditor();
}

function closeTransferStrategyEditor() {
  const editor = state.transferStrategyEditor;
  state.transferStrategyEditor = null;
  state.transferSettingsNotice = null;
  renderTransfer();
  focusTransferStrategyTrigger(editor);
}

async function saveTransferStrategyEditor() {
  const editor = state.transferStrategyEditor;
  if (!editor?.strategy || isBuiltInTransferStrategy(editor.strategy)) return;
  const strategy = cloneTransferStrategy(editor.strategy);
  const current = state.transferSettings || getDefaultTransferSettings();
  const dataOptions = getTransferStrategyDataOptions();
  const validPlatformIds = new Set(dataOptions.platforms.map((platform) => platform.id));
  strategy.platformIds = [...new Set(strategy.platformIds)].filter((platformId) => validPlatformIds.has(platformId));
  const validFeatureIds = new Set(dataOptions.features
    .filter((feature) => strategy.platformIds.includes(feature.platformId))
    .map((feature) => feature.id));
  strategy.featureIds = [...new Set(strategy.featureIds)].filter((featureId) => validFeatureIds.has(featureId));
  const validChannelIds = new Set(current.channels.map((channel) => channel.id));
  strategy.channelIds = [...new Set(strategy.channelIds)].filter((channelId) => validChannelIds.has(channelId));

  if (!String(strategy.name || "").trim()) {
    state.transferSettingsNotice = { tone: "error", text: "请填写策略名称。" };
    renderTransfer();
    focusTransferStrategyEditor();
    return;
  }
  const priority = Number(strategy.priority);
  if (!Number.isInteger(priority) || priority < 0 || priority > MAX_TRANSFER_STRATEGY_PRIORITY) {
    state.transferSettingsNotice = { tone: "error", text: `优先级必须是 0–${MAX_TRANSFER_STRATEGY_PRIORITY} 的整数。` };
    renderTransfer();
    focusTransferStrategyEditor("[data-transfer-strategy-field='priority']");
    return;
  }
  if (!strategy.platformIds.length) {
    state.transferSettingsNotice = { tone: "error", text: "请至少选择一个平台。" };
    state.transferStrategyEditor.openPicker = "platform";
    renderTransfer();
    focusTransferStrategyEditor("[data-transfer-strategy-choice='platform']");
    return;
  }
  if (!strategy.featureIds.length) {
    state.transferSettingsNotice = { tone: "error", text: "请至少选择一个功能。" };
    state.transferStrategyEditor.openPicker = "feature";
    renderTransfer();
    focusTransferStrategyEditor("[data-transfer-strategy-choice='feature']");
    return;
  }
  if (strategy.type === TRANSFER_STRATEGY_TYPES.CHANNEL && !strategy.channelIds.length) {
    state.transferSettingsNotice = { tone: "error", text: current.channels.length ? "请至少选择一个通道。" : "请先在通道列表中新增通道。" };
    state.transferStrategyEditor.openPicker = current.channels.length ? "channel" : null;
    renderTransfer();
    focusTransferStrategyEditor("[data-transfer-strategy-choice='channel']");
    return;
  }

  const now = new Date().toISOString();
  strategy.name = String(strategy.name).trim();
  strategy.priority = normalizeTransferStrategyPriority(priority);
  strategy.updatedAt = now;
  if (!strategy.createdAt) strategy.createdAt = now;
  const strategies = [...(current.strategies || [])];
  const existingIndex = strategies.findIndex((item) => item.id === strategy.id && !isBuiltInTransferStrategy(item));
  if (existingIndex >= 0) strategies.splice(existingIndex, 1, strategy);
  else strategies.unshift(strategy);
  const completedEditor = state.transferStrategyEditor;
  const saved = await persistTransferSettings(
    { ...current, strategies },
    existingIndex >= 0 ? "策略已更新。" : "策略已添加。"
  );
  if (!saved) return;
  state.transferStrategyEditor = null;
  renderTransfer();
  focusTransferStrategyTrigger(completedEditor);
}

function updateTransferStrategyChoice(event) {
  const kind = event.target.dataset.transferStrategyChoice;
  const editor = state.transferStrategyEditor;
  if (!kind || !editor?.strategy) return false;
  const fieldByKind = { platform: "platformIds", feature: "featureIds", channel: "channelIds" };
  const field = fieldByKind[kind];
  if (!field) return false;
  const values = new Set(editor.strategy[field] || []);
  if (event.target.checked) values.add(event.target.value);
  else values.delete(event.target.value);
  editor.strategy[field] = [...values];
  if (kind === "platform") {
    editor.strategy.featureIds = editor.strategy.featureIds.filter((featureId) => (
      editor.strategy.platformIds.some((platformId) => featureId.startsWith(`${platformId}/`))
    ));
  }
  editor.openPicker = kind;
  state.transferSettingsNotice = null;
  renderTransfer();
  focusTransferStrategyEditor(`[data-transfer-strategy-choice='${kind}'][value='${CSS.escape(event.target.value)}']`);
  return true;
}

function updateTransferStrategyField(event) {
  const field = event.target.dataset.transferStrategyField;
  const editor = state.transferStrategyEditor;
  if (!field || !editor?.strategy) return false;
  if (field === "name" || field === "priority") {
    if (field === "name") editor.strategy.name = event.target.value;
    else editor.strategy.priority = event.target.value;
    return true;
  }
  if (event.type !== "change") return true;
  if (field === "enabled") editor.strategy.enabled = event.target.checked;
  if (field === "type") editor.strategy.type = event.target.value;
  editor.openPicker = null;
  state.transferSettingsNotice = null;
  const focusSelector = field === "type"
    ? `[data-transfer-strategy-field='type'][value='${CSS.escape(event.target.value)}']`
    : "[data-transfer-strategy-field='enabled']";
  renderTransfer();
  focusTransferStrategyEditor(focusSelector);
  return true;
}

function updateSettingsDirtyState() {
  state.settingsDirty = JSON.stringify(normalizeGlobalSettings(state.settingsDraft)) !== JSON.stringify(state.globalSettings);
  const saveButton = document.querySelector('[data-settings-action="save"]');
  const saveState = document.querySelector("[data-settings-save-state]");
  if (saveButton) saveButton.disabled = !state.settingsDirty;
  if (saveState) saveState.textContent = state.settingsDirty ? "有尚未保存的修改" : "所有设置已保存";
}

function applyBrandSettings() {
  const appName = getAppName();
  const brandName = document.querySelector(".brand-name");
  const brandMark = document.querySelector(".brand-mark");
  if (brandName) brandName.textContent = appName;
  if (brandMark) brandMark.innerHTML = brandMarkContent(state.globalSettings, "brand-logo-image");
  if (state.activePage === "feature" && state.activeFeature) {
    document.title = `${state.activeFeature.name} · ${appName}`;
  } else {
    const pageTitles = {
      settings: "设置",
      transfer: "数据传输"
    };
    document.title = pageTitles[state.activePage] ? `${pageTitles[state.activePage]} · ${appName}` : appName;
  }
}

function setActiveAppPage(activePage) {
  document.querySelectorAll("[data-app-page]").forEach((button) => {
    const active = button.dataset.appPage === activePage;
    button.classList.toggle("active", active);
    if (active) {
      button.setAttribute("aria-current", "page");
    } else {
      button.removeAttribute("aria-current");
    }
  });
}

function readLogoFile(file) {
  return new Promise((resolve, reject) => {
    const allowedTypes = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
    if (!file || !allowedTypes.has(file.type)) {
      reject(new Error("请选择 PNG、JPG、WebP 或 GIF 图片。"));
      return;
    }
    if (file.size > 1024 * 1024) {
      reject(new Error("Logo 文件不能超过 1 MB。"));
      return;
    }
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result || "")), { once: true });
    reader.addEventListener("error", () => reject(new Error("Logo 图片读取失败。")), { once: true });
    reader.readAsDataURL(file);
  });
}

function filteredGroups() {
  const query = state.query.trim().toLocaleLowerCase("zh-CN");
  if (!query) {
    return state.config.groups;
  }

  return state.config.groups
    .map((group) => {
      const groupMatches = `${group.name} ${group.description}`.toLocaleLowerCase("zh-CN").includes(query);
      const features = groupMatches
        ? group.features
        : group.features.filter((feature) => {
            return `${feature.name} ${feature.description}`.toLocaleLowerCase("zh-CN").includes(query);
          });
      return { ...group, features };
    })
    .filter((group) => group.features.length > 0);
}

function featureCard(group, feature) {
  const tooltipId = `feature-tip-${group.id}-${feature.id}`.replaceAll(/[^a-zA-Z0-9_-]/g, "-");
  const featureKey = buildFeatureKey(group.id, feature.id);
  const isRunning = state.runningFeatures.has(featureKey);
  const icon = group.image
    ? `<img src="${escapeHtml(extensionUrl(group.image))}" alt="" aria-hidden="true">`
    : escapeHtml(group.icon || group.name.slice(0, 1));

  return `
    <div class="feature-tile">
      <button
        class="feature-card"
        type="button"
        data-group-id="${escapeHtml(group.id)}"
        data-feature-id="${escapeHtml(feature.id)}"
        aria-label="打开 ${escapeHtml(feature.name)}${isRunning ? "，正在运行" : ""}"
      >
        <span class="feature-icon platform-${escapeHtml(group.id)}" aria-hidden="true">
          ${icon}
          ${isRunning ? '<span class="feature-running-dot"></span>' : ""}
        </span>
        <span class="feature-name">${escapeHtml(feature.name)}</span>
      </button>
      <button
        class="feature-help"
        type="button"
        aria-label="查看 ${escapeHtml(feature.name)} 简介"
        aria-describedby="${escapeHtml(tooltipId)}"
      >
        <img src="src/assets/icons/question-circle.svg" alt="" aria-hidden="true">
      </button>
      <span id="${escapeHtml(tooltipId)}" class="feature-tooltip" role="tooltip">${escapeHtml(feature.description)}</span>
    </div>
  `;
}

function renderGroups() {
  const groups = filteredGroups();
  const groupList = document.getElementById("groupList");
  const emptySearch = document.getElementById("emptySearch");

  groupList.innerHTML = groups.map((group) => `
    <section class="group-section" aria-labelledby="group-${escapeHtml(group.id)}">
      <header class="group-header">
        <div>
          <span class="group-kicker">GROUP / ${escapeHtml(group.id.toUpperCase())}</span>
          <h2 id="group-${escapeHtml(group.id)}">${escapeHtml(group.name)}</h2>
          <p>${escapeHtml(group.description)}</p>
        </div>
        <span class="group-count">${group.features.length}</span>
      </header>
      <div class="feature-grid">
        ${group.features.map((feature) => featureCard(group, feature)).join("")}
      </div>
    </section>
  `).join("");

  emptySearch.hidden = groups.length > 0;
}

function findFeature(groupId, featureId) {
  const group = state.config.groups.find((item) => item.id === groupId);
  const feature = group?.features.find((item) => item.id === featureId);
  return { group, feature };
}

function removeFeatureStyle() {
  document.getElementById(FEATURE_STYLE_ID)?.remove();
}

function loadFeatureStyle(feature) {
  removeFeatureStyle();
  if (!feature.style) {
    return;
  }
  const link = document.createElement("link");
  link.id = FEATURE_STYLE_ID;
  link.rel = "stylesheet";
  link.href = extensionUrl(feature.style);
  document.head.append(link);
}

function updateFeatureRefreshButton() {
  const button = document.getElementById("refreshActiveFeature");
  if (!button) return;
  const visible = state.activePage === "feature" && Boolean(state.activeFeature);
  button.hidden = !visible;
  button.disabled = !visible || state.featureRefreshing;
  button.classList.toggle("is-refreshing", state.featureRefreshing);
  button.title = state.featureRefreshing ? "正在刷新功能页面" : "强制刷新功能页面";
}

async function refreshActiveFeature() {
  if (state.featureRefreshing || !state.activeGroup || !state.activeFeature) return;
  const groupId = state.activeGroup.id;
  const featureId = state.activeFeature.id;
  state.featureRefreshing = true;
  updateFeatureRefreshButton();
  try {
    if (typeof state.unmountFeature === "function") {
      try {
        await state.unmountFeature();
      } catch (error) {
        // 清理失败不应阻断用户主动刷新；新挂载会重新建立事件订阅与页面状态。
        console.warn("清理旧功能页面失败，将继续刷新：", error);
      }
    }
    state.unmountFeature = null;
    await openFeature(groupId, featureId);
  } finally {
    state.featureRefreshing = false;
    updateFeatureRefreshButton();
  }
}

async function openFeature(groupId, featureId) {
  const { group, feature } = findFeature(groupId, featureId);
  if (!group || !feature) {
    throw new Error("没有找到对应的功能配置。");
  }

  const isMountedFeature = state.activeGroup?.id === groupId
    && state.activeFeature?.id === featureId
    && typeof state.unmountFeature === "function"
    && document.getElementById("featureRoot").childElementCount > 0;

  if (isMountedFeature) {
    state.activePage = "feature";
    document.getElementById("catalogView").hidden = true;
    document.getElementById("settingsView").hidden = true;
    document.getElementById("transferView").hidden = true;
    document.getElementById("featureView").hidden = false;
    setActiveAppPage("feature");
    document.title = `${feature.name} · ${getAppName()}`;
    updateFeatureRefreshButton();
    return;
  }

  if (typeof state.unmountFeature === "function") {
    await state.unmountFeature();
  }

  state.activeGroup = group;
  state.activeFeature = feature;
  state.unmountFeature = null;
  state.activePage = "feature";

  const catalogView = document.getElementById("catalogView");
  const featureView = document.getElementById("featureView");
  const featureRoot = document.getElementById("featureRoot");
  catalogView.hidden = true;
  document.getElementById("settingsView").hidden = true;
  document.getElementById("transferView").hidden = true;
  featureView.hidden = false;
  setActiveAppPage("feature");
  updateFeatureRefreshButton();
  featureRoot.innerHTML = '<div class="loading-state">正在加载功能模块…</div>';
  loadFeatureStyle(feature);

  try {
    const module = await import(extensionUrl(feature.entry));
    if (typeof module.mount !== "function") {
      throw new Error("功能入口必须导出 mount(container, context)。");
    }
    const activeFeatureId = buildFeatureKey(group.id, feature.id);
    const runnerFeatures = getRunnerFeatures();
    const boundRunnerTargets = getCallableRunnerFeatureIds(state.globalSettings, activeFeatureId)
      .map((targetId) => {
        const target = runnerFeatures.find((runnerFeature) => runnerFeature.id === targetId);
        return target ? {
          ...target,
          configuration: getRunnerBindingConfiguration(state.globalSettings, activeFeatureId, targetId)
        } : null;
      })
      .filter(Boolean);
    const cleanup = await module.mount(featureRoot, {
      app: {
        ...state.config.app,
        name: getAppName(),
        logoDataUrl: state.globalSettings.interface.logoDataUrl
      },
      globalSettings: cloneSettings(state.globalSettings),
      group,
      feature,
      featureId: activeFeatureId,
      boundRunnerTargets
    });
    state.unmountFeature = typeof cleanup === "function" ? cleanup : null;
    document.title = `${feature.name} · ${getAppName()}`;
  } catch (error) {
    featureRoot.innerHTML = `
      <section class="module-error" role="alert">
        <strong>功能模块加载失败</strong>
        <p>${escapeHtml(error.message || String(error))}</p>
      </section>
    `;
  }
}

async function showCatalog() {
  await showMainPage("catalog");
}

async function showMainPage(nextPage) {
  state.activePage = ["catalog", "transfer", "settings"].includes(nextPage) ? nextPage : "catalog";
  if (state.activePage !== "settings" && state.runnerEditor) {
    state.runnerEditor = null;
    document.body.classList.remove("has-settings-runner-modal");
  }
  if (state.activePage !== "transfer" && state.transferChannelEditor) {
    state.transferChannelEditor = null;
    state.transferSettingsNotice = null;
    document.body.classList.remove("has-transfer-channel-modal");
  }
  if (state.activePage !== "transfer" && state.transferStrategyEditor) {
    state.transferStrategyEditor = null;
    state.transferSettingsNotice = null;
    document.body.classList.remove("has-transfer-strategy-modal");
  }
  document.getElementById("featureView").hidden = true;
  document.getElementById("catalogView").hidden = state.activePage !== "catalog";
  document.getElementById("settingsView").hidden = state.activePage !== "settings";
  document.getElementById("transferView").hidden = state.activePage !== "transfer";
  setActiveAppPage(state.activePage);
  if (state.activePage === "settings") renderSettings();
  if (state.activePage === "transfer") {
    renderTransfer();
    await refreshTransferWorkspace();
  }
  applyBrandSettings();
  updateFeatureRefreshButton();
}

function bindEvents() {
  document.getElementById("brandHome").addEventListener("click", () => {
    showMainPage("catalog").catch(console.error);
  });

  document.querySelectorAll("[data-app-page]").forEach((button) => {
    button.addEventListener("click", () => {
      showMainPage(button.dataset.appPage).catch(console.error);
    });
  });

  document.getElementById("refreshActiveFeature").addEventListener("click", () => {
    refreshActiveFeature().catch((error) => {
      console.error("刷新功能页面失败：", error);
    });
  });

  document.getElementById("featureSearch").addEventListener("input", (event) => {
    state.query = event.currentTarget.value;
    renderGroups();
  });

  document.getElementById("groupList").addEventListener("click", (event) => {
    const card = event.target.closest("[data-feature-id]");
    if (!card) {
      return;
    }
    openFeature(card.dataset.groupId, card.dataset.featureId).catch(console.error);
  });

  const settingsRoot = document.getElementById("settingsRoot");
  settingsRoot.addEventListener("click", (event) => {
    if (event.target.matches("[data-runner-editor-modal]")) {
      state.runnerEditor = null;
      state.settingsNotice = null;
      renderSettings();
      return;
    }

    const tab = event.target.closest("[data-settings-tab]");
    if (tab) {
      state.settingsTab = tab.dataset.settingsTab;
      state.settingsNotice = null;
      renderSettings();
      return;
    }

    const button = event.target.closest("[data-settings-action]");
    if (!button || button.disabled) return;
    const action = button.dataset.settingsAction;
    if (action === "reset-logo") {
      state.settingsDraft.interface.logoDataUrl = "";
      state.settingsNotice = { tone: "info", text: "Logo 已恢复为默认 BC 标识，保存后生效。" };
      updateSettingsDirtyState();
      renderSettings();
      return;
    }
    if (action === "reset-all") {
      state.settingsDraft = getDefaultGlobalSettings();
      state.runnerEditor = null;
      state.settingsNotice = { tone: "info", text: "已载入全部默认值，保存后应用。" };
      updateSettingsDirtyState();
      renderSettings();
      return;
    }
    if (action === "new-runner-binding") {
      state.runnerEditor = createRunnerEditor();
      state.settingsNotice = null;
      renderSettings();
      return;
    }
    if (action === "cancel-runner-editor") {
      state.runnerEditor = null;
      state.settingsNotice = null;
      renderSettings();
      return;
    }
    if (action === "runner-editor-next") {
      const editor = state.runnerEditor;
      if (!editor?.sourceFeatureId) {
        state.settingsNotice = { tone: "error", text: "请先选择来源功能。" };
      } else if (!editor.sourceOutputFields.length) {
        state.settingsNotice = { tone: "error", text: "请至少选择一个来源输出字段。" };
      } else {
        editor.step = 2;
        state.settingsNotice = null;
      }
      renderSettings();
      return;
    }
    if (action === "runner-editor-back") {
      if (state.runnerEditor) state.runnerEditor.step = 1;
      state.settingsNotice = null;
      renderSettings();
      return;
    }
    if (action === "save-runner-binding") {
      try {
        saveDraftRunnerBinding(state.runnerEditor);
        state.runnerEditor = null;
        state.settingsNotice = { tone: "success", text: "运行器已加入列表，点击“保存设置”后全局生效。" };
        updateSettingsDirtyState();
      } catch (error) {
        state.settingsNotice = { tone: "error", text: error.message || String(error) };
      }
      renderSettings();
      return;
    }
    if (action === "edit-runner-binding") {
      const source = getRunnerFeature(button.dataset.runnerSourceId);
      const target = getRunnerFeature(button.dataset.runnerTargetId);
      if (!source || !target) return;
      state.runnerEditor = createRunnerEditor({
        source,
        target,
        configuration: getDraftRunnerBindingConfiguration(source.id, target.id)
      });
      state.settingsNotice = null;
      renderSettings();
      return;
    }
    if (action === "remove-runner-binding") {
      const sourceId = button.dataset.runnerSourceId || "";
      const targetId = button.dataset.runnerTargetId || "";
      const source = getRunnerFeature(sourceId);
      const target = getRunnerFeature(targetId);
      if (!source || !target) return;
      if (typeof globalThis.confirm === "function" && !globalThis.confirm(`确认删除运行器“${source.name} → ${target.name}”？`)) return;
      removeDraftRunnerBinding(sourceId, targetId);
      state.settingsNotice = { tone: "info", text: "运行器已从列表移除，点击“保存设置”后全局生效。" };
      updateSettingsDirtyState();
      renderSettings();
      return;
    }
    if (action === "save") {
      saveGlobalSettings(state.settingsDraft)
        .then((settings) => {
          state.globalSettings = settings;
          state.settingsDraft = cloneSettings(settings);
          state.settingsDirty = false;
          state.settingsNotice = { tone: "success", text: "全局设置已保存，并已应用到全部功能。" };
          applyBrandSettings();
          renderSettings();
        })
        .catch((error) => {
          state.settingsNotice = { tone: "error", text: `设置保存失败：${error.message || String(error)}` };
          renderSettings();
        });
    }
  });

  settingsRoot.addEventListener("input", (event) => {
    const field = event.target.dataset.settingField;
    if (field === "appName") state.settingsDraft.interface.appName = event.target.value;
    if (field === "taskTimeoutSeconds") state.settingsDraft.limits.taskTimeoutSeconds = event.target.value;
    if (field === "dataStorageLimit") state.settingsDraft.limits.dataStorageLimit = event.target.value;
    if (field === "taskRecordsPerStatusLimit") state.settingsDraft.limits.taskRecordsPerStatusLimit = event.target.value;
    if (field) {
      state.settingsNotice = null;
      updateSettingsDirtyState();
    }
  });

  settingsRoot.addEventListener("change", (event) => {
    if (event.target.matches("[data-runner-editor-field]")) {
      const editor = state.runnerEditor;
      if (!editor) return;
      const field = event.target.dataset.runnerEditorField;
      const value = event.target.value;
      if (field === "sourceGroupId") {
        editor.sourceGroupId = value;
        editor.sourceFeatureId = "";
        editor.sourceOutputFields = [];
      } else if (field === "sourceFeatureId") {
        editor.sourceFeatureId = value;
        editor.sourceOutputFields = [];
      } else if (field === "targetGroupId") {
        editor.targetGroupId = value;
        editor.targetFeatureId = "";
        editor.targetInputFields = [];
      } else if (field === "targetFeatureId") {
        editor.targetFeatureId = value;
        editor.targetInputFields = getRunnerInputFields(value).map((item) => item.key);
      }
      state.settingsNotice = null;
      renderSettings();
      return;
    }
    if (event.target.matches("[data-runner-editor-output], [data-runner-editor-input]")) {
      const editor = state.runnerEditor;
      if (!editor) return;
      const fieldName = event.target.matches("[data-runner-editor-output]") ? "sourceOutputFields" : "targetInputFields";
      const fields = new Set(editor[fieldName] || []);
      if (event.target.checked) fields.add(event.target.value);
      else fields.delete(event.target.value);
      editor[fieldName] = [...fields];
      state.settingsNotice = null;
      renderSettings();
      return;
    }
    if (event.target.matches("[data-setting-logo]")) {
      readLogoFile(event.target.files?.[0])
        .then((dataUrl) => {
          state.settingsDraft.interface.logoDataUrl = dataUrl;
          state.settingsNotice = { tone: "info", text: "Logo 已更新预览，保存后全局生效。" };
          updateSettingsDirtyState();
          renderSettings();
        })
        .catch((error) => {
          state.settingsNotice = { tone: "error", text: error.message || String(error) };
          renderSettings();
        });
      return;
    }
    if (event.target.dataset.settingField === "storageType") {
      state.settingsDraft.storage.type = event.target.value;
      updateSettingsDirtyState();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !state.runnerEditor) return;
    event.preventDefault();
    state.runnerEditor = null;
    state.settingsNotice = null;
    renderSettings();
  });

  const transferRoot = document.getElementById("transferRoot");
  transferRoot.addEventListener("click", (event) => {
    if (event.target.matches("[data-transfer-channel-modal]")) {
      closeTransferChannelEditor();
      return;
    }
    if (event.target.matches("[data-transfer-strategy-modal]")) {
      closeTransferStrategyEditor();
      return;
    }

    const tab = event.target.closest("[data-transfer-tab]");
    if (tab) {
      const nextTab = tab.dataset.transferTab;
      state.transferTab = ["data", "settings", "channels", "strategies"].includes(nextTab) ? nextTab : "data";
      renderTransfer();
      return;
    }

    const statusTab = event.target.closest("[data-transfer-data-status]");
    if (statusTab) {
      state.transferDataFilters.transferStatus = statusTab.dataset.transferDataStatus || "__all__";
      state.transferDataPage = 1;
      renderTransfer();
      return;
    }

    const channelType = event.target.closest("[data-transfer-channel-type]");
    if (channelType && !channelType.disabled && state.transferChannelEditor) {
      const current = state.transferChannelEditor.channel;
      const next = createTransferChannelDraft(channelType.dataset.transferChannelType);
      next.id = current.id;
      next.name = current.name;
      next.enabled = current.enabled;
      next.isDefault = current.isDefault === true;
      next.createdAt = current.createdAt;
      state.transferChannelEditor = { ...state.transferChannelEditor, channel: next };
      renderTransfer();
      focusTransferChannelEditor(`[data-transfer-channel-type='${next.type}']`);
      return;
    }

    const button = event.target.closest("[data-transfer-action]");
    if (!button || button.disabled) return;
    const action = button.dataset.transferAction;
    if (action === "open-transfer-failure") {
      const row = getResolvedTransferDataRows().find((item) => item.id === button.dataset.transferRowId);
      if (row?.transferStatus === TRANSFER_STATUS.FAILED) openTransferFailureDetail(row);
      return;
    }
    if (action === "open-data-detail") {
      const row = getResolvedTransferDataRows().find((item) => item.id === button.dataset.transferRowId);
      if (row) openTransferDataDetail(row);
      return;
    }
    if (action === "refresh-transfer") {
      refreshTransferWorkspace().catch(console.error);
      return;
    }
    if (action === "toggle-data-filters") {
      state.transferDataFiltersOpen = !state.transferDataFiltersOpen;
      renderTransfer();
      return;
    }
    if (action === "new-strategy") {
      openTransferStrategyEditor({ mode: "new", strategy: createTransferStrategyDraft() });
      return;
    }
    if (action === "cancel-strategy-editor") {
      closeTransferStrategyEditor();
      return;
    }
    if (action === "edit-strategy") {
      const strategy = state.transferSettings?.strategies?.find((item) => item.id === button.dataset.transferStrategyId);
      if (!strategy || isBuiltInTransferStrategy(strategy)) return;
      openTransferStrategyEditor({ mode: "edit", strategy: cloneTransferStrategy(strategy) });
      return;
    }
    if (action === "save-strategy") {
      saveTransferStrategyEditor().catch(console.error);
      return;
    }
    if (action === "toggle-strategy") {
      const current = state.transferSettings || getDefaultTransferSettings();
      const strategyId = button.dataset.transferStrategyId;
      const selected = current.strategies.find((strategy) => strategy.id === strategyId);
      if (!selected || isBuiltInTransferStrategy(selected)) return;
      if (
        !selected.enabled
        && selected.type === TRANSFER_STRATEGY_TYPES.CHANNEL
        && !resolveTransferStrategyChannelIds(selected, current.channels).length
      ) {
        state.transferSettingsNotice = { tone: "error", text: "请先编辑策略并至少选择一个有效通道。" };
        renderTransfer();
        return;
      }
      const strategies = current.strategies.map((strategy) => strategy.id === strategyId
        ? { ...strategy, enabled: !strategy.enabled, updatedAt: new Date().toISOString() }
        : strategy);
      persistTransferSettings({ ...current, strategies }, `“${selected.name}”已${selected.enabled ? "停用" : "启用"}。`).catch(console.error);
      return;
    }
    if (action === "remove-strategy") {
      const current = state.transferSettings || getDefaultTransferSettings();
      const strategy = current.strategies.find((item) => item.id === button.dataset.transferStrategyId);
      if (!strategy || isBuiltInTransferStrategy(strategy)) return;
      if (typeof globalThis.confirm === "function" && !globalThis.confirm(`确认删除策略“${strategy.name}”？`)) return;
      const strategies = current.strategies.filter((item) => item.id !== strategy.id);
      if (state.transferStrategyEditor?.strategy?.id === strategy.id) state.transferStrategyEditor = null;
      persistTransferSettings({ ...current, strategies }, "策略已删除。默认策略仍会保留。").catch(console.error);
      return;
    }
    if (action === "new-channel") {
      openTransferChannelEditor({ mode: "new", channel: createTransferChannelDraft() });
      return;
    }
    if (action === "cancel-channel-editor") {
      closeTransferChannelEditor();
      return;
    }
    if (action === "edit-channel") {
      const channel = state.transferSettings?.channels?.find((item) => item.id === button.dataset.transferChannelId);
      if (!channel) return;
      openTransferChannelEditor({ mode: "edit", channel: cloneTransferChannel(channel) });
      return;
    }
    if (action === "save-channel") {
      saveTransferChannelEditor().catch(console.error);
      return;
    }
    if (action === "toggle-channel") {
      const current = state.transferSettings || getDefaultTransferSettings();
      const channelId = button.dataset.transferChannelId;
      const channels = current.channels.map((channel) => channel.id === channelId
        ? { ...channel, enabled: !channel.enabled, updatedAt: new Date().toISOString() }
        : channel);
      persistTransferSettings({ ...current, channels }, "通道状态已更新。").catch(console.error);
      return;
    }
    if (action === "set-default-channel") {
      const current = state.transferSettings || getDefaultTransferSettings();
      const channelId = button.dataset.transferChannelId;
      const selected = current.channels.find((channel) => channel.id === channelId);
      if (!selected) return;
      const now = new Date().toISOString();
      const channels = current.channels.map((channel) => ({
        ...channel,
        isDefault: channel.id === channelId,
        updatedAt: channel.id === channelId ? now : channel.updatedAt
      }));
      persistTransferSettings({ ...current, channels }, `“${selected.name}”已设为默认通道。`).catch(console.error);
      return;
    }
    if (action === "remove-channel") {
      const current = state.transferSettings || getDefaultTransferSettings();
      const channel = current.channels.find((item) => item.id === button.dataset.transferChannelId);
      if (!channel) return;
      if (typeof globalThis.confirm === "function" && !globalThis.confirm(`确认删除通道“${channel.name}”？`)) return;
      const channels = current.channels.filter((item) => item.id !== channel.id);
      if (state.transferChannelEditor?.channel?.id === channel.id) state.transferChannelEditor = null;
      const blockedStrategyCount = (current.strategies || []).filter((strategy) => (
        !isBuiltInTransferStrategy(strategy)
        && strategy.type === TRANSFER_STRATEGY_TYPES.CHANNEL
        && strategy.enabled
        && strategy.channelIds.includes(channel.id)
        && !strategy.channelIds.some((channelId) => channelId !== channel.id && channels.some((item) => item.id === channelId))
      )).length;
      let message = channel.isDefault && channels.length
        ? `通道已删除，已将“${channels[0].name}”设为默认通道。`
        : "通道已删除。";
      if (blockedStrategyCount) message += ` ${blockedStrategyCount} 条策略失去全部绑定通道，命中时将按无需传输阻断，不会改发默认通道。`;
      persistTransferSettings({ ...current, channels }, message).catch(console.error);
      return;
    }
    if (action === "clear-data-filters") {
      state.transferDataFilters = { query: "", platform: "__all__", feature: "__all__", entityType: "__all__", contentType: "__all__", localStatus: "__all__", transferStatus: state.transferDataFilters.transferStatus || "__all__", dateStart: "", dateEnd: "" };
      state.transferDataPage = 1;
      renderTransfer();
      return;
    }
    if (action === "data-prev" || action === "data-next") {
      state.transferDataPage += action === "data-prev" ? -1 : 1;
      renderTransfer();
    }
  });

  transferRoot.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || (!state.transferChannelEditor && !state.transferStrategyEditor)) return;
    event.preventDefault();
    if (state.transferStrategyEditor) closeTransferStrategyEditor();
    else closeTransferChannelEditor();
  });

  function updateTransferFilter(event) {
    const field = event.target.dataset.transferFilter;
    const kind = event.target.dataset.transferKind;
    if (!field || !kind) return;
    state.transferDataFilters[field] = event.target.value;
    state.transferDataPage = 1;
    renderTransfer();
  }

  transferRoot.addEventListener("input", (event) => {
    if (!updateTransferStrategyField(event) && !updateTransferChannelEditor(event)) updateTransferFilter(event);
  });
  transferRoot.addEventListener("change", (event) => {
    if (event.target.matches("[data-transfer-setting='enabled']")) {
      const current = state.transferSettings || getDefaultTransferSettings();
      persistTransferSettings({ ...current, enabled: event.target.checked }, event.target.checked ? "数据传输开关已开启。" : "数据传输开关已关闭。").catch(console.error);
      return;
    }
    if (event.target.matches("[data-transfer-setting='retryCount'], [data-transfer-setting='batchSize']")) {
      const field = event.target.dataset.transferSetting;
      const limits = field === "retryCount"
        ? { min: MIN_TRANSFER_RETRY_COUNT, max: MAX_TRANSFER_RETRY_COUNT, label: "重试次数" }
        : { min: MIN_TRANSFER_BATCH_SIZE, max: MAX_TRANSFER_BATCH_SIZE, label: "批量条数" };
      const value = Number(event.target.value);
      if (!Number.isInteger(value) || value < limits.min || value > limits.max) {
        state.transferSettingsNotice = { tone: "error", text: `${limits.label}必须是 ${limits.min}–${limits.max} 之间的整数。` };
        renderTransfer();
        return;
      }
      const current = state.transferSettings || getDefaultTransferSettings();
      persistTransferSettings({ ...current, [field]: value }, `${limits.label}已更新为 ${value}。`).catch(console.error);
      return;
    }
    if (updateTransferStrategyChoice(event)) return;
    if (!updateTransferStrategyField(event) && !updateTransferChannelEditor(event)) updateTransferFilter(event);
  });

  globalThis.addEventListener(FEATURE_RUN_STATUS_EVENT, (event) => {
    const featureKey = event.detail?.featureKey;
    if (!featureKey) return;
    if (event.detail.running) state.runningFeatures.add(featureKey);
    else state.runningFeatures.delete(featureKey);
    renderGroups();
  });

  globalThis.addEventListener(GLOBAL_SETTINGS_CHANGED_EVENT, (event) => {
    if (!event.detail?.settings || state.settingsDirty) return;
    state.globalSettings = normalizeGlobalSettings(event.detail.settings);
    state.settingsDraft = cloneSettings(state.globalSettings);
    applyBrandSettings();
    renderSettings();
  });
}

function getConfiguredFeatureKeys() {
  return state.config.groups.flatMap((group) => (
    group.features.map((feature) => buildFeatureKey(group.id, feature.id))
  ));
}

async function init() {
  const root = document.getElementById("app");
  root.innerHTML = '<div class="boot-state">正在加载 BrowserCoreClaw…</div>';

  try {
    state.config = await loadConfig();
    state.globalSettings = await loadGlobalSettings().catch(() => getDefaultGlobalSettings());
    state.settingsDraft = cloneSettings(state.globalSettings);
    const featureKeys = getConfiguredFeatureKeys();
    state.runningFeatures = await loadRunningFeatureKeys(featureKeys).catch(() => new Set());
    await clearRunningFeatureKeys(featureKeys);
    state.runningFeatures.clear();
    root.innerHTML = appTemplate(state.config, state.globalSettings);
    renderGroups();
    renderSettings();
    bindEvents();
    applyBrandSettings();
  } catch (error) {
    root.innerHTML = `
      <main class="fatal-error" role="alert">
        <strong>项目初始化失败</strong>
        <p>${escapeHtml(error.message || String(error))}</p>
      </main>
    `;
  }
}

init();
