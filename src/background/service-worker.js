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
  captureWeiboProfilePosts,
  stopWeiboProfilePostsCapture
} from "../groups/weibo/profile-posts/background.js";
import {
  MESSAGE_CAPTURE_WEIBO_PROFILE_POSTS,
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

async function enableActionToOpenSidePanel() {
  if (!chrome.sidePanel?.setPanelBehavior) {
    return;
  }

  await chrome.sidePanel.setPanelBehavior({
    openPanelOnActionClick: true
  });
}

chrome.runtime.onInstalled.addListener(() => {
  enableActionToOpenSidePanel().catch(console.error);
});

chrome.runtime.onStartup.addListener(() => {
  enableActionToOpenSidePanel().catch(console.error);
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
    [MESSAGE_CAPTURE_WEIBO_PROFILE_POSTS]: captureWeiboProfilePosts,
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
    [MESSAGE_STOP_DOUYIN_POST_DETAIL]: stopDouyinPostDetailCapture
  };
  const handler = handlers[message?.type];
  if (!handler) {
    return false;
  }

  handler(message.options || {})
    .then(sendResponse)
    .catch((error) => {
      sendResponse({
        ok: false,
        error: error.message || String(error)
      });
    });
  return true;
});
