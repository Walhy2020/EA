"use strict";

if (window.location.protocol === "file:") {
  const serverUrl = new URL("http://127.0.0.1:39200/demand-h5.html");
  serverUrl.search = window.location.search;
  serverUrl.hash = window.location.hash;
  window.location.replace(serverUrl.toString());
}

const panels = {
  create: document.getElementById("panel-create"),
  today: document.getElementById("panel-today"),
  todo: document.getElementById("panel-todo"),
  memberTodo: document.getElementById("panel-memberTodo"),
  draft: document.getElementById("panel-draft"),
  fallback: document.getElementById("panel-fallback")
};

const tabButtons = [...document.querySelectorAll(".tab-button")];
const tabs = document.querySelector(".tabs");
const projectSelect = document.getElementById("projectSelect");
const monitorRefreshButton = document.getElementById("monitorRefreshButton");
const projectSettingsButton = document.getElementById("projectSettingsButton");
const projectSettingsDialog = document.getElementById("projectSettingsDialog");
const projectSettingsCloseButton = document.getElementById("projectSettingsCloseButton");
const projectSettingsCancelButton = document.getElementById("projectSettingsCancelButton");
const projectSettingsSaveButton = document.getElementById("projectSettingsSaveButton");
const showAllProjectsInput = document.getElementById("showAllProjectsInput");
const allProjectsFieldset = document.getElementById("allProjectsFieldset");
const allProjectsOptions = document.getElementById("allProjectsOptions");
const projectOrderList = document.getElementById("projectOrderList");
const dataStatus = document.getElementById("dataStatus");
const toast = document.getElementById("toast");
const demandForm = document.getElementById("demandForm");
const submitterInput = document.getElementById("submitterInput");
const projectInput = document.getElementById("projectInput");
const draftProjectOutput = document.getElementById("draftProjectOutput");
const draftEmpty = document.getElementById("draftEmpty");
const draftList = document.getElementById("draftList");
const draftContent = document.getElementById("draftContent");
const draftIdOutput = document.getElementById("draftIdOutput");
const draftNameOutput = document.getElementById("draftNameOutput");
const draftStatusOutput = document.getElementById("draftStatusOutput");
const draftTypeOutput = document.getElementById("draftTypeOutput");
const draftScaleTypeOutput = document.getElementById("draftScaleTypeOutput");
const draftPriorityOutput = document.getElementById("draftPriorityOutput");
const draftDesignDeliveryDateOutput = document.getElementById("draftDesignDeliveryDateOutput");
const draftUpdatedAtOutput = document.getElementById("draftUpdatedAtOutput");
const draftLeadsOutput = document.getElementById("draftLeadsOutput");
const draftDemandContentOutput = document.getElementById("draftDemandContentOutput");
const draftLinkOutput = document.getElementById("draftLinkOutput");
const draftCountOutput = document.getElementById("draftCountOutput");
const draftTabButton = document.getElementById("draftTabButton");
const fallbackTabButton = document.getElementById("fallbackTabButton");
const fallbackCountOutput = document.getElementById("fallbackCountOutput");
const fallbackEmpty = document.getElementById("fallbackEmpty");
const fallbackList = document.getElementById("fallbackList");
const fallbackLoading = document.getElementById("fallbackLoading");
const fallbackLeaderFilter = document.getElementById("fallbackLeaderFilter");
const fallbackLeaderFilterOptions = document.getElementById("fallbackLeaderFilterOptions");
const fallbackLeaderFilterClear = document.getElementById("fallbackLeaderFilterClear");
const memberTodoTabButton = document.getElementById("memberTodoTabButton");
const todoEmpty = document.getElementById("todoEmpty");
const todoList = document.getElementById("todoList");
const todoLoading = document.getElementById("todoLoading");
const todoCountOutput = document.getElementById("todoCountOutput");
const memberTodoCountOutput = document.getElementById("memberTodoCountOutput");
const memberTodoEmpty = document.getElementById("memberTodoEmpty");
const memberTodoList = document.getElementById("memberTodoList");
const memberTodoLoading = document.getElementById("memberTodoLoading");
const memberTodoSummary = document.getElementById("memberTodoSummary");
const draftLoading = document.getElementById("draftLoading");
const draftRoleNotice = document.getElementById("draftRoleNotice");
const draftPrimaryAction = document.getElementById("draftPrimaryAction");
const draftSecondaryAction = document.getElementById("draftSecondaryAction");
const leaderSupplementSection = document.getElementById("leaderSupplementSection");
const leaderSupplementTitle = document.getElementById("leaderSupplementTitle");
const leaderSupplementFields = document.getElementById("leaderSupplementFields");
const DEFAULT_PROJECT_NAME = "恶魔高校";
const FALLBACK_VIEWER_NAMES = new Set(["王谦", "李晶晶"]);
const H5_PAGE_VERSION = "0.3.2";
const ENTRY_CONTEXT = window.EADemandEntryContext || {};
const FALLBACK_LEADER_FILTER_API = window.EADemandFallbackLeaderFilter || null;
const DEMAND_LOCATOR_NAVIGATION = window.EADemandLocatorNavigation || null;
const DEMAND_TASK_TIME_SORT = window.EADemandTaskTimeSort || null;
const TASK_ID_COPY_API = window.EADemandTaskIdCopy || null;
const PROJECT_SETTINGS_API = window.EADemandProjectSettings || null;
const PROJECT_CATALOG = [
  { value: "恶魔高校", label: "恶魔高校", aliases: ["高校"] },
  { value: "一骑当千", label: "一骑当千", aliases: ["一骑", "掌上谈兵", "STB"] },
  { value: "女王之刃", label: "女王之刃", aliases: ["女王"] },
  { value: "嗜血", label: "噬血狂袭", aliases: ["噬血狂袭"] },
  { value: "魔王", label: "魔王", aliases: [] }
];
const entryStatus = document.getElementById("entryStatus");
const sessionUserName = document.getElementById("sessionUserName");
const logoutButton = document.getElementById("logoutButton");
const entryRequestId = `demand-h5-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
let entryIdentitySource = "unknown";
const PROJECT_UPDATED_AT_WEEKDAYS = {
  恶魔高校: 3,
  女王之刃: 2,
  噬血狂袭: 4,
  嗜血: 4,
  魔王: 4,
  STB: 4
};
const PROJECT_THEME_NAMES = {
  恶魔高校: "highschool",
  女王之刃: "queen",
  一骑当千: "ikki",
  噬血狂袭: "strike",
  嗜血: "strike",
  魔王: "maou",
  STB: "stb"
};
const FIELD_DISPLAY_NAME_ALIASES = {
  策划负责人: "策划人员"
};
const drafts = [];
const todos = [];
const memberTodos = [];
const requiredFieldItems = [];
const fallbackRequiredFieldItems = [];
let fallbackLeaderFilters = [];
let selectedFallbackLeaderNames = new Set();
let draftNewestFirst = false;
let fallbackNewestFirst = false;
let currentUserLeaderRoles = [];
let memberTodoMessage = "";
let savingDraft = false;
let submittingLeaderSupplement = false;
let currentDraft = null;
let currentDraftRole = null;
let currentLeaderTask = null;
let listLoading = false;
let latestCacheRefreshedAt = "";
let collaborationLoadPromise = null;
let lastForegroundRefreshAt = 0;
let scrollPositionSaveTimer = 0;
let manualRefreshInProgress = false;
let projectSettings = null;
let projectSettingsDraft = null;
const panelScrollPositions = {};
const DISABLED_PANEL_NAMES = new Set(["create"]);

function queryParams() {
  return new URLSearchParams(window.location.search);
}

function isEmbeddedMode() {
  return queryParams().get("embed") === "1" || Boolean(
    typeof ENTRY_CONTEXT.isWeComClient === "function" && ENTRY_CONTEXT.isWeComClient(navigator.userAgent)
  );
}

function initEmbedMode() {
  document.body.classList.toggle("embedded", isEmbeddedMode());
}

function initialPanelName() {
  const hashPanelName = window.location.hash ? window.location.hash.slice(1) : "";
  const name = queryParams().get("panel") || queryParams().get("tab") || hashPanelName;
  return normalizePanelName(name);
}

function normalizePanelName(name) {
  if (!name || !panels[name] || DISABLED_PANEL_NAMES.has(name)) {
    return "todo";
  }
  if (name === "memberTodo" && currentUserLeaderRoles.length === 0) {
    return "todo";
  }
  if (name === "fallback" && !canShowFallbackPanel()) {
    return "todo";
  }
  return name;
}

function canShowFallbackPanel() {
  return FALLBACK_VIEWER_NAMES.has(currentUserName());
}

function defaultProjectSettings() {
  return PROJECT_SETTINGS_API
    ? PROJECT_SETTINGS_API.normalizeSettings({}, PROJECT_CATALOG)
    : { showAll: false, allProjects: PROJECT_CATALOG.map((item) => item.value), order: PROJECT_CATALOG.map((item) => item.value) };
}

function loadProjectSettings() {
  if (!PROJECT_SETTINGS_API) return defaultProjectSettings();
  try {
    const stored = window.localStorage.getItem(PROJECT_SETTINGS_API.STORAGE_KEY);
    return PROJECT_SETTINGS_API.normalizeSettings(stored ? JSON.parse(stored) : {}, PROJECT_CATALOG);
  } catch (error) {
    console.warn("Demand H5 project settings load failed", {
      message: error && error.message ? error.message : String(error || "")
    });
    return defaultProjectSettings();
  }
}

function persistProjectSettings(settings) {
  if (!PROJECT_SETTINGS_API) return;
  window.localStorage.setItem(PROJECT_SETTINGS_API.STORAGE_KEY, JSON.stringify(settings));
}

function projectSelectionOptions(settings = projectSettings) {
  return PROJECT_SETTINGS_API
    ? PROJECT_SETTINGS_API.selectableProjects(settings, PROJECT_CATALOG)
    : PROJECT_CATALOG;
}

function renderProjectSelect(preferredValue = "") {
  if (!projectSelect) return "";
  const options = projectSelectionOptions();
  projectSelect.innerHTML = "";
  for (const item of options) {
    const option = document.createElement("option");
    option.value = item.value;
    option.textContent = item.label;
    projectSelect.appendChild(option);
  }
  const availableValues = options.map((item) => item.value);
  const nextValue = availableValues.includes(preferredValue)
    ? preferredValue
    : (availableValues.includes(DEFAULT_PROJECT_NAME) ? DEFAULT_PROJECT_NAME : availableValues[0] || "");
  projectSelect.value = nextValue;
  return nextValue;
}

function selectedProjectValue() {
  return projectSelect ? String(projectSelect.value || "").trim() : String(projectInput.value || "").trim();
}

function selectedProjectQueryValue() {
  const value = selectedProjectValue();
  return PROJECT_SETTINGS_API && value === PROJECT_SETTINGS_API.ALL_PROJECT_VALUE ? "" : value;
}

function appendSelectedProject(params) {
  const project = selectedProjectQueryValue();
  if (project) params.set("project", project);
}

function filterItemsForSelectedProject(items) {
  if (!PROJECT_SETTINGS_API) return [...(items || [])];
  return PROJECT_SETTINGS_API.filterItems(items, selectedProjectValue(), projectSettings, PROJECT_CATALOG);
}

function projectLabel(value) {
  if (PROJECT_SETTINGS_API && value === PROJECT_SETTINGS_API.ALL_PROJECT_VALUE) return "全部项目";
  const item = PROJECT_CATALOG.find((project) => project.value === value);
  return item ? item.label : value;
}

function renderAllProjectOptions() {
  if (!allProjectsOptions || !projectSettingsDraft) return;
  allProjectsOptions.innerHTML = "";
  const included = new Set(projectSettingsDraft.allProjects || []);
  for (const project of PROJECT_CATALOG) {
    const label = document.createElement("label");
    const checkbox = document.createElement("input");
    const text = document.createElement("span");
    label.className = "all-project-option";
    checkbox.type = "checkbox";
    checkbox.value = project.value;
    checkbox.checked = included.has(project.value);
    text.textContent = project.label;
    label.append(checkbox, text);
    allProjectsOptions.appendChild(label);
  }
}

function renderProjectOrderList() {
  if (!projectOrderList || !projectSettingsDraft || !PROJECT_SETTINGS_API) return;
  projectOrderList.innerHTML = "";
  const order = PROJECT_SETTINGS_API.visibleOrder(projectSettingsDraft, PROJECT_CATALOG);
  order.forEach((value, index) => {
    const row = document.createElement("div");
    const label = document.createElement("span");
    const moveUp = document.createElement("button");
    const moveDown = document.createElement("button");
    row.className = "project-order-row";
    label.className = "project-order-label";
    label.textContent = projectLabel(value);
    moveUp.className = "project-order-button";
    moveUp.type = "button";
    moveUp.dataset.projectOrderValue = value;
    moveUp.dataset.projectOrderDirection = "up";
    moveUp.textContent = "↑";
    moveUp.title = `上移${label.textContent}`;
    moveUp.setAttribute("aria-label", moveUp.title);
    moveUp.disabled = index === 0;
    moveDown.className = "project-order-button";
    moveDown.type = "button";
    moveDown.dataset.projectOrderValue = value;
    moveDown.dataset.projectOrderDirection = "down";
    moveDown.textContent = "↓";
    moveDown.title = `下移${label.textContent}`;
    moveDown.setAttribute("aria-label", moveDown.title);
    moveDown.disabled = index === order.length - 1;
    row.append(label, moveUp, moveDown);
    projectOrderList.appendChild(row);
  });
}

function renderProjectSettingsDialog() {
  if (!projectSettingsDraft) return;
  if (showAllProjectsInput) showAllProjectsInput.checked = projectSettingsDraft.showAll;
  if (allProjectsFieldset) allProjectsFieldset.disabled = !projectSettingsDraft.showAll;
  renderAllProjectOptions();
  renderProjectOrderList();
}

function openProjectSettings() {
  if (!projectSettingsDialog || !PROJECT_SETTINGS_API) return;
  projectSettingsDraft = PROJECT_SETTINGS_API.normalizeSettings(projectSettings, PROJECT_CATALOG);
  renderProjectSettingsDialog();
  if (typeof projectSettingsDialog.showModal === "function") projectSettingsDialog.showModal();
  else projectSettingsDialog.setAttribute("open", "");
}

function closeProjectSettings() {
  if (!projectSettingsDialog) return;
  if (typeof projectSettingsDialog.close === "function") projectSettingsDialog.close();
  else projectSettingsDialog.removeAttribute("open");
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    method: options.method || "GET",
    cache: "no-store",
    headers: {
      "Content-Type": "application/json",
      "X-EA-Demand-Entry-Id": entryRequestId,
      "X-EA-Demand-Entry-Source": entryIdentitySource,
      "X-EA-Demand-Page-Version": H5_PAGE_VERSION,
      ...(options.headers || {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const payload = await response.json().catch(() => ({}));
  if (response.status === 401 && payload.code === "demand_session_required") {
    redirectForSessionLogin();
  }
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.message || `请求失败：HTTP ${response.status}`);
  }
  return payload;
}

function showToast(text) {
  toast.textContent = text;
  toast.classList.add("show");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => {
    toast.classList.remove("show");
  }, 1800);
}

function displayFieldName(fieldName) {
  const text = String(fieldName || "").trim();
  return FIELD_DISPLAY_NAME_ALIASES[text] || text;
}

function switchPanel(name) {
  savePanelScrollPosition(activePanelName());
  const nextName = normalizePanelName(name);
  if (nextName === "draft") {
    renderDraftPanel();
  }
  if (nextName === "fallback") {
    renderFallbackPanel();
  }
  if (nextName === "todo") {
    renderTodoPanel();
  }
  if (nextName === "memberTodo") {
    renderMemberTodoPanel();
  }
  activatePanel(nextName);
  restorePanelScrollPosition(nextName);
}

function activatePanel(name) {
  const nextName = normalizePanelName(name);
  for (const [panelName, panel] of Object.entries(panels)) {
    panel.classList.toggle("active", panelName === nextName);
  }
  for (const button of tabButtons) {
    const disabled = DISABLED_PANEL_NAMES.has(button.dataset.panel);
    const hiddenByRole = button.dataset.panel === "fallback" && !canShowFallbackPanel();
    const hidden = disabled || hiddenByRole;
    const active = !hidden && button.dataset.panel === nextName;
    button.hidden = hidden;
    button.classList.toggle("active", active);
  }
}

function activePanelName() {
  const activeButton = tabButtons.find((button) => button.classList.contains("active"));
  return activeButton && activeButton.dataset.panel ? activeButton.dataset.panel : "todo";
}

function setListLoading(isLoading) {
  listLoading = Boolean(isLoading);
  if (monitorRefreshButton) {
    monitorRefreshButton.disabled = listLoading || manualRefreshInProgress;
  }
  if (listLoading) {
    updateDataStatus();
  }
  for (const node of [todoLoading, memberTodoLoading, draftLoading, fallbackLoading]) {
    if (node) {
      node.hidden = !listLoading;
    }
  }
  if (listLoading) {
    if (todoEmpty && todos.length === 0) {
      todoEmpty.hidden = true;
    }
    if (memberTodoEmpty && memberTodos.length === 0) {
      memberTodoEmpty.hidden = true;
    }
    if (draftEmpty && requiredFieldItems.length === 0) {
      draftEmpty.hidden = true;
    }
    if (fallbackEmpty && fallbackRequiredFieldItems.length === 0) {
      fallbackEmpty.hidden = true;
    }
  }
}

function switchProject(projectName) {
  let nextProjectName = projectName;
  if (projectSelect) {
    const options = [...projectSelect.options].map((option) => option.value);
    if (!options.includes(nextProjectName)) {
      nextProjectName = projectSelect.value || options[0] || "";
    }
    projectSelect.value = nextProjectName;
  }
  projectInput.value = nextProjectName;
  applyProjectTheme(nextProjectName);
  updateProjectDefaultDates(nextProjectName);
  if (draftProjectOutput) {
    draftProjectOutput.textContent = nextProjectName;
  }
}

function applyProjectTheme(projectName) {
  document.documentElement.dataset.projectTheme = PROJECT_THEME_NAMES[projectName] || PROJECT_THEME_NAMES[DEFAULT_PROJECT_NAME];
}

function selectedPriority() {
  return document.getElementById("priorityInput")?.value.trim() || "";
}

function localDateText(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function localDateTimeText(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return "";
  }
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${year}/${month}/${day} ${hour}:${minute}`;
}

