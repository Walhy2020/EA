"use strict";

function resolveDemandH5OAuthOrigin(options = {}) {
  const configuredOrigin = String(options.configuredOrigin || "").trim();
  const fallbackOrigin = `${options.requestProtocol === "https" ? "https" : "http"}://${String(options.requestHost || "").trim()}`;
  const rawOrigin = configuredOrigin || fallbackOrigin;
  try {
    const parsed = new URL(rawOrigin);
    if (!/^https?:$/.test(parsed.protocol) || !parsed.hostname) {
      return { ok: false, message: "OAuth 回调基址必须是 http 或 https 的完整域名地址" };
    }
    return {
      ok: true,
      origin: parsed.origin,
      source: configuredOrigin ? "configured_origin" : "request_host"
    };
  } catch (error) {
    return { ok: false, message: "OAuth 回调基址格式无效" };
  }
}

function demandH5OAuthCallbackUrl(origin) {
  return new URL("/demand-h5-auth", origin).toString();
}

function demandWebLoginCallbackUrl(origin) {
  return new URL("/demand-web-login", origin).toString();
}

module.exports = {
  resolveDemandH5OAuthOrigin,
  demandH5OAuthCallbackUrl,
  demandWebLoginCallbackUrl
};
