"use strict";

const LEADERS = [
  {
    key: "planner",
    role: "策划组长",
    name: "时振兴",
    aliases: ["策划组长", "策划负责人", "策划人员", "时振兴"]
  },
  {
    key: "ui",
    role: "UI组长",
    name: "王谦",
    aliases: ["UI组长", "UI人员", "王谦"]
  },
  {
    key: "motion",
    role: "动效组长",
    name: "刘晓明",
    aliases: ["动效组长", "动效人员", "刘晓明"]
  },
  {
    key: "frontend",
    role: "前端组长",
    name: "胡锦南、赵琛",
    aliases: ["前端组长", "胡锦南", "赵琛", "胡锦南、赵琛"]
  },
  {
    key: "backend",
    role: "后端组长",
    name: "王文静",
    aliases: ["后端组长", "王文静"]
  },
  {
    key: "test",
    role: "测试组长",
    name: "高文盛",
    aliases: ["测试组长", "测试人员", "高文盛"]
  }
];

const PROJECT_FILTERS = {
  all: {
    label: "全部项目",
    aliases: []
  },
  highschool: {
    label: "恶魔高校/高校",
    aliases: ["恶魔高校", "高校"]
  },
  ikki: {
    label: "一骑当千/一骑",
    aliases: ["一骑当千", "一骑"]
  },
  queen: {
    label: "女王之刃/女王",
    aliases: ["女王之刃", "女王"]
  },
  strike: {
    label: "噬血狂袭",
    aliases: ["噬血狂袭", "噬血"]
  },
  maou: {
    label: "魔王",
    aliases: ["魔王"]
  }
};

const state = {
  panels: new Map(),
  otherItems: [],
  lastScanResult: null,
  lastScanStats: null,
  sourceDocUrl: ""
};

const $ = (id) => document.getElementById(id);
const leaderGrid = $("leaderGrid");
const panelTemplate = $("leaderPanelTemplate");
const taskTemplate = $("taskItemTemplate");
const scanButton = $("scanButton");
const signalButton = $("signalButton");
const limitInput = $("limitInput");
const projectFilterInput = $("projectFilterInput");
const statusText = $("statusText");
const summaryText = $("summaryText");
const docNameText = $("docNameText");
const modifyTimeText = $("modifyTimeText");
const scanTimeText = $("scanTimeText");
const issueCountText = $("issueCountText");
const otherPanel = $("otherPanel");
const otherList = $("otherList");
const otherCountText = $("otherCountText");

function normalizeName(value) {
  return String(value || "")
    .replace(/[，,、/|；;\s]+/g, "")
    .trim()
    .toLowerCase();
}

function splitOwnerText(value) {
  return String(value || "")
    .split(/[，,、/|；;\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function localTimeText(date = new Date()) {
  const pad = (number) => String(number).padStart(2, "0");
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
    pad(date.getSeconds())
  ].join("");
}

function modifyTimeLabel(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    return String(value || "-");
  }
  const ms = number > 1000000000000 ? number : number * 1000;
  return `${value} / ${localTimeText(new Date(ms))}`;
}

function locateText(item) {
  const task = item.task || {};
  const links = task.links || {};
  const demandLink = firstUrl(links.demandLink);
  return [
    `需求ID：${task.demandId || "-"}`,
    `需求名称：${task.demand || "-"}`,
    `约行号：${task.viewRowNumber ? `第 ${task.viewRowNumber} 行` : "-"}`,
    `项目：${task.project || "-"}`,
    `类型/状态：${item.demandType || task.demandType || "-"} / ${item.status || task.status || "-"}`,
    `缺失字段：${Array.isArray(item.missingFields) && item.missingFields.length > 0 ? item.missingFields.join("、") : "-"}`,
    `责任来源：${item.ownerSource || "-"}`,
    `recordId：${task.recordId || "-"}`,
    `需求链接：${demandLink || "-"}`,
    `需求总表：${state.sourceDocUrl || "-"}`
  ].join("\n");
}

async function writeClipboardText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return true;
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "readonly");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();
  const ok = document.execCommand("copy");
  textarea.remove();
  return ok;
}

function demandLocateKey(item) {
  const task = item && item.task ? item.task : {};
  return String(task.demandId || task.recordId || "").trim();
}

async function openMasterAndCopyLocate(item) {
  const url = state.sourceDocUrl || firstUrl(item && item.task && item.task.links ? item.task.links.demandLink : "");
  if (!url) {
    statusText.textContent = "未找到可打开的需求总表链接";
    return;
  }

  const key = demandLocateKey(item);
  let copied = false;
  if (key) {
    try {
      copied = await writeClipboardText(key);
    } catch (error) {
      copied = false;
    }
  }

  window.open(url, "_blank", "noreferrer");
  statusText.textContent = key
    ? (copied ? `已打开需求总表，并复制任务ID：${key}` : `已打开需求总表；复制任务ID失败：${key}`)
    : "已打开需求总表；当前任务没有可复制的任务ID";
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    method: options.method || "GET",
    headers: {
      "Content-Type": "application/json"
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.message || `请求失败：HTTP ${response.status}`);
  }
  return payload;
}

