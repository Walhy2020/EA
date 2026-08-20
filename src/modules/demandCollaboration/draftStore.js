"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { resolveProjectPath } = require("../../utils/paths");

const DEFAULT_STORE_PATH = "data/demand-collaboration/drafts.json";
const DEFAULT_EXPIRE_DAYS = 30;
const DEFAULT_MAX_EXPIRED_DRAFTS = 500;
const ACTIVE_STATUSES = new Set(["draft_created", "leader_pending", "submitter_confirming"]);
const FINISHED_STATUSES = new Set(["completed", "cancelled", "expired"]);

function readJsonFile(filePath, fallback, logger) {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
  } catch (error) {
    if (logger && typeof logger.warn === "function") {
      logger.warn("Demand collaboration draft store read failed, fallback to empty store", {
        filePath,
        message: error.message
      });
    }
    return fallback;
  }
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(tempPath, filePath);
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function localDateKey(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}

function normalizeText(value, maxLength = 5000) {
  const text = String(value || "").trim();
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function normalizeLeaders(leaders) {
  if (!Array.isArray(leaders)) {
    return [];
  }
  return leaders
    .map((leader) => {
      if (Array.isArray(leader)) {
        return {
          role: normalizeText(leader[0], 80),
          names: normalizeText(leader[1], 200)
        };
      }
      return {
        role: normalizeText(leader && (leader.role || leader.field || leader.leaderField), 80),
        names: normalizeText(leader && (leader.names || leader.value || leader.leaderNames), 200)
      };
    })
    .filter((leader) => leader.role);
}

function splitParticipantNames(value) {
  return String(value || "")
    .split(/[、,，;；/\s]+/g)
    .map((item) => item.trim())
    .filter(Boolean);
}

function namesInclude(names, userName) {
  const targetName = normalizeText(userName, 80);
  if (!targetName) {
    return false;
  }
  return splitParticipantNames(names).includes(targetName);
}

function activeDrafts(store) {
  return store.drafts.filter((draft) => draft && ACTIVE_STATUSES.has(draft.status));
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function emptyStore() {
  return {
    version: 1,
    nextSerialByDate: {},
    drafts: [],
    expiredDrafts: [],
    updatedAt: ""
  };
}

function normalizeStore(store) {
  const fallback = emptyStore();
  const next = store && typeof store === "object" && !Array.isArray(store) ? store : fallback;
  next.version = Number(next.version || 1);
  next.nextSerialByDate = next.nextSerialByDate && typeof next.nextSerialByDate === "object"
    ? next.nextSerialByDate
    : {};
  next.drafts = Array.isArray(next.drafts) ? next.drafts : [];
  next.expiredDrafts = Array.isArray(next.expiredDrafts) ? next.expiredDrafts : [];
  next.updatedAt = String(next.updatedAt || "");
  return next;
}

function isExpiredDraft(draft, nowMs) {
  if (!draft || FINISHED_STATUSES.has(draft.status)) {
    return false;
  }
  const expiresAtMs = Date.parse(draft.expiresAt || "");
  return Number.isFinite(expiresAtMs) && expiresAtMs <= nowMs;
}

function createDraftStore(options = {}) {
  const moduleConfig = options.moduleConfig || {};
  const workflowRules = plainObject(options.workflowRules);
  const demandCreationRules = plainObject(workflowRules.demandCreation);
  const leaderSupplementFieldsConfig = plainObject(demandCreationRules.leaderSupplementFields);
  const workflowRoleConfig = plainObject(workflowRules.roles);
  const storeConfig = moduleConfig.draftStore || {};
  const logger = options.logger;
  const storePath = resolveProjectPath(storeConfig.path || DEFAULT_STORE_PATH);
  const expireDays = positiveNumber(storeConfig.expireDays, DEFAULT_EXPIRE_DAYS);
  const maxExpiredDrafts = Math.max(1, Math.floor(positiveNumber(
    storeConfig.maxExpiredDrafts,
    DEFAULT_MAX_EXPIRED_DRAFTS
  )));

  function readStore() {
    return normalizeStore(readJsonFile(storePath, emptyStore(), logger));
  }

  function leaderSupplementFields(role) {
    const fields = leaderSupplementFieldsConfig[role];
    if (!Array.isArray(fields)) {
      return [];
    }
    return fields.map((field) => normalizeText(field, 100)).filter(Boolean);
  }

  function attachSupplementFields(task) {
    return {
      ...task,
      supplementFields: Array.isArray(task.supplementFields) && task.supplementFields.length > 0
        ? task.supplementFields.map((field) => normalizeText(field, 100)).filter(Boolean)
        : leaderSupplementFields(task.role),
      supplementValues: plainObject(task.supplementValues)
    };
  }

  function leaderRoleScopes(userName) {
    const normalizedUserName = normalizeText(userName, 80);
    if (!normalizedUserName) {
      return [];
    }
    return Object.entries(workflowRoleConfig)
      .map(([assigneeField, role]) => {
        const safeRole = plainObject(role);
        return {
          assigneeField: normalizeText(assigneeField, 80),
          leaderField: normalizeText(safeRole.leaderField, 80),
          leaderNames: Array.isArray(safeRole.leaderNames)
            ? safeRole.leaderNames.map((name) => normalizeText(name, 80)).filter(Boolean)
            : [],
          memberNames: Array.isArray(safeRole.memberNames)
            ? safeRole.memberNames.map((name) => normalizeText(name, 80)).filter(Boolean)
            : []
        };
      })
      .filter((scope) => scope.assigneeField && namesInclude(scope.leaderNames.join("、"), normalizedUserName));
  }

  function saveStore(store) {
    store.updatedAt = new Date().toISOString();
    writeJsonAtomic(storePath, store);
  }

  function cleanupExpiredDrafts(store = readStore()) {
    const now = new Date();
    const nowMs = now.getTime();
    const active = [];
    const expired = [];

    for (const draft of store.drafts) {
      if (isExpiredDraft(draft, nowMs)) {
        expired.push({
          ...draft,
          status: "expired",
          statusText: "已过期",
          expiredAt: now.toISOString(),
          expireReason: "draft_store_expire_days"
        });
      } else {
        active.push(draft);
      }
    }

    if (expired.length === 0) {
      return {
        store,
        expiredCount: 0,
        saved: false
      };
    }

    store.drafts = active;
    store.expiredDrafts = [...expired, ...store.expiredDrafts]
      .sort((left, right) => String(right.expiredAt || "").localeCompare(String(left.expiredAt || "")))
      .slice(0, maxExpiredDrafts);
    saveStore(store);

    if (logger && typeof logger.info === "function") {
      logger.info("Demand collaboration expired drafts archived", {
        expiredCount: expired.length,
        activeCount: store.drafts.length,
        expiredArchiveCount: store.expiredDrafts.length,
        expireDays,
        storePath: storeConfig.path || DEFAULT_STORE_PATH
      });
    }

    return {
      store,
      expiredCount: expired.length,
      saved: true
    };
  }

  function nextDraftId(store, now = new Date()) {
    const dateKey = localDateKey(now);
    const nextSerial = Number(store.nextSerialByDate[dateKey] || 0) + 1;
    store.nextSerialByDate[dateKey] = nextSerial;
    return `DRAFT-${dateKey}-${String(nextSerial).padStart(4, "0")}`;
  }

  function validateDraftInput(input) {
    const required = [
      ["submitterName", "提出人"],
      ["project", "项目"],
      ["type", "需求类型"],
      ["scaleType", "规模类型"],
      ["priority", "优先级"],
      ["name", "需求名称"],
      ["content", "需求内容"],
      ["designDeliveryDate", "需求设计交付日期"],
      ["updatedAt", "更新时间"]
    ];

    for (const [key, label] of required) {
      if (!normalizeText(input[key], 10000)) {
        throw new Error(`${label}不能为空`);
      }
    }
  }

  function createLeaderTasks(draftId, leaders, nowIso) {
    return leaders.map((leader) => ({
      taskId: `${draftId}-LEADER-${crypto.randomBytes(3).toString("hex")}`,
      role: leader.role,
      names: leader.names,
      status: "pending",
      statusText: "待补充",
      supplementFields: leaderSupplementFields(leader.role),
      supplementValues: {},
      createdAt: nowIso,
      recordUpdatedAt: nowIso,
      completedAt: ""
    }));
  }

  function normalizeSupplementValues(inputValues, allowedFields) {
    const values = plainObject(inputValues);
    const result = {};
    for (const field of allowedFields) {
      result[field] = normalizeText(values[field], 1000);
    }
    return result;
  }

  function validateSupplementValues(values, requiredFields) {
    const missing = requiredFields.filter((field) => !normalizeText(values[field], 1000));
    if (missing.length > 0) {
      throw new Error(`请先补齐：${missing.join("、")}`);
    }
  }

  function decorateDraft(draft) {
    if (!draft || typeof draft !== "object") {
      return draft;
    }
    return {
      ...draft,
      leaderTasks: Array.isArray(draft.leaderTasks)
        ? draft.leaderTasks.map(attachSupplementFields)
        : [],
      leaderSupplements: plainObject(draft.leaderSupplements),
      supplementValues: plainObject(draft.supplementValues)
    };
  }

  function updateDraftAfterLeaderSubmit(draft, nowIso) {
    const leaderTasks = Array.isArray(draft.leaderTasks) ? draft.leaderTasks : [];
    const allCompleted = leaderTasks.length > 0 && leaderTasks.every((task) => task.status === "completed");
    draft.status = allCompleted ? "submitter_confirming" : "leader_pending";
    draft.statusText = allCompleted ? "待提出人确认" : "待组长补充";
    draft.recordUpdatedAt = nowIso;
    if (allCompleted && !draft.submitterConfirmRequestedAt) {
      draft.submitterConfirmRequestedAt = nowIso;
    }
    return allCompleted;
  }

  function createDraft(input = {}) {
    const store = readStore();
    const cleanup = cleanupExpiredDrafts(store);
    const normalized = {
      submitterName: normalizeText(input.submitterName || input.submitter, 80),
      submitterUserId: normalizeText(input.submitterUserId, 100),
      project: normalizeText(input.project, 80),
      type: normalizeText(input.type, 80),
      scaleType: normalizeText(input.scaleType, 40),
      priority: normalizeText(input.priority, 40),
      name: normalizeText(input.name, 200),
      content: normalizeText(input.content, 5000),
      linkAddress: normalizeText(input.linkAddress, 1000),
      designDeliveryDate: normalizeText(input.designDeliveryDate, 40),
      updatedAt: normalizeText(input.updatedAt, 40),
      source: normalizeText(input.source, 80)
    };
    validateDraftInput(normalized);

    const now = new Date();
    const nowIso = now.toISOString();
    const id = nextDraftId(cleanup.store, now);
    const leaders = normalizeLeaders(input.leaders);
    const leaderTasks = createLeaderTasks(id, leaders, nowIso);
    const expiresAt = new Date(now.getTime() + expireDays * 24 * 60 * 60 * 1000).toISOString();
    const status = leaderTasks.length > 0 ? "leader_pending" : "submitter_confirming";

    const draft = {
      id,
      schemaVersion: 1,
      status,
      statusText: leaderTasks.length > 0 ? "待组长补充" : "待提出人确认",
      submitter: {
        name: normalized.submitterName,
        userId: normalized.submitterUserId
      },
      project: normalized.project,
      type: normalized.type,
      scaleType: normalized.scaleType,
      priority: normalized.priority,
      name: normalized.name,
      content: normalized.content,
      linkAddress: normalized.linkAddress,
      designDeliveryDate: normalized.designDeliveryDate,
      updatedAt: normalized.updatedAt,
      leaders,
      leaderTasks,
      createdAt: nowIso,
      recordUpdatedAt: nowIso,
      expiresAt,
      source: normalized.source || "demand-h5"
    };

    cleanup.store.drafts.unshift(draft);
    saveStore(cleanup.store);

    if (logger && typeof logger.info === "function") {
      logger.info("Demand collaboration draft created", {
        draftId: draft.id,
        project: draft.project,
        submitterName: draft.submitter.name,
        leaderTaskCount: draft.leaderTasks.length,
        expiresAt: draft.expiresAt,
        expiredArchivedBeforeCreate: cleanup.expiredCount
      });
    }

    return {
      ok: true,
      draft: decorateDraft(draft),
      draftCount: cleanup.store.drafts.length,
      expiredArchivedCount: cleanup.expiredCount,
      store: {
        path: storeConfig.path || DEFAULT_STORE_PATH,
        expireDays,
        activeCount: cleanup.store.drafts.length,
        expiredArchiveCount: cleanup.store.expiredDrafts.length
      }
    };
  }

  function listDrafts(filters = {}) {
    const cleanup = cleanupExpiredDrafts();
    let drafts = activeDrafts(cleanup.store);
    const submitterName = normalizeText(filters.submitterName, 80);
    const project = normalizeText(filters.project, 80);
    const status = normalizeText(filters.status, 80);

    if (submitterName) {
      drafts = drafts.filter((draft) => draft.submitter && draft.submitter.name === submitterName);
    }
    if (project) {
      drafts = drafts.filter((draft) => draft.project === project);
    }
    if (status) {
      drafts = drafts.filter((draft) => draft.status === status);
    }

    return {
      ok: true,
      drafts: drafts.map(decorateDraft),
      count: drafts.length,
      expiredArchivedCount: cleanup.expiredCount,
      store: {
        path: storeConfig.path || DEFAULT_STORE_PATH,
        expireDays,
        activeCount: cleanup.store.drafts.length,
        expiredArchiveCount: cleanup.store.expiredDrafts.length
      }
    };
  }

  function listTodoItems(filters = {}) {
    const cleanup = cleanupExpiredDrafts();
    const userName = normalizeText(filters.userName || filters.name || filters.submitterName, 80);
    const project = normalizeText(filters.project, 80);
    const items = [];

    if (!userName) {
      return {
        ok: true,
        userName,
        items,
        count: 0,
        expiredArchivedCount: cleanup.expiredCount,
        store: {
          path: storeConfig.path || DEFAULT_STORE_PATH,
          expireDays,
          activeCount: cleanup.store.drafts.length,
          expiredArchiveCount: cleanup.store.expiredDrafts.length
        }
      };
    }

    for (const draft of activeDrafts(cleanup.store)) {
      if (project && draft.project !== project) {
        continue;
      }

      const submitterName = draft.submitter && draft.submitter.name ? draft.submitter.name : "";
      if (submitterName === userName && draft.status === "submitter_confirming") {
        items.push({
          id: `${draft.id}-SUBMITTER-CONFIRM`,
          draftId: draft.id,
          kind: "submitter_confirm",
          role: "提出人",
          roleName: "提出人",
          status: draft.status,
          statusText: "待最终确认",
          actionText: "最终确认",
          title: draft.name,
          project: draft.project,
          updatedAt: draft.updatedAt,
          designDeliveryDate: draft.designDeliveryDate,
          draft: decorateDraft(draft)
        });
      }

      const leaderTasks = Array.isArray(draft.leaderTasks) ? draft.leaderTasks.map(attachSupplementFields) : [];
      for (const leaderTask of leaderTasks) {
        const taskStatus = leaderTask.status || "pending";
        if (taskStatus !== "pending" || !namesInclude(leaderTask.names, userName)) {
          continue;
        }
        items.push({
          id: leaderTask.taskId,
          taskId: leaderTask.taskId,
          draftId: draft.id,
          kind: "leader_supplement",
          role: "组长",
          roleName: leaderTask.role,
          assigneeNames: leaderTask.names,
          status: taskStatus,
          statusText: leaderTask.statusText || "待补充",
          actionText: `补充${leaderTask.role}`,
          title: draft.name,
          project: draft.project,
          updatedAt: draft.updatedAt,
          designDeliveryDate: draft.designDeliveryDate,
          draft: decorateDraft(draft),
          leaderTask
        });
      }
    }

    items.sort((left, right) => String(right.draft && right.draft.createdAt || "").localeCompare(
      String(left.draft && left.draft.createdAt || "")
    ));

    return {
      ok: true,
      userName,
      items,
      count: items.length,
      expiredArchivedCount: cleanup.expiredCount,
      store: {
        path: storeConfig.path || DEFAULT_STORE_PATH,
        expireDays,
        activeCount: cleanup.store.drafts.length,
        expiredArchiveCount: cleanup.store.expiredDrafts.length
      }
    };
  }

  function listMemberTodoItems(filters = {}) {
    const cleanup = cleanupExpiredDrafts();
    const userName = normalizeText(filters.userName || filters.name || filters.submitterName, 80);
    const project = normalizeText(filters.project, 80);
    const leaderRoles = leaderRoleScopes(userName);

    return {
      ok: true,
      userName,
      project,
      isLeader: leaderRoles.length > 0,
      leaderRoles,
      items: [],
      count: 0,
      source: "demand_total_daily_tasks_pending",
      sourceReady: false,
      message: leaderRoles.length > 0
        ? "组员待办入口已按组长身份打开，真实组员任务后续接入需求总表每日任务。"
        : "当前用户不是配置里的组长。",
      expiredArchivedCount: cleanup.expiredCount,
      store: {
        path: storeConfig.path || DEFAULT_STORE_PATH,
        expireDays,
        activeCount: cleanup.store.drafts.length,
        expiredArchiveCount: cleanup.store.expiredDrafts.length
      }
    };
  }

  function submitLeaderSupplement(input = {}) {
    const store = readStore();
    const cleanup = cleanupExpiredDrafts(store);
    const draftId = normalizeText(input.draftId, 80);
    const taskId = normalizeText(input.taskId, 120);
    const userName = normalizeText(input.userName || input.name || input.submitterName, 80);

    if (!draftId) {
      throw new Error("草稿ID不能为空");
    }
    if (!taskId) {
      throw new Error("组长任务ID不能为空");
    }
    if (!userName) {
      throw new Error("当前处理人不能为空");
    }

    const draft = cleanup.store.drafts.find((item) => item && item.id === draftId);
    if (!draft || !ACTIVE_STATUSES.has(draft.status)) {
      throw new Error("未找到可处理的需求草稿");
    }
    if (draft.status !== "leader_pending") {
      throw new Error("当前草稿不在组长补充阶段");
    }

    draft.leaderTasks = Array.isArray(draft.leaderTasks) ? draft.leaderTasks : [];
    const taskIndex = draft.leaderTasks.findIndex((task) => task && task.taskId === taskId);
    if (taskIndex < 0) {
      throw new Error("未找到组长补充任务");
    }

    const task = attachSupplementFields(draft.leaderTasks[taskIndex]);
    if (!namesInclude(task.names, userName)) {
      throw new Error("当前用户不是这个组长任务的处理人");
    }
    if ((task.status || "pending") !== "pending") {
      throw new Error("这个组长任务已经提交过");
    }

    const fields = Array.isArray(task.supplementFields) ? task.supplementFields : [];
    const values = normalizeSupplementValues(input.values, fields);
    validateSupplementValues(values, fields);

    const nowIso = new Date().toISOString();
    const nextTask = {
      ...task,
      status: "completed",
      statusText: "已补充",
      supplementValues: values,
      completedBy: {
        name: userName
      },
      completedAt: nowIso,
      recordUpdatedAt: nowIso
    };

    draft.leaderTasks[taskIndex] = nextTask;
    draft.leaderSupplements = plainObject(draft.leaderSupplements);
    draft.leaderSupplements[nextTask.role] = {
      role: nextTask.role,
      names: nextTask.names,
      submittedBy: userName,
      submittedAt: nowIso,
      values
    };
    draft.supplementValues = {
      ...plainObject(draft.supplementValues),
      ...values
    };
    const allLeaderTasksCompleted = updateDraftAfterLeaderSubmit(draft, nowIso);
    saveStore(cleanup.store);

    if (logger && typeof logger.info === "function") {
      logger.info("Demand collaboration leader supplement submitted", {
        draftId: draft.id,
        taskId: nextTask.taskId,
        role: nextTask.role,
        submittedBy: userName,
        fieldCount: fields.length,
        allLeaderTasksCompleted,
        nextStatus: draft.status
      });
    }

    return {
      ok: true,
      draft: decorateDraft(draft),
      leaderTask: attachSupplementFields(nextTask),
      allLeaderTasksCompleted,
      nextStatus: draft.status,
      nextStatusText: draft.statusText,
      store: {
        path: storeConfig.path || DEFAULT_STORE_PATH,
        expireDays,
        activeCount: cleanup.store.drafts.length,
        expiredArchiveCount: cleanup.store.expiredDrafts.length
      }
    };
  }

  function cleanupExpired() {
    const cleanup = cleanupExpiredDrafts();
    return {
      ok: true,
      expiredArchivedCount: cleanup.expiredCount,
      activeCount: cleanup.store.drafts.length,
      expiredArchiveCount: cleanup.store.expiredDrafts.length,
      store: {
        path: storeConfig.path || DEFAULT_STORE_PATH,
        expireDays
      }
    };
  }

  function getStatus() {
    const store = readStore();
    return {
      enabled: moduleConfig.enabled !== false,
      storagePath: storeConfig.path || DEFAULT_STORE_PATH,
      expireDays,
      activeDraftCount: store.drafts.length,
      expiredDraftCount: store.expiredDrafts.length
    };
  }

  return {
    createDraft,
    listDrafts,
    listTodoItems,
    listMemberTodoItems,
    submitLeaderSupplement,
    cleanupExpired,
    getStatus
  };
}

module.exports = {
  createDraftStore
};
