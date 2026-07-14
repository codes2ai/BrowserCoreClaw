import { captureDouyin, stopDouyinCapture } from "../capture.js";

export function captureDouyinPostDetail(options) {
  return captureDouyin("post-detail", options);
}

export function stopDouyinPostDetailCapture(options) {
  return stopDouyinCapture("post-detail", options);
}
