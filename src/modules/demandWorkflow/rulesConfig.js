"use strict";

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function arrayOfStrings(value) {
  return Array.isArray(value)
    ? value.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
}

function unique(values) {
  return [...new Set(arrayOfStrings(values))];
}

function mergeDeep(base, override) {
  const result = { ...plainObject(base) };
  for (const [key, value] of Object.entries(plainObject(override))) {
    if (plainObject(value) === value && plainObject(result[key]) === result[key]) {
      result[key] = mergeDeep(result[key], value);
    } else if (Array.isArray(value)) {
      result[key] = value.slice();
    } else {
      result[key] = value;
    }
  }
  return result;
}

const DEFAULT_RULES = {
  enabled: true,
  version: "0.1.0",
  storage: {
    draftDir: "data/demand-workflow/drafts",
    participantTaskDir: "data/demand-workflow/participant-tasks",
    dailyTaskDir: "data/demand-workflow/daily-tasks",
    auditLogDir: "data/demand-workflow/audit-log"
  },
  demandCreation: {
    submitterSource: "wecom_sender_name",
    submitterRequiredFields: [],
    manualLeaderFields: [],
    leaderSupplementFields: {},
    initialValues: {},
    writeRequiresSubmitterConfirm: true
  },
  stages: {
    sequence: [],
    dailyIncludedStages: [],
    onlineStages: [],
    assigneeFieldsByStage: {}
  },
  roles: {},
  fieldRules: {
    focusFields: {},
    remainingWorkFields: {},
    progressFields: {},
    deadlineFields: {}
  },
  dailyTaskSummary: {
    timezone: "Asia/Shanghai",
    snapshotBuildTime: "08:00",
    executorPushTimes: ["09:00", "18:40"],
    snapshotPolicy: "freeze_task_ids_and_order_refresh_status_only",
    onlyBuildOncePerDay: true,
    allowManualRebuild: false,
    manualRebuildRequiresConfirm: true,
    sortRules: [],
    todayMustDo: {
      enabled: true,
      capacityThreshold: 1,
      singleTaskAlwaysMustDo: true,
      accumulateRemainingWorkUntilThreshold: true
    },
    refreshFieldsAfterSnapshot: [],
    lateAddedTaskPolicy: "notify_as_urgent_extra_do_not_change_snapshot"
  },
  overdueRules: {
    statusLabels: {
      normal: "正常",
      urgent: "紧迫",
      overdue: "逾期"
    },
    urgentWhenRemainingWorkGreaterThanDaysUntilDeadline: true,
    overdueWhenTodayAfterDeadline: true,
    writeExceptionTagWhenOverdue: "逾期",
    clearExceptionTagWhenBackToNormalOrUrgent: true
  },
  logging: {
    events: []
  }
};

function normalizeRoleConfig(roles) {
  const result = {};
  for (const [assigneeField, role] of Object.entries(plainObject(roles))) {
    const name = String(assigneeField || "").trim();
    if (!name) {
      continue;
    }
    const safeRole = plainObject(role);
    const leaderMemberNames = {};
    for (const [leaderName, memberNames] of Object.entries(plainObject(safeRole.leaderMemberNames))) {
      const safeLeaderName = String(leaderName || "").trim();
      if (!safeLeaderName) {
        continue;
      }
      leaderMemberNames[safeLeaderName] = unique(memberNames);
    }
    result[name] = {
      ...safeRole,
      leaderField: String(safeRole.leaderField || "").trim(),
      leaderNames: unique(safeRole.leaderNames),
      memberNames: unique(safeRole.memberNames),
      leaderMemberNames
    };
  }
  return result;
}

function normalizeStageConfig(stages) {
  const safeStages = plainObject(stages);
  const assigneeFieldsByStage = {};
  for (const [stage, fields] of Object.entries(plainObject(safeStages.assigneeFieldsByStage))) {
    const stageName = String(stage || "").trim();
    if (stageName) {
      assigneeFieldsByStage[stageName] = unique(fields);
    }
  }

  return {
    ...safeStages,
    sequence: unique(safeStages.sequence),
    dailyIncludedStages: unique(safeStages.dailyIncludedStages),
    onlineStages: unique(safeStages.onlineStages),
    assigneeFieldsByStage
  };
}

function normalizeDemandCreationConfig(demandCreation) {
  const safeCreation = plainObject(demandCreation);
  return {
    ...safeCreation,
    draftStatusFlow: unique(safeCreation.draftStatusFlow),
    submitterRequiredFields: unique(safeCreation.submitterRequiredFields),
    manualLeaderFields: unique(safeCreation.manualLeaderFields),
    leaderSupplementFields: Object.fromEntries(
      Object.entries(plainObject(safeCreation.leaderSupplementFields))
        .map(([leaderField, fields]) => [String(leaderField || "").trim(), unique(fields)])
        .filter(([leaderField]) => Boolean(leaderField))
    ),
    initialValues: plainObject(safeCreation.initialValues),
    writeRequiresSubmitterConfirm: safeCreation.writeRequiresSubmitterConfirm !== false
  };
}

