"use strict";

const assert = require("assert");
const { __test } = require("../src/modules/devProgress/devProgressModule");
const filter = require("../src/admin/static/demand-fallback-leader-filter");

const workflowRules = {
  roles: {
    前端开发: {
      leaderField: "前端组长",
      leaderNames: ["胡锦南"]
    },
    测试人员: {
      leaderField: "测试组长",
      leaderNames: ["高文盛"]
    }
  }
};
const settings = { personAliases: {} };
const cache = {
  requiredItems: [
    {
      id: "r-shared-test",
      recordId: "r-shared",
      demandId: "D-100",
      ownerName: "高文盛",
      project: "项目 A",
      missingFields: ["内网验收/测试完成日期", "需求链接"]
    },
    {
      id: "r-shared-frontend",
      recordId: "r-shared",
      demandId: "D-100",
      ownerName: "胡锦南",
      project: "项目 A",
      missingFields: ["程序开发交付日期", "需求链接"]
    },
    {
      id: "r-test-only",
      recordId: "r-test-only",
      demandId: "D-101",
      ownerName: "高文盛",
      project: "项目 B",
      missingFields: ["正式验收/测试完成日期"]
    },
    {
      id: "r-residual",
      recordId: "r-residual",
      demandId: "D-102",
      ownerName: "王谦",
      ownerType: "fallback",
      project: "项目 A",
      missingFields: ["需求链接"]
    }
  ]
};

function comparable(items) {
  return items.map((item) => ({
    recordId: item.recordId,
    demandId: item.demandId,
    missingFields: item.missingFields
  }));
}

function sameLeaderView(name) {
  const personalItems = __test.requiredFieldLeaderViewItems(cache, settings, name, null, workflowRules);
  const fallbackItems = __test.fallbackLeaderViewItems(cache, settings, null, workflowRules);
  const filteredFallbackItems = filter.visibleItems(fallbackItems, [name]);
  assert.deepStrictEqual(
    comparable(filteredFallbackItems),
    comparable(personalItems),
    `${name} 的兜底筛选必须与本人字段范围一致`
  );
  return personalItems;
}

const gaowenshengItems = sameLeaderView("高文盛");
const hujinnanItems = sameLeaderView("胡锦南");
const allFallbackItems = [
  ...__test.fallbackLeaderViewItems(cache, settings, null, workflowRules),
  ...cache.requiredItems.filter((item) => item.ownerType === "fallback").map((item) => ({ ...item, leaderNames: [] }))
];
const multiLeaderItems = filter.visibleItems(allFallbackItems, ["高文盛", "胡锦南"]);
assert.deepStrictEqual(comparable(multiLeaderItems), [
  {
    recordId: "r-shared",
    demandId: "D-100",
    missingFields: ["程序开发交付日期", "内网验收/测试完成日期"]
  },
  {
    recordId: "r-test-only",
    demandId: "D-101",
    missingFields: ["正式验收/测试完成日期"]
  }
]);
assert.deepStrictEqual(
  comparable(filter.visibleItems(allFallbackItems, [])),
  [
    ...comparable(multiLeaderItems),
    { recordId: "r-residual", demandId: "D-102", missingFields: ["需求链接"] }
  ],
  "无筛选时应包含组长同源字段和原兜底剩余字段"
);

assert.deepStrictEqual(
  comparable(filter.visibleItems(
    __test.fallbackLeaderViewItems(cache, settings, { projectName: "项目 A" }, workflowRules),
    ["高文盛"]
  )),
  comparable(__test.requiredFieldLeaderViewItems(cache, settings, "高文盛", { projectName: "项目 A" }, workflowRules)),
  "项目筛选后仍必须保持组长本人字段口径"
);

