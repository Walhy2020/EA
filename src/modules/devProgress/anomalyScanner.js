"use strict";

const DAY_MS = 24 * 60 * 60 * 1000;

const OWNER_ROLE_LABELS = {
  planner: "策划人员",
  frontend: "前端开发",
  backend: "后端开发",
  ui: "UI人员",
  tester: "测试人员",
  effect: "动效人员",
  plannerLead: "策划组长",
  uiLead: "UI组长",
  effectLead: "动效组长",
  frontendLead: "前端组长",
  backendLead: "后端组长",
  testerLead: "测试组长"
};

function startOfLocalDay(date = new Date()) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function parseDateValue(value) {
  const text = String(value || "").trim();
  if (!text) {
    return null;
  }

  const numeric = Number(text);
  if (Number.isFinite(numeric) && numeric > 0) {
    if (numeric > 1000000000000) {
      return startOfLocalDay(new Date(numeric));
    }
    if (numeric > 1000000000) {
      return startOfLocalDay(new Date(numeric * 1000));
    }
    const compact = text.match(/^(\d{4})(\d{2})(\d{2})$/);
    if (compact) {
      return new Date(Number(compact[1]), Number(compact[2]) - 1, Number(compact[3]));
    }
  }

  const match = text.match(/(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})/);
  if (match) {
    return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  }

  return null;
}

