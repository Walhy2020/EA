"use strict";

// The fallback view is intentionally limited to the roles that own its triage flow.
// Names always come from the current workflow configuration, never from the H5 page.
const FALLBACK_LEADER_ROLE_ORDER = [
  { assigneeField: "策划人员", label: "策划" },
  { assigneeField: "前端开发", label: "前端" },
  { assigneeField: "后端开发", label: "后端" },
  { assigneeField: "测试人员", label: "测试" }
];

const OWNER_ROLE_BY_ASSIGNEE_FIELD = {
  策划人员: "planner",
  前端开发: "frontend",
  后端开发: "backend",
  测试人员: "tester"
};

function uniqueNames(values = []) {
  const seen = new Set();
  const result = [];
  for (const value of values || []) {
    const name = String(value || "").trim();
    if (!name || seen.has(name)) {
      continue;
    }
    seen.add(name);
    result.push(name);
  }
  return result;
}

function splitPeople(value) {
  return uniqueNames(String(value || "").split(/[、,，;；\n\r]+/));
}

function namesInclude(values = [], name) {
  const expected = String(name || "").trim();
  return Boolean(expected) && values.some((value) => String(value || "").trim() === expected);
}

function fallbackLeaderFilters(workflowRules = {}) {
  const roles = workflowRules.roles && typeof workflowRules.roles === "object" ? workflowRules.roles : {};
  const result = [];
  for (const definition of FALLBACK_LEADER_ROLE_ORDER) {
    const role = roles[definition.assigneeField] || {};
    const leaderField = String(role.leaderField || "").trim();
    for (const name of uniqueNames(role.leaderNames)) {
      result.push({
        name,
        role: definition.label,
        assigneeField: definition.assigneeField,
        leaderField
      });
    }
  }
  return result;
}

function configuredMembersForLeader(role = {}, leaderName) {
  const byLeader = role.leaderMemberNames && typeof role.leaderMemberNames === "object"
    ? role.leaderMemberNames
    : {};
  const direct = Object.entries(byLeader)
    .find(([name]) => String(name || "").trim() === String(leaderName || "").trim());
  return uniqueNames(direct ? direct[1] : role.memberNames);
}

function relatedNamesForRole(definition, role, owners, ruleOwners, options = {}) {
  const leaderField = String(role.leaderField || "").trim();
  const leaderNames = uniqueNames(role.leaderNames);
  const ownerRole = OWNER_ROLE_BY_ASSIGNEE_FIELD[definition.assigneeField] || "";
  const directLeaderNames = splitPeople(owners[`${ownerRole}Lead`]);
  const matchedDirectLeaders = leaderNames.filter((name) => namesInclude(directLeaderNames, name));
  if (matchedDirectLeaders.length > 0) {
    return matchedDirectLeaders;
  }

  const assignedMembers = splitPeople(owners[ownerRole]);
  const matchedByMember = leaderNames.filter((leaderName) => {
    if (namesInclude(assignedMembers, leaderName)) {
      return true;
    }
    const members = configuredMembersForLeader(role, leaderName);
    return assignedMembers.some((memberName) => namesInclude(members, memberName));
  });
  if (matchedByMember.length > 0) {
    return matchedByMember;
  }

  if (options.explicitMissingRole) {
    return leaderNames;
  }
  const matchedByRule = ruleOwners.includes(leaderField)
    || leaderNames.some((leaderName) => ruleOwners.includes(leaderName));
  return matchedByRule ? leaderNames : [];
}

function relatedLeaderNames(task = {}, originalOwnerName, workflowRules = {}, missingFields = []) {
  const roles = workflowRules.roles && typeof workflowRules.roles === "object" ? workflowRules.roles : {};
  const owners = task.owners && typeof task.owners === "object" ? task.owners : {};
  const ruleOwners = splitPeople(originalOwnerName);
  const missingFieldSet = new Set(uniqueNames(missingFields));
  const explicitDefinitions = FALLBACK_LEADER_ROLE_ORDER.filter((definition) => {
    const role = roles[definition.assigneeField] || {};
    const leaderField = String(role.leaderField || "").trim();
    return missingFieldSet.has(definition.assigneeField) || (leaderField && missingFieldSet.has(leaderField));
  });
  const definitions = explicitDefinitions.length > 0
    ? explicitDefinitions
    : FALLBACK_LEADER_ROLE_ORDER;
  const result = [];

  for (const definition of definitions) {
    const role = roles[definition.assigneeField] || {};
    result.push(...relatedNamesForRole(definition, role, owners, ruleOwners, {
      explicitMissingRole: explicitDefinitions.length > 0
    }));
  }

  return uniqueNames(result);
}

module.exports = {
  fallbackLeaderFilters,
  relatedLeaderNames
};