function updateDataStatus(refreshedAt) {
  if (!dataStatus) {
    return;
  }
  const nextValue = String(refreshedAt || latestCacheRefreshedAt || "").trim();
  if (nextValue) {
    latestCacheRefreshedAt = nextValue;
  }
  const displayText = localDateTimeText(latestCacheRefreshedAt);
  dataStatus.textContent = displayText ? `数据更新时间：${displayText}` : "数据更新时间：读取中";
}

function nextWeekDateText(weekday, date = new Date()) {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const daysToNextMonday = (8 - start.getDay()) % 7 || 7;
  const daysAfterMonday = weekday === 0 ? 6 : weekday - 1;
  start.setDate(start.getDate() + daysToNextMonday + daysAfterMonday);
  return localDateText(start);
}

function defaultUpdatedAtText(projectName) {
  const weekday = PROJECT_UPDATED_AT_WEEKDAYS[projectName];
  return typeof weekday === "number" ? nextWeekDateText(weekday) : localDateText();
}

function updateProjectDefaultDates(projectName) {
  const updatedAtInput = document.getElementById("updatedAtInput");
  if (updatedAtInput) {
    updatedAtInput.value = defaultUpdatedAtText(projectName);
  }
}

function inputValue(id) {
  return document.getElementById(id)?.value.trim() || "";
}