assert.strictEqual(gaowenshengItems.length, 2);
assert.strictEqual(hujinnanItems.length, 1);
assert.deepStrictEqual(
  comparable(__test.mergeRequiredFieldViewItems([
    {
      recordId: "r-flat-a",
      demandId: "D-FLAT-A",
      missingFields: ["字段 A"]
    },
    {
      recordId: "r-flat-b",
      demandId: "D-FLAT-B",
      missingFields: ["字段 B"]
    },
    {
      recordId: "r-flat-a",
      demandId: "D-FLAT-A",
      missingFields: ["字段 C"]
    }
  ])),
  [
    { recordId: "r-flat-a", demandId: "D-FLAT-A", missingFields: ["字段 A", "字段 C"] },
    { recordId: "r-flat-b", demandId: "D-FLAT-B", missingFields: ["字段 B"] }
  ],
  "顶层 recordId 的 H5 任务必须按需求合并，不能全部折叠为一条"
);

const fieldRuleSettings = {
  personAliases: {},
  rules: {
    requiredFields: {
      fallbackOwner: "王谦",
      fallbackOwners: ["王谦", "李晶晶"],
      leaders: {
        UI组长: { names: ["王谦"] },
        前端组长: { sourceField: "前端组长" },
        后端组长: { sourceField: "后端组长" }
      },
      fieldRules: [
        { field: "UI需求", leaderRole: "UI组长" },
        { field: "UI进度", leaderRole: "UI组长" },
        { field: "前端剩余", leaderRole: "前端组长" },
        { field: "后端剩余", leaderRole: "后端组长" }
      ]
    }
  }
};
const fallbackRoleCache = {
  requiredItems: [
    {
      recordId: "r-wang-ui",
      demandId: "D-WANG-UI",
      ownerName: "王谦",
      ownerType: "fallback",
      missingFields: ["UI需求", "UI进度", "前端剩余", "后端剩余"]
    },
    {
      recordId: "r-zhao-1",
      demandId: "D-ZHAO-1",
      ownerName: "赵琛",
      missingFields: ["前端剩余"]
    },
    {
      recordId: "r-zhao-2",
      demandId: "D-ZHAO-2",
      ownerName: "赵琛",
      missingFields: ["前端剩余"]
    }
  ]
};
const wangPersonalItems = __test.requiredFieldLeaderViewItems(
  fallbackRoleCache,
  fieldRuleSettings,
  "王谦"
);
assert.deepStrictEqual(
  comparable(wangPersonalItems),
  [{
    recordId: "r-wang-ui",
    demandId: "D-WANG-UI",
    missingFields: ["UI需求", "UI进度"]
  }],
  "总兜底人个人字段页必须只保留其明确配置的 UI 组长字段"
);
assert.deepStrictEqual(
  [...__test.leaderRequiredFieldSetForPerson(
    "王谦",
    {},
    undefined,
    fieldRuleSettings.rules.requiredFields
  )],
  ["UI需求", "UI进度"],
  "总兜底身份不能把前端和后端动态组长字段带入个人页"
);
assert.strictEqual(
  __test.requiredFieldLeaderViewItems(fallbackRoleCache, fieldRuleSettings, "李晶晶").length,
  0,
  "仅具有总兜底身份的人员不应在个人字段页看到全部字段"
);
assert.deepStrictEqual(
  __test.requiredFieldLeaderViewItems(fallbackRoleCache, fieldRuleSettings, "赵琛")
    .map((item) => item.recordId),
  ["r-zhao-1", "r-zhao-2"],
  "动态组长的多条需求必须保持独立，不能合并为一条"
);
console.log(JSON.stringify({
  passed: true,
  checks: {
    fallbackViewerMatchesGaowenshengFieldScope: true,
    fallbackViewerMatchesOtherLeaderFieldScope: true,
    multiLeaderUsesFieldScopeUnion: true,
    duplicateDemandMergesMissingFields: true,
    flattenedH5ItemsKeepDistinctDemands: true,
    noSelectionKeepsFallbackResidualItems: true,
    projectFilterKeepsLeaderParity: true,
    fallbackOwnerPersonalRoleSeparated: true,
    allDynamicLeaderRecordsRemainDistinct: true
  }
}, null, 2));