function normalizeDailyTaskConfig(dailyTaskSummary) {
  const safeDaily = plainObject(dailyTaskSummary);
  const todayMustDo = plainObject(safeDaily.todayMustDo);
  return {
    ...safeDaily,
    timezone: String(safeDaily.timezone || "Asia/Shanghai").trim(),
    snapshotBuildTime: String(safeDaily.snapshotBuildTime || "08:00").trim(),
    executorPushTimes: unique(safeDaily.executorPushTimes),
    snapshotPolicy: String(safeDaily.snapshotPolicy || "freeze_task_ids_and_order_refresh_status_only").trim(),
    onlyBuildOncePerDay: safeDaily.onlyBuildOncePerDay !== false,
    allowManualRebuild: safeDaily.allowManualRebuild === true,
    manualRebuildRequiresConfirm: safeDaily.manualRebuildRequiresConfirm !== false,
    sortRules: Array.isArray(safeDaily.sortRules) ? safeDaily.sortRules : [],
    todayMustDo: {
      ...todayMustDo,
      enabled: todayMustDo.enabled !== false,
      capacityThreshold: Number(todayMustDo.capacityThreshold || 1),
      singleTaskAlwaysMustDo: todayMustDo.singleTaskAlwaysMustDo !== false,
      accumulateRemainingWorkUntilThreshold: todayMustDo.accumulateRemainingWorkUntilThreshold !== false
    },
    refreshFieldsAfterSnapshot: unique(safeDaily.refreshFieldsAfterSnapshot),
    lateAddedTaskPolicy: String(safeDaily.lateAddedTaskPolicy || "notify_as_urgent_extra_do_not_change_snapshot").trim()
  };
}

function collectWarnings(rules) {
  const warnings = [];
  const stageSet = new Set(rules.stages.sequence);
  for (const stage of rules.stages.dailyIncludedStages) {
    if (!stageSet.has(stage)) {
      warnings.push(`dailyIncludedStages includes unknown stage: ${stage}`);
    }
  }

  const roleNames = Object.keys(rules.roles);
  for (const [stage, fields] of Object.entries(rules.stages.assigneeFieldsByStage)) {
    for (const field of fields) {
      if (!roleNames.includes(field)) {
        warnings.push(`stage ${stage} references unknown role field: ${field}`);
      }
    }
  }

  if (!rules.dailyTaskSummary.snapshotBuildTime) {
    warnings.push("dailyTaskSummary.snapshotBuildTime is empty");
  }
  if (rules.dailyTaskSummary.executorPushTimes.length === 0) {
    warnings.push("dailyTaskSummary.executorPushTimes is empty");
  }
  if (rules.demandCreation.submitterRequiredFields.length === 0) {
    warnings.push("demandCreation.submitterRequiredFields is empty");
  }

  return warnings;
}

function normalizeDemandWorkflowRules(rawRules = {}) {
  const merged = mergeDeep(DEFAULT_RULES, rawRules);
  const normalized = {
    ...merged,
    enabled: merged.enabled !== false,
    version: String(merged.version || DEFAULT_RULES.version).trim(),
    storage: {
      ...DEFAULT_RULES.storage,
      ...plainObject(merged.storage)
    },
    demandCreation: normalizeDemandCreationConfig(merged.demandCreation),
    stages: normalizeStageConfig(merged.stages),
    roles: normalizeRoleConfig(merged.roles),
    fieldRules: {
      ...DEFAULT_RULES.fieldRules,
      ...plainObject(merged.fieldRules)
    },
    dailyTaskSummary: normalizeDailyTaskConfig(merged.dailyTaskSummary),
    overdueRules: {
      ...DEFAULT_RULES.overdueRules,
      ...plainObject(merged.overdueRules)
    },
    logging: {
      ...DEFAULT_RULES.logging,
      ...plainObject(merged.logging),
      events: unique(plainObject(merged.logging).events)
    }
  };

  normalized.diagnostics = {
    warnings: collectWarnings(normalized)
  };
  return normalized;
}

function summarizeDemandWorkflowRules(rules = {}) {
  const safeRules = plainObject(rules);
  const stages = plainObject(safeRules.stages);
  const dailyTaskSummary = plainObject(safeRules.dailyTaskSummary);
  const demandCreation = plainObject(safeRules.demandCreation);
  const diagnostics = plainObject(safeRules.diagnostics);

  return {
    enabled: Boolean(safeRules.enabled),
    version: safeRules.version || "",
    stageCount: arrayOfStrings(stages.sequence).length,
    dailyIncludedStageCount: arrayOfStrings(stages.dailyIncludedStages).length,
    roleCount: Object.keys(plainObject(safeRules.roles)).length,
    submitterRequiredFieldCount: arrayOfStrings(demandCreation.submitterRequiredFields).length,
    leaderSupplementRoleCount: Object.keys(plainObject(demandCreation.leaderSupplementFields)).length,
    snapshotBuildTime: dailyTaskSummary.snapshotBuildTime || "",
    executorPushTimes: arrayOfStrings(dailyTaskSummary.executorPushTimes),
    snapshotPolicy: dailyTaskSummary.snapshotPolicy || "",
    lateAddedTaskPolicy: dailyTaskSummary.lateAddedTaskPolicy || "",
    warningCount: arrayOfStrings(diagnostics.warnings).length,
    warnings: arrayOfStrings(diagnostics.warnings)
  };
}

module.exports = {
  normalizeDemandWorkflowRules,
  summarizeDemandWorkflowRules
};
