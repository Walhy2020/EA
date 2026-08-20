"use strict";

const { detectByRules } = require("./ruleIntentDetector");

function createIntentRouter(options) {
  const routesConfig = options.routesConfig;
  const modules = options.modules;
  const aiIntentDetector = options.aiIntentDetector;
  const answerComposer = options.answerComposer;
  const conversationOrchestrator = options.conversationOrchestrator;
  const logger = options.logger;

  async function detectIntent(text) {
    const ruleIntent = detectByRules(text, routesConfig);
    if (ruleIntent) {
      return ruleIntent;
    }

    if (routesConfig.fallback && routesConfig.fallback.useAiWhenEnabled && aiIntentDetector) {
      try {
        const aiIntent = await aiIntentDetector.detect(text, routesConfig);
        if (aiIntent) {
          return aiIntent;
        }
      } catch (error) {
        logger.warn("AI intent detection failed", { message: error.message });
      }
    }

    const defaultModule = routesConfig.fallback && routesConfig.fallback.defaultModule;
    return {
      source: "fallback",
      intent: defaultModule ? `${defaultModule}.query` : "unknown",
      module: defaultModule || "unknown",
      confidence: 0.2
    };
  }

  async function handleMessage(message) {
    const text = String(message.text || "").trim();
    if (!text) {
      return {
        ok: false,
        text: "请发送要查询的内容。"
      };
    }

    if (conversationOrchestrator && conversationOrchestrator.isEnabled()) {
      try {
        return await conversationOrchestrator.handle({
          ...message,
          text
        });
      } catch (error) {
        logger.warn("LLM conversation orchestrator failed, fallback to rule router", { message: error.message });
      }
    }

    const intent = await detectIntent(text);
    const selectedModule = modules[intent.module];
    if (!selectedModule) {
      return {
        ok: false,
        intent,
        text: `暂时没有可用模块处理：${intent.module}`
      };
    }

    const moduleResult = await selectedModule.handle({
      text,
      intent: intent.intent,
      route: intent,
      sender: message.sender || {},
      raw: message.raw || {}
    });

    return answerComposer.compose({
      text,
      intent,
      moduleResult
    });
  }

  return {
    detectIntent,
    handleMessage
  };
}

module.exports = {
  createIntentRouter
};
