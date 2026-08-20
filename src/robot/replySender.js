"use strict";

function createReplySender() {
  async function send(replyTarget, text) {
    if (replyTarget && typeof replyTarget.send === "function") {
      return replyTarget.send(text);
    }

    return {
      ok: false,
      skipped: true,
      reason: "reply target is not configured"
    };
  }

  return { send };
}

module.exports = {
  createReplySender
};
