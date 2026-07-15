import {
  buildFeatureKey,
  clearRunningFeatureKeys,
  FEATURE_RUN_STATUS_EVENT,
  loadRunningFeatureKeys
} from "../shared/feature-run-status.js";
import {
  getDefaultGlobalSettings,
  GLOBAL_SETTINGS_CHANGED_EVENT,
  loadGlobalSettings,
  normalizeGlobalSettings,
  saveGlobalSettings
} from "../shared/global-settings.js";

const CONFIG_PATH = "src/config/groups.json";
const FEATURE_STYLE_ID = "active-feature-style";

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
  query: ""
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
  if (globalThis.chrome?.runtime?.getURL) {
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

        <section id="featureView" class="feature-view" hidden>
          <button id="backToCatalog" class="back-button" type="button">
            <span aria-hidden="true">←</span> 功能列表
          </button>
          <div id="featureRoot"></div>
        </section>
      </main>
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
    `
  };

  return `
    <nav class="settings-tabs" aria-label="设置分类">
      <button class="${activeTab === "basic" ? "active" : ""}" type="button" data-settings-tab="basic" aria-current="${activeTab === "basic" ? "page" : "false"}">基础</button>
      <button class="${activeTab === "limits" ? "active" : ""}" type="button" data-settings-tab="limits" aria-current="${activeTab === "limits" ? "page" : "false"}">Limit</button>
      <button class="${activeTab === "storage" ? "active" : ""}" type="button" data-settings-tab="storage" aria-current="${activeTab === "storage" ? "page" : "false"}">存储</button>
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
    document.title = state.activePage === "settings" ? `设置 · ${appName}` : appName;
  }
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
    document.getElementById("appHeader").hidden = true;
    document.getElementById("catalogView").hidden = true;
    document.getElementById("settingsView").hidden = true;
    document.getElementById("featureView").hidden = false;
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
  document.getElementById("appHeader").hidden = true;
  catalogView.hidden = true;
  document.getElementById("settingsView").hidden = true;
  featureView.hidden = false;
  featureRoot.innerHTML = '<div class="loading-state">正在加载功能模块…</div>';
  loadFeatureStyle(feature);

  try {
    const module = await import(extensionUrl(feature.entry));
    if (typeof module.mount !== "function") {
      throw new Error("功能入口必须导出 mount(container, context)。");
    }
    const cleanup = await module.mount(featureRoot, {
      app: {
        ...state.config.app,
        name: getAppName(),
        logoDataUrl: state.globalSettings.interface.logoDataUrl
      },
      globalSettings: cloneSettings(state.globalSettings),
      group,
      feature
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
  state.activePage = nextPage === "settings" ? "settings" : "catalog";
  document.getElementById("featureView").hidden = true;
  document.getElementById("appHeader").hidden = false;
  document.getElementById("catalogView").hidden = state.activePage !== "catalog";
  document.getElementById("settingsView").hidden = state.activePage !== "settings";
  document.querySelectorAll("[data-app-page]").forEach((button) => {
    const active = button.dataset.appPage === state.activePage;
    button.classList.toggle("active", active);
    if (active) {
      button.setAttribute("aria-current", "page");
    } else {
      button.removeAttribute("aria-current");
    }
  });
  if (state.activePage === "settings") renderSettings();
  document.title = state.activePage === "settings"
    ? `设置 · ${getAppName()}`
    : getAppName();
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

  document.getElementById("backToCatalog").addEventListener("click", () => {
    showCatalog().catch(console.error);
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
      state.settingsNotice = { tone: "info", text: "已载入全部默认值，保存后应用。" };
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
