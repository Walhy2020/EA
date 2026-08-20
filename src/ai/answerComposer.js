"use strict";

function createAnswerComposer() {
  async function compose(context) {
    const moduleResult = await context.moduleResult;
    if (!moduleResult) {
      return {
        ok: false,
        text: "模块没有返回结果。"
      };
    }

    if (moduleResult.text) {
      return {
        ...moduleResult,
        route: context.intent,
        text: moduleResult.text
      };
    }

    return {
      ...moduleResult,
      route: context.intent,
      text: JSON.stringify(moduleResult.data || moduleResult)
    };
  }

  return { compose };
}

module.exports = {
  createAnswerComposer
};
