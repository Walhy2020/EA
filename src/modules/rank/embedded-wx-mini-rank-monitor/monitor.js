const fs = require("fs");
const path = require("path");
const https = require("https");
const crypto = require("crypto");

const DEFAULT_CONFIG = {
  source: {
    baseUrl: "https://api-insight.gravity-engine.com/apprank/api/v1",
    rankGenre: "wx_minigame",
    rankType: "bestseller",
    fetchLimit: 100,
    pageSize: 100,
  },
  monitor: {
    intervalMinutes: 720,
    topN: 20,
    riseThreshold: 5,
    notifyOnFirstRun: false,
    watchedGames: [],
  },
  notification: {
    webhookUrl: "",
    mentionedMobileList: [],
    mentionedList: [],
  },
  appMessage: {
    enabled: false,
    corpId: "",
    agentId: "",
    secret: "",
    toUser: "",
  },
  appCallback: {
    url: "",
    token: "",
    encodingAesKey: "",
  },
  stateFile: "data/state.json",
};

const OPERATOR_EQUALS = 1;
const REQUEST_PATH = "/rank/public_list/";
const APP_VERSION = "v3.0";
const APP_SOURCE = "Node监控";

function parseArgs(argv) {
  const args = {
    once: false,
    configPath: path.join(__dirname, "config.json"),
    statePath: null,
    help: false,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--once") {
      args.once = true;
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else if (arg === "--config") {
      args.configPath = path.resolve(argv[++i]);
    } else if (arg.startsWith("--config=")) {
      args.configPath = path.resolve(arg.slice("--config=".length));
    } else if (arg === "--state") {
      args.statePath = path.resolve(argv[++i]);
    } else if (arg.startsWith("--state=")) {
      args.statePath = path.resolve(arg.slice("--state=".length));
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function printHelp() {
  console.log([
    "Usage:",
    "  node monitor.js --once              Run one scan and exit",
    "  node monitor.js                     Run forever, scanning every interval",
    "  node monitor.js --config config.json",
    "",
    "Alerts are sent when a game enters Top N or rises by the configured threshold.",
  ].join("\n"));
}

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
}

function deepMerge(base, override) {
  if (!override || typeof override !== "object" || Array.isArray(override)) {
    return override === undefined ? base : override;
  }

  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      base &&
      typeof base[key] === "object" &&
      !Array.isArray(base[key])
    ) {
      result[key] = deepMerge(base[key], value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function loadConfig(configPath, statePathOverride) {
  const fileConfig = readJsonIfExists(configPath) || {};
  const config = deepMerge(DEFAULT_CONFIG, fileConfig);
  config.configPath = configPath;
  config.statePath = statePathOverride
    ? statePathOverride
    : path.resolve(path.dirname(configPath), config.stateFile || DEFAULT_CONFIG.stateFile);

  config.source.fetchLimit = Number(config.source.fetchLimit || 100);
  config.source.pageSize = Number(config.source.pageSize || 100);
  config.monitor.intervalMinutes = Number(config.monitor.intervalMinutes || 60);
  config.monitor.topN = Number(config.monitor.topN || 20);
  config.monitor.riseThreshold = Number(config.monitor.riseThreshold || 5);

  return config;
}

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function nowText(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    "-",
    pad(date.getMonth() + 1),
    "-",
    pad(date.getDate()),
    " ",
    pad(date.getHours()),
    ":",
    pad(date.getMinutes()),
    ":",
    pad(date.getSeconds()),
  ].join("");
}

function makeSessionRaw() {
  return `etg${crypto.randomBytes(3).toString("hex").slice(0, 5)}`;
}

function signHeaders(bodyText, timestamp, session) {
  const signatureText = `${String(timestamp).slice(3, 8)}11${session}${bodyText}`;
  return crypto.createHash("md5").update(signatureText).digest("hex");
}

function decryptPayload(data, sessionRaw, timestamp) {
  if (!data || !data.text) {
    return data || {};
  }

  const key = `${sessionRaw}gv${String(timestamp).slice(7, 11)}00`;
  const decipher = crypto.createDecipheriv("aes-128-ecb", Buffer.from(key, "utf8"), null);
  decipher.setAutoPadding(true);
  const decrypted = Buffer.concat([
    decipher.update(data.text, "base64"),
    decipher.final(),
  ]).toString("utf8");
  return JSON.parse(decrypted);
}

function postJson(url, body, headers = {}) {
  const bodyText = typeof body === "string" ? body : JSON.stringify(body);
  const target = new URL(url);

  return new Promise((resolve, reject) => {
    const request = https.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || 443,
      path: `${target.pathname}${target.search}`,
      method: "POST",
      timeout: 30000,
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(bodyText),
        ...headers,
      },
    }, (response) => {
      let raw = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        raw += chunk;
      });
      response.on("end", () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`HTTP ${response.statusCode}: ${raw.slice(0, 300)}`));
          return;
        }
        try {
          resolve(JSON.parse(raw));
        } catch (error) {
          reject(new Error(`Invalid JSON response: ${error.message}`));
        }
      });
    });

    request.on("timeout", () => {
      request.destroy(new Error("Request timeout"));
    });
    request.on("error", reject);
    request.write(bodyText);
    request.end();
  });
}

