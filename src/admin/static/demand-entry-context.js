"use strict";

(function registerDemandEntryContext(root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  root.EADemandEntryContext = api;
}(typeof window !== "undefined" ? window : globalThis, () => {
  function isWeComClient(userAgent) {
    return /wxwork/i.test(String(userAgent || ""));
  }

  function resolveIdentity(options = {}) {
    return { name: "", source: options.isWeCom ? "wecom_session_required" : "web_session_required" };
  }

  function buildDemandH5Url(locationLike, panelName) {
    const source = new URL(locationLike.href || String(locationLike), "http://localhost");
    const target = new URL("./demand-h5.html", source);
    target.search = source.search;
    target.hash = panelName ? `#${panelName}` : "";
    return `${target.pathname}${target.search}${target.hash}`;
  }

  return { isWeComClient, resolveIdentity, buildDemandH5Url };
}));
