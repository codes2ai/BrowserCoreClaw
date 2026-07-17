export const TRANSFER_SETTINGS_STORAGE_KEY = "browserCoreClawTransferSettingsV1";
export const TRANSFER_SETTINGS_CHANGED_EVENT = "browser-core-claw-transfer-settings-changed";

export const TRANSFER_CHANNEL_TYPES = Object.freeze({
  API: "api",
  MONGODB: "mongodb",
  DINGTALK_WEBHOOK: "dingtalk-webhook",
  FEISHU_WEBHOOK: "feishu-webhook",
  WECHAT_WORK_WEBHOOK: "wechat-work-webhook"
});

export const TRANSFER_STRATEGY_TYPES = Object.freeze({
  NO_CHANNEL: "no-channel",
  CHANNEL: "channel"
});

export const TRANSFER_STRATEGY_CHANNEL_MODES = Object.freeze({
  SELECTED: "selected",
  DEFAULT: "default"
});

export const TRANSFER_ACTIONS = Object.freeze({
  NOT_REQUIRED: "not_required",
  CHANNEL: "channel"
});

export const DEFAULT_TRANSFER_STRATEGY_ID = "strategy-default";
export const MAX_TRANSFER_STRATEGY_PRIORITY = 9999;
export const DEFAULT_TRANSFER_RETRY_COUNT = 3;
export const MIN_TRANSFER_RETRY_COUNT = 1;
export const MAX_TRANSFER_RETRY_COUNT = 10;
export const DEFAULT_TRANSFER_BATCH_SIZE = 20;
export const MIN_TRANSFER_BATCH_SIZE = 1;
export const MAX_TRANSFER_BATCH_SIZE = 500;

const AVAILABLE_CHANNEL_TYPES = new Set([
  TRANSFER_CHANNEL_TYPES.API,
  TRANSFER_CHANNEL_TYPES.MONGODB
]);

const CHANNEL_TYPE_LABELS = Object.freeze({
  [TRANSFER_CHANNEL_TYPES.API]: "API",
  [TRANSFER_CHANNEL_TYPES.MONGODB]: "MongoDB",
  [TRANSFER_CHANNEL_TYPES.DINGTALK_WEBHOOK]: "钉钉 Webhook",
  [TRANSFER_CHANNEL_TYPES.FEISHU_WEBHOOK]: "飞书 Webhook",
  [TRANSFER_CHANNEL_TYPES.WECHAT_WORK_WEBHOOK]: "企微 Webhook"
});

const STRATEGY_TYPE_LABELS = Object.freeze({
  [TRANSFER_STRATEGY_TYPES.NO_CHANNEL]: "无通道",
  [TRANSFER_STRATEGY_TYPES.CHANNEL]: "通道"
});

function hasExtensionStorage() {
  return Boolean(globalThis.chrome?.runtime?.id && chrome.storage?.local);
}

function callChrome(callbackApi) {
  return new Promise((resolve, reject) => {
    callbackApi((result) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(result);
    });
  });
}

function text(value, maxLength = 1000) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function isoNow() {
  return new Date().toISOString();
}

function createId(prefix = "channel") {
  if (globalThis.crypto?.randomUUID) return `${prefix}-${globalThis.crypto.randomUUID()}`;
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function normalizeType(value) {
  return AVAILABLE_CHANNEL_TYPES.has(value) ? value : TRANSFER_CHANNEL_TYPES.API;
}

function normalizeChannel(value = {}) {
  const type = normalizeType(value?.type);
  const config = value?.config && typeof value.config === "object" && !Array.isArray(value.config)
    ? value.config
    : {};
  return {
    id: text(value?.id, 160) || createId("channel"),
    type,
    name: text(value?.name, 80) || `${CHANNEL_TYPE_LABELS[type]} 通道`,
    enabled: value?.enabled !== false,
    isDefault: value?.isDefault === true,
    config: type === TRANSFER_CHANNEL_TYPES.MONGODB
      ? {
          connectionString: text(config.connectionString, 2000),
          database: text(config.database, 120),
          collection: text(config.collection, 120)
        }
      : {
          endpoint: text(config.endpoint, 2000),
          method: "POST",
          headers: text(config.headers, 4000),
          contentType: "application/json"
        },
    createdAt: text(value?.createdAt, 80) || isoNow(),
    updatedAt: text(value?.updatedAt, 80) || isoNow()
  };
}

function normalizeIdList(value, maxItems = 100) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => text(item, 160)).filter(Boolean))].slice(0, maxItems);
}

