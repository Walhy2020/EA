"use strict";

const fs = require("fs");
const path = require("path");

function parseCsvLine(line) {
  const result = [];
  let current = "";
  let quoted = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    const next = line[i + 1];
    if (char === '"' && quoted && next === '"') {
      current += '"';
      i += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      result.push(current);
      current = "";
    } else {
      current += char;
    }
  }

  result.push(current);
  return result;
}

function readLatestTop(historyPath, limit) {
  if (!fs.existsSync(historyPath)) {
    return [];
  }

  const lines = fs.readFileSync(historyPath, "utf8").replace(/^\uFEFF/, "").trim().split(/\r?\n/);
  if (lines.length < 2) {
    return [];
  }

  const headers = parseCsvLine(lines[0]);
  const rows = lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    const row = {};
    headers.forEach((header, index) => {
      row[header] = values[index] || "";
    });
    row.ranking_number = Number(row.ranking || 0);
    return row;
  });

  const latestScanId = rows.length ? rows[rows.length - 1].scan_id : "";
  return rows
    .filter((row) => row.scan_id === latestScanId && row.ranking_number > 0)
    .sort((a, b) => a.ranking_number - b.ranking_number)
    .slice(0, limit);
}

function createWxMiniRankAdapter(options) {
  const moduleConfig = options.moduleConfig;
  const logger = options.logger;
  let monitorApi = null;
  let botApi = null;

  function ensureModuleFiles() {
    const required = [
      path.join(moduleConfig.resolvedPath, "monitor.js"),
      path.join(moduleConfig.resolvedPath, "bot-helper.js")
    ];

    for (const filePath of required) {
      if (!fs.existsSync(filePath)) {
        throw new Error(`Missing wx-mini-rank-monitor file: ${filePath}`);
      }
    }
  }

  function loadMonitorApi() {
    ensureModuleFiles();
    if (!monitorApi) {
      monitorApi = require(path.join(moduleConfig.resolvedPath, "monitor.js"));
    }
    return monitorApi;
  }

  function loadBotApi() {
    ensureModuleFiles();
    if (!botApi) {
      botApi = require(path.join(moduleConfig.resolvedPath, "bot-helper.js"));
    }
    if (typeof botApi.configurePaths === "function") {
      botApi.configurePaths({
        configPath: moduleConfig.configPath,
        historyPath: moduleConfig.historyPath,
        statePath: moduleConfig.statePath
      });
    }
    return botApi;
  }

  async function buildReply(text) {
    const api = loadBotApi();
    if (!api.buildReply) {
      throw new Error("wx-mini-rank-monitor bot-helper.js does not export buildReply");
    }
    return api.buildReply(text);
  }

  async function runOnce() {
    const api = loadMonitorApi();
    if (!api.loadConfig || !api.runOnce) {
      throw new Error("wx-mini-rank-monitor monitor.js does not export loadConfig/runOnce");
    }

    const config = api.loadConfig(moduleConfig.configPath, moduleConfig.statePath);
    logger.info("Manual rank scan started", { modulePath: moduleConfig.resolvedPath });
    await api.runOnce(config);
    return { ok: true };
  }

  function getStatus() {
    const monitorPath = path.join(moduleConfig.resolvedPath, "monitor.js");
    const botPath = path.join(moduleConfig.resolvedPath, "bot-helper.js");
    const latestTop = readLatestTop(moduleConfig.historyPath, 20);

    return {
      enabled: Boolean(moduleConfig.enabled),
      path: moduleConfig.resolvedPath,
      files: {
        monitor: fs.existsSync(monitorPath),
        botHelper: fs.existsSync(botPath),
        config: fs.existsSync(moduleConfig.configPath),
        history: fs.existsSync(moduleConfig.historyPath)
      },
      latestTop: latestTop.map((row) => ({
        ranking: row.ranking,
        appName: row.app_name,
        publisherName: row.publisher_name,
        scanTime: row.scan_time
      }))
    };
  }

  return {
    buildReply,
    runOnce,
    getStatus
  };
}

module.exports = {
  createWxMiniRankAdapter
};
