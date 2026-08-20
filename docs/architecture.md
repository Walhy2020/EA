# Architecture

## Win10 first-stage layout

```text
Node.js background service
  admin console
  robot receiver
  intent router
  module adapters
  notification center

Embedded wx-mini-rank-monitor core
  ranking scan
  ranking history
  ranking query reply builder
```

The integrated assistant owns routing, cross-module orchestration, notification policy, and the local admin console. The mini-game rank source code is embedded for EA deployments, while the old standalone rank monitor directory can still run independently.

## Runtime flow

```text
WeCom smart robot message
-> messageNormalizer
-> ruleIntentDetector
-> deepseekIntentDetector when enabled
-> intentRouter
-> selected module
-> answerComposer
-> replySender
```

The first robot implementation uses the official WeCom smart robot SDK long connection. It does not require a public HTTPS callback endpoint.

## Monitoring flow

```text
monitorManager
-> module bridge
-> detects changes
-> notificationCenter
-> group notifier or app notifier
```

Rank monitoring is disabled in this project by default. EA can run the embedded rank scan when enabled, while the old standalone rank monitor can still keep its own scheduler and notification behavior.
