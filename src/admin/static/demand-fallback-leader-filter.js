(function initDemandFallbackLeaderFilter(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.EADemandFallbackLeaderFilter = api;
  }
}(typeof window !== "undefined" ? window : globalThis, function createDemandFallbackLeaderFilter() {
  function text(value) {
    return String(value || "").trim();
  }

  function uniqueNames(values) {
    const seen = new Set();
    const result = [];
    for (const value of values || []) {
      const name = text(value);
      if (!name || seen.has(name)) continue;
      seen.add(name);
      result.push(name);
    }
    return result;
  }

  function leaderOptions(filters) {
    const byName = new Map();
    for (const filter of filters || []) {
      const name = text(filter && filter.name);
      if (!name) continue;
      const role = text(filter && filter.role);
      if (!byName.has(name)) {
        byName.set(name, { name, roles: [] });
      }
      const option = byName.get(name);
      if (role && !option.roles.includes(role)) {
        option.roles.push(role);
      }
    }
    return [...byName.values()];
  }

  function toggleSelection(selectedNames, name) {
    const next = new Set(uniqueNames(selectedNames));
    const normalizedName = text(name);
    if (!normalizedName) return next;
    if (next.has(normalizedName)) next.delete(normalizedName);
    else next.add(normalizedName);
    return next;
  }

  function taskKey(item, index) {
    const safeItem = item && typeof item === "object" ? item : {};
    const recordId = text(safeItem.recordId);
    if (recordId) return `record:${recordId}`;
    const demandId = text(safeItem.demandId);
    if (demandId) return `demand:${demandId}`;
    const id = text(safeItem.id);
    return id ? `item:${id}` : `index:${index}`;
  }

  function mergeVisibleItems(items) {
    const byTask = new Map();
    for (const [index, item] of (items || []).entries()) {
      const safeItem = item && typeof item === "object" ? item : {};
      const key = taskKey(safeItem, index);
      if (!byTask.has(key)) {
        byTask.set(key, {
          ...safeItem,
          missingFields: uniqueNames(safeItem.missingFields),
          leaderNames: uniqueNames(safeItem.leaderNames)
        });
        continue;
      }
      const existing = byTask.get(key);
      existing.missingFields = uniqueNames([
        ...(existing.missingFields || []),
        ...(safeItem.missingFields || [])
      ]);
      existing.leaderNames = uniqueNames([
        ...(existing.leaderNames || []),
        ...(safeItem.leaderNames || [])
      ]);
    }
    return [...byTask.values()];
  }

  function visibleItems(items, selectedNames) {
    const selected = new Set(uniqueNames(selectedNames));
    const matchedItems = selected.size === 0
      ? items || []
      : (items || []).filter((item) => uniqueNames(item && item.leaderNames)
        .some((name) => selected.has(name)));
    // Server-side items already use each leader's field visibility rule.
    // The H5 only combines rows that represent the same demand.
    return mergeVisibleItems(matchedItems);
  }

  return {
    leaderOptions,
    mergeVisibleItems,
    taskKey,
    toggleSelection,
    uniqueNames,
    visibleItems
  };
}));