function getJson(url, headers = {}) {
  const target = new URL(url);

  return new Promise((resolve, reject) => {
    const request = https.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || 443,
      path: `${target.pathname}${target.search}`,
      method: "GET",
      timeout: 30000,
      headers: {
        accept: "application/json",
        ...headers,
      },
    }, (response) => {
      let raw = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        raw += chunk;
      });
      response.on("end", () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`HTTP ${response.statusCode}: ${raw.slice(0, 300)}`));
          return;
        }
        try {
          resolve(JSON.parse(raw));
        } catch (error) {
          reject(new Error(`Invalid JSON response: ${error.message}`));
        }
      });
    });

    request.on("timeout", () => {
      request.destroy(new Error("Request timeout"));
    });
    request.on("error", reject);
    request.end();
  });
}

async function signedPost(baseUrl, requestPath, body) {
  const bodyText = JSON.stringify(body);
  const timestamp = Date.now();
  const sessionRaw = makeSessionRaw();
  const session = Buffer.from(sessionRaw, "utf8").toString("base64");
  const signature = signHeaders(bodyText, timestamp, session);
  const url = `${baseUrl.replace(/\/$/, "")}${requestPath}`;

  const response = await postJson(url, bodyText, {
    "gravity-timestamp": String(timestamp),
    "gravity-session": session,
    "gravity-signature": signature,
  });

  if (response.code !== 0) {
    const detail = response.extra ? ` ${JSON.stringify(response.extra)}` : "";
    throw new Error(`API error ${response.code}: ${response.msg || "unknown"}${detail}`);
  }

  return decryptPayload(response.data, sessionRaw, timestamp);
}

function buildRankRequest(config, page) {
  return {
    page,
    page_size: config.source.pageSize,
    extra_fields: {
      change_label: true,
      app_genre_ranking: true,
    },
    filters: [
      {
        field: "rank_type",
        operator: OPERATOR_EQUALS,
        values: [config.source.rankType],
      },
      {
        field: "rank_genre",
        operator: OPERATOR_EQUALS,
        values: [config.source.rankGenre],
      },
    ],
  };
}

function normalizeRankItem(item) {
  const appInfo = item.app_info || {};
  const genreRanking = item.app_genre_ranking || {};
  const key = String(appInfo.mini_app_id || item.app_id || appInfo.app_name || "");

  return {
    key,
    appId: item.app_id,
    miniAppId: appInfo.mini_app_id || "",
    appName: appInfo.app_name || "",
    ranking: Number(item.ranking),
    statDate: item.stat_datetime || "",
    publisherName: appInfo.publisher_name || "",
    categoryMain: genreRanking.game_type_main_name || appInfo.game_type_main_name || "",
    categorySub: appInfo.game_type_sub_name || "",
    sourceChange: item.change,
    changeLabel: item.change_label && item.change_label.first_msg
      ? item.change_label.first_msg
      : "",
  };
}

async function fetchRanking(config) {
  const list = [];
  const seen = new Set();
  let page = 1;
  let totalPage = 1;

  do {
    let addedThisPage = 0;
    const payload = await signedPost(
      config.source.baseUrl,
      REQUEST_PATH,
      buildRankRequest(config, page),
    );
    const pageList = Array.isArray(payload.list) ? payload.list : [];
    for (const rawItem of pageList) {
      const item = normalizeRankItem(rawItem);
      if (item.key && Number.isFinite(item.ranking) && !seen.has(item.key)) {
        seen.add(item.key);
        list.push(item);
        addedThisPage += 1;
      }
    }

    const pageInfo = payload.page_info || {};
    totalPage = Number(pageInfo.total_page || page);
    if (addedThisPage === 0) {
      break;
    }
    page += 1;
  } while (page <= totalPage && list.length < config.source.fetchLimit);

  return list
    .filter((item) => item.key && Number.isFinite(item.ranking))
    .sort((a, b) => a.ranking - b.ranking)
    .slice(0, config.source.fetchLimit);
}