function setEntryStatus(text, tone = "") {
  if (!entryStatus) return;
  entryStatus.textContent = text || "";
  entryStatus.hidden = !text;
  entryStatus.classList.toggle("entry-status-test", tone === "test");
}

function setSubmitterIdentity(name, source) {
  if (!submitterInput) return;
  submitterInput.value = String(name || "").trim();
  entryIdentitySource = source || "unknown";
  if (sessionUserName) {
    sessionUserName.textContent = submitterInput.value || "未登录";
  }
}

function currentReturnPath() {
  const target = new URL(window.location.href);
  for (const key of ["code", "state", "userName", "name", "submitter", "entryAuth", "entryError"]) {
    target.searchParams.delete(key);
  }
  return `${target.pathname}${target.search}${target.hash}`;
}

function beginWeComAuthorization() {
  const returnTo = currentReturnPath();
  window.location.replace(`/demand-h5-auth?returnTo=${encodeURIComponent(returnTo)}`);
}

function beginWebLogin() {
  const returnTo = currentReturnPath();
  window.location.replace(`/demand-login.html?returnTo=${encodeURIComponent(returnTo)}`);
}

function redirectForSessionLogin() {
  if (isEmbeddedMode()) beginWeComAuthorization();
  else beginWebLogin();
}

async function requestSessionIdentity() {
  const response = await fetch("/api/dev-progress/h5-session", {
    cache: "no-store",
    headers: {
      "X-EA-Demand-Entry-Id": entryRequestId,
      "X-EA-Demand-Entry-Source": "session_check",
      "X-EA-Demand-Page-Version": H5_PAGE_VERSION
    }
  });
  const payload = await response.json().catch(() => ({}));
  return response.ok && payload.identity ? payload.identity : null;
}

function removeLegacyIdentityFromAddress() {
  const target = new URL(window.location.href);
  let changed = false;
  for (const key of ["code", "state", "userName", "name", "submitter", "entryAuth", "entryError"]) {
    if (target.searchParams.has(key)) {
      target.searchParams.delete(key);
      changed = true;
    }
  }
  if (changed) {
    window.history.replaceState(null, "", `${target.pathname}${target.search}${target.hash}`);
  }
}

async function requestWeComEntryPolicy() {
  const result = await requestJson("/api/dev-progress/h5-entry-policy");
  return result && result.policy ? result.policy : { mode: "identity_required", oauthEnabled: false, testFallbackName: "" };
}

async function initSubmitter() {
  if (!submitterInput) {
    return true;
  }
  const isWeCom = isEmbeddedMode();
  const identity = await requestSessionIdentity().catch(() => null);
  if (identity && identity.name) {
    setSubmitterIdentity(identity.name, identity.source || "signed_session");
    removeLegacyIdentityFromAddress();
    setEntryStatus("");
    return true;
  }

  const entryError = queryParams().get("entryError");
  if (entryError) {
    entryIdentitySource = `wecom_auth_error:${entryError}`;
    const message = entryError === "wecom_auth_invalid_origin" || entryError === "wecom_auth_not_ready" || entryError === "wecom_auth_origin_rejected"
      ? "企业微信身份入口配置不匹配，请确认可信域名、回调地址与工作台主页一致。"
      : "企业微信身份认证未完成，请返回工作台后重新打开需求进度管理。";
    setEntryStatus(message);
    return false;
  }

  if (isWeCom) {
    try {
      const policy = await requestWeComEntryPolicy();
      if (policy.mode === "wecom_oauth" && policy.oauthEnabled) {
        entryIdentitySource = "wecom_oauth_redirect";
        setEntryStatus("正在跳转企业微信身份认证...");
        beginWeComAuthorization();
        return false;
      }
      entryIdentitySource = "wecom_identity_required";
      setEntryStatus("未识别到有效企业微信身份，请从企业微信工作台进入需求进度管理。");
      return false;
    } catch (error) {
      entryIdentitySource = "wecom_entry_policy_failed";
      setEntryStatus("入口身份策略读取失败，请稍后重试。");
      return false;
    }
  }

  entryIdentitySource = "oauth_required";
  setEntryStatus("正在进入企业微信扫码登录...");
  beginWebLogin();
  return false;
}

function initDateInputs() {
  const today = localDateText();
  for (const id of ["updatedAtInput"]) {
    const input = document.getElementById(id);
    if (input && !input.value) {
      input.value = today;
    }
  }
}

function collectLeaderFields() {
  return [...document.querySelectorAll(".leader-option[aria-pressed=\"true\"]")]
    .map((option) => [option.dataset.leaderField || "", option.dataset.leaderNames || ""])
    .filter(([field]) => Boolean(field));
}

function toggleLeaderOption(option) {
  option.setAttribute("aria-pressed", option.getAttribute("aria-pressed") === "true" ? "false" : "true");
}

function updateDraftCount(count) {
  if (draftCountOutput) {
    draftCountOutput.textContent = String(count);
  }
}

function updateFallbackCount(count) {
  if (fallbackCountOutput) {
    fallbackCountOutput.textContent = String(count);
  }
  if (fallbackTabButton) {
    fallbackTabButton.hidden = !canShowFallbackPanel();
  }
}

function clipboardFallback(text) {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "readonly");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();
  try {
    if (document.execCommand("copy") !== true) {
      throw new Error("sync_copy_rejected");
    }
    return true;
  } finally {
    document.body.removeChild(textarea);
  }
}

async function copyText(text) {
  const value = String(text || "").trim();
  if (!value) {
    return false;
  }
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(value);
    return true;
  }
  clipboardFallback(value);
  return true;
}

function makeTaskCardInteractive(card) {
  card.setAttribute("role", "button");
  card.tabIndex = 0;
  card.addEventListener("keydown", (event) => {
    if (event.target !== card || (event.key !== "Enter" && event.key !== " ")) {
      return;
    }
    event.preventDefault();
    card.click();
  });
}

function appendTaskIdCopyButton(card, item) {
  const taskId = TASK_ID_COPY_API ? TASK_ID_COPY_API.taskIdForItem(item) : "";
  if (!taskId) {
    return;
  }
  const button = document.createElement("button");
  button.className = "task-id-copy-button";
  button.type = "button";
  button.title = "复制任务ID";
  button.setAttribute("aria-label", `复制任务ID ${taskId}`);
  const icon = document.createElement("span");
  icon.className = "task-id-copy-icon";
  icon.setAttribute("aria-hidden", "true");
  button.appendChild(icon);
  button.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    const result = await TASK_ID_COPY_API.copyTaskId(taskId, copyText);
    console.info("Demand H5 task ID copy finished", {
      userName: currentUserName(),
      panel: activePanelName(),
      taskIdLength: taskId.length,
      ok: result.ok,
      reason: result.reason
    });
    showToast(result.ok ? `已复制任务ID：${taskId}` : "任务ID复制失败");
  });
  card.classList.add("has-task-id-copy");
  card.appendChild(button);
}

function locatorLog(item, result) {
  console.info("Demand H5 locator navigation", {
    userName: currentUserName(),
    demandId: String(item && item.demandId || "").trim(),
    recordId: String(item && item.recordId || "").trim(),
    hasDemandTableUrl: Boolean(item && (item.demandTableUrl || item.demandUrl)),
    strategy: result.navigation.strategy,
    reason: result.navigation.reason,
    copyStatus: result.copyStatus,
    copyReason: result.copyReason || ""
  });
}

function showDemandLocatorResult(demandId, result) {
  if (result.navigation.strategy === "none") {
    showToast(demandId ? `已复制需求ID：${demandId}，但没有需求总表链接` : "没有可定位的需求总表链接");
    return;
  }
  if (result.copyStatus === "sync_copied") {
    showToast(demandId ? `已复制需求ID：${demandId}，已打开需求总表` : "已打开需求总表");
    return;
  }
  showToast(demandId ? "已打开需求总表，正在尝试复制需求ID" : "已打开需求总表");
}

function openDemandLocator(item) {
  const demandId = String(item && item.demandId ? item.demandId : "").trim();
  const demandTableUrl = String(item && (item.demandTableUrl || item.demandUrl) ? (item.demandTableUrl || item.demandUrl) : "").trim();
  const result = DEMAND_LOCATOR_NAVIGATION
    ? DEMAND_LOCATOR_NAVIGATION.copyThenOpen({
      demandId,
      url: demandTableUrl,
      copySynchronously: clipboardFallback,
      copyAsynchronously: copyText
    })
    : {
      navigation: { strategy: "none", reason: "navigation_module_unavailable" },
      copyStatus: demandId ? "copy_failed" : "no_id",
      copyReason: "navigation_module_unavailable",
      asyncCopyPromise: null
    };
  locatorLog(item, result);
  showDemandLocatorResult(demandId, result);
  if (result.asyncCopyPromise) {
    result.asyncCopyPromise.then((asyncResult) => {
      console.info("Demand H5 locator async copy completed", {
        demandId,
        status: asyncResult.status,
        reason: asyncResult.reason || ""
      });
      if (asyncResult.status === "copy_failed") {
        showToast("已打开需求总表，需求ID复制失败");
      }
    });
  }
  return result;
}

