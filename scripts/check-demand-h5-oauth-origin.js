"use strict";

const {
  resolveDemandH5OAuthOrigin,
  demandH5OAuthCallbackUrl,
  demandWebLoginCallbackUrl
} = require("../src/admin/demandH5OAuth");

const fallback = resolveDemandH5OAuthOrigin({ requestProtocol: "http", requestHost: "10.1.1.81:39200" });
const configured = resolveDemandH5OAuthOrigin({ configuredOrigin: "https://ea.example.com:8443/base", requestProtocol: "http", requestHost: "10.1.1.81:39200" });
const invalid = resolveDemandH5OAuthOrigin({ configuredOrigin: "/demand-h5-auth", requestProtocol: "https", requestHost: "ea.example.com" });
const checks = {
  requestHostFallbackPreserved: fallback.ok && fallback.origin === "http://10.1.1.81:39200" && fallback.source === "request_host",
  configuredOriginPreferred: configured.ok && configured.origin === "https://ea.example.com:8443" && configured.source === "configured_origin",
  callbackUsesConfiguredOrigin: demandH5OAuthCallbackUrl(configured.origin) === "https://ea.example.com:8443/demand-h5-auth",
  webCallbackUsesConfiguredOrigin: demandWebLoginCallbackUrl(configured.origin) === "https://ea.example.com:8443/demand-web-login",
  relativeOriginRejected: !invalid.ok
};
const passed = Object.values(checks).every(Boolean);
console.log(JSON.stringify({ passed, checks }, null, 2));
if (!passed) process.exitCode = 1;
