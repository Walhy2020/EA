(function attachDemandRequiredFieldDisplay(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.DemandRequiredFieldDisplay = api;
  }
})(typeof window !== "undefined" ? window : globalThis, function createDemandRequiredFieldDisplay() {
  "use strict";

  function text(value) {
    return String(value === null || value === undefined ? "" : value).trim();
  }

  function valueText(value) {
    if (Array.isArray(value)) {
      return value.map(text).filter(Boolean).join("、");
    }
    return text(value);
  }

  function normalizeProblems(problems, displayFieldName) {
    const display = typeof displayFieldName === "function" ? displayFieldName : text;
    const result = [];
    const seen = new Set();
    for (const source of Array.isArray(problems) ? problems : []) {
      const problem = source && typeof source === "object" ? source : {};
      const normalized = {
        fieldName: display(problem.fieldName),
        code: text(problem.code),
        message: text(problem.message),
        actualValue: problem.actualValue,
        maximum: problem.maximum,
        resultDate: text(problem.resultDate),
        deadlineField: display(problem.deadlineField),
        deadlineDate: text(problem.deadlineDate)
      };
      if (!normalized.fieldName && !normalized.message) {
        continue;
      }
      const key = JSON.stringify(normalized);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      result.push(normalized);
    }
    return result;
  }

  function problemText(problem) {
    const fieldName = problem.fieldName || "字段";
    if (problem.code === "empty_value") {
      return `${fieldName}未填写`;
    }
    if (problem.code === "number_above_maximum") {
      const actual = valueText(problem.actualValue);
      const maximum = valueText(problem.maximum);
      return `${fieldName}${actual ? `当前为 ${actual}` : ""}${maximum ? `，应不大于 ${maximum}` : "数值不符合要求"}`;
    }
    if (problem.code === "value_not_allowed") {
      const actual = valueText(problem.actualValue);
      return actual ? `${fieldName}当前为 ${actual}，当前阶段不允许` : (problem.message || `${fieldName}需修正`);
    }
    if (problem.code === "date_after_deadline" && problem.resultDate && problem.deadlineDate) {
      return `${fieldName}计算日期 ${problem.resultDate} 晚于 ${problem.deadlineField || "截止日期"} ${problem.deadlineDate}`;
    }
    return problem.message || `${fieldName}需修正`;
  }

  function issueLine(item, displayFieldName) {
    const safeItem = item && typeof item === "object" ? item : {};
    const display = typeof displayFieldName === "function" ? displayFieldName : text;
    const missingFields = (Array.isArray(safeItem.missingFields) ? safeItem.missingFields : [])
      .map(display)
      .filter(Boolean);
    const problems = normalizeProblems(safeItem.fieldProblems, display);
    if (problems.length === 0) {
      return `缺失：${missingFields.join("、") || "-"}`;
    }

    const parts = problems.map(problemText);
    const coveredFields = new Set(problems.map((problem) => problem.fieldName));
    for (const fieldName of missingFields) {
      if (!coveredFields.has(fieldName)) {
        parts.push(`${fieldName}需处理`);
      }
    }
    const uniqueParts = [...new Set(parts.filter(Boolean))];
    const allEmpty = problems.every((problem) => problem.code === "empty_value")
      && missingFields.every((fieldName) => coveredFields.has(fieldName));
    const allValidation = problems.every((problem) => problem.code !== "empty_value")
      && missingFields.every((fieldName) => coveredFields.has(fieldName));
    const prefix = allEmpty ? "缺失" : (allValidation ? "需修正" : "需处理");
    return `${prefix}：${uniqueParts.join("；") || missingFields.join("、") || "-"}`;
  }

  return { normalizeProblems, issueLine };
});