export function normalizeTransferStrategyPriority(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.min(MAX_TRANSFER_STRATEGY_PRIORITY, Math.max(0, Math.trunc(number)));
}

function normalizeBoundedInteger(value, fallback, minimum, maximum) {
  if (value === null || value === undefined || String(value).trim() === "") return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(number)));
}

export function normalizeTransferRetryCount(value) {
  return normalizeBoundedInteger(
    value,
    DEFAULT_TRANSFER_RETRY_COUNT,
    MIN_TRANSFER_RETRY_COUNT,
    MAX_TRANSFER_RETRY_COUNT
  );
}

export function normalizeTransferBatchSize(value) {
  return normalizeBoundedInteger(
    value,
    DEFAULT_TRANSFER_BATCH_SIZE,
    MIN_TRANSFER_BATCH_SIZE,
    MAX_TRANSFER_BATCH_SIZE
  );
}

function normalizeStrategy(value = {}, availableChannelIds = new Set()) {
  const inputType = value?.type;
  const hasKnownType = inputType === TRANSFER_STRATEGY_TYPES.NO_CHANNEL
    || inputType === TRANSFER_STRATEGY_TYPES.CHANNEL;
  const type = inputType === TRANSFER_STRATEGY_TYPES.CHANNEL
    ? TRANSFER_STRATEGY_TYPES.CHANNEL
    : TRANSFER_STRATEGY_TYPES.NO_CHANNEL;
  const platformIds = normalizeIdList(value?.platformIds, 50);
  const featureIds = normalizeIdList(value?.featureIds, 100)
    .filter((featureId) => platformIds.some((platformId) => featureId.startsWith(`${platformId}/`)));
  const requestedChannelIds = normalizeIdList(value?.channelIds, 50);
  const availableRequestedChannelIds = requestedChannelIds.filter((channelId) => availableChannelIds.has(channelId));
  const channelIds = type === TRANSFER_STRATEGY_TYPES.CHANNEL
    ? (availableRequestedChannelIds.length ? availableRequestedChannelIds : requestedChannelIds)
    : [];
  return {
    id: text(value?.id, 160) || createId("strategy"),
    name: text(value?.name, 80) || "未命名策略",
    type,
    channelMode: type === TRANSFER_STRATEGY_TYPES.CHANNEL
      ? TRANSFER_STRATEGY_CHANNEL_MODES.SELECTED
      : "none",
    platformIds,
    featureIds,
    channelIds,
    priority: normalizeTransferStrategyPriority(value?.priority),
    enabled: value?.enabled !== false && hasKnownType,
    readOnly: false,
    createdAt: text(value?.createdAt, 80) || isoNow(),
    updatedAt: text(value?.updatedAt, 80) || isoNow()
  };
}

export function getBuiltInDefaultTransferStrategy() {
  return {
    id: DEFAULT_TRANSFER_STRATEGY_ID,
    name: "默认策略",
    type: TRANSFER_STRATEGY_TYPES.CHANNEL,
    channelMode: TRANSFER_STRATEGY_CHANNEL_MODES.DEFAULT,
    platformIds: [],
    featureIds: [],
    channelIds: [],
    priority: 0,
    enabled: true,
    readOnly: true,
    createdAt: "",
    updatedAt: ""
  };
}

export function isBuiltInTransferStrategy(strategy) {
  return strategy?.id === DEFAULT_TRANSFER_STRATEGY_ID;
}

export function getTransferStrategyPriority(strategy) {
  if (isBuiltInTransferStrategy(strategy)) return 100;
  return strategy?.type === TRANSFER_STRATEGY_TYPES.NO_CHANNEL ? 300 : 200;
}