function leaderForOwner(ownerName) {
  const normalized = normalizeName(ownerName);
  if (!normalized) {
    return null;
  }
  return LEADERS.find((leader) => leader.aliases.some((alias) => normalizeName(alias) === normalized)) || null;
}

function selectedProjectFilter() {
  const key = projectFilterInput && projectFilterInput.value ? projectFilterInput.value : "highschool";
  return PROJECT_FILTERS[key] || PROJECT_FILTERS.highschool;
}

function matchesSelectedProject(task) {
  const filter = selectedProjectFilter();
  if (!filter || filter === PROJECT_FILTERS.all || filter.aliases.length === 0) {
    return true;
  }
  const project = normalizeName(task && task.project ? task.project : "");
  return filter.aliases.some((alias) => normalizeName(alias) === project);
}

function ensurePanels() {
  leaderGrid.innerHTML = "";
  state.panels.clear();
  for (const leader of LEADERS) {
    const node = panelTemplate.content.firstElementChild.cloneNode(true);
    node.dataset.role = leader.key;
    node.querySelector(".leader-role").textContent = leader.role;
    node.querySelector(".leader-name").textContent = leader.name;
    leaderGrid.appendChild(node);
    state.panels.set(leader.key, {
      leader,
      node,
      list: node.querySelector(".task-list"),
      count: node.querySelector(".leader-count"),
      items: []
    });
  }
}

function emptyNode(text) {
  const node = document.createElement("div");
  node.className = "empty";
  node.textContent = text;
  return node;
}

function taskTitle(task) {
  const id = task.demandId ? `[${task.demandId}] ` : "";
  return `${id}${task.demand || "未命名需求"}`;
}

function uniqueTexts(values) {
  return [...new Set((values || [])
    .map((value) => String(value || "").trim())
    .filter(Boolean))];
}

function taskMergeKey(task = {}) {
  return String(task.recordId || task.demandId || `${task.project || ""}|${task.demand || ""}`).trim();
}

function mergeTaskItem(items, nextItem) {
  const nextKey = taskMergeKey(nextItem.task);
  const existing = nextKey
    ? items.find((item) => taskMergeKey(item.task) === nextKey)
    : null;
  if (!existing) {
    items.push({
      ...nextItem,
      missingFields: uniqueTexts(nextItem.missingFields),
      ownerSource: uniqueTexts([nextItem.ownerSource]).join("、")
    });
    return;
  }

  existing.missingFields = uniqueTexts([
    ...(existing.missingFields || []),
    ...(nextItem.missingFields || [])
  ]);
  existing.ownerSource = uniqueTexts([
    ...splitOwnerText(existing.ownerSource),
    nextItem.ownerSource
  ]).join("、");
}

function firstUrl(value) {
  const match = String(value || "").match(/https?:\/\/[^\s，,、]+/);
  return match ? match[0] : "";
}

function renderTask(item) {
  const task = item.task || {};
  const links = task.links || {};
  const node = taskTemplate.content.firstElementChild.cloneNode(true);
  node.querySelector(".task-title").textContent = taskTitle(task);
  node.querySelector(".task-state").textContent = item.status || task.status || "-";
  node.querySelector(".task-project").textContent = task.project || "-";
  node.querySelector(".task-type").textContent = item.demandType || task.demandType || "-";
  node.querySelector(".task-row-number").textContent = task.viewRowNumber ? `第 ${task.viewRowNumber} 行` : "-";
  node.querySelector(".task-missing").textContent = Array.isArray(item.missingFields) && item.missingFields.length > 0
    ? item.missingFields.join("、")
    : "-";
  node.querySelector(".task-owner-source").textContent = item.ownerSource || "-";
  const link = node.querySelector(".task-link");
  const url = firstUrl(links.demandLink);
  const openMasterButton = node.querySelector(".task-open-master");
  openMasterButton.addEventListener("click", () => {
    openMasterAndCopyLocate(item);
  });
  if (url) {
    link.href = url;
    link.textContent = "需求链接";
    link.hidden = false;
  }
  return node;
}

function resetPanelItems() {
  state.otherItems = [];
  for (const panel of state.panels.values()) {
    panel.items = [];
  }
}

function ownerNamesFromIssue(issue) {
  const names = Array.isArray(issue.ownerNames) && issue.ownerNames.length > 0
    ? issue.ownerNames
    : splitOwnerText(issue.owner);
  return names.length > 0 ? names : ["未配置责任人"];
}

