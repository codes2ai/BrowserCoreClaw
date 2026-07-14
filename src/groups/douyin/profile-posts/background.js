import { captureDouyin, stopDouyinCapture } from "../capture.js";

export function captureDouyinProfilePosts(options) {
  return captureDouyin("profile-posts", options);
}

export function stopDouyinProfilePostsCapture(options) {
  return stopDouyinCapture("profile-posts", options);
}
