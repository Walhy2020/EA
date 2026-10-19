"use strict";

(function () {
  const frame = document.getElementById("assignmentPreviewFrame");
  if (!frame) return;
  let context = { project: "all", projects: [], theme: "" };
  let loaded = false;
  let activeRequest = null;
  function sendContext() {
    if (!loaded || !frame.contentWindow) return;
    // The sandbox deliberately has an opaque origin. Only this frame gets UI context.
    frame.contentWindow.postMessage({ type: "ea-assignment-preview-context", ...context }, "*");
  }
  function sendResult(requestId, result, error) {
    frame.contentWindow?.postMessage({ type: "ea-assignment-reference-result", requestId, result, error }, "*");
  }
  async function requestReference(data) {
    if (typeof data.requestId !== "string" || data.requestId.length > 100) return;
    const query = data.query;
    if (!query || typeof query !== "object" || Array.isArray(query)) return;
    // The child can query only this read endpoint; identity never comes from messages.
    const params = new URLSearchParams();
    for (const key of ["role", "taskId", "effort"]) {
      const value = query[key];
      if (value !== undefined && value !== null && typeof value !== "object") params.set(key, String(value).slice(0, 200));
    }
    params.set("project", context.project || "all");
    if (query.forceRefresh === true) params.set("forceRefresh", "1");
    if (activeRequest) activeRequest.abort();
    const controller = new AbortController();
    activeRequest = controller;
    const timeout = setTimeout(() => controller.abort(), 120000);
    try {
      const response = await fetch(`/api/dev-progress/assignment-reference?${params}`, {
        cache: "no-store", credentials: "same-origin", signal: controller.signal,
        headers: { "X-EA-Demand-Page-Version": "assignment-0.2.0" }
      });
      const payload = await response.json();
      if (activeRequest !== controller) return;
      if (!response.ok || !payload.ok) {
        sendResult(data.requestId, null, payload.message || `请求失败：HTTP ${response.status}`);
        return;
      }
      sendResult(data.requestId, payload.devProgress);
    } catch (error) {
      if (activeRequest === controller) sendResult(data.requestId, null, error.name === "AbortError" ? "查询超时，请重试。" : "查询失败，请重试。");
    } finally {
      clearTimeout(timeout);
      if (activeRequest === controller) activeRequest = null;
    }
  }
  window.EAAssignmentPreview = {
    sync(next) {
      const changed = context.project !== next.project || JSON.stringify(context.projects) !== JSON.stringify(next.projects);
      context = next;
      if (changed && activeRequest) { activeRequest.abort(); activeRequest = null; }
      sendContext();
    },
    show() {
      if (!loaded) { frame.src = frame.dataset.src; loaded = true; }
      else sendContext();
    }
  };
  window.addEventListener("message", event => {
    if (event.source !== frame.contentWindow || event.origin !== "null") return;
    if (event.data?.type === "ea-assignment-preview-ready") sendContext();
    if (event.data?.type === "ea-assignment-reference-request") requestReference(event.data);
    if (event.data?.type === "ea-assignment-preview-height") {
      const height = event.data.height;
      if (Number.isFinite(height) && height > 0 && height <= 50000) frame.style.height = `${Math.max(400, Math.ceil(height))}px`;
    }
  });
})();
