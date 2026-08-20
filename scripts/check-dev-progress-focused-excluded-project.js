"use strict";

const { scanDevProgressAnomalies } = require("../src/modules/devProgress/anomalyScanner");

function record(demandId, demandType, status) {
  return {
    recordId: `R-${demandId}`,
    fields: {
      "需求类型": demandType,
      "项目": "魔王",
      "需求名称": "",
      "需求内容": "",
      "需求进度": status,
      "更新时间": "",
      "规模类型": ""
    },
    standard: {
      demandId,
      project: "魔王",
      demand: "",
      demandType,
      status,
      progress: status,
      owners: {},
      dates: { createdAt: "2026-08-12" },
      links: {}
    }
  };
}

const rules = {
  scanStartDate: "2026-06-01",
  excludedProjects: ["魔王"],
  ignoredStatusKeywords: ["取消"],
  requiredFields: {
    enabled: true,
    cumulative: true,
    items: [
      {
        demandType: "新功能",
        status: "规划中",
        owner: "高文盛",
        requiredFields: ["需求名称", "需求内容"]
      },
      {
        demandType: "优化",
        status: "待分配",
        owner: "高文盛",
        requiredFields: ["需求名称", "需求进度"]
      }
    ]
  }
};

const records = [
  record("003612", "新功能", "规划中"),
  record("003614", "优化", ""),
  record("003999", "新功能", "规划中")
];
const result = scanDevProgressAnomalies(records, rules, {
  focusDemandIds: ["3612", "003614"]
});
const ids = result.anomalies.map((item) => item.task.demandId);
const blankStatusTask = result.anomalies.find((item) => item.task.demandId === "003614");
const checks = {
  focusedExcludedProjectIncluded: ids.includes("003612"),
  focusedBlankStatusIncluded: ids.includes("003614"),
  nonFocusedExcludedProjectStillExcluded: !ids.includes("003999"),
  blankStatusUsesPendingFallback: Boolean(blankStatusTask && blankStatusTask.task.status === "待分配"),
  demandNameUsesIdFallback: result.anomalies.every((item) => item.task.demand === `需求 ${item.task.demandId}`)
};
const passed = Object.values(checks).every(Boolean);
console.log(JSON.stringify({ passed, checks, result }, null, 2));
if (!passed) {
  process.exitCode = 1;
}
