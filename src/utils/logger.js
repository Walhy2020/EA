"use strict";

const fs = require("fs");
const path = require("path");
const { projectRoot } = require("./paths");
const { maskSecrets } = require("./secretMask");

const LEVELS = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

function nowStamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate())
  ].join("-") + " " + [
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join(":");
}

function createLogger(options = {}) {
  const level = options.level || "info";
  const minLevel = LEVELS[level] || LEVELS.info;
  const logDir = options.logDir || path.join(projectRoot, "logs");

  fs.mkdirSync(logDir, { recursive: true });

  function write(levelName, message, meta) {
    if ((LEVELS[levelName] || LEVELS.info) < minLevel) {
      return;
    }

    const safeMeta = meta === undefined ? "" : ` ${JSON.stringify(maskSecrets(meta))}`;
    const line = `[${nowStamp()}] [${levelName.toUpperCase()}] ${maskSecrets(message)}${safeMeta}`;
    const datePart = nowStamp().slice(0, 10).replace(/-/g, "");
    fs.appendFileSync(path.join(logDir, `app-${datePart}.log`), `${line}\n`, "utf8");
    console.log(line);
  }

  return {
    debug: (message, meta) => write("debug", message, meta),
    info: (message, meta) => write("info", message, meta),
    warn: (message, meta) => write("warn", message, meta),
    error: (message, meta) => write("error", message, meta)
  };
}

module.exports = {
  createLogger
};
