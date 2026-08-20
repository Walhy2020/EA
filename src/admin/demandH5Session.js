"use strict";

const crypto = require("crypto");

const COOKIE_NAME = "ea_demand_session";
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_TTL_MS = 8 * 24 * 60 * 60 * 1000;

function safeText(value, maxLength) {
  const text = String(value || "").trim();
  if (!text || text.length > maxLength || /[\u0000-\u001f\u007f]/.test(text)) return "";
  return text;
}

function sessionKey(secret) {
  return crypto.createHmac("sha256", String(secret || ""))
    .update("ea-demand-h5-session-v1")
    .digest();
}

function signPayload(payload, secret) {
  return crypto.createHmac("sha256", sessionKey(secret)).update(payload).digest("base64url");
}

function createDemandH5Session(identity, secret, options = {}) {
  const userId = safeText(identity && identity.userId, 128);
  const name = safeText(identity && identity.name, 80);
  if (!userId || !name || !secret) throw new Error("缺少有效的需求进度登录身份或签名密钥");

  const now = Number(options.now || Date.now());
  const ttlMs = Math.min(MAX_TTL_MS, Math.max(60 * 1000, Number(options.ttlMs || DEFAULT_TTL_MS)));
  const payloadData = {
    v: 1,
    sid: crypto.randomBytes(12).toString("base64url"),
    uid: userId,
    name,
    iat: Math.floor(now / 1000),
    exp: Math.floor((now + ttlMs) / 1000)
  };
  const payload = Buffer.from(JSON.stringify(payloadData)).toString("base64url");
  return {
    token: `${payload}.${signPayload(payload, secret)}`,
    sessionId: payloadData.sid,
    expiresAt: new Date(payloadData.exp * 1000).toISOString()
  };
}

function verifyDemandH5Session(token, secret, options = {}) {
  const parts = String(token || "").split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1] || !secret) return { ok: false, reason: "missing_or_malformed" };

  const expected = Buffer.from(signPayload(parts[0], secret));
  const received = Buffer.from(parts[1]);
  if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) {
    return { ok: false, reason: "signature_invalid" };
  }

  try {
    const parsed = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    const nowSeconds = Math.floor(Number(options.now || Date.now()) / 1000);
    const userId = safeText(parsed.uid, 128);
    const name = safeText(parsed.name, 80);
    const sessionId = safeText(parsed.sid, 64);
    const issuedAt = Number(parsed.iat);
    const expiresAt = Number(parsed.exp);
    if (parsed.v !== 1 || !userId || !name || !sessionId || !Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)) {
      return { ok: false, reason: "payload_invalid" };
    }
    if (expiresAt <= nowSeconds) return { ok: false, reason: "expired" };
    if (issuedAt > nowSeconds + 300 || expiresAt <= issuedAt || (expiresAt - issuedAt) * 1000 > MAX_TTL_MS) {
      return { ok: false, reason: "time_invalid" };
    }
    return {
      ok: true,
      identity: {
        userId,
        name,
        sessionId,
        issuedAt: new Date(issuedAt * 1000).toISOString(),
        expiresAt: new Date(expiresAt * 1000).toISOString()
      }
    };
  } catch (error) {
    return { ok: false, reason: "payload_invalid" };
  }
}

function parseCookieHeader(header) {
  const cookies = {};
  for (const entry of String(header || "").split(";")) {
    const separator = entry.indexOf("=");
    if (separator <= 0) continue;
    const name = entry.slice(0, separator).trim();
    const value = entry.slice(separator + 1).trim();
    if (!name) continue;
    try {
      cookies[name] = decodeURIComponent(value);
    } catch (error) {
      cookies[name] = value;
    }
  }
  return cookies;
}

function readDemandH5Session(req, secret, options = {}) {
  const token = parseCookieHeader(req && req.headers ? req.headers.cookie : "")[COOKIE_NAME] || "";
  return verifyDemandH5Session(token, secret, options);
}

function demandH5SessionCookie(token, options = {}) {
  const maxAgeSeconds = Math.max(0, Math.floor(Number(options.maxAgeSeconds ?? DEFAULT_TTL_MS / 1000)));
  const attributes = [
    `${COOKIE_NAME}=${encodeURIComponent(String(token || ""))}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`
  ];
  if (options.secure !== false) attributes.push("Secure");
  return attributes.join("; ");
}

function clearDemandH5SessionCookie(options = {}) {
  return demandH5SessionCookie("", { ...options, maxAgeSeconds: 0 });
}

module.exports = {
  COOKIE_NAME,
  DEFAULT_TTL_MS,
  clearDemandH5SessionCookie,
  createDemandH5Session,
  demandH5SessionCookie,
  parseCookieHeader,
  readDemandH5Session,
  verifyDemandH5Session
};