function loadState(config) {
  return readJsonIfExists(config.statePath);
}

function saveState(config, snapshot, events) {
  ensureParentDir(config.statePath);
  const state = {
    lastRunAt: snapshot.fetchedAt,
    source: {
      rankGenre: config.source.rankGenre,
      rankType: config.source.rankType,
    },
    lastSnapshot: snapshot,
    lastEvents: events,
  };
  fs.writeFileSync(config.statePath, JSON.stringify(state, null, 2), "utf8");
}

function csvEscape(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function appendHistory(config, snapshot, events) {
  const historyDir = path.join(path.dirname(config.statePath), "history");
  fs.mkdirSync(historyDir, { recursive: true });

  const csvPath = path.join(historyDir, "rank_history.csv");
  if (!fs.existsSync(csvPath)) {
    fs.writeFileSync(csvPath, "\ufeffscan_id,scan_time,scan_time_utc,stat_date,rank_genre,rank_type,ranking,app_name,app_id,mini_app_id,publisher_name,category_main,category_sub,change_label,is_top,is_watched\r\n", "utf8");
  }

  const scanId = new Date(snapshot.fetchedAt).toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  const watched = new Set((config.monitor.watchedGames || []).map(normalizeName).filter(Boolean).map((name) => name.toLowerCase()));
  const rows = snapshot.list.map((item) => [
    scanId,
    snapshot.fetchedAtLocal,
    snapshot.fetchedAt,
    snapshot.statDate,
    snapshot.rankGenre,
    snapshot.rankType,
    item.ranking,
    item.appName,
    item.appId,
    item.miniAppId,
    item.publisherName,
    item.categoryMain,
    item.categorySub,
    item.changeLabel,
    item.ranking <= config.monitor.topN ? 1 : 0,
    watched.has(normalizeName(item.appName).toLowerCase()) ? 1 : 0,
  ].map(csvEscape).join(",")).join("\r\n");
  fs.appendFileSync(csvPath, `${rows}\r\n`, "utf8");

  const jsonlPath = path.join(historyDir, "rank_snapshots.jsonl");
  fs.appendFileSync(jsonlPath, `${JSON.stringify({ scan_id: scanId, snapshot, events })}\n`, "utf8");
}

function buildSnapshot(config, list) {
  return {
    fetchedAt: new Date().toISOString(),
    fetchedAtLocal: nowText(),
    rankGenre: config.source.rankGenre,
    rankType: config.source.rankType,
    statDate: list[0] ? list[0].statDate : "",
    list,
  };
}

function analyzeChanges(config, previousSnapshot, currentSnapshot) {
  const topN = config.monitor.topN;
  const riseThreshold = config.monitor.riseThreshold;
  const previousList = previousSnapshot && Array.isArray(previousSnapshot.list)
    ? previousSnapshot.list
    : [];
  const previousMap = new Map(previousList.map((item) => [item.key, item]));
  const hasPrevious = previousList.length > 0;
  const events = [];

  for (const current of currentSnapshot.list) {
    if (current.ranking > topN) {
      continue;
    }

    const previous = previousMap.get(current.key);
    if (!hasPrevious) {
      if (config.monitor.notifyOnFirstRun) {
        events.push({
          type: "first_run_top",
          app: current,
          previous,
          message: `首次记录 Top${topN}`,
        });
      }
      continue;
    }

    if (!previous || previous.ranking > topN) {
      events.push({
        type: "new_top",
        app: current,
        previous,
        message: `新进 Top${topN}`,
      });
      continue;
    }

    const rise = previous.ranking - current.ranking;
    if (rise >= riseThreshold) {
      events.push({
        type: "rise",
        app: current,
        previous,
        rise,
        message: `上升 ${rise} 名`,
      });
    }
  }

  addWatchedGameEvents(config, previousList, currentSnapshot.list, previousMap, events, hasPrevious);

  return events.sort((a, b) => a.app.ranking - b.app.ranking);
}

function normalizeName(value) {
  return String(value || "").trim();
}

function findByName(list, appName) {
  const target = normalizeName(appName).toLowerCase();
  return (list || []).find((item) => normalizeName(item.appName).toLowerCase() === target) || null;
}

function findEventByKey(events, key) {
  return events.find((event) => event.app && event.app.key === key) || null;
}

function addOrMarkWatched(events, current, previous, message, rise = 0) {
  const existing = findEventByKey(events, current.key);
  if (existing) {
    if (!existing.message.startsWith("关注游戏，")) {
      existing.message = `关注游戏，${existing.message}`;
      existing.type = `watched_${existing.type}`;
    }
    return;
  }

  events.push({
    type: "watched",
    app: current,
    previous,
    rise,
    message,
  });
}

function addWatchedGameEvents(config, previousList, currentList, previousMap, events, hasPrevious) {
  const watched = new Set((config.monitor.watchedGames || []).map(normalizeName).filter(Boolean).map((name) => name.toLowerCase()));
  if (!hasPrevious || watched.size === 0) {
    return;
  }

  const currentMap = new Map(currentList.map((item) => [item.key, item]));
  for (const current of currentList) {
    if (!watched.has(normalizeName(current.appName).toLowerCase())) {
      continue;
    }

    const previous = previousMap.get(current.key) || findByName(previousList, current.appName);
    if (!previous) {
      addOrMarkWatched(events, current, null, "关注游戏进入当前抓取范围");
      continue;
    }

    const diff = previous.ranking - current.ranking;
    if (diff === 0) {
      continue;
    }
    addOrMarkWatched(
      events,
      current,
      previous,
      diff > 0 ? `关注游戏上升 ${diff} 名` : `关注游戏下降 ${Math.abs(diff)} 名`,
      diff,
    );
  }

  for (const previous of previousList) {
    if (!watched.has(normalizeName(previous.appName).toLowerCase())) {
      continue;
    }
    if (currentMap.has(previous.key) || findByName(currentList, previous.appName)) {
      continue;
    }
    addOrMarkWatched(events, previous, previous, "关注游戏跌出当前抓取范围");
  }
}

function formatEventLine(event, index) {
  const app = event.app;
  const dropped = event.message.includes("跌出当前抓取范围");
  const previousRank = event.previous ? `上次第${event.previous.ranking}名` : "上次未记录";
  const category = [app.categoryMain, app.categorySub].filter(Boolean).join("/");
  const extraParts = [
    event.message,
    dropped ? "当前未在抓取范围" : `当前第${app.ranking}名`,
    previousRank,
    app.publisherName ? `发行商：${app.publisherName}` : "",
    category ? `类型：${category}` : "",
  ].filter(Boolean);
  return `${index + 1}. ${app.appName}：${extraParts.join("，")}`;
}

function topListText(config, snapshot) {
  return snapshot.list
    .filter((item) => item.ranking <= config.monitor.topN)
    .map((item) => `${item.ranking}.${item.appName}`)
    .join("\n");
}

function watchedGamesText(config, snapshot) {
  const watched = config.monitor.watchedGames || [];
  if (watched.length === 0) {
    return "未设置";
  }
  const parts = watched.map((rawName) => {
    const name = normalizeName(rawName);
    if (!name) {
      return "";
    }
    const item = findByName(snapshot.list, name);
    const category = [item?.categoryMain, item?.categorySub].filter(Boolean).join("/");
    return item ? `${item.appName}：第${item.ranking}名${category ? `，${category}` : ""}` : `${name}：未在前${config.source.fetchLimit}`;
  }).filter(Boolean);
  return parts.length ? parts.join("  ") : "未设置";
}

function formatMessage(config, snapshot, events) {
  const title = `榜单监控模块 ${APP_VERSION}（${APP_SOURCE}）`;
  const header = [
    title,
    `扫描时间：${snapshot.fetchedAtLocal}`,
  ].filter(Boolean);

  const body = events.map(formatEventLine);
  const watched = watchedGamesText(config, snapshot);

  const lines = [
    ...header,
    "",
    ...body,
    "",
    `当前 Top${config.monitor.topN}：`,
    topListText(config, snapshot),
    `关注游戏榜单情况：${watched}`,
    "历史记录：data/history/rank_history.csv",
  ];
  return lines.join("\n");
}

function normalizePipeList(text) {
  return String(text || "")
    .split(/[,，;；|\s]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .join("|");
}

async function getAppAccessToken(appMessage) {
  const url = `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${encodeURIComponent(appMessage.corpId || "")}&corpsecret=${encodeURIComponent(appMessage.secret || "")}`;
  const result = await getJson(url);
  if (result && typeof result.errcode === "number" && result.errcode !== 0) {
    throw new Error(`Access token error ${result.errcode}: ${result.errmsg || "unknown"}`);
  }
  if (!result || !result.access_token) {
    throw new Error("Access token response is empty.");
  }
  return result.access_token;
}

async function sendAppMessage(config, message) {
  const appMessage = config.appMessage || {};
  const toUser = normalizePipeList(appMessage.toUser);
  const agentId = Number(appMessage.agentId);
  if (!appMessage.corpId || !appMessage.secret || !toUser || !Number.isInteger(agentId)) {
    throw new Error("个人推送已开启，但企业ID、AgentId、Secret 或接收成员账号未配置完整。");
  }

  const accessToken = await getAppAccessToken(appMessage);
  const result = await postJson(
    `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${encodeURIComponent(accessToken)}`,
    {
      touser: toUser,
      msgtype: "text",
      agentid: agentId,
      text: { content: message },
      safe: 0,
    },
  );

  if (result && typeof result.errcode === "number" && result.errcode !== 0) {
    throw new Error(`App message error ${result.errcode}: ${result.errmsg || "unknown"}`);
  }
  if (result && (result.invaliduser || result.unlicenseduser)) {
    throw new Error(`App message partial invalid user: invaliduser=${result.invaliduser || ""} unlicenseduser=${result.unlicenseduser || ""}`);
  }
}

async function sendNotification(config, message) {
  const errors = [];

  const webhookUrl = config.notification && config.notification.webhookUrl;
  if (webhookUrl) {
    try {
      const mentioned = Array.isArray(config.notification.mentionedMobileList)
        ? config.notification.mentionedMobileList
        : [];
      const mentionedUsers = Array.isArray(config.notification.mentionedList)
        ? config.notification.mentionedList
        : [];
      const result = await postJson(webhookUrl, {
        msgtype: "text",
        text: {
          content: message,
          mentioned_mobile_list: mentioned,
          mentioned_list: mentionedUsers,
        },
      });

      if (result && typeof result.errcode === "number" && result.errcode !== 0) {
        throw new Error(`Webhook error ${result.errcode}: ${result.errmsg || "unknown"}`);
      }
    } catch (error) {
      errors.push(`群推送失败：${error.message || error}`);
    }
  }

  if (config.appMessage && config.appMessage.enabled) {
    try {
      await sendAppMessage(config, message);
    } catch (error) {
      errors.push(`个人推送失败：${error.message || error}`);
    }
  }

  if (!webhookUrl && !(config.appMessage && config.appMessage.enabled)) {
    console.log(message);
    return;
  }

  if (errors.length > 0) {
    throw new Error(errors.join("；"));
  }
}

async function runOnce(config) {
  const previousState = loadState(config);
  const previousSnapshot = previousState ? previousState.lastSnapshot : null;
  const list = await fetchRanking(config);

  if (list.length === 0) {
    throw new Error("Ranking API returned an empty list.");
  }

  const snapshot = buildSnapshot(config, list);
  const events = analyzeChanges(config, previousSnapshot, snapshot);
  saveState(config, snapshot, events);
  appendHistory(config, snapshot, events);

  if (events.length > 0) {
    await sendNotification(config, formatMessage(config, snapshot, events));
  } else {
    console.log(`[${snapshot.fetchedAtLocal}] No alert. Top1=${list[0].appName}, state=${config.statePath}`);
  }

  return { snapshot, events };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runLoop(config) {
  const intervalMs = Math.max(1, config.monitor.intervalMinutes) * 60 * 1000;
  console.log(`Rank monitor started. interval=${config.monitor.intervalMinutes} minutes, state=${config.statePath}`);

  while (true) {
    try {
      await runOnce(config);
    } catch (error) {
      console.error(`[${nowText()}] Scan failed: ${error.stack || error.message}`);
    }
    await sleep(intervalMs);
  }
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    return;
  }

  const config = loadConfig(args.configPath, args.statePath);
  if (args.once) {
    await runOnce(config);
  } else {
    await runLoop(config);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}

module.exports = {
  analyzeChanges,
  buildSnapshot,
  fetchRanking,
  formatMessage,
  loadConfig,
  runOnce,
};
