"use strict";

function createDemandModule() {
  async function handle() {
    return {
      ok: false,
      module: "demand",
      text: "需求进度模块还没有接入。"
    };
  }

  async function getStatus() {
    return {
      enabled: false,
      message: "需求进度模块未启用"
    };
  }

  return {
    name: "demand",
    handle,
    getStatus
  };
}

module.exports = {
  createDemandModule
};
