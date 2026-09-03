"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { inspectRequiredFields, scanDevProgressAnomalies } = require("../src/modules/devProgress/anomalyScanner");
const { getDevProgressSettings } = require("../src/config/settingsStore");

const projectRoot = path.resolve(__dirname, "..");
const fieldRuleConfig = JSON.parse(fs.readFileSync(
  path.join(projectRoot, "config", "dev-progress-field-rules.json"),
  "utf8"
));
const requiredFields = {
  ...fieldRuleConfig,
  enabled: true,
  mode: "fieldRulesV2"
};
const rules = { requiredFields };

function record(fields = {}, options = {}) {
  return {
    recordId: options.recordId || "record-test",
    fields,
    mapped: {},
    standard: {
      demandId: options.demandId || "999999",
      project: options.project || "测试项目",
      demand: options.demand || "规则测试需求",
      demandType: options.demandType || "新功能",
      status: options.status || "实现中",
      owners: {}
    }
  };
}

function decisions(fields = {}, options = {}, inspectOptions = {}) {
  return inspectRequiredFields(record(fields, options), rules, inspectOptions);
}

function fieldDecisions(fieldName, fields = {}, options = {}, inspectOptions = {}) {
  return decisions(fields, options, inspectOptions).filter((item) => item.fieldName === fieldName);
}

function ownerNames(items) {
  return [...new Set(items.flatMap((item) => item.ownerNames || []))].sort();
}

const normalizedFromSettings = getDevProgressSettings().rules.requiredFields;
assert.strictEqual(normalizedFromSettings.mode, "fieldRulesV2");
assert.strictEqual(normalizedFromSettings.ruleFile, "config/dev-progress-field-rules.json");
assert.strictEqual(normalizedFromSettings.fieldRules.length, 39);
assert.strictEqual(normalizedFromSettings.fieldRules.filter((rule) => rule.endStatus).length, 39);
assert.strictEqual(normalizedFromSettings.sourceVersion, "V0003");
assert.strictEqual(normalizedFromSettings.fallbackOwner, "王谦");
assert.deepStrictEqual(normalizedFromSettings.fallbackOwners, ["王谦", "李晶晶"]);

assert.strictEqual(fieldDecisions("需求名称", {}, { status: "待分配" }).length, 0);
assert.ok(fieldDecisions("需求名称", {}, { status: "规划中" }).some((item) => item.missing));
assert.strictEqual(fieldDecisions("需求名称", {}, { status: "设计中" }).length, 0);
assert.ok(fieldDecisions("需求名称", {}, { status: "测试阻塞" }).some((item) => item.missing));
assert.strictEqual(decisions({}, { status: "已拒绝" }).length, 0);
assert.strictEqual(decisions({}, { status: "暂停中" }).length, 0);
assert.strictEqual(decisions({}, { demandType: "任务拆分" }).length, 0);
assert.ok(fieldDecisions("规模类型", {}, { status: "规划中" }).some((item) => item.missing));

const scanSummary = scanDevProgressAnomalies([record({}, { status: "规划中" })], {
  requiredFields
});
assert.strictEqual(scanSummary.rules.requiredFieldRuleMode, "fieldRulesV2");
assert.strictEqual(scanSummary.rules.requiredFieldRuleVersion, "3.0.0");
assert.strictEqual(scanSummary.rules.requiredFieldRuleSourceVersion, "V0003");
assert.strictEqual(scanSummary.rules.requiredFieldRuleCount, 39);
assert.strictEqual(scanSummary.rules.requiredFieldBoundedRuleCount, 39);

assert.deepStrictEqual(requiredFields.statusGroups, {
  "开发中监控": ["待分配", "规划中", "实现中"],
  "验收中监控": ["内网验收中", "验收后bug修改中", "内网测试中", "测试2验收中", "测试2测试中", "测试1验收/测试中", "测试阻塞"],
  "验收完-更新前监控": ["测试服全完成", "上线前整备", "待上线"],
  "更新完成后监控": ["已上线", "需跟进上限后效果", "待复盘", "已更新但未验收"],
  "其他阻塞阶段": ["已拒绝", "暂停中"]
});
assert.strictEqual(requiredFields.fieldRules.filter((rule) => rule.endStatus === "实现中").length, 20);
assert.strictEqual(requiredFields.fieldRules.filter((rule) => rule.endStatus === "测试阻塞").length, 3);
assert.strictEqual(requiredFields.fieldRules.filter((rule) => rule.endStatus === "待上线").length, 9);
assert.strictEqual(requiredFields.fieldRules.filter((rule) => rule.endStatus === "已更新但未验收").length, 7);
assert.ok(requiredFields.fieldRules.every((rule) => rule.monitorGroups.length > 0));

