"use strict";

function pad2(value) {
  return String(value).padStart(2, "0");
}

function formatLocalMinute(date = new Date()) {
  const current = date instanceof Date ? date : new Date(date);
  return [
    current.getFullYear(),
    pad2(current.getMonth() + 1),
    pad2(current.getDate())
  ].join("-") + " " + [
    pad2(current.getHours()),
    pad2(current.getMinutes())
  ].join(":");
}

module.exports = {
  formatLocalMinute
};
