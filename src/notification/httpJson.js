"use strict";

const http = require("http");
const https = require("https");

function requestJson(urlText, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlText);
    const payload = options.body === undefined ? "" : JSON.stringify(options.body);
    const transport = url.protocol === "http:" ? http : https;
    const headers = {
      ...(options.headers || {})
    };
    if (options.body !== undefined) {
      headers["Content-Type"] = headers["Content-Type"] || "application/json";
      headers["Content-Length"] = Buffer.byteLength(payload);
    }
    const req = transport.request({
      method: options.method || "GET",
      hostname: url.hostname,
      port: url.port || (url.protocol === "http:" ? 80 : 443),
      path: `${url.pathname}${url.search}`,
      headers
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 200)}`));
          return;
        }
        try {
          resolve(text ? JSON.parse(text) : {});
        } catch (_) {
          resolve({ raw: text });
        }
      });
    });
    req.on("error", reject);
    if (options.body !== undefined) {
      req.write(payload);
    }
    req.end();
  });
}

function postJson(urlText, body, headers = {}) {
  return requestJson(urlText, {
    method: "POST",
    body,
    headers
  });
}

function getJson(urlText, headers = {}) {
  return requestJson(urlText, {
    method: "GET",
    headers
  });
}

module.exports = {
  getJson,
  postJson
};
