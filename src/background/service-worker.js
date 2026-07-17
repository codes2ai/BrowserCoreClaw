import { captureGoogleNews, stopGoogleNewsCapture } from "../groups/google/google-news/background.js";
import { MESSAGE_CAPTURE_GOOGLE_NEWS, MESSAGE_STOP_GOOGLE_NEWS } from "../groups/google/google-news/constants.js";
import {
  captureXiaohongshuKeyword,
  checkXiaohongshuLogin,
  openXiaohongshuLogin,
  stopXiaohongshuKeywordCapture
} from "../groups/xiaohongshu/keyword-search/background.js";
import {
  MESSAGE_CAPTURE_XIAOHONGSHU_KEYWORD,
  MESSAGE_CHECK_XIAOHONGSHU_LOGIN,
  MESSAGE_OPEN_XIAOHONGSHU_LOGIN,
  MESSAGE_STOP_XIAOHONGSHU_KEYWORD
} from "../groups/xiaohongshu/keyword-search/constants.js";
import {
  captureXiaohongshuProfile,
  stopXiaohongshuProfileCapture
} from "../groups/xiaohongshu/profile-notes/background.js";
import {
  MESSAGE_CAPTURE_XIAOHONGSHU_PROFILE,
  MESSAGE_STOP_XIAOHONGSHU_PROFILE
} from "../groups/xiaohongshu/profile-notes/constants.js";
import {
  captureXiaohongshuProfileInfo,
  stopXiaohongshuProfileInfoCapture
} from "../groups/xiaohongshu/profile-info/background.js";
import {
  MESSAGE_CAPTURE_XIAOHONGSHU_PROFILE_INFO,
  MESSAGE_STOP_XIAOHONGSHU_PROFILE_INFO
} from "../groups/xiaohongshu/profile-info/constants.js";
import {
  captureXiaohongshuPostDetail,
  stopXiaohongshuPostDetailCapture
} from "../groups/xiaohongshu/post-detail/background.js";
import {
  MESSAGE_CAPTURE_XIAOHONGSHU_POST_DETAIL,
  MESSAGE_STOP_XIAOHONGSHU_POST_DETAIL
} from "../groups/xiaohongshu/post-detail/constants.js";
import {
  checkWeiboProfilePostsLogin,
  captureWeiboProfilePosts,
  openWeiboProfilePostsLogin,
  stopWeiboProfilePostsCapture
} from "../groups/weibo/profile-posts/background.js";
import {
  MESSAGE_CHECK_WEIBO_PROFILE_POSTS_LOGIN,
  MESSAGE_CAPTURE_WEIBO_PROFILE_POSTS,
  MESSAGE_OPEN_WEIBO_PROFILE_POSTS_LOGIN,
  MESSAGE_STOP_WEIBO_PROFILE_POSTS
} from "../groups/weibo/profile-posts/constants.js";
import {
  captureWeiboProfileInfo,
  stopWeiboProfileInfoCapture
} from "../groups/weibo/profile-info/background.js";
import {
  MESSAGE_CAPTURE_WEIBO_PROFILE_INFO,
  MESSAGE_STOP_WEIBO_PROFILE_INFO
} from "../groups/weibo/profile-info/constants.js";
import {
  captureWeiboPostDetail,
  stopWeiboPostDetailCapture
} from "../groups/weibo/post-detail/background.js";
import {
  MESSAGE_CAPTURE_WEIBO_POST_DETAIL,
  MESSAGE_STOP_WEIBO_POST_DETAIL
} from "../groups/weibo/post-detail/constants.js";
import {
  captureDouyinProfilePosts,
  stopDouyinProfilePostsCapture
} from "../groups/douyin/profile-posts/background.js";
import {
  MESSAGE_CAPTURE_DOUYIN_PROFILE_POSTS,
  MESSAGE_STOP_DOUYIN_PROFILE_POSTS
} from "../groups/douyin/profile-posts/constants.js";
import {
  captureDouyinProfileInfo,
  stopDouyinProfileInfoCapture
} from "../groups/douyin/profile-info/background.js";
import {
  MESSAGE_CAPTURE_DOUYIN_PROFILE_INFO,
  MESSAGE_STOP_DOUYIN_PROFILE_INFO
} from "../groups/douyin/profile-info/constants.js";
import {
  captureDouyinPostDetail,
  stopDouyinPostDetailCapture
} from "../groups/douyin/post-detail/background.js";
import {
  MESSAGE_CAPTURE_DOUYIN_POST_DETAIL,
  MESSAGE_STOP_DOUYIN_POST_DETAIL
} from "../groups/douyin/post-detail/constants.js";
import {
  executeFeatureRunner,
  getFeatureRunnerTask,
  listRegisteredFeatureRunners,
  stopFeatureRunner,
  validateFeatureRunnerRequest
} from "./runner-controller.js";
import {
  MESSAGE_EXECUTE_FEATURE_RUNNER,
  MESSAGE_GET_FEATURE_RUNNER_TASK,
  MESSAGE_LIST_FEATURE_RUNNERS,
  MESSAGE_STOP_FEATURE_RUNNER,
  MESSAGE_VALIDATE_FEATURE_RUNNER
} from "./runner-messages.js";

const DASHBOARD_PATH = "sidepanel.html";
let dashboardOpenPromise = null;

function callChrome(callbackApi) {
  return new Promise((resolve, reject) => {
    callbackApi((result) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(result);
    });
  });
}