function updateTodoCount(count) {
  if (todoCountOutput) {
    todoCountOutput.textContent = String(count);
  }
}

function updateMemberTodoCount(count) {
  if (memberTodoCountOutput) {
    memberTodoCountOutput.textContent = String(count);
  }
}

function currentUserName() {
  return inputValue("submitterInput");
}

function splitNames(value) {
  return String(value || "")
    .split(/[、,，;；/\s]+/g)
    .map((item) => item.trim())
    .filter(Boolean);
}

function namesInclude(names, userName) {
  const targetName = String(userName || "").trim();
  return Boolean(targetName) && splitNames(names).includes(targetName);
}

function normalizeLeaderTaskForView(task) {
  const safeTask = task && typeof task === "object" ? task : {};
  return {
    taskId: safeTask.taskId || "",
    role: safeTask.role || "",
    names: safeTask.names || "",
    status: safeTask.status || "",
    statusText: safeTask.statusText || "",
    supplementFields: Array.isArray(safeTask.supplementFields)
      ? safeTask.supplementFields.map((field) => String(field || "").trim()).filter(Boolean)
      : [],
    supplementValues: safeTask.supplementValues && typeof safeTask.supplementValues === "object"
      ? safeTask.supplementValues
      : {},
    completedAt: safeTask.completedAt || "",
    completedBy: safeTask.completedBy || null
  };
}

function normalizeDraftForView(draft) {
  const submitter = draft.submitter && typeof draft.submitter === "object" ? draft.submitter : {};
  const leaders = Array.isArray(draft.leaders)
    ? draft.leaders.map((leader) => [
      leader.role || leader.field || "",
      leader.names || leader.value || ""
    ]).filter(([field]) => Boolean(field))
    : [];
  const leaderTasks = Array.isArray(draft.leaderTasks)
    ? draft.leaderTasks.map(normalizeLeaderTaskForView)
    : [];
  return {
    id: draft.id || "",
    status: draft.status || "",
    statusText: draft.statusText || "",
    submitter: submitter.name || draft.submitterName || "",
    project: draft.project || "",
    type: draft.type || "",
    scaleType: draft.scaleType || "",
    priority: draft.priority || "",
    name: draft.name || "",
    content: draft.content || "",
    linkAddress: draft.linkAddress || "",
    leaders,
    leaderTasks,
    leaderSupplements: draft.leaderSupplements && typeof draft.leaderSupplements === "object" ? draft.leaderSupplements : {},
    supplementValues: draft.supplementValues && typeof draft.supplementValues === "object" ? draft.supplementValues : {},
    designDeliveryDate: draft.designDeliveryDate || "",
    updatedAt: draft.updatedAt || "",
    createdAt: draft.createdAt || "",
    expiresAt: draft.expiresAt || ""
  };
}

function normalizeRequiredFieldItem(item) {
  const safeItem = item && typeof item === "object" ? item : {};
  return {
    id: safeItem.id || safeItem.recordId || safeItem.demandId || "",
    ownerName: safeItem.ownerName || "",
    originalOwnerName: safeItem.originalOwnerName || "",
    isFallbackOwner: Boolean(safeItem.isFallbackOwner || safeItem.ownerType === "fallback"),
    ownerType: safeItem.ownerType || "",
    recordId: safeItem.recordId || "",
    demandId: safeItem.demandId || "",
    project: safeItem.project || "",
    demand: safeItem.demand || "",
    demandType: safeItem.demandType || "",
    status: safeItem.status || "",
    leaderNames: FALLBACK_LEADER_FILTER_API
      ? FALLBACK_LEADER_FILTER_API.uniqueNames(safeItem.leaderNames)
      : [],
    missingFields: Array.isArray(safeItem.missingFields)
      ? safeItem.missingFields.map(displayFieldName).filter(Boolean)
      : [],
    createdAt: safeItem.createdAt || "",
    createdTime: safeItem.createdTime || "",
    updatedAt: safeItem.updatedAt || "",
    recordUpdatedAt: safeItem.recordUpdatedAt || "",
    recordUpdatedTime: safeItem.recordUpdatedTime || "",
    demandLink: safeItem.demandLink || "",
    demandLinkUrl: safeItem.demandLinkUrl || "",
    demandTableUrl: safeItem.demandTableUrl || "",
    demandUrl: safeItem.demandUrl || "",
    groupChat: safeItem.groupChat || ""
  };
}

function replaceRequiredFieldItems(nextItems) {
  requiredFieldItems.splice(0, requiredFieldItems.length, ...nextItems.map(normalizeRequiredFieldItem));
  refreshDraftCount();
}

function replaceFallbackRequiredFieldItems(nextItems) {
  fallbackRequiredFieldItems.splice(0, fallbackRequiredFieldItems.length, ...nextItems.map(normalizeRequiredFieldItem));
  refreshFallbackCount();
}

function replaceFallbackLeaderFilters(nextFilters) {
  fallbackLeaderFilters = Array.isArray(nextFilters) ? nextFilters : [];
}

function fallbackLeaderOptions() {
  return FALLBACK_LEADER_FILTER_API
    ? FALLBACK_LEADER_FILTER_API.leaderOptions(fallbackLeaderFilters)
    : [];
}

function visibleFallbackRequiredFieldItems() {
  return FALLBACK_LEADER_FILTER_API
    ? FALLBACK_LEADER_FILTER_API.visibleItems(fallbackRequiredFieldItems, selectedFallbackLeaderNames)
    : [...fallbackRequiredFieldItems];
}

function sortedRequiredFieldItems(items, newestFirst) {
  return DEMAND_TASK_TIME_SORT
    ? DEMAND_TASK_TIME_SORT.sortByCreatedTime(items, newestFirst)
    : [...items];
}

function updateCreatedTimeSortButton(button, newestFirst) {
  if (!button) return;
  const directionText = newestFirst ? "越晚创建越靠上" : "越早创建越靠上";
  const nextDirectionText = newestFirst ? "越早创建越靠上" : "越晚创建越靠上";
  const panelText = button.dataset.panel === "fallback" ? "兜底需求" : "字段待补充";
  button.dataset.newestFirst = String(newestFirst);
  button.setAttribute("aria-label", `${panelText}，按创建时间排序：当前${directionText}，点击切换为${nextDirectionText}`);
  button.title = `当前${directionText}，点击切换为${nextDirectionText}`;
}

function toggleCreatedTimeSort(scope) {
  if (!DEMAND_TASK_TIME_SORT) return;
  if (scope === "draft") {
    draftNewestFirst = DEMAND_TASK_TIME_SORT.toggleDirection(draftNewestFirst);
    console.info("Demand H5 created-time sort changed", {
      scope,
      newestFirst: draftNewestFirst,
      clickTarget: "whole_tab",
      itemCount: requiredFieldItems.length
    });
    renderDraftPanel();
    return;
  }
  fallbackNewestFirst = DEMAND_TASK_TIME_SORT.toggleDirection(fallbackNewestFirst);
  console.info("Demand H5 created-time sort changed", {
    scope,
    newestFirst: fallbackNewestFirst,
    clickTarget: "whole_tab",
    itemCount: visibleFallbackRequiredFieldItems().length
  });
  renderFallbackPanel();
}

function renderFallbackLeaderFilter() {
  if (!fallbackLeaderFilter || !fallbackLeaderFilterOptions) return;
  const options = fallbackLeaderOptions();
  fallbackLeaderFilter.hidden = options.length === 0;
  fallbackLeaderFilterOptions.innerHTML = "";
  for (const option of options) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "fallback-filter-option";
    button.dataset.fallbackLeaderName = option.name;
    button.setAttribute("aria-pressed", String(selectedFallbackLeaderNames.has(option.name)));
    button.textContent = option.name;
    button.setAttribute("aria-label", `${option.name}，点击切换筛选`);
    fallbackLeaderFilterOptions.appendChild(button);
  }
  if (fallbackLeaderFilterClear) {
    fallbackLeaderFilterClear.hidden = selectedFallbackLeaderNames.size === 0;
    fallbackLeaderFilterOptions.appendChild(fallbackLeaderFilterClear);
  }
}

function replaceDrafts(nextDrafts) {
  drafts.splice(0, drafts.length, ...nextDrafts.map(normalizeDraftForView));
  refreshDraftCount();
}

function upsertDraft(nextDraft) {
  const normalized = normalizeDraftForView(nextDraft);
  const index = drafts.findIndex((draft) => draft.id === normalized.id);
  if (index >= 0) {
    drafts[index] = normalized;
  } else {
    drafts.unshift(normalized);
  }
  refreshDraftCount();
  return normalized;
}

