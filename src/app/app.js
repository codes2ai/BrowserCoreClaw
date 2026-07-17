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
  normalizeRunnerBindingConfiguration,
  RUNNER_BINDING_PARAMETER_LIMITS
} from "../shared/runner-capability-schema.js";
import { getFeatureRunner } from "../runners/registry.js";
import {
  TRANSFER_STATUS,
  filterTransferDataRows,
  filterTransferTaskRows,
  getTransferFilterOptions,
  loadTransferWorkspace,
  paginateTransferRows
} from "../shared/transfer-workspace.js";

const CONFIG_PATH = "src/config/groups.json";
const FEATURE_STYLE_ID = "active-feature-style";
let activeTransferDataDetailClose = null;

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
  runnerSourceFeatureId: "xiaohongshu/keyword-search",
  runnerConfigTargetFeatureId: "xiaohongshu/post-detail",
  query: "",
  transferWorkspace: null,
  transferLoading: false,
  transferNotice: null,
  transferTab: "data",
  transferDataFiltersOpen: false,
  transferTaskFiltersOpen: false,
  transferDataPage: 1,
  transferTaskPage: 1,
  transferDataFilters: {
    query: "",
    platform: "__all__",
    feature: "__all__",
    localStatus: "__all__",
    transferStatus: "__all__",
    dateStart: "",
    dateEnd: ""
  },
  transferTaskFilters: {
    query: "",
    platform: "__all__",
    feature: "__all__",
    trigger: "__all__",
    status: "__all__",
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

function getRunnerSourceFeatureId() {
  const runnerFeatures = getRunnerFeatures();
  if (!runnerFeatures.some((feature) => feature.id === state.runnerSourceFeatureId)) {
    state.runnerSourceFeatureId = runnerFeatures.find((feature) => feature.id === "xiaohongshu/keyword-search")?.id
      || runnerFeatures[0]?.id
      || "";
  }
  return state.runnerSourceFeatureId;
}

function getRunnerTargetIds(sourceFeatureId = getRunnerSourceFeatureId()) {
  const configured = state.settingsDraft?.runners?.callableByFeature?.[sourceFeatureId];
  return Array.isArray(configured) ? configured : [];
}

function setRunnerTargetEnabled(sourceFeatureId, targetFeatureId, enabled) {
  if (!sourceFeatureId || !targetFeatureId || sourceFeatureId === targetFeatureId) return;
  const bindings = state.settingsDraft.runners.callableByFeature;
  const targets = new Set(getRunnerTargetIds(sourceFeatureId));
  if (enabled) {
    targets.add(targetFeatureId);
    state.runnerConfigTargetFeatureId = targetFeatureId;
  } else {
    targets.delete(targetFeatureId);
    if (state.runnerConfigTargetFeatureId === targetFeatureId) {
      state.runnerConfigTargetFeatureId = [...targets][0] || "";
    }
  }
  if (targets.size) bindings[sourceFeatureId] = [...targets];
  else delete bindings[sourceFeatureId];
}

function getRunnerConfigTargetFeatureId(targetFeatureIds = getRunnerTargetIds()) {
  const targetIds = Array.isArray(targetFeatureIds) ? targetFeatureIds : [...targetFeatureIds];
  if (!targetIds.includes(state.runnerConfigTargetFeatureId)) {
    state.runnerConfigTargetFeatureId = targetIds[0] || "";
  }
  return state.runnerConfigTargetFeatureId;
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
            <p>聚合各功能的本地数据与远程归档任务；接入远程存储后可在此统一同步。</p>
          </header>
          <div id="transferRoot"></div>
        </section>

        <section id="featureView" class="feature-view" hidden>
          <div id="featureRoot"></div>
        </section>
      </main>
    </div>
  `;
}

function runnerConfigurationPanelTemplate(sourceFeatureId, targetFeature) {
  if (!targetFeature) {
    return `
      <aside class="settings-runner-config-section" aria-labelledby="runner-config-title">
        <header class="settings-runner-config-heading">
          <div><h3 id="runner-config-title">字段配置</h3><p>选择并启用一个调用能力后进行配置。</p></div>
        </header>
        <div class="settings-runner-config-empty">
          <strong>暂无已选能力</strong>
          <span>在中间列表勾选目标能力，输出字段与调用参数会显示在这里。</span>
        </div>
      </aside>
    `;
  }

  const schema = getRunnerCapabilitySchema(targetFeature.id);
  const configuration = getDraftRunnerBindingConfiguration(sourceFeatureId, targetFeature.id);
  const selectedFields = new Set(configuration.outputFields);
  const parameters = configuration.parameters;
  const limits = RUNNER_BINDING_PARAMETER_LIMITS;

  return `
    <aside class="settings-runner-config-section" aria-labelledby="runner-config-title">
      <header class="settings-runner-config-heading">
        <div><h3 id="runner-config-title">字段配置</h3><p>${escapeHtml(targetFeature.name)}</p></div>
        <span>配置中</span>
      </header>
      <div class="settings-runner-config-target">
        <strong>${escapeHtml(targetFeature.name)}</strong>
        <code>${escapeHtml(targetFeature.id)}</code>
      </div>
      <section class="settings-runner-config-block" aria-labelledby="runner-output-fields-title">
        <header>
          <div><h4 id="runner-output-fields-title">输出字段</h4><p>仅返回勾选的字段；数据主键会由系统保留。</p></div>
          <button type="button" data-settings-action="select-all-runner-output-fields">全选</button>
        </header>
        <div class="settings-runner-output-fields">
          ${schema.outputFields.map((item) => `
            <label class="settings-runner-field-option">
              <input type="checkbox" value="${escapeHtml(item.key)}" data-runner-output-field ${selectedFields.has(item.key) ? "checked" : ""}>
              <span aria-hidden="true">✓</span>
              <span><strong>${escapeHtml(item.label)}</strong><small>${escapeHtml(item.key)}</small></span>
            </label>
          `).join("")}
        </div>
      </section>
      <section class="settings-runner-config-block" aria-labelledby="runner-parameters-title">
        <header><div><h4 id="runner-parameters-title">调用参数</h4><p>应用于当前来源自动调用该能力时。</p></div></header>
        <div class="settings-runner-parameter-list">
          <div class="settings-runner-parameter-static">
            <span>输入参数</span>
            <strong>${escapeHtml(schema.inputLabel)}</strong>
            <code>${escapeHtml(schema.inputKey)}</code>
            <small>由来源能力的本轮结果自动生成</small>
          </div>
          ${schema.hasLimit ? `
            <label class="settings-runner-parameter-control">
              <span>单项结果数</span>
              <input type="number" min="${limits.limit.min}" max="${limits.limit.max}" step="1" value="${parameters.limit}" data-runner-parameter="limit">
              <small>${limits.limit.min}–${limits.limit.max} 条</small>
            </label>
          ` : ""}
          <label class="settings-runner-parameter-control">
            <span>并发数</span>
            <input type="number" min="${limits.concurrency.min}" max="${limits.concurrency.max}" step="1" value="${parameters.concurrency}" data-runner-parameter="concurrency">
            <small>${limits.concurrency.min}–${limits.concurrency.max} 个任务</small>
          </label>
          <div class="settings-runner-parameter-range">
            <span>调用间隔</span>
            <label><input type="number" min="${limits.interval.min}" max="${limits.interval.max}" step="100" value="${parameters.intervalMinMs}" data-runner-parameter="intervalMinMs"><small>最小 ms</small></label>
            <i>—</i>
            <label><input type="number" min="${limits.interval.min}" max="${limits.interval.max}" step="100" value="${parameters.intervalMaxMs}" data-runner-parameter="intervalMaxMs"><small>最大 ms</small></label>
          </div>
          <label class="settings-runner-parameter-switch">
            <input type="checkbox" data-runner-parameter="forceUpdateData" ${parameters.forceUpdateData ? "checked" : ""}>
            <span aria-hidden="true"></span>
            <span><strong>强制更新已有数据</strong><small>主键相同时也使用本次结果覆盖。</small></span>
          </label>
        </div>
      </section>
      <button class="settings-runner-config-reset" type="button" data-settings-action="reset-runner-binding-configuration">恢复此能力默认配置</button>
    </aside>
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
  const runnerSourceFeatureId = getRunnerSourceFeatureId();
  const runnerSource = runnerFeatures.find((feature) => feature.id === runnerSourceFeatureId);
  const runnerTargetIds = new Set(getRunnerTargetIds(runnerSourceFeatureId));
  const runnerConfigTargetFeatureId = getRunnerConfigTargetFeatureId(runnerTargetIds);
  const runnerConfigTarget = runnerFeatures.find((feature) => feature.id === runnerConfigTargetFeatureId);
  const selectedRunnerTargets = runnerFeatures.filter((feature) => runnerTargetIds.has(feature.id));
  const runnerSourcesByGroup = runnerFeatures.reduce((groups, feature) => {
    if (!groups.has(feature.groupId)) groups.set(feature.groupId, { name: feature.groupName, features: [] });
    groups.get(feature.groupId).features.push(feature);
    return groups;
  }, new Map());
  const runnerTargetsByGroup = runnerFeatures
    .filter((feature) => feature.id !== runnerSourceFeatureId)
    .reduce((groups, feature) => {
      if (!groups.has(feature.groupId)) groups.set(feature.groupId, { name: feature.groupName, features: [] });
      groups.get(feature.groupId).features.push(feature);
      return groups;
    }, new Map());
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
          <div><h2 id="settings-runner-title">运行器</h2><p>配置功能之间允许调用的 Runner：一个来源功能可以绑定多个目标功能。</p></div>
          <span class="settings-scope-badge">固定配置</span>
        </header>
        <div class="settings-runner-intro">
          <strong>调用关系、输出字段与参数会统一保存。</strong>
          <span>来源能力发起自动调用时，将按当前白名单和右侧配置执行。</span>
        </div>
        <div class="settings-runner-workspace">
          <aside class="settings-runner-sources" aria-labelledby="runner-source-list-title">
            <header class="settings-runner-pane-heading">
              <div><h3 id="runner-source-list-title">功能列表</h3><p>点击一个功能，配置它可调用的 Runner。</p></div>
              <span>${runnerFeatures.length} 个功能</span>
            </header>
            <div class="settings-runner-source-groups">
              ${[...runnerSourcesByGroup.values()].map((group) => `
                <section class="settings-runner-source-group">
                  <h4>${escapeHtml(group.name)}</h4>
                  <div class="settings-runner-source-list">
                    ${group.features.map((feature) => `<button class="settings-runner-source ${feature.id === runnerSourceFeatureId ? "is-selected" : ""}" type="button" data-settings-action="select-runner-source" data-source-feature-id="${escapeHtml(feature.id)}" aria-pressed="${feature.id === runnerSourceFeatureId}">
                      <span><strong>${escapeHtml(feature.name)}</strong><small><code>${escapeHtml(feature.id)}</code></small></span>
                      <span class="settings-runner-source-state" aria-hidden="true">${feature.id === runnerSourceFeatureId ? "已选" : ""}</span>
                    </button>`).join("")}
                  </div>
                </section>
              `).join("")}
            </div>
          </aside>
          <section class="settings-runner-target-section" aria-labelledby="runner-target-list-title">
            <header class="settings-runner-target-heading">
              <div><h3 id="runner-target-list-title">可调用能力</h3><p>${runnerSource ? `当前来源：${runnerSource.groupName} / ${runnerSource.name}` : "暂无可配置的来源功能。"}</p></div>
              <span>${runnerTargetIds.size} 个已启用</span>
            </header>
            <div class="settings-runner-current-source">
              <span>来源 Runner</span><code>${escapeHtml(runnerSourceFeatureId || "-")}</code><span>点击下方能力可多选，选中结果会立即回显。</span>
            </div>
            <div class="settings-runner-selection-summary" aria-live="polite">
              <strong>已选目标</strong>
              <div>${selectedRunnerTargets.length ? selectedRunnerTargets.map((feature) => `<span>${escapeHtml(feature.name)}</span>`).join("") : "<em>暂未选择，点击下方能力进行配置。</em>"}</div>
            </div>
            <div class="settings-runner-target-groups">
              ${runnerTargetsByGroup.size ? [...runnerTargetsByGroup.values()].map((group) => `
                <section class="settings-runner-target-group">
                  <h4>${escapeHtml(group.name)}</h4>
                  <div class="settings-runner-target-list">
                    ${group.features.map((feature) => `<div class="settings-runner-target ${runnerTargetIds.has(feature.id) ? "is-selected" : ""} ${feature.id === runnerConfigTargetFeatureId ? "is-configuring" : ""}">
                      <label class="settings-runner-target-toggle" aria-label="${runnerTargetIds.has(feature.id) ? "停用" : "启用"} ${escapeHtml(feature.name)}">
                        <input type="checkbox" value="${escapeHtml(feature.id)}" data-runner-target ${runnerTargetIds.has(feature.id) ? "checked" : ""}>
                        <span class="settings-runner-target-check" aria-hidden="true">✓</span>
                      </label>
                      <button class="settings-runner-target-copy" type="button" data-settings-action="select-runner-config-target" data-target-feature-id="${escapeHtml(feature.id)}" aria-current="${feature.id === runnerConfigTargetFeatureId ? "true" : "false"}">
                        <strong>${escapeHtml(feature.name)}</strong><small><code>${escapeHtml(feature.id)}</code></small>
                      </button>
                    </div>`).join("")}
                  </div>
                </section>
              `).join("") : '<p class="settings-runner-empty">没有其他已注册的 Runner 可供选择。</p>'}
            </div>
          </section>
          ${runnerConfigurationPanelTemplate(runnerSourceFeatureId, runnerConfigTarget)}
        </div>
        <footer class="settings-runner-footer">
          <span>映射：<code>${escapeHtml(runnerSourceFeatureId || "-")}</code> → ${runnerTargetIds.size ? `${runnerTargetIds.size} 个 Runner` : "未配置目标"}</span>
          <button class="settings-text-button" type="button" data-settings-action="clear-runner-targets" ${runnerTargetIds.size ? "" : "disabled"}>清空当前配置</button>
        </footer>
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
  `;
}

function renderSettings() {
  const root = document.getElementById("settingsRoot");
  if (root && state.settingsDraft) root.innerHTML = settingsPanelTemplate();
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

function getTransferStatusMeta(status) {
  const statusMap = {
    [TRANSFER_STATUS.TRANSFERRING]: { label: "传输中", tone: "processing" },
    [TRANSFER_STATUS.SUCCESS]: { label: "成功", tone: "success" },
    [TRANSFER_STATUS.FAILED]: { label: "失败", tone: "error" },
    [TRANSFER_STATUS.NOT_REQUIRED]: { label: "无需传输", tone: "muted" }
  };
  return statusMap[status] || statusMap[TRANSFER_STATUS.NOT_REQUIRED];
}

function transferStatusPill(status) {
  const meta = getTransferStatusMeta(status);
  return `<span class="transfer-status-pill ${meta.tone}">${meta.label}</span>`;
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

function transferFilterFields(kind, rows) {
  const isData = kind === "data";
  const filters = isData ? state.transferDataFilters : state.transferTaskFilters;
  const featureOptions = getTransferFilterOptions(rows, "featureId", "featureName");
  const platformOptions = getTransferFilterOptions(rows, "platformId", "platformName");
  const isOpen = isData ? state.transferDataFiltersOpen : state.transferTaskFiltersOpen;
  const statusOptions = isData
    ? [
        { value: TRANSFER_STATUS.TRANSFERRING, label: "传输中" },
        { value: TRANSFER_STATUS.SUCCESS, label: "成功" },
        { value: TRANSFER_STATUS.FAILED, label: "失败" },
        { value: TRANSFER_STATUS.NOT_REQUIRED, label: "无需传输" }
      ]
    : [
        { value: TRANSFER_STATUS.TRANSFERRING, label: "传输中" },
        { value: TRANSFER_STATUS.SUCCESS, label: "成功" },
        { value: TRANSFER_STATUS.FAILED, label: "失败" },
        { value: TRANSFER_STATUS.NOT_REQUIRED, label: "无需传输" }
      ];
  const triggerOptions = [
    { value: "manual", label: "手动触发" },
    { value: "runner", label: "运行器" },
    { value: "local", label: "本地归档" }
  ];

  return `
    <div class="transfer-toolbar">
      <label class="transfer-search-field">
        <span class="sr-only">搜索${isData ? "数据" : "任务"}</span>
        <input type="search" placeholder="搜索标题、链接、功能或任务编号" value="${escapeHtml(filters.query)}" data-transfer-filter="query" data-transfer-kind="${kind}">
      </label>
      <div class="transfer-toolbar-actions">
        <button class="transfer-secondary-button" type="button" data-transfer-action="toggle-${kind}-filters" aria-expanded="${isOpen}">${isOpen ? "收起筛选" : "展开筛选"}</button>
        <button class="transfer-icon-button" type="button" data-transfer-action="refresh-transfer" aria-label="刷新本地数据" title="刷新本地数据">刷新</button>
      </div>
    </div>
    <section class="transfer-filter-panel" ${isOpen ? "" : "hidden"} aria-label="${isData ? "数据" : "任务"}筛选条件">
      <div class="transfer-filter-grid">
        <label><span>平台</span><select data-transfer-filter="platform" data-transfer-kind="${kind}">${transferOptionMarkup(platformOptions, filters.platform, "全部平台")}</select></label>
        <label><span>功能</span><select data-transfer-filter="feature" data-transfer-kind="${kind}">${transferOptionMarkup(featureOptions, filters.feature, "全部功能")}</select></label>
        ${isData ? `<label><span>本地状态</span><select data-transfer-filter="localStatus" data-transfer-kind="${kind}"><option value="__all__">全部本地状态</option><option value="stored" ${filters.localStatus === "stored" ? "selected" : ""}>本地已保存</option></select></label>` : `<label><span>触发来源</span><select data-transfer-filter="trigger" data-transfer-kind="${kind}">${transferOptionMarkup(triggerOptions, filters.trigger, "全部来源")}</select></label>`}
        <label><span>${isData ? "传输状态" : "任务状态"}</span><select data-transfer-filter="${isData ? "transferStatus" : "status"}" data-transfer-kind="${kind}">${transferOptionMarkup(statusOptions, isData ? filters.transferStatus : filters.status, "全部状态")}</select></label>
        <label><span>${isData ? "采集开始日期" : "创建开始日期"}</span><input type="date" value="${escapeHtml(filters.dateStart)}" data-transfer-filter="dateStart" data-transfer-kind="${kind}"></label>
        <label><span>${isData ? "采集结束日期" : "创建结束日期"}</span><input type="date" value="${escapeHtml(filters.dateEnd)}" data-transfer-filter="dateEnd" data-transfer-kind="${kind}"></label>
      </div>
      <footer class="transfer-filter-footer"><span>筛选仅影响当前列表与后续导出范围。</span><button type="button" data-transfer-action="clear-${kind}-filters">清空条件</button></footer>
    </section>
  `;
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

function openTransferDataDetail(row) {
  if (!row || !globalThis.document?.body) return;
  activeTransferDataDetailClose?.();

  const raw = row.raw && typeof row.raw === "object" && !Array.isArray(row.raw) ? row.raw : {};
  const fields = Object.entries(raw);
  const previousFocus = document.activeElement;
  const previousBodyOverflow = document.body.style.overflow;
  const titleId = `transferDataDetailTitle-${globalThis.crypto?.randomUUID?.() || Date.now()}`;
  const backdrop = document.createElement("div");
  backdrop.className = "transfer-data-detail-backdrop";
  backdrop.dataset.transferDataDetail = "";
  backdrop.innerHTML = `
    <section class="transfer-data-detail-dialog" role="dialog" aria-modal="true" aria-labelledby="${titleId}">
      <header class="transfer-data-detail-header">
        <div>
          <span>DATA DETAIL</span>
          <h2 id="${titleId}">数据详情</h2>
          <p>${escapeHtml(row.platformName)} / ${escapeHtml(row.featureName)}</p>
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
        ${fields.length ? `
          <dl class="transfer-data-detail-fields">
            ${fields.map(([key, value]) => `
              <div>
                <dt><code>${escapeHtml(key)}</code></dt>
                <dd>${renderTransferDetailValue(value)}</dd>
              </div>
            `).join("")}
          </dl>
        ` : '<div class="transfer-data-detail-no-fields">这条数据没有可展示的原始字段。</div>'}
      </div>
      <footer class="transfer-data-detail-footer">
        <span>共 ${fields.length} 个字段</span>
        <button type="button" data-transfer-detail-close>关闭详情</button>
      </footer>
    </section>
  `;

  const close = () => {
    document.removeEventListener("keydown", handleKeydown, true);
    backdrop.remove();
    document.body.style.overflow = previousBodyOverflow;
    if (activeTransferDataDetailClose === close) activeTransferDataDetailClose = null;
    if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
  };
  const handleKeydown = (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    close();
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

function transferDataTable(rows, pageState) {
  const body = rows.length ? rows.map((row) => `
    <tr>
      <td><span class="transfer-platform-name">${escapeHtml(row.platformName)}</span></td>
      <td>${escapeHtml(row.featureName)}</td>
      <td class="transfer-primary-cell"><button class="transfer-data-identifier" type="button" data-transfer-action="open-data-detail" data-transfer-row-id="${escapeHtml(row.id)}" aria-haspopup="dialog" aria-label="查看数据详情：${escapeHtml(row.title)}"><strong>${escapeHtml(row.title)}</strong><small>${escapeHtml(row.identifier)}</small></button></td>
      <td><time>${escapeHtml(formatTransferTime(row.collectedAt))}</time></td>
      <td><span class="transfer-local-status">本地已保存</span></td>
      <td>${transferStatusPill(row.transferStatus)}</td>
    </tr>
  `).join("") : `<tr><td class="transfer-empty-cell" colspan="6">没有符合当前条件的数据。</td></tr>`;
  return `
    <div class="transfer-table-shell" tabindex="0">
      <table class="transfer-table">
        <thead><tr><th>平台</th><th>功能</th><th>标题 / 唯一标识</th><th>采集时间</th><th>本地状态</th><th>传输状态</th></tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>
    ${transferPagination("data", pageState)}
  `;
}

function getTransferTriggerLabel(trigger) {
  return ({ manual: "手动触发", runner: "运行器", local: "本地归档" })[trigger] || "未知来源";
}

function transferTaskTable(rows, pageState) {
  const body = rows.length ? rows.map((row) => `
    <tr>
      <td class="transfer-task-id"><strong>${escapeHtml(row.id)}</strong>${row.error ? `<small class="transfer-task-error">${escapeHtml(row.error)}</small>` : ""}</td>
      <td><span class="transfer-platform-name">${escapeHtml(row.platformName)}</span></td>
      <td>${escapeHtml(row.featureName)}</td>
      <td>${escapeHtml(getTransferTriggerLabel(row.trigger))}</td>
      <td>${row.dataCount} 条</td>
      <td><time>${escapeHtml(formatTransferTime(row.createdAt))}</time></td>
      <td>${transferStatusPill(row.status)}</td>
      <td>${row.status === TRANSFER_STATUS.NOT_REQUIRED ? "等待远程接入" : `${row.processed} / ${row.dataCount}`}</td>
    </tr>
  `).join("") : `<tr><td class="transfer-empty-cell" colspan="8">没有符合当前条件的传输任务。</td></tr>`;
  return `
    <div class="transfer-table-shell" tabindex="0">
      <table class="transfer-table transfer-task-table">
        <thead><tr><th>任务编号</th><th>平台</th><th>功能</th><th>触发来源</th><th>数据范围</th><th>创建时间</th><th>状态</th><th>进度 / 结果</th></tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>
    ${transferPagination("task", pageState)}
  `;
}

function transferSummaryLabel(rows, type) {
  const total = rows.length;
  const statusKey = type === "data" ? "transferStatus" : "status";
  const counts = rows.reduce((result, row) => {
    const status = row[statusKey] || TRANSFER_STATUS.NOT_REQUIRED;
    result[status] = (result[status] || 0) + 1;
    return result;
  }, {});
  const orderedStatuses = [TRANSFER_STATUS.TRANSFERRING, TRANSFER_STATUS.SUCCESS, TRANSFER_STATUS.FAILED, TRANSFER_STATUS.NOT_REQUIRED]
    .filter((status) => counts[status]);
  return `<div class="transfer-list-summary"><strong>${type === "data" ? "数据" : "任务"} ${total} 条</strong>${orderedStatuses.map((status) => {
    const meta = getTransferStatusMeta(status);
    return `<span class="${meta.tone}">${meta.label} ${counts[status]}</span>`;
  }).join("")}</div>`;
}

function transferWorkspaceTemplate() {
  if (state.transferLoading && !state.transferWorkspace) {
    return '<section class="transfer-loading" aria-live="polite">正在读取各功能的本地存储…</section>';
  }

  const workspace = state.transferWorkspace || { isPreview: false, dataRows: [], taskRows: [] };
  const dataRows = Array.isArray(workspace.dataRows) ? workspace.dataRows : [];
  const taskRows = Array.isArray(workspace.taskRows) ? workspace.taskRows : [];
  const filteredDataRows = filterTransferDataRows(dataRows, state.transferDataFilters);
  const filteredTaskRows = filterTransferTaskRows(taskRows, state.transferTaskFilters);
  const dataPage = paginateTransferRows(filteredDataRows, state.transferDataPage, 20);
  const taskPage = paginateTransferRows(filteredTaskRows, state.transferTaskPage, 20);
  state.transferDataPage = dataPage.currentPage;
  state.transferTaskPage = taskPage.currentPage;
  const isData = state.transferTab === "data";
  const notice = state.transferNotice
    ? `<div class="transfer-notice ${escapeHtml(state.transferNotice.tone)}" role="status">${escapeHtml(state.transferNotice.text)}</div>`
    : `<div class="transfer-notice ${workspace.isPreview ? "info" : "neutral"}" role="status">${workspace.isPreview ? "网页预览展示示例数据；在扩展中会聚合所有功能的本地存储。" : "已读取各功能的本地存储。远程归档尚未接入，当前不会上传数据。"}</div>`;
  const activeRows = isData ? dataRows : taskRows;
  const activePage = isData ? dataPage : taskPage;

  return `
    <section class="transfer-workspace" aria-label="数据传输工作台">
      ${notice}
      <div class="transfer-tabs" role="tablist" aria-label="数据传输内容">
        <button type="button" role="tab" aria-selected="${isData}" class="${isData ? "active" : ""}" data-transfer-tab="data">数据 <span>${dataRows.length}</span></button>
        <button type="button" role="tab" aria-selected="${!isData}" class="${!isData ? "active" : ""}" data-transfer-tab="task">任务 <span>${taskRows.length}</span></button>
      </div>
      <section class="transfer-content" role="tabpanel">
        <header class="transfer-content-header">
          <div>
            <h2>${isData ? "所有本地数据" : "传输任务"}</h2>
            <p>${isData ? "按平台、功能、采集时间和传输状态筛选所有本地采集结果。" : "查看归档任务的触发来源、状态、数据范围与失败信息。"}</p>
          </div>
          <button class="transfer-primary-disabled" type="button" disabled>远程同步尚未接入</button>
        </header>
        ${transferFilterFields(isData ? "data" : "task", activeRows)}
        ${transferSummaryLabel(isData ? filteredDataRows : filteredTaskRows, isData ? "data" : "task")}
        ${isData ? transferDataTable(dataPage.items, dataPage) : transferTaskTable(taskPage.items, taskPage)}
      </section>
    </section>
  `;
}

function renderTransfer() {
  const root = document.getElementById("transferRoot");
  if (root) root.innerHTML = transferWorkspaceTemplate();
}

async function refreshTransferWorkspace() {
  state.transferLoading = true;
  state.transferNotice = null;
  if (state.activePage === "transfer") renderTransfer();
  try {
    state.transferWorkspace = await loadTransferWorkspace(getTransferFeatureDescriptors());
  } catch (error) {
    state.transferWorkspace = { isPreview: false, dataRows: [], taskRows: [], loadedAt: "" };
    state.transferNotice = { tone: "error", text: `读取本地数据失败：${error.message || String(error)}` };
  } finally {
    state.transferLoading = false;
    if (state.activePage === "transfer") renderTransfer();
  }
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
      state.runnerConfigTargetFeatureId = "xiaohongshu/post-detail";
      state.settingsNotice = { tone: "info", text: "已载入全部默认值，保存后应用。" };
      updateSettingsDirtyState();
      renderSettings();
      return;
    }
    if (action === "select-runner-source") {
      state.runnerSourceFeatureId = button.dataset.sourceFeatureId || "";
      state.runnerConfigTargetFeatureId = "";
      state.settingsNotice = null;
      renderSettings();
      return;
    }
    if (action === "select-runner-config-target") {
      const sourceFeatureId = getRunnerSourceFeatureId();
      const targetFeatureId = button.dataset.targetFeatureId || "";
      const wasEnabled = getRunnerTargetIds(sourceFeatureId).includes(targetFeatureId);
      if (!wasEnabled) setRunnerTargetEnabled(sourceFeatureId, targetFeatureId, true);
      state.runnerConfigTargetFeatureId = targetFeatureId;
      state.settingsNotice = null;
      if (!wasEnabled) updateSettingsDirtyState();
      renderSettings();
      return;
    }
    if (action === "select-all-runner-output-fields") {
      const sourceFeatureId = getRunnerSourceFeatureId();
      const targetFeatureId = getRunnerConfigTargetFeatureId();
      const configuration = getDraftRunnerBindingConfiguration(sourceFeatureId, targetFeatureId);
      configuration.outputFields = getRunnerCapabilitySchema(targetFeatureId).outputFields.map((item) => item.key);
      setDraftRunnerBindingConfiguration(sourceFeatureId, targetFeatureId, configuration);
      state.settingsNotice = null;
      updateSettingsDirtyState();
      renderSettings();
      return;
    }
    if (action === "reset-runner-binding-configuration") {
      const sourceFeatureId = getRunnerSourceFeatureId();
      const targetFeatureId = getRunnerConfigTargetFeatureId();
      setDraftRunnerBindingConfiguration(sourceFeatureId, targetFeatureId, {});
      state.settingsNotice = { tone: "info", text: "已恢复当前能力的默认字段与调用参数，保存后生效。" };
      updateSettingsDirtyState();
      renderSettings();
      return;
    }
    if (action === "clear-runner-targets") {
      const sourceFeatureId = getRunnerSourceFeatureId();
      delete state.settingsDraft.runners.callableByFeature[sourceFeatureId];
      delete state.settingsDraft.runners.configurationByBinding?.[sourceFeatureId];
      state.runnerConfigTargetFeatureId = "";
      state.settingsNotice = { tone: "info", text: "已清空当前来源功能的可调用 Runner 配置，保存后生效。" };
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
    if (event.target.matches('[data-runner-parameter]:not([type="checkbox"])')) {
      const sourceFeatureId = getRunnerSourceFeatureId();
      const targetFeatureId = getRunnerConfigTargetFeatureId();
      const configuration = getDraftRunnerBindingConfiguration(sourceFeatureId, targetFeatureId);
      configuration.parameters[event.target.dataset.runnerParameter] = event.target.value;
      setDraftRunnerBindingConfiguration(sourceFeatureId, targetFeatureId, configuration);
      state.settingsNotice = null;
      updateSettingsDirtyState();
      return;
    }
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
    if (event.target.matches("[data-runner-target]")) {
      setRunnerTargetEnabled(getRunnerSourceFeatureId(), event.target.value, event.target.checked);
      state.settingsNotice = null;
      updateSettingsDirtyState();
      renderSettings();
      return;
    }
    if (event.target.matches("[data-runner-output-field]")) {
      const sourceFeatureId = getRunnerSourceFeatureId();
      const targetFeatureId = getRunnerConfigTargetFeatureId();
      const configuration = getDraftRunnerBindingConfiguration(sourceFeatureId, targetFeatureId);
      const outputFields = new Set(configuration.outputFields);
      if (event.target.checked) outputFields.add(event.target.value);
      else outputFields.delete(event.target.value);
      if (!outputFields.size) {
        state.settingsNotice = { tone: "error", text: "输出字段至少保留一项。" };
        renderSettings();
        return;
      }
      configuration.outputFields = [...outputFields];
      setDraftRunnerBindingConfiguration(sourceFeatureId, targetFeatureId, configuration);
      state.settingsNotice = null;
      updateSettingsDirtyState();
      renderSettings();
      return;
    }
    if (event.target.matches("[data-runner-parameter]")) {
      const sourceFeatureId = getRunnerSourceFeatureId();
      const targetFeatureId = getRunnerConfigTargetFeatureId();
      const configuration = getDraftRunnerBindingConfiguration(sourceFeatureId, targetFeatureId);
      const parameter = event.target.dataset.runnerParameter;
      configuration.parameters[parameter] = event.target.type === "checkbox"
        ? event.target.checked
        : event.target.value;
      setDraftRunnerBindingConfiguration(sourceFeatureId, targetFeatureId, configuration);
      state.settingsNotice = null;
      updateSettingsDirtyState();
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

  const transferRoot = document.getElementById("transferRoot");
  transferRoot.addEventListener("click", (event) => {
    const tab = event.target.closest("[data-transfer-tab]");
    if (tab) {
      state.transferTab = tab.dataset.transferTab === "task" ? "task" : "data";
      renderTransfer();
      return;
    }

    const button = event.target.closest("[data-transfer-action]");
    if (!button || button.disabled) return;
    const action = button.dataset.transferAction;
    if (action === "open-data-detail") {
      const row = state.transferWorkspace?.dataRows?.find((item) => item.id === button.dataset.transferRowId);
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
    if (action === "toggle-task-filters") {
      state.transferTaskFiltersOpen = !state.transferTaskFiltersOpen;
      renderTransfer();
      return;
    }
    if (action === "clear-data-filters") {
      state.transferDataFilters = { query: "", platform: "__all__", feature: "__all__", localStatus: "__all__", transferStatus: "__all__", dateStart: "", dateEnd: "" };
      state.transferDataPage = 1;
      renderTransfer();
      return;
    }
    if (action === "clear-task-filters") {
      state.transferTaskFilters = { query: "", platform: "__all__", feature: "__all__", trigger: "__all__", status: "__all__", dateStart: "", dateEnd: "" };
      state.transferTaskPage = 1;
      renderTransfer();
      return;
    }
    if (action === "data-prev" || action === "data-next") {
      state.transferDataPage += action === "data-prev" ? -1 : 1;
      renderTransfer();
      return;
    }
    if (action === "task-prev" || action === "task-next") {
      state.transferTaskPage += action === "task-prev" ? -1 : 1;
      renderTransfer();
    }
  });

  function updateTransferFilter(event) {
    const field = event.target.dataset.transferFilter;
    const kind = event.target.dataset.transferKind;
    if (!field || !kind) return;
    const filters = kind === "task" ? state.transferTaskFilters : state.transferDataFilters;
    filters[field] = event.target.value;
    if (kind === "task") state.transferTaskPage = 1;
    else state.transferDataPage = 1;
    renderTransfer();
  }

  transferRoot.addEventListener("input", updateTransferFilter);
  transferRoot.addEventListener("change", updateTransferFilter);

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