function isDashboardTab(tab, dashboardUrl) {
  return tab?.url === dashboardUrl || tab?.pendingUrl === dashboardUrl;
}

async function openOrFocusDashboard() {
  const dashboardUrl = chrome.runtime.getURL(DASHBOARD_PATH);
  const tabs = await callChrome((done) => chrome.tabs.query({}, done));
  const existing = tabs
    .filter((tab) => isDashboardTab(tab, dashboardUrl))
    .sort((first, second) => {
      if (first.active !== second.active) return first.active ? -1 : 1;
      return (second.lastAccessed || 0) - (first.lastAccessed || 0);
    })[0];

  if (Number.isInteger(existing?.id)) {
    if (Number.isInteger(existing.windowId)) {
      await callChrome((done) => chrome.windows.update(existing.windowId, { focused: true }, done));
    }
    return callChrome((done) => chrome.tabs.update(existing.id, { active: true }, done));
  }

  return callChrome((done) => chrome.tabs.create({ url: dashboardUrl, active: true }, done));
}

function ensureDashboardOpen() {
  if (!dashboardOpenPromise) {
    dashboardOpenPromise = openOrFocusDashboard().finally(() => {
      dashboardOpenPromise = null;
    });
  }
  return dashboardOpenPromise;
}

chrome.action.onClicked.addListener(() => {
  ensureDashboardOpen().catch((error) => {
    console.error("无法打开 BrowserCoreClaw 控制台：", error);
  });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handlers = {
    [MESSAGE_CAPTURE_GOOGLE_NEWS]: captureGoogleNews,
    [MESSAGE_STOP_GOOGLE_NEWS]: stopGoogleNewsCapture,
    [MESSAGE_CHECK_XIAOHONGSHU_LOGIN]: checkXiaohongshuLogin,
    [MESSAGE_OPEN_XIAOHONGSHU_LOGIN]: openXiaohongshuLogin,
    [MESSAGE_CAPTURE_XIAOHONGSHU_KEYWORD]: captureXiaohongshuKeyword,
    [MESSAGE_STOP_XIAOHONGSHU_KEYWORD]: stopXiaohongshuKeywordCapture,
    [MESSAGE_CAPTURE_XIAOHONGSHU_PROFILE]: captureXiaohongshuProfile,
    [MESSAGE_STOP_XIAOHONGSHU_PROFILE]: stopXiaohongshuProfileCapture,
    [MESSAGE_CAPTURE_XIAOHONGSHU_PROFILE_INFO]: captureXiaohongshuProfileInfo,
    [MESSAGE_STOP_XIAOHONGSHU_PROFILE_INFO]: stopXiaohongshuProfileInfoCapture,
    [MESSAGE_CAPTURE_XIAOHONGSHU_POST_DETAIL]: captureXiaohongshuPostDetail,
    [MESSAGE_STOP_XIAOHONGSHU_POST_DETAIL]: stopXiaohongshuPostDetailCapture,
    [MESSAGE_CAPTURE_WEIBO_PROFILE_POSTS]: captureWeiboProfilePosts,
    [MESSAGE_CHECK_WEIBO_PROFILE_POSTS_LOGIN]: checkWeiboProfilePostsLogin,
    [MESSAGE_OPEN_WEIBO_PROFILE_POSTS_LOGIN]: openWeiboProfilePostsLogin,
    [MESSAGE_STOP_WEIBO_PROFILE_POSTS]: stopWeiboProfilePostsCapture,
    [MESSAGE_CAPTURE_WEIBO_PROFILE_INFO]: captureWeiboProfileInfo,
    [MESSAGE_STOP_WEIBO_PROFILE_INFO]: stopWeiboProfileInfoCapture,
    [MESSAGE_CAPTURE_WEIBO_POST_DETAIL]: captureWeiboPostDetail,
    [MESSAGE_STOP_WEIBO_POST_DETAIL]: stopWeiboPostDetailCapture,
    [MESSAGE_CAPTURE_DOUYIN_PROFILE_POSTS]: captureDouyinProfilePosts,
    [MESSAGE_STOP_DOUYIN_PROFILE_POSTS]: stopDouyinProfilePostsCapture,
    [MESSAGE_CAPTURE_DOUYIN_PROFILE_INFO]: captureDouyinProfileInfo,
    [MESSAGE_STOP_DOUYIN_PROFILE_INFO]: stopDouyinProfileInfoCapture,
    [MESSAGE_CAPTURE_DOUYIN_POST_DETAIL]: captureDouyinPostDetail,
    [MESSAGE_STOP_DOUYIN_POST_DETAIL]: stopDouyinPostDetailCapture,
    [MESSAGE_LIST_FEATURE_RUNNERS]: listRegisteredFeatureRunners,
    [MESSAGE_VALIDATE_FEATURE_RUNNER]: validateFeatureRunnerRequest,
    [MESSAGE_EXECUTE_FEATURE_RUNNER]: executeFeatureRunner,
    [MESSAGE_STOP_FEATURE_RUNNER]: stopFeatureRunner,
    [MESSAGE_GET_FEATURE_RUNNER_TASK]: getFeatureRunnerTask
  };
  const handler = handlers[message?.type];
  if (!handler) {
    return false;
  }

  Promise.resolve()
    .then(() => handler(message.options || {}))
    .then(sendResponse)
    .catch((error) => {
      sendResponse({
        ok: false,
        error: error.message || String(error),
        errorCode: error.code || ""
      });
    });
  return true;
});
