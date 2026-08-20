"use strict";

const https = require("https");

const ACCESS_TOKEN_CACHE_MARGIN_MS = 5 * 60 * 1000;
const USER_NAME_CACHE_MS = 12 * 60 * 60 * 1000;
const USER_ID_CACHE_MS = 12 * 60 * 60 * 1000;

const accessTokenCache = new Map();
const userNameCache = new Map();
const userIdByNameCache = new Map();

function requestJson(method, url, payload) {
  return new Promise((resolve, reject) => {
    const body = payload === undefined ? "" : JSON.stringify(payload);
    const request = https.request(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body)
      }
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        try {
          const data = text ? JSON.parse(text) : {};
          resolve({ statusCode: response.statusCode, data });
        } catch (error) {
          reject(new Error(`企业微信返回了非 JSON 响应，HTTP ${response.statusCode}`));
        }
      });
    });

    request.on("error", reject);
    if (body) {
      request.write(body);
    }
    request.end();
  });
}

function envValue(envName) {
  return envName ? (process.env[envName] || "") : "";
}

function authCacheKey(auth = {}) {
  return `${auth.corpIdEnv || ""}:${auth.secretEnv || ""}:${envValue(auth.corpIdEnv)}`;
}

async function getAccessToken(auth = {}) {
  const corpId = envValue(auth.corpIdEnv);
  const secret = envValue(auth.secretEnv);
  if (!corpId || !secret) {
    throw new Error("缺少企业微信 CorpID 或应用 Secret");
  }

  const key = authCacheKey(auth);
  const cached = accessTokenCache.get(key);
  if (cached && cached.expiresAt > Date.now() + ACCESS_TOKEN_CACHE_MARGIN_MS) {
    return cached.accessToken;
  }

  const url = `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${encodeURIComponent(corpId)}&corpsecret=${encodeURIComponent(secret)}`;
  const { data } = await requestJson("GET", url);
  if (data.errcode !== 0 || !data.access_token) {
    throw new Error(`获取企业微信 access_token 失败：${data.errcode || "unknown"} ${data.errmsg || ""}`.trim());
  }

  accessTokenCache.set(key, {
    accessToken: data.access_token,
    expiresAt: Date.now() + Math.max(60, Number(data.expires_in || 7200)) * 1000
  });
  return data.access_token;
}

async function resolveWeComUserName(auth = {}, userId) {
  const normalizedUserId = String(userId || "").trim();
  if (!normalizedUserId) {
    return "";
  }

  const userKey = `${authCacheKey(auth)}:${normalizedUserId}`;
  const cached = userNameCache.get(userKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.name;
  }

  const accessToken = await getAccessToken(auth);
  const url = `https://qyapi.weixin.qq.com/cgi-bin/user/get?access_token=${encodeURIComponent(accessToken)}&userid=${encodeURIComponent(normalizedUserId)}`;
  const { data } = await requestJson("GET", url);
  const name = data.errcode === 0 && data.name ? String(data.name).trim() : "";
  const resolvedName = name || normalizedUserId;

  userNameCache.set(userKey, {
    name: resolvedName,
    expiresAt: Date.now() + USER_NAME_CACHE_MS
  });
  return resolvedName;
}

async function resolveWeComOAuthUserId(auth = {}, code) {
  const normalizedCode = String(code || "").trim();
  if (!normalizedCode) return "";
  const accessToken = await getAccessToken(auth);
  const url = `https://qyapi.weixin.qq.com/cgi-bin/auth/getuserinfo?access_token=${encodeURIComponent(accessToken)}&code=${encodeURIComponent(normalizedCode)}`;
  const { data } = await requestJson("GET", url);
  if (data.errcode !== 0) {
    throw new Error(`读取企业微信 OAuth 身份失败：${data.errcode || "unknown"} ${data.errmsg || ""}`.trim());
  }
  return String(data.UserId || data.userid || "").trim();
}

function looksLikeUserId(value) {
  return /^[A-Za-z][A-Za-z0-9_.@-]{1,63}$/.test(String(value || "").trim());
}

function rootDepartmentId() {
  return process.env.WECOM_CONTACT_ROOT_DEPARTMENT_ID || "1";
}

async function resolveWeComUserIdByName(auth = {}, name) {
  const normalizedName = String(name || "").trim();
  if (!normalizedName) {
    return "";
  }
  if (looksLikeUserId(normalizedName) && !/[\u4e00-\u9fa5]/.test(normalizedName)) {
    return normalizedName;
  }

  const cacheKey = `${authCacheKey(auth)}:${normalizedName}`;
  const cached = userIdByNameCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.userId;
  }

  const accessToken = await getAccessToken(auth);
  const url = `https://qyapi.weixin.qq.com/cgi-bin/user/list?access_token=${encodeURIComponent(accessToken)}&department_id=${encodeURIComponent(rootDepartmentId())}&fetch_child=1`;
  const { data } = await requestJson("GET", url);
  if (data.errcode !== 0 || !Array.isArray(data.userlist)) {
    throw new Error(`按姓名读取企业微信通讯录失败：${data.errcode || "unknown"} ${data.errmsg || ""}`.trim());
  }

  const matches = data.userlist
    .filter((user) => String(user && user.name ? user.name : "").trim() === normalizedName)
    .map((user) => String(user.userid || "").trim())
    .filter(Boolean);
  const uniqueMatches = [...new Set(matches)];
  if (uniqueMatches.length !== 1) {
    userIdByNameCache.set(cacheKey, {
      userId: "",
      expiresAt: Date.now() + Math.min(USER_ID_CACHE_MS, 10 * 60 * 1000)
    });
    return "";
  }

  userIdByNameCache.set(cacheKey, {
    userId: uniqueMatches[0],
    expiresAt: Date.now() + USER_ID_CACHE_MS
  });
  return uniqueMatches[0];
}

module.exports = {
  resolveWeComUserName,
  resolveWeComOAuthUserId,
  resolveWeComUserIdByName
};