function normalizeTodoForView(item) {
  const missingFields = Array.isArray(item.missingFields)
    ? item.missingFields.map(displayFieldName).filter(Boolean)
    : [];
  const memberNames = Array.isArray(item.memberNames || item.assigneeNames)
    ? (item.memberNames || item.assigneeNames).map((name) => String(name || "").trim()).filter(Boolean)
    : [];
  const roleLabels = Array.isArray(item.roleLabels)
    ? item.roleLabels.map((label) => {
      const text = String(label || "");
      if (!text.startsWith("缺失：")) {
        return text;
      }
      const fields = text.slice("缺失：".length)
        .split("、")
        .map(displayFieldName)
        .filter(Boolean);
      return `缺失：${fields.join("、") || "-"}`;
    }).filter(Boolean)
    : [];
  return {
    source: item.source || (item.demandId || item.recordId ? "dev_progress" : "demand_collaboration"),
    id: item.id || item.taskId || item.recordId || item.demandId || "",
    taskId: item.taskId || "",
    draftId: item.draftId || "",
    kind: item.kind || "",
    role: item.role || "",
    roleName: item.roleName || "",
    statusText: item.statusText || "",
    actionText: item.actionText || "",
    title: item.title || "",
    project: item.project || "",
    updatedAt: item.updatedAt || "",
    designDeliveryDate: item.designDeliveryDate || "",
    recordId: item.recordId || "",
    demandId: item.demandId || "",
    demand: item.demand || item.title || "",
    demandType: item.demandType || "",
    status: item.status || item.statusText || "",
    roleLabels,
    memberNames,
    assigneeNames: memberNames,
    assigneeFields: Array.isArray(item.assigneeFields) ? item.assigneeFields : [],
    leaderFields: Array.isArray(item.leaderFields) ? item.leaderFields : [],
    missingFields,
    createdAt: item.createdAt || "",
    createdTime: item.createdTime || "",
    recordUpdatedAt: item.recordUpdatedAt || "",
    recordUpdatedTime: item.recordUpdatedTime || "",
    demandLink: item.demandLink || "",
    demandLinkUrl: item.demandLinkUrl || "",
    demandTableUrl: item.demandTableUrl || "",
    demandUrl: item.demandUrl || "",
    groupChat: item.groupChat || "",
    draft: normalizeDraftForView(item.draft || {}),
    leaderTask: item.leaderTask ? normalizeLeaderTaskForView(item.leaderTask) : null
  };
}

function replaceTodos(nextTodos) {
  todos.splice(0, todos.length, ...nextTodos.map(normalizeTodoForView));
  refreshTodoCounts();
}

function replaceMemberTodos(nextTodos) {
  memberTodos.splice(0, memberTodos.length, ...nextTodos.map(normalizeTodoForView));
  refreshTodoCounts();
}

function refreshTodoCounts() {
  updateTodoCount(todos.length);
  updateMemberTodoCount(memberTodos.length);
  updateLeaderNavigation();
}

function updateLeaderNavigation() {
  const isLeader = currentUserLeaderRoles.length > 0;
  if (memberTodoTabButton) {
    memberTodoTabButton.hidden = !isLeader;
  }
  if (tabs) {
    tabs.classList.toggle("leader-tabs", isLeader);
    tabs.classList.toggle("fallback-tabs", canShowFallbackPanel());
  }
  if (!isLeader && panels.memberTodo && panels.memberTodo.classList.contains("active")) {
    activatePanel("todo");
  }
}

async function loadDraftsFromServer(options = {}) {
  try {
    const params = new URLSearchParams();
    params.set("limit", "4000");
    appendSelectedProject(params);
    if (options.forceRefresh) params.set("forceRefresh", "1");
    if (options.waitForRefresh) params.set("waitForRefresh", "1");
    const result = await requestJson(`/api/dev-progress/required-field-items?${params.toString()}`);
    const devProgress = result.devProgress || {};
    updateDataStatus(devProgress.cache && devProgress.cache.refreshedAt);
    replaceRequiredFieldItems(filterItemsForSelectedProject(Array.isArray(devProgress.items) ? devProgress.items : []));
    return devProgress.cache || null;
  } catch (error) {
    if (options.throwOnError) throw error;
    showToast(`读取待补充需求失败：${error.message}`);
    return null;
  }
}

async function loadFallbackItemsFromServer(options = {}) {
  if (!canShowFallbackPanel()) {
    replaceFallbackRequiredFieldItems([]);
    return null;
  }
  try {
    const params = new URLSearchParams();
    params.set("limit", "4000");
    params.set("scope", "fallback");
    appendSelectedProject(params);
    const result = await requestJson(`/api/dev-progress/required-field-items?${params.toString()}`);
    const devProgress = result.devProgress || {};
    updateDataStatus(devProgress.cache && devProgress.cache.refreshedAt);
    replaceFallbackLeaderFilters(devProgress.leaderFilters);
    replaceFallbackRequiredFieldItems(filterItemsForSelectedProject(Array.isArray(devProgress.items) ? devProgress.items : []));
    return devProgress.cache || null;
  } catch (error) {
    if (options.throwOnError) throw error;
    showToast(`读取兜底需求失败：${error.message}`);
    return null;
  }
}

async function loadTodosFromServer(options = {}) {
  try {
    const params = new URLSearchParams();
    params.set("limit", "4000");
    appendSelectedProject(params);
    const result = await requestJson(`/api/dev-progress/person-tasks?${params.toString()}`);
    const devProgress = result.devProgress || {};
    updateDataStatus(devProgress.cache && devProgress.cache.refreshedAt);
    replaceTodos(filterItemsForSelectedProject(Array.isArray(devProgress.items) ? devProgress.items : []).map((item) => ({
      ...item,
      source: "dev_progress"
    })));
    return devProgress.cache || null;
  } catch (error) {
    if (options.throwOnError) throw error;
    showToast(`读取待办失败：${error.message}`);
    return null;
  }
}

async function loadMemberTodosFromServer(options = {}) {
  try {
    const params = new URLSearchParams();
    params.set("limit", "4000");
    appendSelectedProject(params);
    const result = await requestJson(`/api/dev-progress/member-tasks?${params.toString()}`);
    const devProgress = result.devProgress || {};
    updateDataStatus(devProgress.cache && devProgress.cache.refreshedAt);
    currentUserLeaderRoles = Array.isArray(devProgress.leaderRoles) ? devProgress.leaderRoles : [];
    memberTodoMessage = devProgress.message || "";
    replaceMemberTodos(filterItemsForSelectedProject(Array.isArray(devProgress.items) ? devProgress.items : []).map((item) => ({
      ...item,
      source: "dev_progress"
    })));
    return devProgress.cache || null;
  } catch (error) {
    currentUserLeaderRoles = [];
    memberTodoMessage = "";
    replaceMemberTodos([]);
    if (options.throwOnError) throw error;
    showToast(`读取组员待办失败：${error.message}`);
    return null;
  }
}

async function loadTodoDataFromServer(options = {}) {
  await loadTodosFromServer(options);
  await loadMemberTodosFromServer(options);
  renderTodoPanel();
}

async function loadCollaborationData(options = {}) {
  const cache = await loadDraftsFromServer({
    forceRefresh: Boolean(options.forceRefresh),
    waitForRefresh: Boolean(options.forceRefresh || options.waitForRefresh),
    throwOnError: Boolean(options.throwOnError)
  });
  await loadFallbackItemsFromServer(options);
  await loadTodoDataFromServer(options);
  return { cache };
}

async function refreshCollaborationData(options = {}) {
  if (collaborationLoadPromise) {
    return collaborationLoadPromise;
  }

  const panelName = options.panelName || activePanelName();
  setListLoading(true);
  collaborationLoadPromise = loadCollaborationData(options)
    .catch((error) => {
      if (!options.manual) showToast(`读取协作数据失败：${error.message}`);
      if (options.throwOnError) throw error;
      return null;
    })
    .finally(() => {
      setListLoading(false);
      switchPanel(panelName);
      collaborationLoadPromise = null;
    });
  return collaborationLoadPromise;
}

function refreshAfterPageResume() {
  if (document.visibilityState && document.visibilityState !== "visible") {
    return;
  }
  const now = Date.now();
  if (now - lastForegroundRefreshAt < 3000) {
    return;
  }
  lastForegroundRefreshAt = now;
  refreshCollaborationData({ panelName: activePanelName() });
}

async function performManualRefresh() {
  if (manualRefreshInProgress || collaborationLoadPromise) return;
  const previousRefreshedAt = latestCacheRefreshedAt;
  manualRefreshInProgress = true;
  if (monitorRefreshButton) {
    monitorRefreshButton.disabled = true;
    monitorRefreshButton.classList.add("is-refreshing");
  }
  if (dataStatus) dataStatus.textContent = "数据更新时间：正在读取最新需求总表...";
  const startedAt = Date.now();
  try {
    const result = await refreshCollaborationData({
      panelName: activePanelName(),
      forceRefresh: true,
      waitForRefresh: true,
      manual: true,
      throwOnError: true
    });
    const refreshedAt = result && result.cache ? String(result.cache.refreshedAt || "") : "";
    if (!refreshedAt || refreshedAt === previousRefreshedAt) {
      throw new Error("未能读取最新需求总表，当前仍显示上一次成功数据");
    }
    console.info("Demand H5 manual refresh completed", {
      project: selectedProjectValue(),
      durationMs: Date.now() - startedAt,
      refreshedAt
    });
    showToast("已读取最新需求总表");
  } catch (error) {
    updateDataStatus(previousRefreshedAt);
    console.warn("Demand H5 manual refresh failed", {
      project: selectedProjectValue(),
      durationMs: Date.now() - startedAt,
      message: error && error.message ? error.message : String(error || "")
    });
    showToast(`刷新失败：${error.message}`);
  } finally {
    manualRefreshInProgress = false;
    if (monitorRefreshButton) {
      monitorRefreshButton.disabled = Boolean(collaborationLoadPromise);
      monitorRefreshButton.classList.remove("is-refreshing");
    }
  }
}

