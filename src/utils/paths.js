"use strict";

const path = require("path");

const projectRoot = path.resolve(__dirname, "..", "..");

function resolveProjectPath(value) {
  if (!value) {
    return "";
  }

  if (path.isAbsolute(value)) {
    return path.normalize(value);
  }

  return path.resolve(projectRoot, value);
}

module.exports = {
  projectRoot,
  resolveProjectPath
};
