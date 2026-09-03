(function initDemandProjectSettings(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.EADemandProjectSettings = api;
}(typeof window !== "undefined" ? window : globalThis, function createDemandProjectSettings() {
  const ALL_PROJECT_VALUE = "__all_projects__";
  const STORAGE_KEY = "ea-demand-monitor-project-settings-v1";

  function uniqueValues(values) {
    return [...new Set((values || []).map((value) => String(value || "").trim()).filter(Boolean))];
  }

  function catalogValues(catalog) {
    return uniqueValues((catalog || []).map((item) => item && item.value));
  }

  function normalizeSettings(input, catalog) {
    const source = input && typeof input === "object" ? input : {};
    const values = catalogValues(catalog);
    const allowedOrderValues = new Set([ALL_PROJECT_VALUE, ...values]);
    const requestedOrder = uniqueValues(Array.isArray(source.order) ? source.order : []);
    const order = requestedOrder.filter((value) => allowedOrderValues.has(value));
    for (const value of [ALL_PROJECT_VALUE, ...values]) {
      if (!order.includes(value)) order.push(value);
    }

    const requestedAllProjects = Array.isArray(source.allProjects)
      ? uniqueValues(source.allProjects).filter((value) => values.includes(value))
      : values;

    return {
      showAll: Boolean(source.showAll),
      allProjects: requestedAllProjects.length > 0 ? requestedAllProjects : values,
      order
    };
  }

  function visibleOrder(settings, catalog) {
    const normalized = normalizeSettings(settings, catalog);
    return normalized.order.filter((value) => normalized.showAll || value !== ALL_PROJECT_VALUE);
  }

  function selectableProjects(settings, catalog) {
    const catalogMap = new Map((catalog || []).map((item) => [String(item.value || "").trim(), item]));
    return visibleOrder(settings, catalog).map((value) => {
      if (value === ALL_PROJECT_VALUE) {
        return { value, label: "全部项目", isAll: true };
      }
      const item = catalogMap.get(value) || {};
      return { value, label: String(item.label || value), isAll: false };
    });
  }

  function moveProject(settings, catalog, value, direction) {
    const normalized = normalizeSettings(settings, catalog);
    const visible = visibleOrder(normalized, catalog);
    const currentIndex = visible.indexOf(value);
    const nextIndex = direction === "up" ? currentIndex - 1 : currentIndex + 1;
    if (currentIndex < 0 || nextIndex < 0 || nextIndex >= visible.length) return normalized;

    const swapValue = visible[nextIndex];
    const currentOrderIndex = normalized.order.indexOf(value);
    const swapOrderIndex = normalized.order.indexOf(swapValue);
    [normalized.order[currentOrderIndex], normalized.order[swapOrderIndex]] = [
      normalized.order[swapOrderIndex],
      normalized.order[currentOrderIndex]
    ];
    return normalized;
  }

  function normalizeMatchText(value) {
    return String(value || "").trim().replace(/\s+/g, "").toLowerCase();
  }

  function projectMatchesCatalogValue(projectName, value, catalog) {
    const item = (catalog || []).find((entry) => String(entry && entry.value || "").trim() === value);
    if (!item) return false;
    const target = normalizeMatchText(projectName);
    return uniqueValues([item.value, item.label, ...(item.aliases || [])])
      .some((candidate) => normalizeMatchText(candidate) === target);
  }

  function itemMatchesSelection(item, selectedValue, settings, catalog) {
    const projectName = item && item.project;
    if (selectedValue === ALL_PROJECT_VALUE) {
      const normalized = normalizeSettings(settings, catalog);
      return normalized.allProjects.some((value) => projectMatchesCatalogValue(projectName, value, catalog));
    }
    return projectMatchesCatalogValue(projectName, selectedValue, catalog);
  }

  function filterItems(items, selectedValue, settings, catalog) {
    if (selectedValue !== ALL_PROJECT_VALUE) return [...(items || [])];
    return (items || []).filter((item) => itemMatchesSelection(item, selectedValue, settings, catalog));
  }

  return {
    ALL_PROJECT_VALUE,
    STORAGE_KEY,
    normalizeSettings,
    visibleOrder,
    selectableProjects,
    moveProject,
    projectMatchesCatalogValue,
    itemMatchesSelection,
    filterItems
  };
}));
