"use strict";

function createConversationStore(options = {}) {
  const ttlMs = Number(options.ttlMs || 30 * 60 * 1000);
  const sessions = new Map();

  function now() {
    return Date.now();
  }

  function cleanup() {
    const cutoff = now() - ttlMs;
    for (const [key, value] of sessions.entries()) {
      if (!value.updatedAt || value.updatedAt < cutoff) {
        sessions.delete(key);
      }
    }
  }

  function get(sessionId) {
    cleanup();
    return sessions.get(sessionId) || null;
  }

  function set(sessionId, value) {
    sessions.set(sessionId, {
      ...value,
      updatedAt: now()
    });
  }

  function clear(sessionId) {
    sessions.delete(sessionId);
  }

  return {
    get,
    set,
    clear
  };
}

module.exports = {
  createConversationStore
};
