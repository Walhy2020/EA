"use strict";

const SECRET_KEY_PATTERN = /(secret|apikey|api_key|token|webhook|encodingaeskey|password|credential|authorization)/i;

function shouldMaskKey(key) {
  if (/(env|configured)$/i.test(key)) {
    return false;
  }
  return SECRET_KEY_PATTERN.test(key);
}

function maskValue(value) {
  if (value === null || value === undefined || value === "") {
    return value;
  }

  const text = String(value);
  if (text.length <= 6) {
    return "***";
  }

  return `${text.slice(0, 3)}***${text.slice(-3)}`;
}

function maskSecrets(input) {
  if (Array.isArray(input)) {
    return input.map((item) => maskSecrets(item));
  }

  if (input && typeof input === "object") {
    const result = {};
    for (const [key, value] of Object.entries(input)) {
      if (shouldMaskKey(key)) {
        result[key] = maskValue(value);
      } else {
        result[key] = maskSecrets(value);
      }
    }
    return result;
  }

  if (typeof input === "string") {
    return input
      .replace(/(key=)[^&\s]+/gi, "$1***")
      .replace(/(scode=)[^&\s]+/gi, "$1***")
      .replace(/(access_token=)[^&\s]+/gi, "$1***")
      .replace(/(webhook\/send\?key=)[^&\s]+/gi, "$1***");
  }

  return input;
}

module.exports = {
  maskSecrets,
  maskValue
};
