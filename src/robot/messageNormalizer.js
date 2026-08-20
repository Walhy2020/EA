"use strict";

function normalizeRobotMessage(raw) {
  if (typeof raw === "string") {
    return {
      text: raw,
      raw
    };
  }

  return {
    text: raw && (raw.text || raw.content || raw.message) ? String(raw.text || raw.content || raw.message) : "",
    sender: raw && raw.sender ? raw.sender : {},
    raw
  };
}

module.exports = {
  normalizeRobotMessage
};
