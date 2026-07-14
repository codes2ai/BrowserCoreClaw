import { mountXiaohongshuLoginGate } from "../keyword-search/login-gate.js";
import { mountXiaohongshuProfileInfoMonitor } from "./monitor.js";

export function mount(container, context) {
  return mountXiaohongshuLoginGate(container, context, {
    mountMonitor: mountXiaohongshuProfileInfoMonitor
  });
}