function collectItems(scanResult) {
  resetPanelItems();
  const anomalies = Array.isArray(scanResult.anomalies) ? scanResult.anomalies : [];
  const stats = {
    filteredAnomalyCount: 0,
    filteredIssueCount: 0,
    skippedByProjectCount: 0
  };
  for (const anomaly of anomalies) {
    const task = anomaly.task || {};
    if (!matchesSelectedProject(task)) {
      stats.skippedByProjectCount += 1;
      continue;
    }
    stats.filteredAnomalyCount += 1;
    for (const issue of anomaly.issues || []) {
      if (issue.type !== "missing_required_field") {
        continue;
      }
      stats.filteredIssueCount += 1;
      const ownerNames = ownerNamesFromIssue(issue);
      let matched = false;
      for (const ownerName of ownerNames) {
        const leader = leaderForOwner(ownerName);
        const item = {
          task,
          demandType: issue.demandType || task.demandType || "",
          status: issue.status || task.status || "",
          missingFields: Array.isArray(issue.missingFields) ? issue.missingFields : [],
          ownerSource: ownerName
        };
        if (leader && state.panels.has(leader.key)) {
          mergeTaskItem(state.panels.get(leader.key).items, item);
          matched = true;
        } else {
          mergeTaskItem(state.otherItems, item);
        }
      }
      if (!matched && ownerNames.length === 0) {
        mergeTaskItem(state.otherItems, {
          task,
          demandType: issue.demandType || task.demandType || "",
          status: issue.status || task.status || "",
          missingFields: Array.isArray(issue.missingFields) ? issue.missingFields : [],
          ownerSource: "未配置责任人"
        });
      }
    }
  }
  state.lastScanStats = stats;
  return stats;
}

function renderPanels() {
  for (const panel of state.panels.values()) {
    panel.count.textContent = String(panel.items.length);
    panel.list.innerHTML = "";
    if (panel.items.length === 0) {
      panel.list.appendChild(emptyNode("暂无待处理项"));
      continue;
    }
    for (const item of panel.items) {
      panel.list.appendChild(renderTask(item));
    }
  }

  otherList.innerHTML = "";
  otherCountText.textContent = String(state.otherItems.length);
  otherPanel.hidden = state.otherItems.length === 0;
  for (const item of state.otherItems) {
    otherList.appendChild(renderTask(item));
  }
}

async function readSignal() {
  signalButton.disabled = true;
  statusText.textContent = "读取变更信号中...";
  try {
    const payload = await requestJson("/api/dev-progress/test-connection", {
      method: "POST"
    });
    const doc = payload.devProgress && payload.devProgress.doc ? payload.devProgress.doc : {};
    docNameText.textContent = doc.docName || "-";
    modifyTimeText.textContent = modifyTimeLabel(doc.modifyTime);
    statusText.textContent = "变更信号已读取";
  } catch (error) {
    statusText.textContent = `读取失败：${error.message}`;
  } finally {
    signalButton.disabled = false;
  }
}

async function scanTable() {
  scanButton.disabled = true;
  statusText.textContent = "扫描总表中...";
  try {
    const limit = Math.max(1, Math.min(Number(limitInput.value || 2000), 5000));
    const payload = await requestJson("/api/dev-progress/scan-anomalies", {
      method: "POST",
      body: { limit }
    });
    const result = payload.devProgress || {};
    state.lastScanResult = result;
    state.sourceDocUrl = result.source && result.source.docUrl ? result.source.docUrl : "";
    const stats = collectItems(result);
    renderPanels();
    scanTimeText.textContent = localTimeText();
    issueCountText.textContent = String(stats.filteredIssueCount || 0);
    const leaderTaskCount = [...state.panels.values()].reduce((total, panel) => total + panel.items.length, 0);
    summaryText.textContent = `项目：${selectedProjectFilter().label}；扫描 ${result.scannedCount || 0} 条，命中 ${leaderTaskCount} 条组长待处理项，其他责任人 ${state.otherItems.length} 条`;
    statusText.textContent = "扫描完成";
  } catch (error) {
    statusText.textContent = `扫描失败：${error.message}`;
  } finally {
    scanButton.disabled = false;
  }
}

scanButton.addEventListener("click", scanTable);
signalButton.addEventListener("click", readSignal);
projectFilterInput.addEventListener("change", () => {
  if (!state.lastScanResult) {
    summaryText.textContent = `当前项目：${selectedProjectFilter().label}，等待扫描`;
    return;
  }
  const stats = collectItems(state.lastScanResult);
  renderPanels();
  issueCountText.textContent = String(stats.filteredIssueCount || 0);
  const leaderTaskCount = [...state.panels.values()].reduce((total, panel) => total + panel.items.length, 0);
  summaryText.textContent = `项目：${selectedProjectFilter().label}；扫描 ${state.lastScanResult.scannedCount || 0} 条，命中 ${leaderTaskCount} 条组长待处理项，其他责任人 ${state.otherItems.length} 条`;
  statusText.textContent = "已切换项目筛选";
});

ensurePanels();
renderPanels();
summaryText.textContent = `当前项目：${selectedProjectFilter().label}，等待扫描`;
readSignal();
