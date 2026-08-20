(function initDemandLocatorNavigation(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.EADemandLocatorNavigation = api;
  }
}(typeof window !== "undefined" ? window : globalThis, function createDemandLocatorNavigation() {
  function openDemandTable(url, options = {}) {
    const targetUrl = String(url || "").trim();
    if (!targetUrl) {
      return { strategy: "none", reason: "missing_link" };
    }
    const openWindow = typeof options.openWindow === "function" ? options.openWindow : window.open.bind(window);
    const navigateCurrent = typeof options.navigateCurrent === "function"
      ? options.navigateCurrent
      : (nextUrl) => window.location.assign(nextUrl);
    let childWindow = null;
    try {
      childWindow = openWindow("about:blank", "_blank");
    } catch (error) {
      navigateCurrent(targetUrl);
      return { strategy: "current_page", reason: "window_open_error", error: String(error && error.message || error || "") };
    }
    if (!childWindow) {
      navigateCurrent(targetUrl);
      return { strategy: "current_page", reason: "popup_blocked" };
    }
    try {
      childWindow.opener = null;
      childWindow.location.replace(targetUrl);
      return { strategy: "new_window", reason: "opened" };
    } catch (error) {
      try {
        childWindow.close();
      } catch (_) {
        // Nothing else is required before the current-page fallback.
      }
      navigateCurrent(targetUrl);
      return { strategy: "current_page", reason: "child_navigation_error", error: String(error && error.message || error || "") };
    }
  }

  function copyThenOpen(options = {}) {
    const demandId = String(options.demandId || "").trim();
    const copySynchronously = typeof options.copySynchronously === "function" ? options.copySynchronously : null;
    const copyAsynchronously = typeof options.copyAsynchronously === "function" ? options.copyAsynchronously : null;
    let copyStatus = demandId ? "sync_unavailable" : "no_id";
    let copyReason = "";
    let asyncCopyPromise = null;

    if (demandId && copySynchronously) {
      try {
        if (copySynchronously(demandId) !== true) {
          throw new Error("sync_copy_rejected");
        }
        copyStatus = "sync_copied";
      } catch (error) {
        copyStatus = "async_attempted";
        copyReason = String(error && error.message || error || "sync_copy_failed");
        if (copyAsynchronously) {
          asyncCopyPromise = Promise.resolve()
            .then(() => copyAsynchronously(demandId))
            .then(() => ({ status: "async_copied" }))
            .catch((asyncError) => ({
              status: "copy_failed",
              reason: String(asyncError && asyncError.message || asyncError || "async_copy_failed")
            }));
        } else {
          copyStatus = "copy_failed";
        }
      }
    }

    const navigation = openDemandTable(options.url, options);
    return { navigation, copyStatus, copyReason, asyncCopyPromise };
  }

  return { openDemandTable, copyThenOpen };
}));
