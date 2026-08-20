"use strict";

const { maskSecrets } = require("./secretMask");

function safeStringify(value) {
  try {
    return JSON.stringify(maskSecrets(value));
  } catch (_) {
    return "";
  }
}

function errorInfo(error, fallback = "未知错误") {
  if (error instanceof Error) {
    return {
      message: error.message || fallback,
      name: error.name || "Error",
      code: error.code
    };
  }

  if (typeof error === "string") {
    return { message: error || fallback };
  }

  if (error && typeof error === "object") {
    const errcode = error.errcode !== undefined ? error.errcode : error.code;
    const errmsg = error.errmsg || error.message || error.error;
    const reqId = error.headers && error.headers.req_id ? String(error.headers.req_id) : undefined;
    const baseMessage = errmsg
      ? `${errmsg}${errcode !== undefined ? ` (errcode: ${errcode})` : ""}`
      : safeStringify({
        cmd: error.cmd,
        errcode,
        errmsg,
        reqId
      });

    return {
      message: baseMessage || fallback,
      code: error.code,
      errcode,
      errmsg,
      cmd: error.cmd,
      reqId
    };
  }

  return { message: fallback };
}

module.exports = {
  errorInfo
};
