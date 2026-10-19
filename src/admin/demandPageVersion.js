"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");

const ASSETS = [
  "demand-h5.html", "demand-h5.css", "demand-h5.js", "demand-page-update.js",
  "demand-entry-context.js", "demand-fallback-leader-filter.js", "demand-locator-navigation.js",
  "demand-task-time-sort.js", "demand-task-id-copy.js", "demand-project-settings.js",
  "demand-required-field-display.js", "demand-assignment-preview.js",
  "assignment-preview/index.html", "assignment-preview/app.js", "assignment-preview/model.js",
  "assignment-preview/styles.css", "assignment-preview/assets/lucide.min.js", "assignment-preview/assets/ea.png"
];

function createDemandPageVersionReader(root, { nowMs = Date.now, readFile = fs.readFileSync } = {}) {
  let cached = null;
  return function readPageVersion() {
    const now = nowMs();
    if (cached && now - cached.at < 5000) return cached.buildId;
    const hash = createHash("sha256");
    for (const asset of ASSETS) {
      hash.update(asset).update("\0").update(readFile(path.join(root, asset))).update("\0");
    }
    cached = { at: now, buildId: hash.digest("hex").slice(0, 24) };
    return cached.buildId;
  };
}

module.exports = { ASSETS, createDemandPageVersionReader };
