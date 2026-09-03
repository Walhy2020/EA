(function attachDemandTaskIdCopy(root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.EADemandTaskIdCopy = api;
  }
})(typeof window !== "undefined" ? window : globalThis, function createDemandTaskIdCopyApi() {
  "use strict";

  function taskIdForItem(item) {
    const safeItem = item && typeof item === "object" ? item : {};
    return String(
      safeItem.demandId
      || safeItem.taskId
      || safeItem.recordId
      || safeItem.id
      || ""
    ).trim();
  }

  async function copyTaskId(taskId, copyText) {
    const normalizedTaskId = String(taskId || "").trim();
    if (!normalizedTaskId || typeof copyText !== "function") {
      return { ok: false, taskId: normalizedTaskId, reason: "copy_unavailable" };
    }
    try {
      const copied = await copyText(normalizedTaskId);
      return copied === false
        ? { ok: false, taskId: normalizedTaskId, reason: "copy_rejected" }
        : { ok: true, taskId: normalizedTaskId, reason: "copied" };
    } catch (error) {
      return {
        ok: false,
        taskId: normalizedTaskId,
        reason: "copy_failed",
        message: error && error.message ? error.message : String(error || "")
      };
    }
  }

  return { taskIdForItem, copyTaskId };
});