function resetPageScroll() {
  window.requestAnimationFrame(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  });
}

function currentPageScrollTop() {
  return window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0;
}

function savePanelScrollPosition(panelName) {
  const name = normalizePanelName(panelName);
  panelScrollPositions[name] = currentPageScrollTop();
}

function scheduleActivePanelScrollSave() {
  if (scrollPositionSaveTimer) {
    return;
  }
  scrollPositionSaveTimer = window.requestAnimationFrame(() => {
    scrollPositionSaveTimer = 0;
    savePanelScrollPosition(activePanelName());
  });
}

function restorePanelScrollPosition(panelName) {
  const name = normalizePanelName(panelName);
  const scrollTop = panelScrollPositions[name] || 0;
  window.requestAnimationFrame(() => {
    window.scrollTo({ top: scrollTop, left: 0, behavior: "auto" });
  });
}

function scrollActivePanelToTop(panelName) {
  const name = normalizePanelName(panelName || activePanelName());
  panelScrollPositions[name] = 0;
  resetPageScroll();
}

function showDraftEmpty() {
  currentDraft = null;
  currentDraftRole = null;
  currentLeaderTask = null;
  if (leaderSupplementSection) {
    leaderSupplementSection.hidden = true;
  }
  if (draftEmpty) {
    draftEmpty.hidden = listLoading;
    draftEmpty.textContent = "暂无字段待补充";
  }
  if (draftList) {
    draftList.hidden = true;
  }
  if (draftContent) {
    draftContent.hidden = true;
  }
}

function showFallbackEmpty() {
  if (fallbackEmpty) {
    fallbackEmpty.hidden = listLoading;
    fallbackEmpty.textContent = selectedFallbackLeaderNames.size > 0
      ? "未找到所选组长相关的兜底需求"
      : "暂无兜底需求";
  }
  if (fallbackList) {
    fallbackList.hidden = true;
  }
}

function draftSummaryText(draft) {
  return [draft.project, draft.updatedAt].filter(Boolean).join(" · ");
}

function renderRequiredItemList(listNode, items, datasetName) {
  if (!listNode) {
    return;
  }
  listNode.innerHTML = "";

  for (const requiredItem of items) {
    const item = document.createElement("div");
    item.className = "draft-list-item required-field-item";
    makeTaskCardInteractive(item);
    item.dataset[datasetName] = requiredItem.id;

    const text = document.createElement("span");
    text.className = "draft-list-text";

    const title = document.createElement("strong");
    title.textContent = `[${requiredItem.demandId || "-"}] ${requiredItem.demand || "未命名需求"}`;

    const meta = document.createElement("em");
    meta.textContent = [
      requiredItem.project,
      requiredItem.demandType,
      requiredItem.status,
      requiredItem.updatedAt
    ].filter(Boolean).join(" · ");

    const missing = document.createElement("span");
    missing.className = "missing-fields-line";
    missing.textContent = `缺失：${requiredItem.missingFields.join("、") || "-"}`;

    text.append(title, meta, missing);
    item.append(text);
    appendTaskIdCopyButton(item, requiredItem);
    listNode.appendChild(item);
  }
}

function renderDraftList() {
  updateCreatedTimeSortButton(draftTabButton, draftNewestFirst);
  renderRequiredItemList(draftList, sortedRequiredFieldItems(requiredFieldItems, draftNewestFirst), "requiredItemId");
}

function renderFallbackList() {
  updateCreatedTimeSortButton(fallbackTabButton, fallbackNewestFirst);
  renderRequiredItemList(
    fallbackList,
    sortedRequiredFieldItems(visibleFallbackRequiredFieldItems(), fallbackNewestFirst),
    "fallbackItemId"
  );
}

function todoSummaryText(todo) {
  if (todo.source === "dev_progress") {
    return [
      todo.project,
      todo.demandType,
      todo.status,
      todo.roleLabels.join("、")
    ].filter(Boolean).join(" · ");
  }
  return [todo.project, todo.actionText || todo.statusText].filter(Boolean).join(" · ");
}

function renderTodoList() {
  if (!todoList) {
    return;
  }
  todoList.innerHTML = "";

  for (const todo of todos) {
    const item = document.createElement("div");
    item.className = "draft-list-item";
    makeTaskCardInteractive(item);
    item.dataset.todoId = todo.id;

    const text = document.createElement("span");
    text.className = "draft-list-text";

    const title = document.createElement("strong");
    title.textContent = todo.source === "dev_progress"
      ? `[${todo.demandId || "-"}] ${todo.demand || "未命名需求"}`
      : (todo.title || todo.draft.name);

    const meta = document.createElement("em");
    meta.textContent = todoSummaryText(todo);

    text.append(title, meta);
    item.append(text);
    if (todo.source !== "dev_progress") {
      const action = document.createElement("span");
      action.className = "state-pill";
      action.textContent = "处理";
      item.append(action);
    }
    appendTaskIdCopyButton(item, todo);
    todoList.appendChild(item);
  }
}

function renderMemberTodoList() {
  if (!memberTodoList) {
    return;
  }
  memberTodoList.innerHTML = "";

  for (const todo of memberTodos) {
    const item = document.createElement("div");
    item.className = "draft-list-item";
    makeTaskCardInteractive(item);
    item.dataset.memberTodoId = todo.id;

    const text = document.createElement("span");
    text.className = "draft-list-text";

    const title = document.createElement("strong");
    title.textContent = todo.source === "dev_progress"
      ? `[${todo.demandId || "-"}] ${todo.demand || "未命名需求"}`
      : (todo.title || todo.draft.name || "组员任务");

    const meta = document.createElement("em");
    const memberText = todo.memberNames.length > 0 ? `组员：${todo.memberNames.join("、")}` : "";
    meta.textContent = [memberText, todoSummaryText(todo)].filter(Boolean).join(" · ");

    text.append(title, meta);
    item.append(text);
    appendTaskIdCopyButton(item, todo);
    memberTodoList.appendChild(item);
  }
}

function showTodoEmpty() {
  if (todoEmpty) {
    todoEmpty.hidden = listLoading;
  }
  if (todoList) {
    todoList.hidden = true;
  }
}

function showTodoList() {
  if (todoEmpty) {
    todoEmpty.hidden = true;
  }
  renderTodoList();
  if (todoList) {
    todoList.hidden = false;
  }
}

function showMemberTodoEmpty() {
  if (memberTodoEmpty) {
    memberTodoEmpty.hidden = listLoading;
    memberTodoEmpty.textContent = "暂无组员待办";
  }
  if (memberTodoList) {
    memberTodoList.hidden = true;
  }
}

function showMemberTodoList() {
  if (memberTodoEmpty) {
    memberTodoEmpty.hidden = true;
  }
  renderMemberTodoList();
  if (memberTodoList) {
    memberTodoList.hidden = false;
  }
}

function renderMemberTodoSummary() {
  if (!memberTodoSummary) {
    return;
  }
  if (currentUserLeaderRoles.length === 0) {
    memberTodoSummary.hidden = true;
    memberTodoSummary.textContent = "";
    return;
  }
  const roleText = currentUserLeaderRoles
    .map((role) => {
      const members = Array.isArray(role.memberNames) ? role.memberNames.length : 0;
      return `${role.leaderField || role.assigneeField}：${members}人`;
    })
    .join("；");
  memberTodoSummary.textContent = roleText || memberTodoMessage || "当前身份是组长";
  memberTodoSummary.hidden = false;
}

function renderTodoPanel() {
  refreshTodoCounts();
  if (todos.length === 0) {
    showTodoEmpty();
    return;
  }
  showTodoList();
}

function renderMemberTodoPanel() {
  refreshTodoCounts();
  renderMemberTodoSummary();
  if (memberTodos.length === 0) {
    showMemberTodoEmpty();
    return;
  }
  showMemberTodoList();
}

function showDraftList() {
  currentDraft = null;
  currentDraftRole = null;
  currentLeaderTask = null;
  if (leaderSupplementSection) {
    leaderSupplementSection.hidden = true;
  }
  if (draftEmpty) {
    draftEmpty.hidden = true;
  }
  if (draftContent) {
    draftContent.hidden = true;
  }
  renderDraftList();
  if (draftList) {
    draftList.hidden = false;
  }
}

function showFallbackList() {
  renderFallbackList();
  if (fallbackEmpty) {
    fallbackEmpty.hidden = true;
  }
  if (fallbackList) {
    fallbackList.hidden = false;
  }
}

function looksLikeDateField(fieldName) {
  return /日期|时间/.test(String(fieldName || ""));
}

function findPendingLeaderTaskForCurrentUser(draft) {
  return (draft.leaderTasks || []).find((task) => (
    (task.status || "pending") === "pending" && namesInclude(task.names, currentUserName())
  )) || null;
}

function pendingLeaderTaskLabels(draft) {
  return (draft.leaderTasks || [])
    .filter((task) => (task.status || "pending") === "pending")
    .map((task) => task.role || task.names || "组长")
    .filter(Boolean);
}

function leaderTaskStatusText(task) {
  const status = task.status || "pending";
  if (status === "completed") {
    return "已补充";
  }
  return task.statusText || "待补充";
}

