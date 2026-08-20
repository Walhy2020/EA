(function initDemandTaskTimeSort(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.EADemandTaskTimeSort = api;
}(typeof window !== "undefined" ? window : globalThis, function createDemandTaskTimeSort() {
  function createdTimestamp(item) {
    const value = item && (item.createdTime || item.recordCreatedTime || item.createdAt || item.recordCreatedAt);
    const text = String(value || "").trim();
    if (!text) return Number.NaN;
    if (/^\d{10,16}$/.test(text)) {
      const timestamp = Number(text);
      if (!Number.isFinite(timestamp)) return Number.NaN;
      return timestamp < 100000000000 ? timestamp * 1000 : timestamp;
    }
    const timestamp = Date.parse(text);
    return Number.isFinite(timestamp) ? timestamp : Number.NaN;
  }

  function sortByCreatedTime(items, newestFirst) {
    return [...(items || [])]
      .map((item, index) => ({ item, index, timestamp: createdTimestamp(item) }))
      .sort((left, right) => {
        const leftValid = Number.isFinite(left.timestamp);
        const rightValid = Number.isFinite(right.timestamp);
        if (leftValid !== rightValid) return leftValid ? -1 : 1;
        if (leftValid && left.timestamp !== right.timestamp) {
          return newestFirst ? right.timestamp - left.timestamp : left.timestamp - right.timestamp;
        }
        return left.index - right.index;
      })
      .map(({ item }) => item);
  }

  function toggleDirection(newestFirst) {
    return !Boolean(newestFirst);
  }

  return { createdTimestamp, sortByCreatedTime, toggleDirection };
}));
