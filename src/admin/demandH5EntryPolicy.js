"use strict";

const { resolveDemandH5OAuthOrigin } = require("./demandH5OAuth");

function isIpAddress(hostname) {
  const value = String(hostname || "").trim();
  return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(value) || value.includes(":");
}

function parseHttpOrigin(value) {
  try {
    const parsed = new URL(String(value || "").trim());
    if (!/^https?:$/.test(parsed.protocol) || !parsed.hostname || parsed.pathname !== "/" || parsed.search || parsed.hash) return null;
    if (isIpAddress(parsed.hostname) || parsed.hostname.toLowerCase() === "localhost") return null;
    return parsed;
  } catch (error) {
    return null;
  }
}

function resolveInternalHttpOrigin(internalHttpOAuth = {}) {
  if (!internalHttpOAuth || internalHttpOAuth.enabled !== true) return null;
  const parsed = parseHttpOrigin(internalHttpOAuth.allowedOrigin);
  return parsed && parsed.protocol === "http:" ? parsed : null;
}

function resolveTrustedWeComOAuthOrigin(configuredOrigin, options = {}) {
  const rawOrigin = String(configuredOrigin || "").trim();
  if (!rawOrigin) {
    return { enabled: false, reason: "trusted_origin_missing" };
  }

  const resolved = resolveDemandH5OAuthOrigin({ configuredOrigin: rawOrigin });
  if (!resolved.ok) {
    return { enabled: false, reason: "trusted_origin_invalid" };
  }

  const parsed = parseHttpOrigin(rawOrigin);
  if (!parsed || parsed.origin !== resolved.origin) {
    return { enabled: false, reason: "trusted_origin_invalid" };
  }

  if (parsed.protocol === "https:") {
    return { enabled: true, origin: parsed.origin, reason: "configured_https_origin" };
  }

  const allowedInternalOrigin = resolveInternalHttpOrigin(options.internalHttpOAuth);
  if (allowedInternalOrigin && parsed.origin === allowedInternalOrigin.origin) {
    return { enabled: true, origin: parsed.origin, reason: "configured_internal_http_origin" };
  }
  return { enabled: false, reason: "trusted_https_or_allowed_internal_http_required" };
}

function resolveDemandH5EntryPolicy(options = {}) {
  const oauth = resolveTrustedWeComOAuthOrigin(options.oauthRedirectOrigin, options);
  if (oauth.enabled) {
    return { mode: "wecom_oauth", oauth, testFallbackName: "" };
  }

  const testFallbackName = String(options.testFallbackUserName || "").trim();
  if (options.testMode === true && testFallbackName) {
    return { mode: "test_fallback", oauth, testFallbackName };
  }

  return { mode: "identity_required", oauth, testFallbackName: "" };
}

function isDemandH5OAuthRequestOriginAllowed(policy = {}, request = {}) {
  if (!policy.oauth || !policy.oauth.enabled) return false;
  const protocol = request.protocol === "https" ? "https" : "http";
  const origin = parseHttpOrigin(`${protocol}://${String(request.host || "").trim()}`);
  return Boolean(origin && origin.origin === policy.oauth.origin);
}

module.exports = {
  resolveTrustedWeComOAuthOrigin,
  resolveDemandH5EntryPolicy,
  isDemandH5OAuthRequestOriginAllowed
};
