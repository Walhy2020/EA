"use strict";

const https = require("https");
const dns = require("dns");
const path = require("path");
const { LIMITS } = require("./excelContent");

function publicAddress(address) {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts;
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0))
    || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19)));
}

function filenameFromHeader(header) {
  const value = String(header || "");
  const encoded = value.match(/filename\*=UTF-8''([^;]+)/i);
  const plain = value.match(/filename="([^"]+)"|filename=([^;]+)/i);
  let name = encoded ? encoded[1] : plain ? plain[1] || plain[2] : "";
  try { name = decodeURIComponent(name); } catch (_) {}
  return path.win32.basename(name.trim()).replace(/[\r\n\0]/g, "");
}

function fetchFile(url, signal, redirects = 0) {
  return new Promise((resolve, reject) => {
    let target;
    try { target = new URL(url); } catch (_) { return reject(new Error("文件下载地址无效，请重新发送 Excel。")); }
    if (target.protocol !== "https:" || target.username || target.password || (target.port && target.port !== "443") || redirects > 3
      || /^[\d.]+$/.test(target.hostname) || target.hostname.includes(":")) {
      return reject(new Error("文件下载地址不受支持，请重新发送 Excel。"));
    }
    const request = https.get(target, {
      signal,
      family: 4,
      lookup(hostname, options, callback) {
        dns.lookup(hostname, { family: 4, all: true }, (error, addresses) => {
          if (error || !addresses?.length || addresses.some((entry) => !publicAddress(entry.address))) return callback(new Error("file_host_not_public"));
          if (options.all) callback(null, addresses);
          else callback(null, addresses[0].address, 4);
        });
      }
    }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        try { fetchFile(new URL(response.headers.location, target).href, signal, redirects + 1).then(resolve, reject); }
        catch (_) { reject(new Error("invalid_file_redirect")); }
        return;
      }
      if (response.statusCode !== 200) { response.resume(); return reject(new Error("文件下载失败或已过期，请重新发送 Excel。")); }
      const maximum = LIMITS.bytes + 4096;
      if (Number(response.headers["content-length"] || 0) > maximum) {
        request.destroy(new Error("file_too_large"));
        return;
      }
      let length = 0;
      const chunks = [];
      response.on("error", reject);
      response.on("data", (chunk) => {
        length += chunk.length;
        if (length > maximum) request.destroy(new Error("file_too_large"));
        else chunks.push(chunk);
      });
      response.on("end", () => resolve({ buffer: Buffer.concat(chunks), filename: filenameFromHeader(response.headers["content-disposition"]) }));
    });
    request.on("error", reject);
  });
}

async function downloadExcelFile(file) {
  let stage = "download";
  try {
    const result = await fetchFile(file.url, AbortSignal.timeout(30000));
    if (!result.filename) throw new Error("missing_filename");
    stage = "decrypt";
    result.buffer = file.aeskey ? require("@wecom/aibot-node-sdk").decryptFile(result.buffer, file.aeskey) : result.buffer;
    if (result.buffer.length > LIMITS.bytes) throw new Error("file_too_large");
    return result;
  } catch (cause) {
    // Never echo temporary URLs, keys or remote HTTP error bodies into chat/logs.
    const error = new Error("无法读取附件（可能已过期、超过10MB或下载/解密失败），请重新发送 Excel 文件。");
    error.code = ["file_too_large", "missing_filename", "file_host_not_public"].includes(cause.message)
      ? cause.message : cause.name === "AbortError" ? "download_timeout" : `${stage}_failed`;
    throw error;
  }
}

module.exports = { downloadExcelFile, filenameFromHeader, publicAddress };