function dateLabel(date) {
  if (!date) {
    return "";
  }
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function daysUntil(date, today = startOfLocalDay()) {
  return Math.floor((startOfLocalDay(date).getTime() - today.getTime()) / DAY_MS);
}

function containsAny(text, keywords) {
  const value = String(text || "");
  return (keywords || []).some((keyword) => keyword && value.includes(keyword));
}

function matchesCompletionKeyword(status, keyword) {
  const text = String(status || "").trim();
  const value = String(keyword || "").trim();
  if (!value) {
    return false;
  }
  if (value === "完成" || value === "结束") {
    return text === value || text === `已${value}`;
  }
  return text.includes(value);
}

function isCompleted(status, rules) {
  const text = String(status || "");
  if (!text) {
    return false;
  }
  if (containsAny(text, ["未完成", "没完成", "未上线", "未验收"])) {
    return false;
  }
  return (rules.completedStatusKeywords || []).some((keyword) => matchesCompletionKeyword(text, keyword));
}

function isOnlineStatus(status, rules = {}) {
  const text = String(status || "").trim();
  if (!text || containsAny(text, ["未上线", "不上线", "暂不上线", "无需上线"])) {
    return false;
  }

  const keywords = Array.isArray(rules.onlineStatusKeywords) && rules.onlineStatusKeywords.length > 0
    ? rules.onlineStatusKeywords
    : ["已上线", "上线完成"];
  return containsAny(text, keywords);
}

function isReleased(record, rules = {}) {
  const standard = record.standard || {};
  return isCompleted(standard.status, rules) || isOnlineStatus(standard.status, rules);
}

function isBeforeScanStartDate(record, scanStartDate) {
  if (!scanStartDate) {
    return false;
  }
  const standard = record.standard || {};
  const dates = standard.dates || {};
  const updatedAt = parseDateValue(dates.updatedAt);
  return Boolean(updatedAt && updatedAt.getTime() < scanStartDate.getTime());
}

function isExcludedProject(record, rules = {}) {
  const projects = Array.isArray(rules.excludedProjects) ? rules.excludedProjects : [];
  if (projects.length === 0) {
    return false;
  }
  const standard = record.standard || {};
  const project = normalizedText(standard.project);
  if (!project) {
    return false;
  }
  return projects
    .map((item) => normalizedText(item))
    .filter(Boolean)
    .some((item) => project === item || project.includes(item));
}

function isIgnored(status, rules) {
  return containsAny(status, rules.ignoredStatusKeywords);
}

function parseNumber(value) {
  const match = String(value || "").match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : 0;
}

function ownerValue(record, role) {
  const owners = record.standard && record.standard.owners ? record.standard.owners : {};
  return owners[role] || "";
}

function normalizedText(value) {
  return value === null || value === undefined ? "" : String(value).trim();
}

function uniqueValues(values) {
  return [...new Set(values.map((value) => normalizedText(value)).filter(Boolean))];
}

function splitPeople(value) {
  return uniqueValues(String(value || "").split(/[、,，/\\|;；\s]+/));
}

function isEmptyRequiredValue(value) {
  return normalizedText(value) === "";
}

function recordFieldValue(record, fieldName) {
  const fields = record.fields || {};
  const mapped = record.mapped || {};
  if (Object.prototype.hasOwnProperty.call(fields, fieldName)) {
    return fields[fieldName];
  }
  if (Object.prototype.hasOwnProperty.call(mapped, fieldName)) {
    return mapped[fieldName];
  }
  return "";
}

function rawFieldValueType(record, fieldName, value) {
  const types = record && record.fieldValueTypes && typeof record.fieldValueTypes === "object"
    ? record.fieldValueTypes
    : {};
  if (Object.prototype.hasOwnProperty.call(types, fieldName)) {
    return types[fieldName];
  }
  if (value === null) {
    return "null";
  }
  if (value === undefined) {
    return "undefined";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  return typeof value;
}

function fieldValueSource(record, fieldName) {
  const sources = record && record.fieldValueSources && typeof record.fieldValueSources === "object"
    ? record.fieldValueSources
    : {};
  return sources[fieldName] || { source: "record_values" };
}

function normalizedArray(value) {
  const values = Array.isArray(value) ? value : [value];
  return uniqueValues(values);
}

function matchesNormalizedValue(value, expectedValues) {
  const text = normalizedText(value);
  const targets = normalizedArray(expectedValues);
  return targets.length === 0 || targets.includes(text);
}

function fieldValueConditionsMatch(record, conditions = {}) {
  for (const [fieldName, expectedValues] of Object.entries(conditions || {})) {
    if (!matchesNormalizedValue(recordFieldValue(record, fieldName), expectedValues)) {
      return false;
    }
  }
  return true;
}

function requiredFieldFilterMatchesRecord(record, filter = {}) {
  const standard = record.standard || {};
  const when = filter.when && typeof filter.when === "object" ? filter.when : filter;
  if (when.demandTypes && !matchesNormalizedValue(standard.demandType, when.demandTypes)) {
    return false;
  }
  if (when.statuses && !matchesNormalizedValue(standard.status, when.statuses)) {
    return false;
  }
  const fieldValues = when.fieldValues || when.fieldEquals || {};
  return fieldValueConditionsMatch(record, fieldValues);
}

function requiredFieldFilterMatchesEntry(entry = {}, filter = {}) {
  const fields = normalizedArray(filter.fields || filter.requiredFields);
  if (fields.length > 0 && !fields.includes(normalizedText(entry.fieldName))) {
    return false;
  }
  const owners = normalizedArray(filter.owners || filter.ownerNames || filter.owner);
  if (owners.length === 0) {
    return true;
  }
  const ownerNames = Array.isArray(entry.ownerNames) ? entry.ownerNames : splitPeople(entry.owner);
  return ownerNames.some((ownerName) => owners.includes(normalizedText(ownerName)));
}

function applyRequiredFieldFilters(record, entries, requiredRule = {}) {
  const filters = Array.isArray(requiredRule.fieldFilters) ? requiredRule.fieldFilters : [];
  if (filters.length === 0 || entries.length === 0) {
    return entries;
  }

  const result = [];
  for (const entry of entries) {
    let ownerNames = Array.isArray(entry.ownerNames) ? [...entry.ownerNames] : splitPeople(entry.owner);
    let dropEntry = false;

    for (const filter of filters) {
      if (!requiredFieldFilterMatchesRecord(record, filter) || !requiredFieldFilterMatchesEntry({
        ...entry,
        ownerNames
      }, filter)) {
        continue;
      }

      const filterOwners = normalizedArray(filter.owners || filter.ownerNames || filter.owner);
      if (filterOwners.length === 0) {
        dropEntry = true;
        break;
      }
      ownerNames = ownerNames.filter((ownerName) => !filterOwners.includes(normalizedText(ownerName)));
      if (ownerNames.length === 0) {
        dropEntry = true;
        break;
      }
    }

    if (!dropEntry) {
      result.push({
        ...entry,
        ownerNames,
        owner: ownerNames.length > 0 ? ownerNames.join("、") : entry.owner
      });
    }
  }
  return uniqueFieldEntries(result);
}

function ruleItemOwner(item) {
  return normalizedText(item.owner || item.ownerName || item.responsiblePerson || item["负责人"]);
}

function ownerNamesForRuleItem(item) {
  return splitPeople(ruleItemOwner(item));
}

function requiredFieldEntriesFromItem(item, fallbackOwner = "") {
  const requiredFields = Array.isArray(item.requiredFields) ? item.requiredFields : [];
  const explicitOwner = ruleItemOwner(item);
  const owner = explicitOwner || normalizedText(fallbackOwner);
  const ownerNames = splitPeople(owner);
  return uniqueValues(requiredFields).map((fieldName) => ({
    fieldName,
    owner,
    ownerNames,
    ruleStatus: normalizedText(item.status),
    isFallbackOwner: !explicitOwner && Boolean(owner)
  }));
}

function uniqueFieldEntries(entries) {
  const result = [];
  const seenEntries = new Set();
  for (const entry of entries) {
    const ownerKey = Array.isArray(entry.ownerNames) && entry.ownerNames.length > 0
      ? entry.ownerNames.join("、")
      : entry.owner || "";
    const entryKey = `${entry.fieldName || ""}||${ownerKey}`;
    if (!entry.fieldName || seenEntries.has(entryKey)) {
      continue;
    }
    seenEntries.add(entryKey);
    result.push(entry);
  }
  return result;
}

function requiredFieldEntriesForRecord(record, rule) {
  const requiredRule = rule || {};
  const items = Array.isArray(requiredRule.items) ? requiredRule.items : [];
  const standard = record.standard || {};
  const demandType = normalizedText(standard.demandType);
  const status = normalizedText(standard.status);
  const cumulative = requiredRule.cumulative !== false;
  const fallbackOwner = normalizedText(requiredRule.fallbackOwner);

  if (!demandType || !status) {
    return [];
  }

  if (!cumulative) {
    const exactEntries = [];
    for (const item of items) {
      if (normalizedText(item.demandType) === demandType && normalizedText(item.status) === status) {
        exactEntries.push(...requiredFieldEntriesFromItem(item, fallbackOwner));
      }
    }
    return uniqueFieldEntries(exactEntries);
  }

  const accumulatedEntries = [];
  let matchedStatus = false;
  for (const item of items) {
    if (normalizedText(item.demandType) !== demandType) {
      if (matchedStatus) {
        break;
      }
      continue;
    }
    const itemStatus = normalizedText(item.status);
    if (matchedStatus && itemStatus !== status) {
      break;
    }
    accumulatedEntries.push(...requiredFieldEntriesFromItem(item, fallbackOwner));
    if (itemStatus === status) {
      matchedStatus = true;
    }
  }

  return matchedStatus ? uniqueFieldEntries(accumulatedEntries) : [];
}

function inspectRequiredFields(record, rules) {
  const rule = rules && rules.requiredFields ? rules.requiredFields : {};
  if (!rule.enabled) {
    return [];
  }

  const requiredEntries = requiredFieldEntriesForRecord(record, rule);
  const filteredEntries = applyRequiredFieldFilters(record, requiredEntries, rule);
  return filteredEntries.map((entry) => {
    const value = recordFieldValue(record, entry.fieldName);
    const normalizedValue = normalizedText(value);
    const missing = isEmptyRequiredValue(value);
    return {
      ...entry,
      rawValueType: rawFieldValueType(record, entry.fieldName, value),
      valueSource: fieldValueSource(record, entry.fieldName),
      normalizedValue,
      missing,
      reason: missing ? "empty_value" : "explicit_value"
    };
  });
}

function taskSummary(record) {
  const standard = record.standard || {};
  return {
    recordId: record.recordId,
    scanIndex: record.scanIndex || 0,
    viewRowNumber: record.viewRowNumber || 0,
    demandId: standard.demandId || "",
    project: standard.project || "",
    demand: standard.demand || "",
    demandType: standard.demandType || "",
    status: standard.status || "",
    owners: standard.owners || {},
    dates: standard.dates || {},
    links: standard.links || {}
  };
}

function addIssue(result, record, issue) {
  if (!result.has(record.recordId)) {
    result.set(record.recordId, {
      task: taskSummary(record),
      issues: []
    });
  }
  result.get(record.recordId).issues.push(issue);
}

function scanOverdue(record, rules, result, today) {
  if (!rules.overdue || !rules.overdue.enabled) {
    return;
  }

  const dates = record.standard && record.standard.dates ? record.standard.dates : {};
  const deadlines = [
    { key: "devDeadline", label: "开发截止日期", value: dates.devDeadline || dates.plan },
    { key: "testDeadline", label: "测试截止日期", value: dates.testDeadline },
    { key: "acceptanceDeadline", label: "验收截止日期", value: dates.acceptanceDeadline }
  ];

  for (const deadline of deadlines) {
    const date = parseDateValue(deadline.value);
    if (!date) {
      continue;
    }
    const diff = daysUntil(date, today);
    if (diff < 0) {
      addIssue(result, record, {
        type: "overdue",
        severity: diff <= -3 ? "high" : "medium",
        field: deadline.key,
        title: `${deadline.label}已逾期`,
        message: `${deadline.label}为 ${dateLabel(date)}，已逾期 ${Math.abs(diff)} 天。`,
        days: Math.abs(diff),
        date: dateLabel(date)
      });
    }
  }
}

function scanStale(record, rules, result, today) {
  if (!rules.stale || !rules.stale.enabled) {
    return;
  }

  const dates = record.standard && record.standard.dates ? record.standard.dates : {};
  const updatedAt = parseDateValue(dates.updatedAt);
  if (!updatedAt) {
    return;
  }

  const diff = daysUntil(updatedAt, today);
  const days = Math.abs(diff);
  if (diff < 0 && days >= Number(rules.stale.days || 3)) {
    addIssue(result, record, {
      type: "stale",
      severity: days >= 7 ? "high" : "medium",
      field: "updatedAt",
      title: "长时间未更新",
      message: `更新时间为 ${dateLabel(updatedAt)}，已有 ${days} 天未更新。`,
      days,
      date: dateLabel(updatedAt)
    });
  }
}

function scanRemainingNearDeadline(record, rules, result, today) {
  const rule = rules.remainingNearDeadline || {};
  if (!rule.enabled) {
    return;
  }

  const dates = record.standard && record.standard.dates ? record.standard.dates : {};
  const deadline = parseDateValue(dates.devDeadline || dates.plan);
  if (!deadline) {
    return;
  }

  const diff = daysUntil(deadline, today);
  if (diff < 0 || diff > Number(rule.days || 2)) {
    return;
  }

  const mapped = record.mapped || {};
  const remainingItems = [
    { key: "frontendRemaining", label: "前端剩余", value: mapped.frontendRemaining },
    { key: "backendRemaining", label: "后端剩余", value: mapped.backendRemaining }
  ];
  const minimum = Number(rule.minimum || 0);
  for (const item of remainingItems) {
    const amount = parseNumber(item.value);
    if (amount > minimum) {
      addIssue(result, record, {
        type: "remaining_near_deadline",
        severity: diff <= 0 ? "high" : "medium",
        field: item.key,
        title: "临近截止仍有剩余",
        message: `${dateLabel(deadline)} 距开发截止还有 ${diff} 天，${item.label}为 ${amount}。`,
        daysUntilDeadline: diff,
        value: amount,
        date: dateLabel(deadline)
      });
    }
  }
}

function scanMissingOwner(record, rules, result) {
  const rule = rules.missingOwner || {};
  if (!rule.enabled) {
    return;
  }

  for (const role of rule.requiredRoles || []) {
    if (!ownerValue(record, role)) {
      addIssue(result, record, {
        type: "missing_owner",
        severity: "medium",
        field: role,
        title: "负责人缺失",
        message: `${OWNER_ROLE_LABELS[role] || role}为空。`
      });
    }
  }
}

function scanRequiredFields(record, rules, result) {
  const missingEntries = inspectRequiredFields(record, rules).filter((entry) => entry.missing);
  if (missingEntries.length === 0) {
    return;
  }

  const standard = record.standard || {};
  const grouped = new Map();
  for (const entry of missingEntries) {
    const ownerNames = Array.isArray(entry.ownerNames) ? entry.ownerNames : [];
    const ownerKey = ownerNames.length > 0 ? ownerNames.join("、") : "";
    if (!grouped.has(ownerKey)) {
      grouped.set(ownerKey, {
        owner: entry.owner || "",
        ownerNames,
        missingFields: [],
        isFallbackOwner: Boolean(entry.isFallbackOwner)
      });
    }
    grouped.get(ownerKey).missingFields.push(entry.fieldName);
    grouped.get(ownerKey).isFallbackOwner = grouped.get(ownerKey).isFallbackOwner || Boolean(entry.isFallbackOwner);
  }

  for (const group of grouped.values()) {
    addIssue(result, record, {
      type: "missing_required_field",
      severity: "medium",
      field: "requiredFields",
      title: "监控字段缺失",
      message: `${standard.demandType || "未识别需求类型"}/${standard.status || "未识别进度"} 缺少必填字段：${group.missingFields.join("、")}。`,
      demandType: standard.demandType || "",
      status: standard.status || "",
      owner: group.owner || "",
      ownerNames: group.ownerNames,
      missingFields: group.missingFields,
      isFallbackOwner: Boolean(group.isFallbackOwner)
    });
  }
}

function summarizeByType(anomalies) {
  const summary = {};
  for (const anomaly of anomalies) {
    for (const issue of anomaly.issues) {
      summary[issue.type] = (summary[issue.type] || 0) + 1;
    }
  }
  return summary;
}

function scanDevProgressAnomalies(records, rules, options = {}) {
  const today = options.today ? startOfLocalDay(options.today) : startOfLocalDay();
  const scanStartDate = parseDateValue(rules.scanStartDate);
  const focusDemandIds = new Set((Array.isArray(options.focusDemandIds) ? options.focusDemandIds : [])
    .map((value) => String(value || "").trim().replace(/^0+/, "").padStart(6, "0"))
    .filter((value) => /^\d{6}$/.test(value)));
  const result = new Map();
  let skipped = 0;
  let skippedBeforeStartDateCount = 0;
  let skippedProjectCount = 0;
  let skippedReleasedCount = 0;
  let skippedIgnoredCount = 0;

  for (const sourceRecord of records) {
    const sourceStandard = sourceRecord.standard || {};
    const demandId = String(sourceStandard.demandId || "").trim().replace(/^0+/, "").padStart(6, "0");
    const isFocusedDemand = focusDemandIds.has(demandId);
    const record = isFocusedDemand && (!normalizedText(sourceStandard.demand) || !normalizedText(sourceStandard.status))
      ? {
        ...sourceRecord,
        standard: {
          ...sourceStandard,
          demand: normalizedText(sourceStandard.demand) || `需求 ${demandId}`,
          status: normalizedText(sourceStandard.status) || "待分配",
          progress: normalizedText(sourceStandard.progress) || "待分配"
        }
      }
      : sourceRecord;
    const status = record.standard && record.standard.status ? record.standard.status : "";
    if (isBeforeScanStartDate(record, scanStartDate)) {
      skipped += 1;
      skippedBeforeStartDateCount += 1;
      continue;
    }
    if (!isFocusedDemand && isExcludedProject(record, rules)) {
      skipped += 1;
      skippedProjectCount += 1;
      continue;
    }
    if (isReleased(record, rules)) {
      skipped += 1;
      skippedReleasedCount += 1;
      continue;
    }
    if (isIgnored(status, rules)) {
      skipped += 1;
      skippedIgnoredCount += 1;
      continue;
    }

    scanOverdue(record, rules, result, today);
    scanStale(record, rules, result, today);
    scanRemainingNearDeadline(record, rules, result, today);
    scanMissingOwner(record, rules, result);
    scanRequiredFields(record, rules, result);
  }

  const anomalies = [...result.values()]
    .sort((left, right) => right.issues.length - left.issues.length || String(left.task.demandId).localeCompare(String(right.task.demandId)));
  return {
    ok: true,
    scannedCount: records.length,
    skippedCount: skipped,
    skippedBeforeStartDateCount,
    skippedProjectCount,
    skippedReleasedCount,
    skippedIgnoredCount,
    anomalyCount: anomalies.length,
    issueCount: anomalies.reduce((total, item) => total + item.issues.length, 0),
    summaryByType: summarizeByType(anomalies),
    generatedAt: new Date().toISOString(),
    rules: {
      scanLimit: rules.scanLimit,
      scanStartDate: scanStartDate ? dateLabel(scanStartDate) : "",
      excludedProjects: Array.isArray(rules.excludedProjects) ? rules.excludedProjects : [],
      overdueEnabled: Boolean(rules.overdue && rules.overdue.enabled),
      staleEnabled: Boolean(rules.stale && rules.stale.enabled),
      remainingNearDeadlineEnabled: Boolean(rules.remainingNearDeadline && rules.remainingNearDeadline.enabled),
      missingOwnerEnabled: Boolean(rules.missingOwner && rules.missingOwner.enabled),
      requiredFieldsEnabled: Boolean(rules.requiredFields && rules.requiredFields.enabled),
      requiredFieldRuleCount: rules.requiredFields && Array.isArray(rules.requiredFields.items)
        ? rules.requiredFields.items.length
        : 0
    },
    anomalies
  };
}

module.exports = {
  inspectRequiredFields,
  scanDevProgressAnomalies
};
