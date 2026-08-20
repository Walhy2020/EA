"use strict";

const assert = require("assert");
const {
  fallbackLeaderFilters,
  relatedLeaderNames
} = require("../src/modules/devProgress/fallbackLeaderFilter");

const workflowRules = {
  roles: {
    策划人员: {
      leaderField: "策划组长",
      leaderNames: ["时振兴"],
      memberNames: ["策划甲"]
    },
    前端开发: {
      leaderField: "前端组长",
      leaderNames: ["胡锦南", "赵琛"],
      leaderMemberNames: {
        胡锦南: ["前端甲"],
        赵琛: ["前端乙"]
      }
    },
    后端开发: {
      leaderField: "后端组长",
      leaderNames: ["王文静"],
      memberNames: ["后端甲"]
    },
    测试人员: {
      leaderField: "测试组长",
      leaderNames: ["高文盛"],
      memberNames: ["测试甲"]
    }
  }
};

assert.deepStrictEqual(
  fallbackLeaderFilters(workflowRules).map((item) => `${item.role}:${item.name}`),
  ["策划:时振兴", "前端:胡锦南", "前端:赵琛", "后端:王文静", "测试:高文盛"]
);

assert.deepStrictEqual(
  relatedLeaderNames({ owners: { frontend: "前端乙" } }, "", workflowRules),
  ["赵琛"]
);
assert.deepStrictEqual(
  relatedLeaderNames({ owners: { backendLead: "王文静" } }, "", workflowRules),
  ["王文静"]
);
assert.deepStrictEqual(
  relatedLeaderNames({}, "策划组长、前端组长", workflowRules),
  ["时振兴", "胡锦南", "赵琛"]
);
assert.deepStrictEqual(
  relatedLeaderNames({}, "时振兴、前端组长、后端组长、测试组长", workflowRules, ["前端开发"]),
  ["胡锦南", "赵琛"]
);
assert.deepStrictEqual(
  relatedLeaderNames({}, "时振兴、前端组长、后端组长、测试组长", workflowRules, ["策划人员", "后端组长"]),
  ["时振兴", "王文静"]
);
assert.deepStrictEqual(
  relatedLeaderNames({ owners: { frontend: "未知成员" } }, "", workflowRules),
  []
);

console.log(JSON.stringify({
  ok: true,
  checks: [
    "roleOrderAndConfiguredLeaders",
    "memberToSpecificLeader",
    "directLeaderOwner",
    "legacyOwnerFieldFallback",
    "missingFieldRoleOverridesMergedLegacyOwners",
    "multipleMissingRolesUseUnion",
    "unmatchedTaskHasNoLeader"
  ]
}, null, 2));
