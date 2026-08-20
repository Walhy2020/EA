const fs = require("fs");
const https = require("https");
const path = require("path");
const { fetchRanking } = require("./monitor");
let wecomSdk = null;

const baseDir = __dirname;
const runtimePaths = {
  configPath: path.join(baseDir, "config.json"),
  historyPath: path.join(baseDir, "data", "history", "rank_history.csv"),
  statePath: path.join(baseDir, "data", "state.json")
};

function configurePaths(paths = {}) {
  if (paths.configPath) {
    runtimePaths.configPath = path.resolve(paths.configPath);
  }
  if (paths.historyPath) {
    runtimePaths.historyPath = path.resolve(paths.historyPath);
  }
  if (paths.statePath) {
    runtimePaths.statePath = path.resolve(paths.statePath);
  }
}

function loadWeComSdk() {
  if (!wecomSdk) {
    wecomSdk = require("@wecom/aibot-node-sdk");
  }
  return wecomSdk;
}

function nowText(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function log(message) {
  const line = `[${nowText()}] ${message}`;
  console.log(line);
  try {
    const logDir = path.join(baseDir, "logs");
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(path.join(logDir, `bot-${nowText().slice(0, 10).replace(/-/g, "")}.log`), `${line}\n`, "utf8");
  } catch (_) {
  }
}

function errorMessage(error) {
  return error && error.message ? error.message : String(error || "");
}

function isAuthFailure(error) {
  const message = errorMessage(error);
  return error && error.code === "WS_AUTH_FAILURE_EXHAUSTED"
    || /Authentication failed|invalid bot_id or secret|853000|Max auth failure attempts/i.test(message);
}

function loadConfig() {
  const config = JSON.parse(fs.readFileSync(runtimePaths.configPath, "utf8").replace(/^\uFEFF/, ""));
  config.smartBot = config.smartBot || {};
  config.monitor = config.monitor || {};
  config.monitor.watchedGames = Array.isArray(config.monitor.watchedGames) ? config.monitor.watchedGames : [];
  config.source = config.source || {};
  config.source.baseUrl = config.source.baseUrl || "https://api-insight.gravity-engine.com/apprank/api/v1";
  config.source.rankGenre = config.source.rankGenre || "wx_minigame";
  config.source.rankType = config.source.rankType || "bestseller";
  config.source.fetchLimit = Number(config.source.fetchLimit || 100);
  config.source.pageSize = Number(config.source.pageSize || 100);
  config.ai = config.ai || {};
  config.ai.provider = config.ai.provider || "deepseek";
  config.ai.baseUrl = config.ai.baseUrl || "https://api.deepseek.com";
  config.ai.model = config.ai.model || "deepseek-v4-flash";
  config.ai.apiKey = config.ai.apiKey || "";
  config.ai.enabled = Boolean(config.ai.enabled);
  return config;
}

function saveConfig(config) {
  config.smartBot = config.smartBot || {};
  config.monitor = config.monitor || {};
  config.monitor.watchedGames = Array.isArray(config.monitor.watchedGames) ? config.monitor.watchedGames : [];
  config.ai = config.ai || {};
  const tempPath = `${runtimePaths.configPath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(config), "utf8");
  fs.renameSync(tempPath, runtimePaths.configPath);
}

function postJson(urlText, body, headers = {}) {
  const bodyText = JSON.stringify(body);
  const target = new URL(urlText);
  const options = {
    method: "POST",
    hostname: target.hostname,
    path: `${target.pathname}${target.search}`,
    port: target.port || 443,
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
      "Content-Length": Buffer.byteLength(bodyText),
      ...headers,
    },
    timeout: 30000,
  };

  return new Promise((resolve, reject) => {
    const request = https.request(options, (response) => {
      let raw = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        raw += chunk;
      });
      response.on("end", () => {
        let parsed = null;
        try {
          parsed = raw ? JSON.parse(raw) : {};
        } catch (error) {
          reject(new Error(`接口返回不是 JSON：${raw.slice(0, 200)}`));
          return;
        }
        if (response.statusCode < 200 || response.statusCode >= 300) {
          const message = parsed && parsed.error && parsed.error.message ? parsed.error.message : raw;
          reject(new Error(`HTTP ${response.statusCode} ${message}`));
          return;
        }
        resolve(parsed);
      });
    });
    request.on("timeout", () => {
      request.destroy(new Error("请求超时"));
    });
    request.on("error", reject);
    request.write(bodyText);
    request.end();
  });
}

function parseCsvLine(line) {
  const fields = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"' && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        current += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      fields.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  fields.push(current);
  return fields;
}

function readHistoryRows() {
  if (!fs.existsSync(runtimePaths.historyPath)) {
    return [];
  }

  const raw = fs.readFileSync(runtimePaths.historyPath, "utf8").replace(/^\uFEFF/, "");
  const lines = raw.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) {
    return [];
  }

  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    const row = {};
    headers.forEach((header, index) => {
      row[header] = values[index] || "";
    });
    row.ranking_number = Number(row.ranking || 0);
    return row;
  });
}

function latestSnapshotRows() {
  const rows = readHistoryRows();
  if (rows.length > 0) {
    const latestScanId = rows[rows.length - 1].scan_id;
    return rows
      .filter((row) => row.scan_id === latestScanId)
      .sort((a, b) => a.ranking_number - b.ranking_number);
  }

  if (!fs.existsSync(runtimePaths.statePath)) {
    return [];
  }

  const state = JSON.parse(fs.readFileSync(runtimePaths.statePath, "utf8").replace(/^\uFEFF/, ""));
  const snapshot = state.lastSnapshot || {};
  return (snapshot.list || []).map((item) => ({
    scan_time: snapshot.fetchedAtLocal || "",
    stat_date: snapshot.statDate || "",
    rank_genre: snapshot.rankGenre || "",
    rank_type: snapshot.rankType || "",
    ranking: String(item.ranking || ""),
    ranking_number: Number(item.ranking || 0),
    app_name: item.appName || "",
    publisher_name: item.publisherName || "",
    category_main: item.categoryMain || "",
    category_sub: item.categorySub || "",
  })).sort((a, b) => a.ranking_number - b.ranking_number);
}

function normalizeCommand(content) {
  return String(content || "")
    .replace(/@\S+\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractDays(text) {
  const match = text.match(/(\d+)\s*天/);
  return match ? Number(match[1]) : null;
}

function cleanupGameName(text) {
  return String(text || "")
    .replace(/^(历史|查询|查|游戏|排名|查一下|看一下|看看|帮我查)\s*/g, "")
    .replace(/\d+\s*天/g, "")
    .replace(/(最近|当前|现在|目前|榜单|排名|名次|怎么样|怎样|如何|是多少|第几|变化|情况|一下)/g, "")
    .replace(/[，,。；;]+/g, " ")
    .trim();
}

function normalizeGameName(text) {
  return String(text || "")
    .replace(/[《》「」"']/g, "")
    .replace(/^[\s:：,，;；、。.-]+|[\s:：,，;；、。.-]+$/g, "")
    .replace(/\s+/g, "")
    .trim();
}

function knownGameNames() {
  const names = new Set();
  for (const row of latestSnapshotRows()) {
    if (row.app_name) {
      names.add(row.app_name);
    }
  }
  for (const row of readHistoryRows()) {
    if (row.app_name) {
      names.add(row.app_name);
    }
  }
  return Array.from(names).sort((a, b) => b.length - a.length);
}

function compactText(text) {
  return String(text || "").replace(/\s+/g, "");
}

function findKnownGameName(command) {
  const compactCommand = compactText(command);
  for (const name of knownGameNames()) {
    if (compactCommand.includes(compactText(name))) {
      return name;
    }
  }
  return "";
}

function resolveKnownGameName(input) {
  return resolveGameNameFromList(input, knownGameNames());
}

function resolveGameNameFromList(input, names) {
  const target = compactText(input).toLowerCase();
  if (!target) {
    return { status: "empty", name: "", matches: [] };
  }

  const exact = names.find((name) => compactText(name).toLowerCase() === target);
  if (exact) {
    return { status: "ok", name: exact, matches: [exact] };
  }

  const matches = names.filter((name) => compactText(name).toLowerCase().includes(target));
  if (matches.length === 1) {
    return { status: "ok", name: matches[0], matches };
  }
  if (matches.length > 1) {
    return { status: "ambiguous", name: "", matches: matches.slice(0, 5) };
  }

  return { status: "not_found", name: "", matches: [] };
}

async function liveGameNames(config) {
  try {
    const list = await fetchRanking(config);
    return list.map((item) => item.appName).filter(Boolean);
  } catch (error) {
    log(`实时榜单校验失败：${error.message || error}`);
    return [];
  }
}

async function resolveWatchedGameName(input, getLiveNames) {
  const local = resolveKnownGameName(input);
  if (local.status !== "not_found") {
    return local;
  }

  const names = await getLiveNames();
  if (names.length === 0) {
    return local;
  }

  return resolveGameNameFromList(input, names);
}

function sameGameName(a, b) {
  return compactText(a).toLowerCase() === compactText(b).toLowerCase();
}

function wantsTopList(command) {
  return /top\s*20/i.test(command)
    || /top20/i.test(command)
    || /(前\s*20|前二十|二十名|榜单|排行榜|排名榜|畅销榜|最新排名|当前排名|当前榜单|最新榜单)/.test(command);
}

function watchAction(command) {
  const compact = compactText(command);
  if (/^(关注列表|关注游戏列表|监控列表|查看关注|我的关注|已关注|当前关注|关注了谁|关注哪些)$/.test(compact)) {
    return "list";
  }
  if (/(取消关注|删除关注|移除关注|删掉关注|去掉关注|停止关注|不再关注|不要关注|不关注|取消监控|删除监控|移除监控|停止监控|不再监控|不要监控|不监控)/.test(compact)) {
    return "remove";
  }
  if (/(添加关注|增加关注|新增关注|加入关注|加到关注|放到关注|列入关注|关注游戏|关注一下|设为关注|设置关注|开始关注|添加监控|增加监控|新增监控|加入监控|加到监控|放到监控|列入监控|监控游戏|监控一下|设为监控|设置监控|开始监控)/.test(compact)) {
    return "add";
  }
  if (/^(关注|监控).+/.test(compact)) {
    return "add";
  }
  if (/^(删除|移除|删掉|去掉).+/.test(compact)) {
    return "remove";
  }
  return "";
}

function stripWatchCommand(command) {
  return String(command || "")
    .replace(/^(请|麻烦)?\s*(帮我)?\s*/, "")
    .replace(/^(把|将)?\s*/, "")
    .replace(/^(添加|增加|新增|加入|加到|放到|列入|设为|设置|开始|取消|删除|移除|删掉|去掉|停止|不再|不要|不)\s*/, "")
    .replace(/^(关注游戏|监控游戏|关注名单|关注列表|监控列表|关注|监控)\s*/, "")
    .replace(/^(到|从)\s*(关注游戏|监控游戏|关注名单|关注列表|监控列表|关注|监控)?\s*/, "")
    .replace(/(关注列表|监控列表|名单|列表|一下)$/, "")
    .trim();
}

function extractWatchGameNames(command) {
  const known = findKnownGameName(command);
  if (known) {
    return [known];
  }

  const stripped = stripWatchCommand(command);
  return stripped
    .split(/[,，;；、\r\n]+|以及|和/g)
    .map(normalizeGameName)
    .filter(Boolean);
}

function formatWatchedGamesList(config) {
  const games = config.monitor.watchedGames || [];
  if (games.length === 0) {
    return "当前没有设置关注游戏。";
  }
  return [
    "当前关注游戏：",
    ...games.map((name, index) => `${index + 1}.${name}`),
  ].join("\n");
}

async function updateWatchedGames(action, command) {
  const config = loadConfig();
  if (action === "list") {
    return formatWatchedGamesList(config);
  }

  const names = extractWatchGameNames(command);
  if (names.length === 0) {
    return [
      "请带上游戏名。",
      "例：增加关注游戏 占城大师",
      "例：删除关注游戏 占城大师",
    ].join("\n");
  }

  const watched = config.monitor.watchedGames || [];
  const changed = [];
  const unchanged = [];
  const notFound = [];
  const ambiguous = [];
  let fetchedLiveNames = null;
  const getLiveNames = async () => {
    if (fetchedLiveNames === null) {
      fetchedLiveNames = await liveGameNames(config);
    }
    return fetchedLiveNames;
  };

  if (action === "add") {
    for (const name of names) {
      const watchedName = watched.find((item) => sameGameName(item, name));
      if (watchedName) {
        unchanged.push(`${watchedName} 已在关注列表`);
        continue;
      }

      const resolved = await resolveWatchedGameName(name, getLiveNames);
      if (resolved.status === "not_found") {
        notFound.push(name);
        continue;
      }
      if (resolved.status === "ambiguous") {
        ambiguous.push(`${name} 匹配到多个游戏：${resolved.matches.join("、")}，请说完整游戏名`);
        continue;
      }

      const appName = resolved.name;
      if (watched.some((item) => sameGameName(item, appName))) {
        unchanged.push(`${appName} 已在关注列表`);
      } else {
        watched.push(appName);
        changed.push(appName);
      }
    }
  } else if (action === "remove") {
    for (const name of names) {
      const index = watched.findIndex((item) => sameGameName(item, name));
      if (index >= 0) {
        changed.push(watched[index]);
        watched.splice(index, 1);
      } else {
        unchanged.push(`${name} 不在关注列表`);
      }
    }
  }

  config.monitor.watchedGames = watched;
  if (changed.length > 0) {
    saveConfig(config);
  }

  const actionText = action === "add" ? "已增加关注" : "已删除关注";
  return [
    changed.length > 0 ? `${actionText}：${changed.join("、")}` : "关注列表没有变化。",
    unchanged.length > 0 ? unchanged.join("\n") : "",
    notFound.length > 0 ? `未找到这些游戏，未加入关注：${notFound.join("、")}。只能关注已扫描榜单里存在的游戏。` : "",
    ambiguous.length > 0 ? ambiguous.join("\n") : "",
    "",
    formatWatchedGamesList(config),
    changed.length > 0 ? "下一轮扫描会按新的关注列表判断榜单变化。" : "",
  ].filter((line) => line !== "").join("\n");
}

function formatTop20() {
  const rows = latestSnapshotRows().filter((row) => row.ranking_number <= 20);
  if (rows.length === 0) {
    return "还没有历史榜单数据。请先让监控程序完成一次扫描。";
  }

  const scanTime = rows[0].scan_time || "--";
  const lines = rows.map((row) => `${row.ranking}.${row.app_name}`);
  return [
    "当前 Top20",
    `扫描时间：${scanTime}`,
    "",
    ...lines,
  ].join("\n");
}

function formatGameHistory(gameName, days) {
  const name = gameName.trim();
  if (!name) {
    return helpText();
  }

  let rows = readHistoryRows().filter((row) => row.app_name && row.app_name.includes(name));
  if (days) {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    rows = rows.filter((row) => {
      const time = new Date(row.scan_time.replace(/-/g, "/")).getTime();
      return Number.isFinite(time) && time >= cutoff;
    });
  }

  if (rows.length === 0) {
    const latest = latestSnapshotRows().find((row) => row.app_name && row.app_name.includes(name));
    if (latest) {
      return `${latest.app_name} 当前第${latest.ranking}名，但历史 CSV 里没有更多记录。`;
    }
    return `没有查到「${name}」的历史记录。`;
  }

  rows.sort((a, b) => String(a.scan_time).localeCompare(String(b.scan_time)));
  const latest = rows[rows.length - 1];
  const selected = rows.slice(-12);
  const lines = selected.map((row) => `${row.scan_time} 第${row.ranking}名`);
  const title = `${latest.app_name} 历史排名${days ? `（${days}天）` : ""}`;
  return [
    title,
    `当前：第${latest.ranking}名`,
    latest.publisher_name ? `发行商：${latest.publisher_name}` : "",
    "",
    ...lines,
  ].filter((line) => line !== "").join("\n");
}

function helpText() {
  return [
    "这里是榜单监控模块，可以查询微信小游戏畅销榜历史：",
    "1. top20",
    "2. 历史 游戏名",
    "3. 历史 游戏名 7天",
    "4. 查 游戏名",
    "5. 关注列表",
    "6. 增加关注游戏 游戏名",
    "7. 删除关注游戏 游戏名",
    "",
    "也可以直接问：占城大师最近排名怎么样",
    "例：增加关注游戏 占城大师",
    "例：删除关注游戏 占城大师",
    "例：历史 占城大师 7天",
  ].join("\n");
}

function isHelpCommand(command) {
  return !command
    || /^(帮助|help|\?|功能|菜单|说明)$/i.test(command)
    || /^(查什么|怎么查|能查什么)$/.test(command)
    || /你.*(能|会|可以).*?(干什么|做什么|查什么|帮.*什么)/.test(command)
    || /(你是谁|怎么用|如何使用|使用方法|能干什么|可以干什么)/.test(command);
}

function stripJsonFence(text) {
  return String(text || "")
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function deepSeekEndpoint(baseUrl) {
  const normalized = String(baseUrl || "https://api.deepseek.com").replace(/\/+$/, "");
  return `${normalized}/chat/completions`;
}

function rankContextText() {
  const topRows = latestSnapshotRows().filter((row) => row.ranking_number <= 20);
  const topText = topRows.map((row) => `${row.ranking}.${row.app_name}`).join("\n");
  const names = knownGameNames().slice(0, 120).join("、");
  const watched = (loadConfig().monitor.watchedGames || []).join("、") || "无";
  return [
    `当前Top20：\n${topText || "暂无"}`,
    `已知游戏名：${names || "暂无"}`,
    `当前关注游戏：${watched}`,
  ].join("\n\n");
}

async function callDeepSeekIntent(command) {
  const config = loadConfig();
  const ai = config.ai || {};
  if (!ai.enabled || !ai.apiKey) {
    return null;
  }

  const systemPrompt = [
    "你是榜单监控模块的意图解析器。",
    "你只能返回 JSON，不要返回 Markdown，不要解释。",
    "可用 action：top20、history、watch_list、watch_add、watch_remove、help、chat。",
    "如果用户想看榜单前20，action=top20。",
    "如果用户问某个游戏排名、走势、最近几天情况，action=history，并填写 gameName 和 days。",
    "如果用户想增加关注游戏，action=watch_add，并填写 gameName。必须尽量从已知游戏名中选择标准全名。",
    "如果用户想删除/取消关注游戏，action=watch_remove，并填写 gameName。必须尽量从已知游戏名或当前关注游戏中选择标准全名。",
    "如果用户问你能做什么，action=help。",
    "如果用户闲聊或问工具相关解释，action=chat，并填写 reply。reply 要简短、中文、围绕榜单监控模块。",
    "JSON 格式：{\"action\":\"history\",\"gameName\":\"占城大师\",\"days\":7,\"reply\":\"\"}",
  ].join("\n");

  const body = {
    model: ai.model || "deepseek-v4-flash",
    temperature: 0.1,
    max_tokens: 600,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: `${rankContextText()}\n\n用户消息：${command}` },
    ],
  };

  const response = await postJson(deepSeekEndpoint(ai.baseUrl), body, {
    Authorization: `Bearer ${ai.apiKey}`,
  });
  const content = response
    && response.choices
    && response.choices[0]
    && response.choices[0].message
    ? response.choices[0].message.content
    : "";
  if (!content) {
    throw new Error("DeepSeek 没有返回内容");
  }
  return JSON.parse(stripJsonFence(content));
}

async function executeIntent(intent) {
  const action = intent && intent.action ? String(intent.action) : "";
  const gameName = intent && intent.gameName ? String(intent.gameName).trim() : "";
  const days = intent && intent.days ? Number(intent.days) : null;
  if (action === "top20") {
    return formatTop20();
  }
  if (action === "history") {
    return gameName ? formatGameHistory(gameName, Number.isFinite(days) ? days : null) : helpText();
  }
  if (action === "watch_list") {
    return updateWatchedGames("list", "");
  }
  if (action === "watch_add") {
    return gameName ? updateWatchedGames("add", `增加关注游戏 ${gameName}`) : helpText();
  }
  if (action === "watch_remove") {
    return gameName ? updateWatchedGames("remove", `删除关注游戏 ${gameName}`) : helpText();
  }
  if (action === "help") {
    return helpText();
  }
  if (action === "chat" && intent.reply) {
    return String(intent.reply);
  }
  return helpText();
}

async function buildAiReply(command) {
  try {
    const intent = await callDeepSeekIntent(command);
    if (!intent) {
      return null;
    }
    return await executeIntent(intent);
  } catch (error) {
    return `DeepSeek 调用失败：${error.message || error}`;
  }
}

async function buildReply(content) {
  const command = normalizeCommand(content);
  if (isHelpCommand(command)) {
    return helpText();
  }

  const action = watchAction(command);
  if (action) {
    return await updateWatchedGames(action, command);
  }

  const days = extractDays(command);
  const knownGameName = findKnownGameName(command);
  if (knownGameName) {
    return formatGameHistory(knownGameName, days);
  }

  if (wantsTopList(command)) {
    return formatTop20();
  }

  if (/^(历史|查询|查|游戏|排名)/.test(command)) {
    const gameName = findKnownGameName(cleanupGameName(command)) || cleanupGameName(command);
    return formatGameHistory(gameName, days);
  }

  const aiReply = await buildAiReply(command);
  if (aiReply) {
    return aiReply;
  }

  return helpText();
}

async function replyText(wsClient, frame, text) {
  const { generateReqId } = loadWeComSdk();
  const streamId = generateReqId("rank");
  await wsClient.replyStream(frame, streamId, text, true);
}

function startBot() {
  const { WSClient } = loadWeComSdk();
  const config = loadConfig();
  const botConfig = config.smartBot || {};
  if (!botConfig.enabled) {
    log("smartBot.enabled=false，查询机器人未启动。");
    return;
  }
  if (!botConfig.botId || !botConfig.secret) {
    log("缺少 smartBot.botId 或 smartBot.secret，查询机器人未启动。");
    return;
  }

  const wsClient = new WSClient({
    botId: botConfig.botId,
    secret: botConfig.secret,
    maxReconnectAttempts: -1,
    maxAuthFailureAttempts: 0,
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    },
  });

  let stoppingAfterAuthFailure = false;

  wsClient.on("connected", () => {
    if (!stoppingAfterAuthFailure) {
      log("企业微信智能机器人长连接已建立，正在认证。");
    }
  });
  wsClient.on("authenticated", () => log("企业微信智能机器人认证成功。"));
  wsClient.on("disconnected", (reason) => {
    if (!stoppingAfterAuthFailure) {
      log(`企业微信智能机器人连接断开：${reason || ""}`);
    }
  });
  wsClient.on("reconnecting", (attempt) => {
    if (!stoppingAfterAuthFailure) {
      log(`企业微信智能机器人正在重连：${attempt}`);
    }
  });
  wsClient.on("error", (error) => {
    if (isAuthFailure(error)) {
      if (!stoppingAfterAuthFailure) {
        stoppingAfterAuthFailure = true;
        log("企业微信智能机器人认证失败：Bot ID 或 Secret 不正确。请重新复制 API模式 / 长连接 里的凭据后保存设置。查询机器人已停止，榜单监控不受影响。");
      }
      setTimeout(() => {
        try {
          wsClient.disconnect();
        } catch (_) {
        }
        process.exit(2);
      }, 100);
      return;
    }
    log(`企业微信智能机器人错误：${errorMessage(error)}`);
  });

  wsClient.on("message.text", async (frame) => {
    const content = frame && frame.body && frame.body.text ? frame.body.text.content : "";
    log(`收到文本消息：${content}`);
    try {
      const reply = await buildReply(content);
      await replyText(wsClient, frame, reply);
      log("查询回复已发送。");
    } catch (error) {
      log(`查询回复失败：${error && error.stack ? error.stack : error}`);
      try {
        await replyText(wsClient, frame, `查询失败：${error.message || error}`);
      } catch (_) {
      }
    }
  });

  wsClient.on("event.enter_chat", async (frame) => {
    try {
      await wsClient.replyWelcome(frame, {
        msgtype: "text",
        text: { content: helpText() },
      });
    } catch (error) {
      log(`欢迎语发送失败：${error && error.message ? error.message : error}`);
    }
  });

  process.on("SIGINT", () => {
    wsClient.disconnect();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    wsClient.disconnect();
    process.exit(0);
  });

  wsClient.connect();
}

if (require.main === module) {
  const testIndex = process.argv.indexOf("--test-query");
  if (testIndex >= 0) {
    buildReply(process.argv.slice(testIndex + 1).join(" "))
      .then((reply) => {
        console.log(reply);
      })
      .catch((error) => {
        console.error(error && error.stack ? error.stack : error);
        process.exitCode = 1;
      });
  } else {
    startBot();
  }
}

module.exports = {
  configurePaths,
  buildReply,
  formatGameHistory,
  formatTop20,
};