export function getTransferStrategyPriorityLabel(strategy) {
  const priority = getTransferStrategyPriority(strategy);
  if (priority === 300) return "最高";
  if (priority === 200) return "第二";
  return "最低";
}

export function compareTransferStrategies(left, right) {
  const typePriorityDifference = getTransferStrategyPriority(right) - getTransferStrategyPriority(left);
  if (typePriorityDifference) return typePriorityDifference;
  return normalizeTransferStrategyPriority(right?.priority) - normalizeTransferStrategyPriority(left?.priority);
}

export function getTransferStrategyTypeLabel(strategy) {
  if (isBuiltInTransferStrategy(strategy)) return "默认通道";
  return STRATEGY_TYPE_LABELS[strategy?.type] || "未知类型";
}

export function resolveTransferStrategyChannelIds(strategy, channels = []) {
  if (isBuiltInTransferStrategy(strategy)) {
    const defaultChannel = channels.find((channel) => channel?.isDefault === true);
    return defaultChannel ? [defaultChannel.id] : [];
  }
  if (strategy?.type !== TRANSFER_STRATEGY_TYPES.CHANNEL) return [];
  const availableChannelIds = new Set(channels.map((channel) => channel?.id).filter(Boolean));
  return normalizeIdList(strategy?.channelIds, 50).filter((channelId) => availableChannelIds.has(channelId));
}

function transferStrategyMatchesData(strategy, data = {}) {
  if (isBuiltInTransferStrategy(strategy)) return true;
  const platformId = text(data?.platformId, 160);
  const featureId = text(data?.featureId, 160);
  return strategy?.platformIds?.includes(platformId) && strategy?.featureIds?.includes(featureId);
}

function noTransferDecision(reason, strategy = null) {
  return {
    action: TRANSFER_ACTIONS.NOT_REQUIRED,
    reason,
    strategyId: strategy?.id || "",
    strategyName: strategy?.name || "",
    strategyType: strategy?.type || "",
    typePriority: strategy ? getTransferStrategyPriority(strategy) : 0,
    priority: strategy ? normalizeTransferStrategyPriority(strategy.priority) : 0,
    channelIds: [],
    channelNames: []
  };
}

export function createTransferStrategyResolver(value = {}) {
  const settings = normalizeTransferSettings(value);
  const channelById = new Map(settings.channels.map((channel) => [channel.id, channel]));
  const strategies = [...settings.strategies]
    .filter((strategy) => strategy.enabled)
    .sort(compareTransferStrategies);

  return (data = {}) => {
    if (!settings.enabled) return noTransferDecision("transfer_disabled");

    const strategy = strategies.find((candidate) => transferStrategyMatchesData(candidate, data));
    if (!strategy) return noTransferDecision("no_matching_strategy");
    if (strategy.type === TRANSFER_STRATEGY_TYPES.NO_CHANNEL) {
      return noTransferDecision("strategy_no_channel", strategy);
    }

    const channels = resolveTransferStrategyChannelIds(strategy, settings.channels)
      .map((channelId) => channelById.get(channelId))
      .filter((channel) => channel?.enabled);
    if (!channels.length) {
      return noTransferDecision(
        isBuiltInTransferStrategy(strategy) ? "default_channel_unavailable" : "strategy_channel_unavailable",
        strategy
      );
    }

    return {
      action: TRANSFER_ACTIONS.CHANNEL,
      reason: isBuiltInTransferStrategy(strategy) ? "default_channel" : "strategy_channel",
      strategyId: strategy.id,
      strategyName: strategy.name,
      strategyType: strategy.type,
      typePriority: getTransferStrategyPriority(strategy),
      priority: normalizeTransferStrategyPriority(strategy.priority),
      channelIds: channels.map((channel) => channel.id),
      channelNames: channels.map((channel) => channel.name)
    };
  };
}

export function resolveTransferStrategyDecision(data = {}, settings = {}) {
  return createTransferStrategyResolver(settings)(data);
}

