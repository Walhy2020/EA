"use strict";

const assert = require("assert");
const { __test } = require("../src/modules/devProgress/devProgressModule");

const item = {
  recordId: "record-1",
  demandId: "D-1",
  demand: "权限回归",
  missingFields: ["程序开发交付日期", "需求链接"]
};
const dualFallbackSettings = {
  rules: {
    requiredFields: {
      fallbackOwner: "王谦",
      fallbackOwners: ["王谦", "李晶晶"]
    }
  }
};

assert.strictEqual(
  __test.requiredFieldItemForLeaderScope(item, new Set()),
  null,
  "非组长即使被历史 owner 规则命中，也不能看到必填字段"
);
assert.strictEqual(
  __test.requiredFieldItemsOwnerForScope(dualFallbackSettings, "李晶晶", true),
  "王谦",
  "已授权的兜底查看者应读取配置兜底人的任务集合"
);
assert.strictEqual(
  __test.requiredFieldItemsOwnerForScope(dualFallbackSettings, "李晶晶", false),
  "李晶晶",
  "普通个人范围仍应读取当前用户任务"
);

assert.deepStrictEqual(
  __test.requiredFieldFallbackViewerNames(dualFallbackSettings),
  ["王谦", "李晶晶"],
  "兜底查看者应保留配置的兜底人并增加李晶晶"
);
assert.strictEqual(
  __test.canReadRequiredFieldFallbackScope(dualFallbackSettings, "李晶晶"),
  true,
  "李晶晶可以读取兜底任务"
);
assert.strictEqual(
  __test.canReadRequiredFieldFallbackScope(dualFallbackSettings, "李东"),
  false,
  "非兜底查看者不能读取兜底任务"
);

const frontendLeaderItem = __test.requiredFieldItemForLeaderScope(
  item,
  new Set(["程序开发交付日期"])
);
assert.deepStrictEqual(
  frontendLeaderItem.missingFields,
  ["程序开发交付日期"],
  "组长只能看到自身责任字段"
);
assert.strictEqual(
  __test.requiredFieldItemForLeaderScope(item, new Set(["UI制作交付日期"])),
  null,
  "组长没有匹配字段时不能看到事项"
);

console.log(JSON.stringify({
  passed: true,
  checks: {
    nonLeaderDenied: true,
    leaderFieldScoped: true,
    unrelatedLeaderDenied: true,
    fallbackViewerWhitelist: true,
    fallbackViewerUsesSharedTaskSet: true
  }
}, null, 2));
