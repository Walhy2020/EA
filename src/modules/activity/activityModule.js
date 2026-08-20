"use strict";

function createActivityModule() {
  async function handle() {
    return {
      ok: false,
      module: "activity",
      text: "活动情报模块还没有接入。"
    };
  }

  async function getStatus() {
    return {
      enabled: false,
      message: "活动情报模块未启用"
    };
  }

  return {
    name: "activity",
    handle,
    getStatus
  };
}

module.exports = {
  createActivityModule
};
