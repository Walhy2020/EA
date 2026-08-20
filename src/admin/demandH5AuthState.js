"use strict";

const crypto = require("crypto");

function signDemandH5State(returnPath, secret, options = {}) {
  const now = Number(options.now || Date.now());
  const ttlMs = Number(options.ttlMs || 5 * 60 * 1000);
  const payload = Buffer.from(JSON.stringify({
    returnPath,
    expiresAt: now + ttlMs,
    audience: String(options.audience || "demand_h5")
  })).toString("base64url");
  const signature = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function verifyDemandH5State(state, secret, options = {}) {
  const [payload, signature] = String(state || "").split(".");
  if (!payload || !signature) return "";
  const expected = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  const received = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (received.length !== expectedBuffer.length || !crypto.timingSafeEqual(received, expectedBuffer)) return "";
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (Number(parsed.expiresAt) <= Number(options.now || Date.now())) return "";
    if (options.audience && parsed.audience !== String(options.audience)) return "";
    const normalizeReturnPath = typeof options.normalizeReturnPath === "function" ? options.normalizeReturnPath : (value) => String(value || "");
    return normalizeReturnPath(parsed.returnPath);
  } catch (error) {
    return "";
  }
}

module.exports = {
  signDemandH5State,
  verifyDemandH5State
};
