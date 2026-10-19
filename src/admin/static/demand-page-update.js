(function () {
  "use strict";
  const meta = document.querySelector('meta[name="ea-page-build"]');
  const baseline = meta && meta.content;
  const banner = document.getElementById("pageUpdateNotice");
  if (!baseline || !banner) return;

  const validBuild = value => typeof value === "string" && /^[a-f0-9]{24}$/.test(value);
  if (!validBuild(baseline)) return;
  let busy = false;
  let lastCheck = 0;
  let dismissed = "";
  let offered = "";
  let disposed = false;

  async function check() {
    if (disposed || busy || document.hidden || Date.now() - lastCheck < 30000) return;
    busy = true;
    lastCheck = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch("/api/dev-progress/page-version", {
        credentials: "same-origin", cache: "no-store", signal: controller.signal
      });
      if (!response.ok || disposed) return;
      const result = await response.json();
      if (!result.ok || !validBuild(result.buildId) || disposed) return;
      offered = result.buildId;
      banner.hidden = offered === baseline || offered === dismissed;
    } catch (_) {
      // A failed release check must not interrupt the current page or its drafts.
    } finally {
      clearTimeout(timeout);
      busy = false;
    }
  }

  document.getElementById("pageUpdateReload").addEventListener("click", () => window.location.reload());
  document.getElementById("pageUpdateLater").addEventListener("click", () => {
    dismissed = offered;
    banner.hidden = true;
  });
  document.addEventListener("visibilitychange", check);
  window.addEventListener("focus", check);
  const timer = setInterval(check, 60000);
  const firstCheck = setTimeout(check, 5000);
  window.addEventListener("pagehide", event => {
    if (event.persisted) return;
    disposed = true;
    clearInterval(timer);
    clearTimeout(firstCheck);
  });
})();
