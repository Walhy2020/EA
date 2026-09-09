"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { getDevProgressSettings, getDemandWorkflowRulesSettings } = require("../src/config/settingsStore");
const { __test } = require("../src/modules/devProgress/devProgressModule");

const cachePath = process.argv[2] || path.join(__dirname, "../data/dev-progress/h5-monitor-cache.json");
const cache = JSON.parse(fs.readFileSync(cachePath, "utf8"));
const settings = getDevProgressSettings();
const workflow = getDemandWorkflowRulesSettings().normalizedRules;
const resolved = __test.monitorWorkflowRules(settings, workflow);
const leaders = [...new Set(Object.values(resolved.roles).flatMap((role) => role.leaderNames || []))];
const start = performance.now();
const results = [];
function canonical(items) {
  return items.map((item) => [item.recordId, [...item.missingFields].sort()])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
}
for (const leader of leaders) {
  const view = __test.requiredFieldMemberViews(cache, settings, leader, null, workflow);
  assert(view.isLeader);
  for (const member of view.views) {
    const direct = __test.directRequiredFieldItems(cache, settings, member.name);
    assert.deepStrictEqual(canonical(member.items), canonical(direct));
    assert(member.items.every((item) => !item.isFallbackOwner && item.leaderMissingFields.length === 0));
    assert.strictEqual(new Set(member.items.map((item) => item.recordId)).size, member.items.length);
  }
  const all = __test.mergeRequiredFieldViewItems([
    ...__test.directRequiredFieldItems(cache, settings, leader),
    ...__test.requiredFieldLeaderViewItems(cache, settings, leader, null, workflow),
    ...view.views.flatMap((member) => member.items)
  ]);
  assert.strictEqual(new Set(all.map((item) => item.recordId)).size, all.length);
  results.push({ leader, total: all.length, members: view.views.map((member) => ({ name: member.name, total: member.total })) });
}
console.log(JSON.stringify({ passed: true, cacheGeneratedAt: cache.generatedAt,
  elapsedMs: Math.round(performance.now() - start), leaders: results }, null, 2));