export function normalizeTransferStrategies(value, channels = []) {
  const strategies = Array.isArray(value) ? value : [];
  const availableChannelIds = new Set(channels.map((channel) => channel?.id).filter(Boolean));
  const seenIds = new Set([DEFAULT_TRANSFER_STRATEGY_ID]);
  const customStrategies = strategies
    .filter((strategy) => strategy && typeof strategy === "object" && !isBuiltInTransferStrategy(strategy))
    .map((strategy) => normalizeStrategy(strategy, availableChannelIds))
    .filter((strategy) => {
      if (seenIds.has(strategy.id)) return false;
      seenIds.add(strategy.id);
      return true;
    })
    .slice(0, 99)
    .sort(compareTransferStrategies);
  return [...customStrategies, getBuiltInDefaultTransferStrategy()];
}

export function ensureSingleDefaultChannel(channels = []) {
  const items = Array.isArray(channels) ? channels : [];
  if (!items.length) return [];
  const defaultIndex = items.findIndex((channel) => channel?.isDefault === true);
  const selectedIndex = defaultIndex >= 0 ? defaultIndex : 0;
  return items.map((channel, index) => ({
    ...channel,
    isDefault: index === selectedIndex
  }));
}

export function getDefaultTransferSettings() {
  return {
    enabled: false,
    retryCount: DEFAULT_TRANSFER_RETRY_COUNT,
    batchSize: DEFAULT_TRANSFER_BATCH_SIZE,
    channels: [],
    strategies: [getBuiltInDefaultTransferStrategy()]
  };
}

export function getTransferChannelTypeLabel(type) {
  return CHANNEL_TYPE_LABELS[type] || "未知通道";
}

export function isTransferChannelTypeAvailable(type) {
  return AVAILABLE_CHANNEL_TYPES.has(type);
}

export function createTransferChannelDraft(type = TRANSFER_CHANNEL_TYPES.API) {
  return normalizeChannel({
    id: "",
    type,
    name: "",
    enabled: true,
    isDefault: false,
    config: {}
  });
}

export function createTransferStrategyDraft() {
  return normalizeStrategy({
    id: "",
    name: "新策略",
    type: TRANSFER_STRATEGY_TYPES.NO_CHANNEL,
    platformIds: [],
    featureIds: [],
    channelIds: [],
    priority: 0,
    enabled: true
  });
}

export function normalizeTransferSettings(value = {}) {
  const channels = Array.isArray(value?.channels) ? value.channels : [];
  const seenIds = new Set();
  const normalizedChannels = channels
    .filter((channel) => channel && typeof channel === "object")
    .map((channel) => normalizeChannel(channel))
    .filter((channel) => {
      if (seenIds.has(channel.id)) return false;
      seenIds.add(channel.id);
      return true;
    })
    .slice(0, 100);
  const finalChannels = ensureSingleDefaultChannel(normalizedChannels);
  return {
    enabled: value?.enabled === true,
    retryCount: normalizeTransferRetryCount(value?.retryCount),
    batchSize: normalizeTransferBatchSize(value?.batchSize),
    channels: finalChannels,
    strategies: normalizeTransferStrategies(value?.strategies, finalChannels)
  };
}

export async function loadTransferSettings() {
  if (hasExtensionStorage()) {
    const values = await callChrome((done) => chrome.storage.local.get(TRANSFER_SETTINGS_STORAGE_KEY, done));
    return normalizeTransferSettings(values?.[TRANSFER_SETTINGS_STORAGE_KEY]);
  }

  try {
    return normalizeTransferSettings(JSON.parse(globalThis.localStorage?.getItem(TRANSFER_SETTINGS_STORAGE_KEY) || "null"));
  } catch {
    return getDefaultTransferSettings();
  }
}

export async function saveTransferSettings(value) {
  const settings = normalizeTransferSettings(value);
  if (hasExtensionStorage()) {
    await callChrome((done) => chrome.storage.local.set({
      [TRANSFER_SETTINGS_STORAGE_KEY]: settings
    }, done));
  } else {
    globalThis.localStorage?.setItem(TRANSFER_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  }

  globalThis.dispatchEvent?.(new CustomEvent(TRANSFER_SETTINGS_CHANGED_EVENT, {
    detail: { settings }
  }));
  return settings;
}
