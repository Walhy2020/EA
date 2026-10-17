"use strict";

(function () {
  const frame = document.getElementById("assignmentPreviewFrame");
  if (!frame) return;
  let context = { project: "all", projects: [], theme: "" };
  let loaded = false;
  function sendContext() {
    if (!loaded || !frame.contentWindow) return;
    // The sandbox deliberately has an opaque origin. Only this frame gets UI context.
    frame.contentWindow.postMessage({ type: "ea-assignment-preview-context", ...context }, "*");
  }
  window.EAAssignmentPreview = {
    sync(next) { context = next; sendContext(); },
    show() {
      if (!loaded) { frame.src = frame.dataset.src; loaded = true; }
      else sendContext();
    }
  };
  window.addEventListener("message", event => {
    if (event.source !== frame.contentWindow || event.origin !== "null") return;
    if (event.data?.type === "ea-assignment-preview-ready") sendContext();
    if (event.data?.type === "ea-assignment-preview-height") {
      const height = event.data.height;
      if (Number.isFinite(height) && height > 0 && height <= 10000) frame.style.height = `${Math.max(400, Math.ceil(height))}px`;
    }
  });
})();
