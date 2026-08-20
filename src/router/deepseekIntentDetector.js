"use strict";

function createDeepSeekIntentDetector(options) {
  const aiConfig = options.aiConfig || {};
  const deepseekClient = options.deepseekClient;

  async function detect(text, routesConfig) {
    if (!aiConfig.enabled || !deepseekClient) {
      return null;
    }

    const modules = (routesConfig.rules || []).map((rule) => ({
      module: rule.module,
      intent: rule.intent,
      keywords: rule.keywords || []
    }));

    const prompt = [
      "你是企业内部机器人路由器，只返回 JSON。",
      "从用户消息判断应该交给哪个模块处理。",
      "可用模块：",
      JSON.stringify(modules),
      "返回格式：{\"module\":\"rank\",\"intent\":\"rank.query\",\"confidence\":0.8}",
      `用户消息：${text}`
    ].join("\n");

    const content = await deepseekClient.chat([
      { role: "system", content: "You route messages. Return compact JSON only." },
      { role: "user", content: prompt }
    ]);

    const parsed = JSON.parse(String(content || "").replace(/^```json\s*/i, "").replace(/```$/i, "").trim());
    if (!parsed || !parsed.module) {
      return null;
    }

    return {
      source: "deepseek",
      intent: parsed.intent || `${parsed.module}.query`,
      module: parsed.module,
      confidence: Number(parsed.confidence || 0.5)
    };
  }

  return { detect };
}

module.exports = {
  createDeepSeekIntentDetector
};