const configuredFields = new Set(requiredFields.fieldRules.map((item) => item.field));
assert.ok(configuredFields.has("监修时间"));
assert.ok(configuredFields.has("特效制作耗时"));
assert.ok(configuredFields.has("特效制作剩余"));
assert.ok(configuredFields.has("动作制作耗时"));
assert.ok(configuredFields.has("动作制作剩余"));
assert.ok(!configuredFields.has("动效制作耗时"));
assert.ok(!configuredFields.has("动效制作剩余"));
assert.ok(!configuredFields.has("监修日期修正值"));
assert.ok(!configuredFields.has("监修日期修正值（可负）"));

assert.strictEqual(fieldDecisions("群聊", {}, { demandType: "bug" }).length, 0);
assert.ok(fieldDecisions("群聊", {}, { demandType: "新功能" }).some((item) => item.missing));
assert.strictEqual(fieldDecisions("需求设计耗时", {}, { demandType: "活动配置", status: "规划中" }).length, 0);
assert.ok(fieldDecisions("需求设计剩余", {}, { demandType: "活动配置", status: "规划中" }).some((item) => item.missing));
assert.ok(fieldDecisions("规模类型", {}, { status: "规划中" }).some((item) => item.missing));
assert.ok(fieldDecisions("规模类型", {}, { status: "实现中" }).some((item) => item.missing));
assert.ok(fieldDecisions("规模类型", {}, { status: "内网验收中" }).some((item) => item.missing));
assert.ok(fieldDecisions("规模类型", {}, { status: "已上线" }).some((item) => item.missing));
assert.ok(fieldDecisions("规模类型", {}, { status: "需跟进上限后效果" }).some((item) => item.missing));
assert.ok(fieldDecisions("规模类型", {}, { status: "待复盘" }).some((item) => item.missing));
assert.ok(fieldDecisions("规模类型", {}, { status: "已更新但未验收" }).some((item) => item.missing));
assert.ok(fieldDecisions("需求名称", {}, { status: "内网验收中" }).some((item) => item.missing));
assert.ok(fieldDecisions("测试人员", {}, { status: "内网验收中" }).some((item) => item.missing));
assert.ok(fieldDecisions("测试人员", {}, { status: "测试服全完成" }).some((item) => item.missing));
assert.ok(fieldDecisions("测试人员", {}, { status: "待上线" }).some((item) => item.missing));
assert.strictEqual(fieldDecisions("测试人员", {}, { status: "已上线" }).length, 0);

const noUiCascade = decisions({ UI需求: "" });
assert.ok(noUiCascade.some((item) => item.fieldName === "UI需求" && item.missing));
assert.strictEqual(noUiCascade.filter((item) => item.fieldName === "UI人员").length, 0);
assert.strictEqual(fieldDecisions("UI人员", { UI需求: "-" }).length, 0);
assert.ok(fieldDecisions("UI人员", { UI需求: "需要UI", 策划人员: "张三" }).some((item) => item.missing));

