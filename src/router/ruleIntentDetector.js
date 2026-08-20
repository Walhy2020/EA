"use strict";

function normalizeText(text) {
  return String(text || "").trim().toLowerCase();
}

function detectByRules(text, routesConfig) {
  const normalized = normalizeText(text);
  if (!normalized) {
    return null;
  }

  const rules = Array.isArray(routesConfig.rules) ? routesConfig.rules : [];
  for (const rule of rules) {
    const keywords = Array.isArray(rule.keywords) ? rule.keywords : [];
    if (keywords.some((keyword) => normalized.includes(String(keyword).toLowerCase()))) {
      return {
        source: "rule",
        intent: rule.intent,
        module: rule.module,
        confidence: 0.85,
        matchedKeywords: keywords.filter((keyword) => normalized.includes(String(keyword).toLowerCase()))
      };
    }
  }

  return null;
}

module.exports = {
  detectByRules
};