function leaderStatusSummary(draft) {
  const tasks = Array.isArray(draft.leaderTasks) ? draft.leaderTasks : [];
  if (tasks.length > 0) {
    return tasks
      .map((task) => `${task.role || "组长"}：${leaderTaskStatusText(task)}`)
      .join("；");
  }
  return draft.leaders.length
    ? draft.leaders.map(([field, value]) => `${field}：${value}`).join("；")
    : "未选择通知对象";
}

function canViewDraftForCurrentUser(draft) {
  if (!draft) {
    return false;
  }
  if (draft.submitter === currentUserName()) {
    return true;
  }
  return Boolean(findPendingLeaderTaskForCurrentUser(draft));
}

function visibleDraftsForCurrentUser() {
  return drafts.filter(canViewDraftForCurrentUser);
}

function refreshDraftCount() {
  updateDraftCount(requiredFieldItems.length);
}

function refreshFallbackCount() {
  updateFallbackCount(visibleFallbackRequiredFieldItems().length);
}

function fieldInputId(fieldName) {
  return `leaderSupplement_${String(fieldName || "").replace(/[^\w\u4e00-\u9fa5]+/g, "_")}`;
}

function renderLeaderSupplementForm(role) {
  currentLeaderTask = role && role.leaderTask ? role.leaderTask : null;
  if (!leaderSupplementSection || !leaderSupplementFields) {
    return;
  }
  leaderSupplementFields.innerHTML = "";

  if (!role || role.type !== "leader" || !currentLeaderTask || (currentLeaderTask.status || "pending") !== "pending") {
    leaderSupplementSection.hidden = true;
    return;
  }

  const fields = Array.isArray(currentLeaderTask.supplementFields) ? currentLeaderTask.supplementFields : [];
  if (leaderSupplementTitle) {
    leaderSupplementTitle.textContent = `${currentLeaderTask.role || "组长"}补充字段`;
  }

  if (fields.length === 0) {
    const empty = document.createElement("p");
    empty.className = "leader-supplement-empty";
    empty.textContent = "当前组长没有配置补充字段，点击保存即可完成处理。";
    leaderSupplementFields.appendChild(empty);
  }

  for (const field of fields) {
    const label = document.createElement("label");
    const labelText = document.createElement("span");
    const input = document.createElement("input");
    labelText.textContent = field;
    input.id = fieldInputId(field);
    input.dataset.fieldName = field;
    input.type = looksLikeDateField(field) ? "date" : "text";
    input.required = true;
    input.value = currentLeaderTask.supplementValues[field] || "";
    label.append(labelText, input);
    leaderSupplementFields.appendChild(label);
  }

  leaderSupplementSection.hidden = false;
}

function resolveDraftRole(draft, context = {}) {
  if (context.todo && context.todo.kind === "leader_supplement") {
    const leaderTask = context.todo.leaderTask || findPendingLeaderTaskForCurrentUser(draft);
    return {
      type: "leader",
      text: `组长视角：${context.todo.roleName || "组长"}待补充`,
      primaryText: "保存补充",
      secondaryText: "返回待办",
      leaderTask
    };
  }
  if (context.todo && context.todo.kind === "submitter_confirm") {
    return {
      type: "submitter",
      text: "提出人视角：待最终确认",
      primaryText: "最终确认",
      secondaryText: "撤回修改"
    };
  }
  if (draft.submitter === currentUserName()) {
    const pendingLabels = pendingLeaderTaskLabels(draft);
    return {
      type: "submitter",
      text: draft.status === "leader_pending"
        ? `提出人视角：等待组长补充${pendingLabels.length ? `（还差：${pendingLabels.join("、")}）` : ""}`
        : "提出人视角：待最终确认",
      primaryText: draft.status === "leader_pending" ? "提醒未处理人" : "最终确认",
      secondaryText: "撤回修改"
    };
  }
  const leaderTask = findPendingLeaderTaskForCurrentUser(draft);
  if (leaderTask) {
    return {
      type: "leader",
      text: `组长视角：${leaderTask.role || "组长"}待补充`,
      primaryText: "保存补充",
      secondaryText: "返回待办",
      leaderTask
    };
  }
  return {
    type: "readonly",
    text: "只读视角：当前用户不是处理人",
    primaryText: "",
    secondaryText: "返回列表"
  };
}

function applyDraftRole(role) {
  if (draftRoleNotice) {
    draftRoleNotice.hidden = false;
    draftRoleNotice.textContent = role.text;
  }
  if (draftPrimaryAction) {
    draftPrimaryAction.hidden = !role.primaryText;
    draftPrimaryAction.textContent = role.primaryText || "";
  }
  if (draftSecondaryAction) {
    draftSecondaryAction.textContent = role.secondaryText || "返回列表";
  }
}

function renderDraftDetail(draft, context = {}) {
  const role = resolveDraftRole(draft, context);
  currentDraft = draft;
  currentDraftRole = role;
  if (draftIdOutput) {
    draftIdOutput.textContent = draft.id;
  }
  if (draftNameOutput) {
    draftNameOutput.textContent = draft.name;
  }
  if (draftStatusOutput) {
    draftStatusOutput.textContent = draft.statusText || "等待确认";
  }
  if (draftProjectOutput) {
    draftProjectOutput.textContent = draft.project;
  }
  if (draftTypeOutput) {
    draftTypeOutput.textContent = draft.type;
  }
  if (draftScaleTypeOutput) {
    draftScaleTypeOutput.textContent = draft.scaleType;
  }
  if (draftPriorityOutput) {
    draftPriorityOutput.textContent = draft.priority;
  }
  if (draftDesignDeliveryDateOutput) {
    draftDesignDeliveryDateOutput.textContent = draft.designDeliveryDate;
  }
  if (draftUpdatedAtOutput) {
    draftUpdatedAtOutput.textContent = draft.updatedAt;
  }
  if (draftLeadsOutput) {
    draftLeadsOutput.textContent = leaderStatusSummary(draft);
  }
  if (draftDemandContentOutput) {
    draftDemandContentOutput.textContent = draft.content;
  }
  if (draftLinkOutput) {
    draftLinkOutput.textContent = draft.linkAddress;
  }
  applyDraftRole(role);
  renderLeaderSupplementForm(role);
  if (draftEmpty) {
    draftEmpty.hidden = true;
  }
  if (draftList) {
    draftList.hidden = true;
  }
  if (draftContent) {
    draftContent.hidden = false;
  }
  resetPageScroll();
}

function renderDraftPanel() {
  updateCreatedTimeSortButton(draftTabButton, draftNewestFirst);
  updateDraftCount(requiredFieldItems.length);
  if (requiredFieldItems.length === 0) {
    showDraftEmpty();
    return;
  }
  showDraftList();
}

function renderFallbackPanel() {
  updateCreatedTimeSortButton(fallbackTabButton, fallbackNewestFirst);
  renderFallbackLeaderFilter();
  refreshFallbackCount();
  if (visibleFallbackRequiredFieldItems().length === 0) {
    showFallbackEmpty();
    return;
  }
  showFallbackList();
}

function renderGeneratedDraft(draft) {
  const nextDraft = normalizeDraftForView(draft);
  drafts.unshift(nextDraft);
  refreshDraftCount();
  const visibleDrafts = visibleDraftsForCurrentUser();
  if (visibleDrafts.length === 1) {
    renderDraftDetail(nextDraft);
    return;
  }
  showDraftList();
}

function collectLeaderSupplementValues() {
  const values = {};
  if (!leaderSupplementFields) {
    return values;
  }
  for (const input of leaderSupplementFields.querySelectorAll("input[data-field-name]")) {
    values[input.dataset.fieldName] = input.value.trim();
  }
  return values;
}

async function submitCurrentLeaderSupplement() {
  if (submittingLeaderSupplement) {
    return;
  }
  if (!currentDraft || !currentLeaderTask) {
    showToast("未找到当前组长任务");
    return;
  }

  const values = collectLeaderSupplementValues();
  const missing = (currentLeaderTask.supplementFields || []).filter((field) => !values[field]);
  if (missing.length > 0) {
    showToast(`请先补齐：${missing.join("、")}`);
    return;
  }

  submittingLeaderSupplement = true;
  if (draftPrimaryAction) {
    draftPrimaryAction.disabled = true;
  }

  try {
    const result = await requestJson("/api/demand-collaboration/leader-supplement", {
      method: "POST",
      body: {
        draftId: currentDraft.id,
        taskId: currentLeaderTask.taskId,
        values
      }
    });
    const collaboration = result.demandCollaboration || {};
    const nextDraft = upsertDraft(collaboration.draft || {});
    await loadTodoDataFromServer();
    if (canViewDraftForCurrentUser(nextDraft)) {
      renderDraftDetail(nextDraft);
    } else {
      renderDraftPanel();
    }
    showToast(collaboration.allLeaderTasksCompleted
      ? "组长补充已全部完成，已流转给提出人确认"
      : "补充已保存");
  } catch (error) {
    showToast(`补充保存失败：${error.message}`);
  } finally {
    submittingLeaderSupplement = false;
    if (draftPrimaryAction) {
      draftPrimaryAction.disabled = false;
    }
  }
}

for (const button of tabButtons) {
  button.addEventListener("click", () => {
    const panelName = button.dataset.panel;
    switchPanel(panelName);
    if (panelName === "draft" || panelName === "fallback") {
      toggleCreatedTimeSort(panelName);
    }
  });
  button.addEventListener("dblclick", (event) => {
    event.preventDefault();
    const panelName = button.dataset.panel;
    switchPanel(panelName);
    scrollActivePanelToTop(panelName);
  });
}

if (monitorRefreshButton) {
  monitorRefreshButton.addEventListener("click", performManualRefresh);
}