const plannerOwners = ownerNames(fieldDecisions("需求内容", { 策划人员: "张三" }));
assert.deepStrictEqual(plannerOwners, ["张三", "时振兴", "王谦", "李晶晶"].sort());
const uiOwners = ownerNames(fieldDecisions("UI进度", { UI需求: "需要UI", UI人员: "李四" }));
assert.deepStrictEqual(uiOwners, ["李四", "王谦", "李晶晶"].sort());
const uiFallbackOnly = fieldDecisions("UI进度", { UI需求: "需要UI", UI人员: "" });
assert.deepStrictEqual(ownerNames(uiFallbackOnly), ["王谦", "李晶晶"].sort());
assert.strictEqual(uiFallbackOnly.filter((item) => item.ownerNames.includes("王谦")).length, 1);
assert.strictEqual(uiFallbackOnly.filter((item) => item.ownerNames.includes("李晶晶")).length, 1);
const frontendOwners = ownerNames(fieldDecisions("前端剩余", {
  前端开发: "赵鹏",
  前端组长: "胡锦南"
}));
assert.deepStrictEqual(frontendOwners, ["赵鹏", "胡锦南", "王谦", "李晶晶"].sort());
const frontendFallbackOnly = fieldDecisions("前端开发", {
  前端开发: "",
  前端组长: ""
});
assert.deepStrictEqual(ownerNames(frontendFallbackOnly), ["王谦", "李晶晶"].sort());

const workdayDates = [
  "2026-08-31",
  "2026-09-01",
  "2026-09-02",
  "2026-09-03"
];
const deadlineViolation = fieldDecisions("前端剩余", {
  前端开发: "赵鹏",
  前端组长: "胡锦南",
  前端剩余: "2",
  开发截止日期: "2026-09-01"
}, {}, { today: new Date(2026, 7, 31), workdayDates });
assert.ok(deadlineViolation.every((item) => item.missing && item.reason === "date_after_deadline"));
assert.ok(deadlineViolation.every((item) => item.problems[0].resultDate === "2026-09-02"));

const deadlinePass = fieldDecisions("前端剩余", {
  前端开发: "赵鹏",
  前端组长: "胡锦南",
  前端剩余: "2",
  开发截止日期: "2026-09-02"
}, {}, { today: new Date(2026, 7, 31), workdayDates });
assert.ok(deadlinePass.every((item) => !item.missing));

const missingDeadlineIgnored = fieldDecisions("前端剩余", {
  前端开发: "赵鹏",
  前端组长: "胡锦南",
  前端剩余: "2",
  开发截止日期: ""
}, {}, { today: new Date(2026, 7, 31), workdayDates });
assert.ok(missingDeadlineIgnored.every((item) => !item.missing));
assert.ok(missingDeadlineIgnored.every((item) => item.validationSkipped.some((skip) => skip.code === "deadline_dependency_unavailable")));

const missingCalendarIgnored = fieldDecisions("前端剩余", {
  前端开发: "赵鹏",
  前端组长: "胡锦南",
  前端剩余: "2",
  开发截止日期: "2026-09-01"
}, {}, { today: new Date(2026, 7, 31), workdayDates: [] });
assert.ok(missingCalendarIgnored.every((item) => !item.missing));
assert.ok(missingCalendarIgnored.every((item) => item.validationSkipped.some((skip) => skip.code === "workday_calendar_unavailable")));

const directDateViolation = fieldDecisions("UI日方时间", {
  UI需求: "需要UI",
  UI人员: "李四",
  UI日方时间: "2026-09-03",
  UI完成时间: "2026-09-02",
  美术截止日期: "2026-09-04"
});
assert.ok(directDateViolation.every((item) => item.missing && item.reason === "date_after_deadline"));

const frontendRemainingDuringDevelopment = fieldDecisions("前端剩余", {
  前端开发: "赵鹏",
  前端剩余: "2",
  开发截止日期: "2026-09-03"
}, { status: "实现中" }, { today: new Date(2026, 7, 31), workdayDates });
assert.ok(frontendRemainingDuringDevelopment.every((item) => !item.missing));

const frontendRemainingDuringAcceptance = fieldDecisions("前端剩余", {
  前端开发: "赵鹏",
  前端剩余: "1",
  开发截止日期: "2026-09-03"
}, { status: "内网验收中" }, { today: new Date(2026, 7, 31), workdayDates });
assert.ok(frontendRemainingDuringAcceptance.every((item) => (
  item.missing && item.reason === "number_above_maximum" && item.problems[0].maximum === 0
)));
assert.ok(fieldDecisions("前端剩余", {
  前端开发: "赵鹏",
  前端剩余: "0",
  开发截止日期: "2026-09-03"
}, { status: "内网验收中" }, { today: new Date(2026, 7, 31), workdayDates }).every((item) => !item.missing));
assert.strictEqual(fieldDecisions("前端剩余", {
  前端开发: "赵鹏",
  前端剩余: "1",
  开发截止日期: "2026-09-03"
}, { status: "测试服全完成" }, { today: new Date(2026, 7, 31), workdayDates }).length, 0);
assert.ok(fieldDecisions("前端剩余", {
  前端开发: "赵鹏",
  前端剩余: "1",
  开发截止日期: "2026-09-03"
}, { status: "测试阻塞" }, { today: new Date(2026, 7, 31), workdayDates })
  .every((item) => item.missing && item.reason === "number_above_maximum"));

