import { captureDouyin, stopDouyinCapture } from "../capture.js";

export function captureDouyinProfileInfo(options) {
  return captureDouyin("profile-info", options);
}

export function stopDouyinProfileInfoCapture(options) {
  return stopDouyinCapture("profile-info", options);
}
