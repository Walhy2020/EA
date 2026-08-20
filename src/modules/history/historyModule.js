"use strict";

function createHistoryModule() {
  async function handle() {
    return {
      ok: false,
      module: "history",
      text: "跨模块历史查询还没有接入。"
    };
  }

  async function getStatus() {
    return {
      enabled: false,
      message: "跨模块历史查询未启用"
    };
  }

  return {
    name: "history",
    handle,
    getStatus
  };
}

module.exports = {
  createHistoryModule
};