const uiProgressDuringDevelopment = fieldDecisions("UI进度", {
  UI需求: "需要UI",
  UI进度: "待分配"
}, { status: "实现中" });
assert.ok(uiProgressDuringDevelopment.every((item) => !item.missing));
for (const status of ["内网验收中", "测试服全完成", "待上线"]) {
  const invalidUiProgress = fieldDecisions("UI进度", {
    UI需求: "需要UI",
    UI进度: "制作/拆分中"
  }, { status });
  assert.ok(invalidUiProgress.every((item) => item.missing && item.reason === "value_not_allowed"));
}
assert.strictEqual(fieldDecisions("UI进度", {
  UI需求: "需要UI",
  UI进度: "制作/拆分中"
}, { status: "已上线" }).length, 0);

const invalidEffectProgress = fieldDecisions("动效进度", {
  动效需求: "需要动效",
  动效进度: "制作中"
}, { status: "内网测试中" });
assert.ok(invalidEffectProgress.every((item) => item.missing && item.reason === "value_not_allowed"));

for (const fieldName of [
  "UI剩余时间", "需求设计剩余", "配置/数值剩余", "特效制作剩余", "动作制作剩余"
]) {
  const fields = {
    [fieldName]: "1",
    UI需求: "需要UI",
    动效需求: "需要动效",
    策划人员: "张三",
    UI人员: "李四",
    动效人员: "王五",
    需求截止日期: "2026-09-03",
    配置截止日期: "2026-09-03",
    动效制作交付日期: "2026-09-03",
    美术截止日期: "2026-09-03"
  };
  const invalidRemaining = fieldDecisions(fieldName, fields, { status: "测试服全完成" }, {
    today: new Date(2026, 7, 31),
    workdayDates
  });
  assert.ok(invalidRemaining.every((item) => item.missing && item.reason === "number_above_maximum"), fieldName);
}

assert.strictEqual(fieldDecisions("监修时间", {
  UI需求: "-",
  动效需求: "-"
}).length, 0);
const monitorRequired = fieldDecisions("监修时间", {
  UI需求: "-",
  动效需求: "需要动效",
  监修时间: ""
});
assert.ok(monitorRequired.some((item) => item.missing && item.reason === "empty_value"));
const monitorDeadlineViolation = fieldDecisions("监修时间", {
  UI需求: "需要UI",
  动效需求: "-",
  监修时间: "2026-09-03",
  监修截止日期: "2026-09-02"
});
assert.ok(monitorDeadlineViolation.every((item) => item.missing && item.reason === "date_after_deadline"));
assert.ok(fieldDecisions("监修时间", {
  UI需求: "需要UI",
  动效需求: "-",
  监修时间: ""
}, { status: "内网验收中" }).some((item) => item.missing));

const liveFieldTitles = [...configuredFields].filter((fieldName) => fieldName !== "监修时间");
assert.strictEqual(fieldDecisions("监修时间", {
  UI需求: "需要UI",
  动效需求: "-"
}, {}, { availableFieldTitles: liveFieldTitles }).length, 0);
const schemaSummary = scanDevProgressAnomalies([record({
  UI需求: "需要UI",
  动效需求: "-"
})], { requiredFields }, { availableFieldTitles: liveFieldTitles });
assert.strictEqual(schemaSummary.rules.requiredFieldAvailableRuleCount, 38);
assert.strictEqual(schemaSummary.rules.requiredFieldUnavailableRuleCount, 1);
assert.deepStrictEqual(schemaSummary.rules.requiredFieldUnavailableFields, ["监修时间"]);

console.log("Dev progress field rules v2 check passed");