if (projectSettingsButton) {
  projectSettingsButton.addEventListener("click", openProjectSettings);
}

for (const button of [projectSettingsCloseButton, projectSettingsCancelButton]) {
  if (button) button.addEventListener("click", closeProjectSettings);
}

if (showAllProjectsInput) {
  showAllProjectsInput.addEventListener("change", () => {
    if (!projectSettingsDraft || !PROJECT_SETTINGS_API) return;
    projectSettingsDraft.showAll = showAllProjectsInput.checked;
    projectSettingsDraft = PROJECT_SETTINGS_API.normalizeSettings(projectSettingsDraft, PROJECT_CATALOG);
    renderProjectSettingsDialog();
  });
}

if (allProjectsOptions) {
  allProjectsOptions.addEventListener("change", (event) => {
    const checkbox = event.target.closest('input[type="checkbox"]');
    if (!checkbox || !projectSettingsDraft) return;
    const selected = new Set(projectSettingsDraft.allProjects || []);
    if (checkbox.checked) selected.add(checkbox.value);
    else selected.delete(checkbox.value);
    projectSettingsDraft.allProjects = [...selected];
  });
}

if (projectOrderList) {
  projectOrderList.addEventListener("click", (event) => {
    const button = event.target.closest("[data-project-order-value]");
    if (!button || !projectSettingsDraft || !PROJECT_SETTINGS_API) return;
    projectSettingsDraft = PROJECT_SETTINGS_API.moveProject(
      projectSettingsDraft,
      PROJECT_CATALOG,
      button.dataset.projectOrderValue,
      button.dataset.projectOrderDirection
    );
    renderProjectOrderList();
  });
}

if (projectSettingsSaveButton) {
  projectSettingsSaveButton.addEventListener("click", () => {
    if (!projectSettingsDraft || !PROJECT_SETTINGS_API) return;
    if (projectSettingsDraft.showAll && (projectSettingsDraft.allProjects || []).length === 0) {
      showToast("“全部项目”至少需要包含一个项目");
      return;
    }
    const previousProject = selectedProjectValue();
    projectSettings = PROJECT_SETTINGS_API.normalizeSettings(projectSettingsDraft, PROJECT_CATALOG);
    try {
      persistProjectSettings(projectSettings);
    } catch (error) {
      showToast(`项目设置保存失败：${error.message}`);
      return;
    }
    const nextProject = renderProjectSelect(previousProject);
    switchProject(nextProject);
    closeProjectSettings();
    console.info("Demand H5 project settings saved", {
      showAll: projectSettings.showAll,
      allProjectCount: projectSettings.allProjects.length,
      projectOrder: projectSettings.order
    });
    showToast("项目设置已保存");
    refreshCollaborationData({ panelName: activePanelName() });
  });
}

if (projectSelect) {
  projectSelect.addEventListener("change", () => {
    switchProject(projectSelect.value);
    refreshCollaborationData({ panelName: activePanelName() });
  });
}

for (const option of document.querySelectorAll(".leader-option")) {
  option.addEventListener("click", () => {
    toggleLeaderOption(option);
  });
}

if (draftList) {
  draftList.addEventListener("click", async (event) => {
    const requiredTarget = event.target.closest("[data-required-item-id]");
    if (requiredTarget) {
      const requiredItem = requiredFieldItems.find((item) => item.id === requiredTarget.dataset.requiredItemId);
      if (requiredItem) {
        await openDemandLocator(requiredItem);
      }
      return;
    }
    const target = event.target.closest("[data-draft-id]");
    if (!target) {
      return;
    }
    const draft = drafts.find((item) => item.id === target.dataset.draftId);
    if (draft) {
      renderDraftDetail(draft);
    }
  });
}

if (fallbackList) {
  fallbackList.addEventListener("click", async (event) => {
    const target = event.target.closest("[data-fallback-item-id]");
    if (!target) {
      return;
    }
    const fallbackItem = fallbackRequiredFieldItems.find((item) => item.id === target.dataset.fallbackItemId);
    if (fallbackItem) {
      await openDemandLocator(fallbackItem);
    }
  });
}

if (fallbackLeaderFilterOptions) {
  fallbackLeaderFilterOptions.addEventListener("click", (event) => {
    const target = event.target.closest("[data-fallback-leader-name]");
    const leaderName = target && target.dataset.fallbackLeaderName;
    if (!leaderName || !FALLBACK_LEADER_FILTER_API) return;
    selectedFallbackLeaderNames = FALLBACK_LEADER_FILTER_API.toggleSelection(selectedFallbackLeaderNames, leaderName);
    console.info("Demand H5 fallback leader filter changed", {
      selectedLeaderCount: selectedFallbackLeaderNames.size,
      selectedLeaderNames: [...selectedFallbackLeaderNames],
      visibleItemCount: visibleFallbackRequiredFieldItems().length,
      totalItemCount: fallbackRequiredFieldItems.length
    });
    renderFallbackPanel();
  });
}

if (fallbackLeaderFilterClear) {
  fallbackLeaderFilterClear.addEventListener("click", () => {
    if (selectedFallbackLeaderNames.size === 0) return;
    selectedFallbackLeaderNames = new Set();
    console.info("Demand H5 fallback leader filter cleared", {
      visibleItemCount: visibleFallbackRequiredFieldItems().length,
      totalItemCount: fallbackRequiredFieldItems.length
    });
    renderFallbackPanel();
  });
}

if (todoList) {
  todoList.addEventListener("click", async (event) => {
    const target = event.target.closest("[data-todo-id]");
    if (!target) {
      return;
    }
    const todo = todos.find((item) => item.id === target.dataset.todoId);
    if (todo) {
      if (todo.source === "dev_progress") {
        await openDemandLocator(todo);
        return;
      }
      renderDraftDetail(todo.draft, { todo });
      activatePanel("draft");
    }
  });
}

if (memberTodoList) {
  memberTodoList.addEventListener("click", async (event) => {
    const target = event.target.closest("[data-member-todo-id]");
    if (!target) {
      return;
    }
    const todo = memberTodos.find((item) => item.id === target.dataset.memberTodoId);
    if (todo && todo.source === "dev_progress") {
      await openDemandLocator(todo);
      return;
    }
    if (todo && todo.draft && todo.draft.id) {
      renderDraftDetail(todo.draft, { memberTodo: todo });
      activatePanel("draft");
      return;
    }
    showToast("未找到组员待办详情");
  });
}

demandForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (savingDraft) {
    return;
  }
  const submitter = inputValue("submitterInput");
  const project = projectInput.value.trim();
  const type = document.getElementById("typeInput").value.trim();
  const scaleType = inputValue("scaleTypeInput");
  const priority = selectedPriority();
  const name = document.getElementById("nameInput").value.trim();
  const content = document.getElementById("contentInput").value.trim();
  const linkAddress = inputValue("linkInput");
  const designDeliveryDate = inputValue("designDeliveryDateInput");
  const updatedAt = inputValue("updatedAtInput");
  const leaders = collectLeaderFields();

  if (!submitter || !project || !type || !scaleType || !priority || !name || !content || !designDeliveryDate || !updatedAt) {
    showToast("请先补齐必填字段");
    return;
  }

  const submitButton = demandForm.querySelector(".primary-button[type=\"submit\"]");
  savingDraft = true;
  if (submitButton) {
    submitButton.disabled = true;
  }

  try {
    const result = await requestJson("/api/demand-collaboration/drafts", {
      method: "POST",
      body: {
        project,
        type,
        scaleType,
        priority,
        name,
        content,
        linkAddress,
        leaders,
        designDeliveryDate,
        updatedAt,
        source: "demand-h5"
      }
    });
    const collaboration = result.demandCollaboration || {};
    renderGeneratedDraft(collaboration.draft || {});
    await loadTodoDataFromServer();
    showToast("草稿已保存，等待组长补充");
    window.setTimeout(() => switchPanel("draft"), 450);
  } catch (error) {
    showToast(`草稿保存失败：${error.message}`);
  } finally {
    savingDraft = false;
    if (submitButton) {
      submitButton.disabled = false;
    }
  }
});

for (const button of document.querySelectorAll(".todo-card button, .bottom-actions button")) {
  button.addEventListener("click", async () => {
    if (button === draftSecondaryAction && button.textContent.trim() === "返回待办") {
      switchPanel("todo");
      return;
    }
    if (button === draftPrimaryAction && currentDraftRole && currentDraftRole.type === "leader") {
      await submitCurrentLeaderSupplement();
      return;
    }
    showToast("原型演示：这里后续会调用后台接口");
  });
}

if (logoutButton) {
  logoutButton.addEventListener("click", () => {
    const returnTo = currentReturnPath();
    window.location.assign(`/demand-web-logout?returnTo=${encodeURIComponent(returnTo)}`);
  });
}

async function initializeDemandH5() {
  initEmbedMode();
  if (!(await initSubmitter())) return;
  initDateInputs();
  projectSettings = loadProjectSettings();
  switchProject(renderProjectSelect(projectInput.value || DEFAULT_PROJECT_NAME));
  const initialPanel = initialPanelName();
  switchPanel(initialPanel);
  refreshCollaborationData({ panelName: initialPanelName() });
  window.addEventListener("pageshow", refreshAfterPageResume);
  window.addEventListener("focus", refreshAfterPageResume);
  document.addEventListener("visibilitychange", refreshAfterPageResume);
  window.addEventListener("scroll", scheduleActivePanelScrollSave, { passive: true });
}

initializeDemandH5();
