const CONFIG_PATH = "src/config/groups.json";
const FEATURE_STYLE_ID = "active-feature-style";

const state = {
  config: null,
  activePage: "catalog",
  activeFeature: null,
  activeGroup: null,
  unmountFeature: null,
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

function appTemplate(config) {
  const featureCount = countFeatures(config.groups);
  return `
    <div class="app-shell">
      <header id="appHeader" class="app-header">
        <button id="brandHome" class="brand-home" type="button" aria-label="返回功能列表">
          <span class="brand-mark" aria-hidden="true">BC</span>
          <span class="brand-name">${escapeHtml(config.app.name)}</span>
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
            <p>统一管理浏览器采集相关配置。</p>
          </header>
          <section class="settings-placeholder" aria-label="设置页面占位">
            <div>
              <strong>设置页面</strong>
              <p>后续将在这里加入通用采集、存储、导出和权限设置。</p>
              <span>功能规划中</span>
            </div>
          </section>
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

  return `
    <div class="feature-tile">
      <button
        class="feature-card"
        type="button"
        data-group-id="${escapeHtml(group.id)}"
        data-feature-id="${escapeHtml(feature.id)}"
        aria-label="打开 ${escapeHtml(feature.name)}"
      >
        <span class="feature-icon" aria-hidden="true">${escapeHtml(group.icon || group.name.slice(0, 1))}</span>
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
    document.title = `${feature.name} · ${state.config.app.name}`;
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
      app: state.config.app,
      group,
      feature
    });
    state.unmountFeature = typeof cleanup === "function" ? cleanup : null;
    document.title = `${feature.name} · ${state.config.app.name}`;
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
  document.title = state.activePage === "settings"
    ? `设置 · ${state.config.app.name}`
    : state.config.app.name;
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
}

async function init() {
  const root = document.getElementById("app");
  root.innerHTML = '<div class="boot-state">正在加载 BrowserCoreClaw…</div>';

  try {
    state.config = await loadConfig();
    root.innerHTML = appTemplate(state.config);
    renderGroups();
    bindEvents();
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
